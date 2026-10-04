import { createClient } from "@supabase/supabase-js";
import { getGmailAccessToken, sendRenewalEmail } from "../../src/lib/renewal-email.server.ts";
import { loadGmailOAuthCredentials } from "../../src/lib/gmail-oauth.server.ts";

const FIRST_REMINDER_WINDOW = { daysBefore: 7, minDaysLeft: 5 };
const FOLLOW_UP_WINDOW = { daysBefore: 4, minDaysLeft: 1 };
const STALE_SENDING_MINUTES = 20;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function createSupabaseFetch(apiKey) {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (apiKey.startsWith("sb_secret_") && headers.get("Authorization") === `Bearer ${apiKey}`) {
      headers.delete("Authorization");
    }
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

function dateInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateKey, numberOfDays) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + numberOfDays);
  return date.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  return Math.round((Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000);
}

async function claimReminder(supabase, membershipId, daysBefore, email, existing, now) {
  if (!existing) {
    const { data, error } = await supabase.from("renewal_reminders").insert({
      membership_id: membershipId,
      days_before: daysBefore,
      channels: [],
      delivery_status: "sending",
      attempt_count: 1,
      attempted_at: now,
      recipient_email: email,
    }).select("id").single();
    if (error?.code === "23505") return null;
    if (error) throw new Error(`Could not claim the renewal reminder: ${error.message}`);
    return data;
  }

  const staleBefore = new Date(Date.now() - STALE_SENDING_MINUTES * 60_000).toISOString();
  let update = supabase.from("renewal_reminders").update({
    delivery_status: "sending",
    attempt_count: existing.attempt_count + 1,
    attempted_at: now,
    recipient_email: email,
    last_error: null,
  }).eq("id", existing.id);

  if (existing.delivery_status === "failed") update = update.eq("delivery_status", "failed");
  else if (existing.delivery_status === "sending" && existing.attempted_at && existing.attempted_at < staleBefore) {
    update = update.eq("delivery_status", "sending").lt("attempted_at", staleBefore);
  } else return null;

  const { data, error } = await update.select("id").maybeSingle();
  if (error) throw new Error(`Could not claim the renewal reminder retry: ${error.message}`);
  return data;
}

export default async function membershipRenewalReminders() {
  const supabase = createAdminClient();
  const gmailCredentials = await loadGmailOAuthCredentials(supabase);
  const { data: gym, error: gymError } = await supabase
    .from("gym_settings")
    .select("gym_name, timezone")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (gymError) throw new Error(`Could not read gym settings: ${gymError.message}`);
  if (!gym) throw new Error("Gym settings have not been initialized.");

  const timeZone = gym.timezone || "Asia/Kolkata";
  const today = dateInTimezone(new Date(), timeZone);
  const lastReminderDate = addDays(today, 7);
  const { data: memberships, error: membershipsError } = await supabase
    .from("memberships")
    .select("id, member_id, ends_on")
    .eq("status", "active")
    .gte("ends_on", today)
    .lte("ends_on", lastReminderDate)
    .order("ends_on");
  if (membershipsError) throw new Error(`Could not load expiring memberships: ${membershipsError.message}`);
  if (!memberships?.length) return Response.json({ sent: 0, failed: 0, skipped: 0, message: "No memberships are due for reminders." });

  const memberIds = [...new Set(memberships.map((membership) => membership.member_id))];
  const membershipIds = memberships.map((membership) => membership.id);
  const [{ data: members, error: membersError }, { data: reminderRows, error: remindersError }] = await Promise.all([
    supabase.from("members").select("id, profile_id").in("id", memberIds),
    supabase.from("renewal_reminders").select("id, membership_id, days_before, delivery_status, attempt_count, attempted_at").in("membership_id", membershipIds),
  ]);
  if (membersError) throw new Error(`Could not load member profiles: ${membersError.message}`);
  if (remindersError) throw new Error(`Could not load reminder history: ${remindersError.message}`);

  const memberById = new Map((members ?? []).map((member) => [member.id, member]));
  const profileIds = [...new Set((members ?? []).map((member) => member.profile_id))];
  const { data: profiles, error: profilesError } = profileIds.length
    ? await supabase.from("profiles").select("id, display_name, email").in("id", profileIds)
    : { data: [], error: null };
  if (profilesError) throw new Error(`Could not load member emails: ${profilesError.message}`);

  const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  const reminderByKey = new Map((reminderRows ?? []).map((row) => [`${row.membership_id}:${row.days_before}`, row]));
  const { data: currentAndFuture, error: futureError } = await supabase
    .from("memberships")
    .select("id, member_id, ends_on, status")
    .in("member_id", memberIds)
    .in("status", ["active", "pending"]);
  if (futureError) throw new Error(`Could not check recent renewals: ${futureError.message}`);

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let accessTokenPromise;
  const gymName = gym.gym_name || "GYM MANAGER";
  const appUrl = process.env.APP_URL || process.env.URL || "";

  for (const membership of memberships) {
    const daysLeft = daysBetween(today, membership.ends_on);
    const member = memberById.get(membership.member_id);
    const profile = member ? profileById.get(member.profile_id) : null;
    if (!profile?.email) { skipped += 1; continue; }

    const alreadyRenewed = (currentAndFuture ?? []).some((other) =>
      other.member_id === membership.member_id &&
      other.id !== membership.id &&
      other.ends_on > membership.ends_on,
    );
    if (alreadyRenewed) { skipped += 1; continue; }

    const dueWindow = daysLeft >= FIRST_REMINDER_WINDOW.minDaysLeft
      ? FIRST_REMINDER_WINDOW
      : FOLLOW_UP_WINDOW;
    if (daysLeft < dueWindow.minDaysLeft || daysLeft > dueWindow.daysBefore) { skipped += 1; continue; }

    const reminderKey = `${membership.id}:${dueWindow.daysBefore}`;
    const existing = reminderByKey.get(reminderKey);
    if (existing?.delivery_status === "sent") { skipped += 1; continue; }
    const now = new Date().toISOString();
    let claimed;
    try {
      claimed = await claimReminder(supabase, membership.id, dueWindow.daysBefore, profile.email, existing, now);
    } catch (error) {
      failed += 1;
      console.error(error);
      continue;
    }
    if (!claimed) { skipped += 1; continue; }
    const reminder = { ...claimed, days_before: dueWindow.daysBefore };

    try {
      accessTokenPromise ??= getGmailAccessToken(gmailCredentials);
      const accessToken = await accessTokenPromise;
      const providerMessageId = await sendRenewalEmail({
        accessToken,
        senderEmail: gmailCredentials.senderEmail,
        email: profile.email,
        appUrl,
        gymName,
        memberName: profile.display_name,
        expiresOn: membership.ends_on,
        timeZone,
        reminderDaysBefore: reminder.days_before,
        reminderId: reminder.id,
      });
      const { error: sentUpdateError } = await supabase.from("renewal_reminders").update({
        delivery_status: "sent",
        channels: ["email"],
        provider_message_id: providerMessageId,
        sent_at: new Date().toISOString(),
        last_error: null,
      }).eq("id", claimed.id);
      if (sentUpdateError) throw new Error(`Email was accepted but reminder status could not be saved: ${sentUpdateError.message}`);
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown email delivery error.";
      const { error: failedUpdateError } = await supabase.from("renewal_reminders").update({
        delivery_status: "failed",
        last_error: message.slice(0, 1000),
      }).eq("id", claimed.id);
      if (failedUpdateError) console.error("Could not record failed reminder delivery:", failedUpdateError.message);
      console.error(`Renewal reminder failed for membership ${membership.id}:`, message);
      failed += 1;
    }
  }

  console.info(`Membership renewal reminders finished: sent=${sent}, failed=${failed}, skipped=${skipped}, local_date=${today}, timezone=${timeZone}`);
  return Response.json({ sent, failed, skipped, localDate: today, timeZone });
}

export const config = {
  schedule: "0 2 * * *",
};
