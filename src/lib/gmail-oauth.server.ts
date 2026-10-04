import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const TABLE = "gym_gmail_oauth";

export type GmailOAuthCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  senderEmail: string;
};

type OAuthState = { adminId: string; issuedAt: number; nonce: string; redirectUri: string };

function encryptionKey() {
  const secret = process.env["GMAIL_CREDENTIALS_ENCRYPTION_KEY"] || process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!secret) throw new Error("Configure GMAIL_CREDENTIALS_ENCRYPTION_KEY or SUPABASE_SERVICE_ROLE_KEY on the server.");
  return createHash("sha256").update("gym-manager:gmail-oauth:v1:").update(secret).digest();
}

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decrypt(value: string) {
  const [version, ivPart, tagPart, ciphertextPart] = value.split(".");
  if (version !== "v1" || !ivPart || !tagPart || !ciphertextPart) throw new Error("Saved Gmail credentials could not be decrypted. Reconnect Gmail in Settings.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Saved Gmail credentials could not be decrypted. Reconnect Gmail in Settings.");
  }
}

export async function readGmailOAuthRow(db: SupabaseClient) {
  const { data, error } = await db.from(TABLE).select("id, client_id, client_secret_ciphertext, refresh_token_ciphertext, sender_email, connected_at").eq("id", 1).maybeSingle();
  if (error) throw new Error(`Could not load Gmail OAuth settings: ${error.message}`);
  return data;
}

export async function loadGmailOAuthCredentials(db: SupabaseClient): Promise<GmailOAuthCredentials> {
  const row = await readGmailOAuthRow(db);
  if (!row?.refresh_token_ciphertext || !row.sender_email) {
    throw new Error("Connect a Gmail account in Admin Settings before sending membership reminder emails.");
  }
  return {
    clientId: row.client_id,
    clientSecret: decrypt(row.client_secret_ciphertext),
    refreshToken: decrypt(row.refresh_token_ciphertext),
    senderEmail: row.sender_email,
  };
}

export function sealOAuthState(state: OAuthState) {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const signature = createHmac("sha256", encryptionKey()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function openOAuthState(value: string): OAuthState {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) throw new Error("The Gmail authorization request is invalid. Start again from Settings.");
  const expected = createHmac("sha256", encryptionKey()).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("The Gmail authorization request is invalid. Start again from Settings.");
  let state: OAuthState;
  try { state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState; }
  catch { throw new Error("The Gmail authorization request is invalid. Start again from Settings."); }
  if (!state.adminId || !state.nonce || !state.redirectUri || !Number.isSafeInteger(state.issuedAt) || Math.floor(Date.now() / 1000) - state.issuedAt > OAUTH_STATE_MAX_AGE_SECONDS || state.issuedAt > Math.floor(Date.now() / 1000) + 60) {
    throw new Error("The Gmail authorization request expired. Start again from Settings.");
  }
  return state;
}

export function createOAuthNonce() { return randomBytes(24).toString("base64url"); }
export function encryptGmailSecret(value: string) { return encrypt(value); }
export function decryptGmailSecret(value: string) { return decrypt(value); }

export function gmailCallbackUrl(requestUrl: string) {
  const requestOrigin = new URL(requestUrl).origin;
  const configuredBase = process.env["APP_URL"] || process.env["URL"] || requestOrigin;
  const base = new URL(configuredBase);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    throw new Error("The Gmail OAuth callback must use HTTPS.");
  }
  return new URL("/api/gmail-oauth/callback", base).toString();
}
