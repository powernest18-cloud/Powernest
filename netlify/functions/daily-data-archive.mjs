import { createClient } from "@supabase/supabase-js";
import { runDailyGymDataArchive } from "../../src/lib/drive-archive.server.ts";
import { readDriveArchiveOAuthRow } from "../../src/lib/drive-archive-oauth.server.ts";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function createSupabaseFetch(apiKey) {
  return (input, init) => {
    const headers = new Headers(typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (apiKey.startsWith("sb_secret_") && headers.get("Authorization") === `Bearer ${apiKey}`) headers.delete("Authorization");
    headers.set("apikey", apiKey);
    return fetch(input, { ...init, headers });
  };
}

function createAdminClient() {
  const apiKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(requiredEnv("SUPABASE_URL"), apiKey, {
    global: { fetch: createSupabaseFetch(apiKey) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default async function dailyDataArchive() {
  try {
    const db = createAdminClient();
    const connection = await readDriveArchiveOAuthRow(db);
    if (!connection?.refresh_token_ciphertext || !connection.folder_id) {
      return Response.json({ ok: true, skipped: true, message: "Google Drive archive is not configured." });
    }
    const result = await runDailyGymDataArchive(db);
    console.info("Daily gym archive completed:", JSON.stringify({ date: result.archiveDate, timeZone: result.timeZone, results: result.results }));
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown archive error.";
    console.error("Daily gym archive failed:", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export const config = { schedule: "15 3 * * *" };
