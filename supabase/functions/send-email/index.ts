import { Webhook } from "npm:standardwebhooks@1.0.0";

type EmailData = {
  token: string;
  token_hash: string;
  redirect_to: string;
  email_action_type: string;
  site_url: string;
  token_new?: string;
  token_hash_new?: string;
  old_email?: string;
};

type HookPayload = {
  user: { email?: string; new_email?: string; user_metadata?: Record<string, unknown> };
  email_data: EmailData;
};

const encoder = new TextEncoder();
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required function secret: ${name}`);
  return value;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function encodeHeader(value: string) {
  const safe = value.replace(/[\r\n]+/g, " ").trim();
  return `=?UTF-8?B?${btoa(String.fromCharCode(...encoder.encode(safe)))}?=`;
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function decryptSecret(encrypted: string) {
  const [version, ivText, tagText, cipherText] = encrypted.split(".");
  if (version !== "v1" || !ivText || !tagText || !cipherText) {
    throw new Error("Saved Gmail credentials have an unsupported format.");
  }

  const encryptionSecret = Deno.env.get("GMAIL_CREDENTIALS_ENCRYPTION_KEY")
    || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!encryptionSecret) throw new Error("Gmail credential encryption key is not configured.");

  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`gym-manager:gmail-oauth:v1:${encryptionSecret}`),
  ));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
  const ciphertext = fromBase64Url(cipherText);
  const tag = fromBase64Url(tagText);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(ivText), tagLength: 128 },
    key,
    combined,
  );
  return new TextDecoder().decode(plaintext);
}

async function readGmailSettings() {
  const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(
    `${supabaseUrl}/rest/v1/gym_gmail_oauth?id=eq.1&select=client_id,client_secret_ciphertext,refresh_token_ciphertext,sender_email`,
    {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      signal: AbortSignal.timeout(1800),
    },
  );
  if (!response.ok) throw new Error("Could not read the configured Gmail sender.");
  const rows = await response.json() as Array<{
    client_id: string;
    client_secret_ciphertext: string;
    refresh_token_ciphertext: string | null;
    sender_email: string | null;
  }>;
  const row = rows[0];
  if (!row?.refresh_token_ciphertext || !row.sender_email) {
    throw new Error("Connect a Gmail account in Admin Settings before enabling auth email delivery.");
  }
  return {
    clientId: row.client_id,
    clientSecret: await decryptSecret(row.client_secret_ciphertext),
    refreshToken: await decryptSecret(row.refresh_token_ciphertext),
    senderEmail: row.sender_email,
  };
}

async function getAccessToken(credentials: { clientId: string; clientSecret: string; refreshToken: string }) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(1800),
  });
  const result = await response.json().catch(() => ({})) as { access_token?: string };
  if (!response.ok || !result.access_token) throw new Error("Google could not authorize the Gmail sender.");
  return result.access_token;
}

function actionContent(actionType: string) {
  switch (actionType) {
    case "signup": return { subject: "Confirm your account", heading: "Confirm your email", intro: "Use the secure link below to confirm your email address and finish creating your account." };
    case "recovery": return { subject: "Reset your password", heading: "Reset your password", intro: "Use the secure link below to choose a new password." };
    case "magiclink": return { subject: "Your sign-in link", heading: "Sign in to your account", intro: "Use the secure link below to sign in." };
    case "invite": return { subject: "You’re invited", heading: "Accept your invitation", intro: "Use the secure link below to accept your invitation and continue." };
    case "email_change": return { subject: "Confirm your email change", heading: "Confirm your email change", intro: "Use the secure link below to confirm this email change." };
    case "reauthentication": return { subject: "Confirm it’s you", heading: "Confirm it’s you", intro: "Use the secure link below to confirm this action." };
    default: throw new Error(`Unsupported Supabase auth email action: ${actionType}`);
  }
}

function verificationUrl(supabaseUrl: string, redirectTo: string, type: string, tokenHash: string) {
  const url = new URL("/auth/v1/verify", supabaseUrl);
  url.searchParams.set("token", tokenHash);
  url.searchParams.set("type", type);
  if (redirectTo) url.searchParams.set("redirect_to", redirectTo);
  return url.toString();
}

function buildRawEmail({
  senderEmail, gymName, to, subject, heading, intro, token, actionUrl,
}: {
  senderEmail: string; gymName: string; to: string; subject: string; heading: string;
  intro: string; token: string; actionUrl: string;
}) {
  const safeGym = escapeHtml(gymName);
  const safeHeading = escapeHtml(heading);
  const safeIntro = escapeHtml(intro);
  const safeToken = escapeHtml(token);
  const safeUrl = escapeHtml(actionUrl);
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,sans-serif;color:#17202a"><main style="max-width:600px;margin:32px auto;padding:28px;background:#fff;border-radius:12px"><p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#687385">${safeGym}</p><h1 style="font-size:24px">${safeHeading}</h1><p>${safeIntro}</p><p style="margin:28px 0"><a href="${safeUrl}" style="background:#176b48;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px">Continue securely</a></p><p>Or enter this code on the app:</p><p style="font-size:24px;letter-spacing:.16em;font-weight:bold">${safeToken}</p><p style="font-size:12px;color:#687385">If you didn’t request this email, you can ignore it.</p></main></body></html>`;
  const text = `${heading}\n\n${intro}\n\nContinue securely: ${actionUrl}\n\nOr enter this code on the app: ${token}\n\nIf you didn’t request this email, you can ignore it.`;
  const boundary = `gym-auth-${crypto.randomUUID()}`;
  const base64Lines = (value: string) => btoa(String.fromCharCode(...encoder.encode(value))).match(/.{1,76}/g)?.join("\r\n") ?? "";
  const message = [
    `From: ${encodeHeader(gymName)} <${senderEmail}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(`${gymName}: ${subject}`)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return toBase64Url(encoder.encode(message));
}

async function sendEmail(accessToken: string, senderEmail: string, gymName: string, to: string, content: ReturnType<typeof actionContent>, token: string, actionUrl: string) {
  if (!emailPattern.test(to)) throw new Error("Supabase provided an invalid email recipient.");
  const raw = buildRawEmail({ senderEmail, gymName, to, ...content, token, actionUrl });
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
    signal: AbortSignal.timeout(1800),
  });
  if (!response.ok) throw new Error(`Gmail API failed to send an auth email (HTTP ${response.status}).`);
}

async function getGymName() {
  const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${supabaseUrl}/rest/v1/gym_settings?select=gym_name&limit=1`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    signal: AbortSignal.timeout(1200),
  });
  if (!response.ok) return "GYM MANAGER";
  const rows = await response.json() as Array<{ gym_name?: string }>;
  return rows[0]?.gym_name?.trim() || "GYM MANAGER";
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const rawPayload = await request.text();
  let payload: HookPayload;
  try {
    const hookSecret = requiredEnv("SEND_EMAIL_HOOK_SECRET").replace(/^v1,whsec_/, "");
    const webhook = new Webhook(hookSecret);
    payload = webhook.verify(rawPayload, Object.fromEntries(request.headers)) as HookPayload;
  } catch {
    return new Response("Invalid auth hook signature", { status: 401 });
  }

  try {
    const { user, email_data: emailData } = payload;
    const actionType = emailData.email_action_type;
    const content = actionContent(actionType);
    const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
    const [credentials, gymName] = await Promise.all([readGmailSettings(), getGymName()]);
    const accessToken = await getAccessToken(credentials);

    if (actionType === "email_change" && emailData.token_hash_new && emailData.token_hash) {
      const oldAddress = user.email;
      const newAddress = user.new_email;
      if (!oldAddress || !newAddress || !emailData.token || !emailData.token_new) {
        throw new Error("Supabase sent incomplete secure email-change details.");
      }
      await Promise.all([
        sendEmail(accessToken, credentials.senderEmail, gymName, oldAddress, content, emailData.token, verificationUrl(supabaseUrl, emailData.redirect_to, actionType, emailData.token_hash_new)),
        sendEmail(accessToken, credentials.senderEmail, gymName, newAddress, content, emailData.token_new, verificationUrl(supabaseUrl, emailData.redirect_to, actionType, emailData.token_hash)),
      ]);
    } else {
      const to = user.email;
      const token = emailData.token;
      const tokenHash = emailData.token_hash || emailData.token_hash_new;
      if (!to || !token || !tokenHash) throw new Error("Supabase sent incomplete auth email details.");
      await sendEmail(accessToken, credentials.senderEmail, gymName, to, content, token, verificationUrl(supabaseUrl, emailData.redirect_to, actionType, tokenHash));
    }

    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error("Send Email Auth Hook failed:", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "Auth email could not be sent." }, { status: 500 });
  }
});
