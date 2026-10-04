function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function encodeHeader(value: string) {
  const safeValue = value.replace(/[\r\n]+/g, " ").trim();
  return `=?UTF-8?B?${Buffer.from(safeValue, "utf8").toString("base64")}?=`;
}

function encodeMimeBody(value: string) {
  const base64 = Buffer.from(value, "utf8").toString("base64");
  return base64.match(/.{1,76}/g)?.join("\r\n") || "";
}

export async function getGmailAccessToken(credentials: { clientId: string; clientSecret: string; refreshToken: string }) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const result = await response.json().catch(() => ({})) as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || typeof result.access_token !== "string") {
    throw new Error(result.error_description || result.error || `Google OAuth returned HTTP ${response.status}.`);
  }
  return result.access_token;
}

export async function sendRenewalEmail({
  accessToken,
  senderEmail,
  gymName,
  memberName,
  email,
  expiresOn,
  timeZone,
  appUrl,
  reminderDaysBefore,
  membershipExpired = false,
  reminderId,
}: {
  accessToken: string;
  senderEmail: string;
  gymName: string;
  memberName: string;
  email: string;
  expiresOn: string;
  timeZone: string;
  appUrl?: string;
  reminderDaysBefore: number;
  membershipExpired?: boolean;
  reminderId: string;
}) {
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(senderEmail)) {
    throw new Error("The connected Gmail sender address is invalid. Reconnect Gmail in Admin Settings.");
  }
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
    throw new Error("Member email address is invalid.");
  }

  const expiryLabel = new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeZone,
  }).format(new Date(`${expiresOn}T12:00:00.000Z`));
  const firstReminder = reminderDaysBefore === 7 || reminderDaysBefore === 0;
  const reminderLabel = membershipExpired ? "expired membership reminder" : firstReminder ? "membership renewal reminder" : "membership renewal follow-up";
  const subject = membershipExpired ? `${gymName}: your membership expired on ${expiryLabel}` : `${gymName}: your membership expires on ${expiryLabel}`;
  const signInUrl = appUrl ? `${appUrl.replace(/\/$/, "")}/auth` : null;
  const greeting = memberName ? `Hello ${escapeHtml(memberName)},` : "Hello,";
  const title = membershipExpired ? "Your membership has expired" : "Membership renewal reminder";
  const bodyCopy = membershipExpired
    ? `Your membership expired on <strong>${escapeHtml(expiryLabel)}</strong>. Renew your membership to get back to training at ${escapeHtml(gymName)}.`
    : `This is your ${firstReminder ? "renewal" : "follow-up renewal"} reminder. Your current membership expires on <strong>${escapeHtml(expiryLabel)}</strong>. Renew before it expires to keep your membership active.`;
  const ctaLabel = membershipExpired ? "Sign in to renew your membership" : "Sign in to view membership plans";
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,sans-serif;color:#17202a"><main style="max-width:600px;margin:32px auto;padding:28px;background:#fff;border-radius:12px"><p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#687385">${escapeHtml(gymName)}</p><h1 style="font-size:24px">${title}</h1><p>${greeting}</p><p>${bodyCopy}</p>${signInUrl ? `<p style="margin:28px 0"><a href="${escapeHtml(signInUrl)}" style="background:#176b48;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px">${ctaLabel}</a></p>` : ""}<p style="font-size:12px;color:#687385">This is an ${escapeHtml(reminderLabel)} from ${escapeHtml(gymName)}.</p></main></body></html>`;
  const text = membershipExpired
    ? `${memberName ? `Hello ${memberName},\n\n` : "Hello,\n\n"}Your membership expired on ${expiryLabel}. Renew your membership to get back to training at ${gymName}.${signInUrl ? `\n\nSign in to renew your membership: ${signInUrl}` : ""}`
    : `${memberName ? `Hello ${memberName},\n\n` : "Hello,\n\n"}This is your ${firstReminder ? "renewal" : "follow-up renewal"} reminder. Your current membership expires on ${expiryLabel}. Renew before it expires to keep your membership active.${signInUrl ? `\n\nSign in to view membership plans: ${signInUrl}` : ""}`;
  const boundary = `gym-renewal-${reminderId.replace(/[^a-zA-Z0-9-]/g, "")}`;
  const mimeMessage = [
    `From: ${encodeHeader(gymName)} <${senderEmail}>`,
    `To: ${email}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: <membership-renewal-${boundary}@gmail.com>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeMimeBody(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeMimeBody(html),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(mimeMessage, "utf8").toString("base64url") }),
    signal: AbortSignal.timeout(12_000),
  });
  const result = await response.json().catch(() => ({})) as { id?: string; error?: { message?: string } | string; error_description?: string };
  if (!response.ok) {
    const errorMessage = typeof result.error === "string" ? result.error : result.error?.message;
    throw new Error(errorMessage || result.error_description || `Gmail API returned HTTP ${response.status}.`);
  }
  return typeof result.id === "string" ? result.id : null;
}
