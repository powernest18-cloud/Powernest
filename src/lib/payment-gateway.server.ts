import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const TABLE = "gym_payment_gateway_credentials";

export type PaymentGatewayCredentials = {
  razorpayKeyId: string;
  razorpayKeySecret: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
};

function encryptionKey() {
  const secret = process.env["PAYMENT_CREDENTIALS_ENCRYPTION_KEY"] || process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!secret) throw new Error("Configure PAYMENT_CREDENTIALS_ENCRYPTION_KEY or SUPABASE_SERVICE_ROLE_KEY on the server.");
  return createHash("sha256").update("gym-manager:payment-gateway:v1:").update(secret).digest();
}

export function encryptPaymentSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptPaymentSecret(value: string) {
  const [version, ivPart, tagPart, ciphertextPart] = value.split(".");
  if (version !== "v1" || !ivPart || !tagPart || !ciphertextPart) throw new Error("Saved payment credentials could not be decrypted. Re-enter the gateway keys in Admin Settings.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Saved payment credentials could not be decrypted. Re-enter the gateway keys in Admin Settings.");
  }
}

async function readPaymentGatewayRow(db: SupabaseClient) {
  const { data, error } = await db.from(TABLE).select("id, razorpay_key_id_ciphertext, razorpay_key_secret_ciphertext, stripe_secret_key_ciphertext, stripe_webhook_secret_ciphertext").eq("id", 1).maybeSingle();
  if (error) throw new Error(`Could not read payment gateway settings: ${error.message}`);
  return data;
}

export async function loadPaymentGatewayCredentials(db: SupabaseClient): Promise<PaymentGatewayCredentials> {
  const row = await readPaymentGatewayRow(db);
  return {
    razorpayKeyId: row?.razorpay_key_id_ciphertext ? decryptPaymentSecret(row.razorpay_key_id_ciphertext) : process.env["RAZORPAY_KEY_ID"] || "",
    razorpayKeySecret: row?.razorpay_key_secret_ciphertext ? decryptPaymentSecret(row.razorpay_key_secret_ciphertext) : process.env["RAZORPAY_KEY_SECRET"] || "",
    stripeSecretKey: row?.stripe_secret_key_ciphertext ? decryptPaymentSecret(row.stripe_secret_key_ciphertext) : process.env["STRIPE_SECRET_KEY"] || "",
    stripeWebhookSecret: row?.stripe_webhook_secret_ciphertext ? decryptPaymentSecret(row.stripe_webhook_secret_ciphertext) : process.env["STRIPE_WEBHOOK_SECRET"] || "",
  };
}

export async function getPaymentGatewayCredentialStatus(db: SupabaseClient) {
  const row = await readPaymentGatewayRow(db);
  const razorpaySaved = Boolean(row?.razorpay_key_id_ciphertext && row.razorpay_key_secret_ciphertext);
  const stripeSaved = Boolean(row?.stripe_secret_key_ciphertext);
  const stripeWebhookSaved = Boolean(row?.stripe_webhook_secret_ciphertext);
  const razorpayEnvironment = Boolean(process.env["RAZORPAY_KEY_ID"] && process.env["RAZORPAY_KEY_SECRET"]);
  const stripeEnvironment = Boolean(process.env["STRIPE_SECRET_KEY"]);
  const stripeWebhookEnvironment = Boolean(process.env["STRIPE_WEBHOOK_SECRET"]);
  return {
    razorpayConfigured: razorpaySaved || razorpayEnvironment,
    razorpaySource: razorpaySaved ? "settings" as const : razorpayEnvironment ? "environment" as const : null,
    stripeConfigured: stripeSaved || stripeEnvironment,
    stripeSource: stripeSaved ? "settings" as const : stripeEnvironment ? "environment" as const : null,
    stripeWebhookConfigured: stripeWebhookSaved || stripeWebhookEnvironment,
    stripeWebhookSource: stripeWebhookSaved ? "settings" as const : stripeWebhookEnvironment ? "environment" as const : null,
  };
}
