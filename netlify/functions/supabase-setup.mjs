import { timingSafeEqual } from "node:crypto";

const NETLIFY_API = "https://api.netlify.com/api/v1";

class NetlifyApiError extends Error {
  constructor(status, path) {
    super(`Netlify returned HTTP ${status} for ${path}.`);
    this.status = status;
    this.path = path;
  }
}

function json(statusCode, payload) {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function matchesSecret(provided, expected) {
  if (typeof provided !== "string" || !expected) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

async function netlifyRequest(path, init = {}) {
  const response = await fetch(`${NETLIFY_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init.headers,
    },
  });
  const body = await response.text();
  let data;
  try { data = body ? JSON.parse(body) : null; } catch { data = null; }
  if (!response.ok) {
    throw new NetlifyApiError(response.status, path);
  }
  return data;
}

export default async function handler(request) {
  if (request.method !== "POST") return json(405, { error: "Use POST to save the database connection." });
  if (!process.env.SUPABASE_SETUP_TOKEN || process.env.SUPABASE_SETUP_TOKEN.length < 32 || !process.env.NETLIFY_AUTH_TOKEN || !process.env.NETLIFY_SITE_ID) {
    return json(503, { error: "Database setup is not enabled yet. The deployment owner must configure its Netlify setup variables first." });
  }

  let input;
  try { input = await request.json(); } catch { return json(400, { error: "The submitted setup details are invalid." }); }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return json(400, { error: "The submitted setup details are invalid." });
  }
  if (!matchesSecret(input.setupToken, process.env.SUPABASE_SETUP_TOKEN)) {
    return json(401, { error: "The setup access code is incorrect." });
  }

  const projectUrl = typeof input.projectUrl === "string" ? input.projectUrl.trim() : "";
  const publishableKey = typeof input.publishableKey === "string" ? input.publishableKey.trim() : "";
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const serviceRoleKey = typeof input.serviceRoleKey === "string" ? input.serviceRoleKey.trim() : "";
  let parsedUrl;
  try { parsedUrl = new URL(projectUrl); } catch { return json(400, { error: "Enter a valid Supabase project URL." }); }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    return json(400, { error: "The Supabase project URL must be a secure HTTPS URL without credentials or query parameters." });
  }
  if (!publishableKey || publishableKey.length > 2000 || !projectId || projectId.length > 100 || !serviceRoleKey || serviceRoleKey.length > 4000) {
    return json(400, { error: "Enter the publishable key, project ID, and service-role key from the same Supabase project." });
  }

  const siteId = process.env.NETLIFY_SITE_ID;
  const credentials = [
    { key: "SUPABASE_URL", value: projectUrl },
    { key: "VITE_SUPABASE_URL", value: projectUrl },
    { key: "SUPABASE_PUBLISHABLE_KEY", value: publishableKey },
    { key: "VITE_SUPABASE_PUBLISHABLE_KEY", value: publishableKey },
    { key: "SUPABASE_PROJECT_ID", value: projectId },
    { key: "SUPABASE_SERVICE_ROLE_KEY", value: serviceRoleKey },
  ];

  let step = "looking up the Netlify project";
  try {
    const site = await netlifyRequest(`/sites/${encodeURIComponent(siteId)}`);
    const accountId = process.env.NETLIFY_ACCOUNT_ID || site.account_slug || site.account_id || site.account?.slug || site.account?.id;
    if (!accountId) throw new Error("Could not determine the Netlify team for this site. Configure NETLIFY_ACCOUNT_ID in the deployment environment.");
    const accountPath = `/accounts/${encodeURIComponent(accountId)}/env`;
    step = "reading the Netlify environment variables";
    const current = await netlifyRequest(`${accountPath}?site_id=${encodeURIComponent(siteId)}`);
    const existingKeys = new Map((Array.isArray(current) ? current : []).map((item) => [item.key, item]));
    const newVariables = [];

    for (const variable of credentials) {
      const prior = existingKeys.get(variable.key);
      const body = {
        key: variable.key,
        values: [{ context: "all", value: variable.value }],
      };
      if (prior) {
        step = `updating ${variable.key}`;
        await netlifyRequest(`${accountPath}/${encodeURIComponent(variable.key)}?site_id=${encodeURIComponent(siteId)}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
      } else {
        step = `creating ${variable.key}`;
        newVariables.push(body);
      }
    }

    if (newVariables.length) {
      step = "creating the remaining Netlify environment variables";
      await netlifyRequest(`${accountPath}?site_id=${encodeURIComponent(siteId)}`, {
        method: "POST",
        body: JSON.stringify(newVariables),
      });
    }

    step = "queueing the Netlify deployment";
    await netlifyRequest(`/sites/${encodeURIComponent(siteId)}/builds`, { method: "POST" });
    return json(200, { ok: true, message: "Credentials were saved and a new deployment was queued." });
  } catch (error) {
    // Do not log submitted credentials, setup codes, or raw API request bodies.
    const detail = error instanceof Error ? error.message : "Unexpected Netlify API error.";
    console.error("[Supabase setup] Could not update the Netlify environment:", detail);
    const status = error instanceof NetlifyApiError ? ` Netlify returned HTTP ${error.status}.` : "";
    return json(502, { error: `Could not save the database connection while ${step}.${status} Check the Netlify token, account/site IDs, and permissions.` });
  }
}
