import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TABLE = "gym_drive_archive_oauth";
type OAuthState = { adminId: string; issuedAt: number; nonce: string; redirectUri: string };

function encryptionKey() {
  const secret = process.env["GMAIL_CREDENTIALS_ENCRYPTION_KEY"] || process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!secret) throw new Error("Configure GMAIL_CREDENTIALS_ENCRYPTION_KEY or SUPABASE_SERVICE_ROLE_KEY on the server.");
  return createHash("sha256").update("gym-manager:drive-archive-oauth:v1:").update(secret).digest();
}

export function encryptDriveSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptDriveSecret(value: string) {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Saved Google Drive credentials could not be decrypted. Reconnect Google Drive in Settings.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Saved Google Drive credentials could not be decrypted. Reconnect Google Drive in Settings.");
  }
}

export async function readDriveArchiveOAuthRow(db: SupabaseClient) {
  const { data, error } = await (db as any).from(TABLE).select("id, client_id, client_secret_ciphertext, refresh_token_ciphertext, sender_email, folder_id, folder_url, connected_at, updated_at").eq("id", 1).maybeSingle();
  if (error) throw new Error(`Could not load Google Drive archive settings: ${error.message}`);
  return data as { id: number; client_id: string; client_secret_ciphertext: string; refresh_token_ciphertext: string | null; sender_email: string | null; folder_id: string | null; folder_url: string | null; connected_at: string | null; updated_at: string } | null;
}

export function sealDriveOAuthState(state: OAuthState) {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const signature = createHmac("sha256", encryptionKey()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function openDriveOAuthState(value: string): OAuthState {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) throw new Error("Invalid Google Drive authorization request.");
  const expected = createHmac("sha256", encryptionKey()).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid Google Drive authorization request.");
  const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
  const now = Math.floor(Date.now() / 1000);
  if (!state.adminId || !state.nonce || !state.redirectUri || !Number.isSafeInteger(state.issuedAt) || now - state.issuedAt > 600 || state.issuedAt > now + 60) throw new Error("Google Drive authorization request expired. Start again from Settings.");
  return state;
}

export function createDriveOAuthNonce() { return randomBytes(24).toString("base64url"); }

export function driveArchiveCallbackUrl(requestUrl: string) {
  const origin = new URL(requestUrl).origin;
  const base = new URL(process.env["APP_URL"] || process.env["URL"] || origin);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") throw new Error("Google Drive OAuth callback must use HTTPS.");
  return new URL("/api/google-drive-archive/callback", base).toString();
}

export async function getDriveArchiveAccessToken(db: SupabaseClient) {
  const row = await readDriveArchiveOAuthRow(db);
  if (!row?.refresh_token_ciphertext) throw new Error("Connect Google Drive in Admin Settings before running the archive.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: row.client_id,
      client_secret: decryptDriveSecret(row.client_secret_ciphertext),
      refresh_token: decryptDriveSecret(row.refresh_token_ciphertext),
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tokens = await response.json().catch(() => ({})) as { access_token?: string; error?: string };
  if (!response.ok || !tokens.access_token) throw new Error(`Google Drive token refresh failed: ${tokens.error || response.status}`);
  return { accessToken: tokens.access_token, row };
}
