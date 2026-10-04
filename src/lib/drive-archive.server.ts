import type { SupabaseClient } from "@supabase/supabase-js";
import { getDriveArchiveAccessToken } from "./drive-archive-oauth.server";

type CsvRow = Record<string, string | number | boolean | null | undefined>;

function csv(rows: CsvRow[], defaultHeaders: string[]) {
  const headers = rows.length ? [...new Set(rows.flatMap((row) => Object.keys(row)))] : defaultHeaders;
  const cell = (value: CsvRow[string]) => {
    let text = value == null ? "" : String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${headers.map(cell).join(",")}\r\n${rows.map((row) => headers.map((header) => cell(row[header])).join(",")).join("\r\n")}\r\n`;
}

function localDate(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dayStartUtc(dateKey: string, timeZone: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const target = Date.UTC(year!, month! - 1, day!);
  let guess = target;
  for (let index = 0; index < 3; index++) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
    const rendered = Date.UTC(values.year!, values.month! - 1, values.day!, values.hour!, values.minute!, values.second!);
    guess += target - rendered;
  }
  return new Date(guess).toISOString();
}

async function rows<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const result: T[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await query(from, from + 499);
    if (error) throw new Error(error.message);
    result.push(...(data ?? []));
    if (!data || data.length < 500) return result;
  }
}

async function rowsForIds<T>(ids: string[], query: (ids: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const result: T[] = [];
  for (let index = 0; index < ids.length; index += 100) {
    const group = ids.slice(index, index + 100);
    result.push(...await rows((from, to) => query(group, from, to)));
  }
  return result;
}

function driveEscape(value: string) { return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'"); }

async function uploadCsv(accessToken: string, folderId: string, fileName: string, contents: string) {
  const query = new URLSearchParams({
    q: `'${driveEscape(folderId)}' in parents and name = '${driveEscape(fileName)}' and trashed = false`,
    fields: "files(id,name,webViewLink)",
    pageSize: "1",
  });
  const findResponse = await fetch(`https://www.googleapis.com/drive/v3/files?${query}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  const findBody = await findResponse.json().catch(() => ({})) as { files?: { id: string; webViewLink?: string }[]; error?: { message?: string } };
  if (!findResponse.ok) throw new Error(`Could not check Google Drive for an existing archive: ${findBody.error?.message || findResponse.status}`);
  const existing = findBody.files?.[0];
  const metadata = JSON.stringify({ name: fileName, mimeType: "text/csv", ...(existing ? {} : { parents: [folderId] }) });
  const delimiter = `gym_archive_${crypto.randomUUID()}`;
  const body = `--${delimiter}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${delimiter}\r\nContent-Type: text/csv; charset=UTF-8\r\n\r\n${contents}\r\n--${delimiter}--`;
  const endpoint = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=id,name,webViewLink`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink";
  const response = await fetch(endpoint, {
    method: existing ? "PATCH" : "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${delimiter}` },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json().catch(() => ({})) as { id?: string; name?: string; webViewLink?: string; error?: { message?: string } };
  if (!response.ok || !result.id) throw new Error(`Could not upload ${fileName}: ${result.error?.message || response.status}`);
  return { id: result.id, name: result.name || fileName, url: result.webViewLink || `https://drive.google.com/file/d/${result.id}/view` };
}

async function exportDataset(db: SupabaseClient, accessToken: string, folderId: string, archiveDate: string, start: string, end: string, dataset: "attendance" | "class_bookings") {
  const runDb = db as any;
  let data: CsvRow[];
  if (dataset === "attendance") {
    const checkins = await rows((from, to) => runDb.from("attendance").select("id, member_id, schedule_id, checked_in_at, source, recorded_by, external_event_id, created_at").gte("checked_in_at", start).lt("checked_in_at", end).order("checked_in_at").range(from, to));
    const memberIds = [...new Set(checkins.map((item: any) => item.member_id))];
    const scheduleIds = [...new Set(checkins.map((item: any) => item.schedule_id).filter(Boolean))];
    const memberRows = await rowsForIds(memberIds, (ids, from, to) => runDb.from("members").select("id, member_code, profile_id").in("id", ids).range(from, to));
    const profileIds = [...new Set(memberRows.map((item: any) => item.profile_id))];
    const profiles = await rowsForIds(profileIds, (ids, from, to) => runDb.from("profiles").select("id, display_name, email").in("id", ids).range(from, to));
    const schedules = await rowsForIds(scheduleIds, (ids, from, to) => runDb.from("class_schedules").select("id, class_id, starts_at, ends_at").in("id", ids).range(from, to));
    const classIds = [...new Set(schedules.map((item: any) => item.class_id))];
    const classes = await rowsForIds(classIds, (ids, from, to) => runDb.from("classes").select("id, name").in("id", ids).range(from, to));
    const membersById = new Map(memberRows.map((item: any) => [item.id, item]));
    const profileById = new Map(profiles.map((item: any) => [item.id, item]));
    const scheduleById = new Map(schedules.map((item: any) => [item.id, item]));
    const classById = new Map(classes.map((item: any) => [item.id, item]));
    data = checkins.map((item: any) => {
      const member: any = membersById.get(item.member_id);
      const profile: any = member ? profileById.get(member.profile_id) : null;
      const schedule: any = item.schedule_id ? scheduleById.get(item.schedule_id) : null;
      const gymClass: any = schedule ? classById.get(schedule.class_id) : null;
      return { ...item, member_code: member?.member_code, member_name: profile?.display_name, member_email: profile?.email, class_name: gymClass?.name, class_starts_at: schedule?.starts_at, class_ends_at: schedule?.ends_at };
    });
  } else {
    const bookings = await rows((from, to) => runDb.from("class_bookings").select("id, member_id, schedule_id, status, booked_at, cancelled_at").gte("booked_at", start).lt("booked_at", end).order("booked_at").range(from, to));
    const memberIds = [...new Set(bookings.map((item: any) => item.member_id))];
    const scheduleIds = [...new Set(bookings.map((item: any) => item.schedule_id))];
    const memberRows = await rowsForIds(memberIds, (ids, from, to) => runDb.from("members").select("id, member_code, profile_id").in("id", ids).range(from, to));
    const profileIds = [...new Set(memberRows.map((item: any) => item.profile_id))];
    const profiles = await rowsForIds(profileIds, (ids, from, to) => runDb.from("profiles").select("id, display_name, email").in("id", ids).range(from, to));
    const schedules = await rowsForIds(scheduleIds, (ids, from, to) => runDb.from("class_schedules").select("id, class_id, starts_at, ends_at, trainer_id, capacity, status").in("id", ids).range(from, to));
    const classIds = [...new Set(schedules.map((item: any) => item.class_id))];
    const classes = await rowsForIds(classIds, (ids, from, to) => runDb.from("classes").select("id, name").in("id", ids).range(from, to));
    const membersById = new Map(memberRows.map((item: any) => [item.id, item]));
    const profileById = new Map(profiles.map((item: any) => [item.id, item]));
    const scheduleById = new Map(schedules.map((item: any) => [item.id, item]));
    const classById = new Map(classes.map((item: any) => [item.id, item]));
    data = bookings.map((item: any) => {
      const member: any = membersById.get(item.member_id);
      const profile: any = member ? profileById.get(member.profile_id) : null;
      const schedule: any = scheduleById.get(item.schedule_id);
      const gymClass: any = schedule ? classById.get(schedule.class_id) : null;
      return { ...item, member_code: member?.member_code, member_name: profile?.display_name, member_email: profile?.email, class_name: gymClass?.name, class_starts_at: schedule?.starts_at, class_ends_at: schedule?.ends_at, class_capacity: schedule?.capacity, class_status: schedule?.status };
    });
  }

  const fileName = `${dataset}-${archiveDate}.csv`;
  const attendanceHeaders = ["id", "member_id", "schedule_id", "checked_in_at", "source", "recorded_by", "external_event_id", "created_at", "member_code", "member_name", "member_email", "class_name", "class_starts_at", "class_ends_at"];
  const bookingHeaders = ["id", "member_id", "schedule_id", "status", "booked_at", "cancelled_at", "member_code", "member_name", "member_email", "class_name", "class_starts_at", "class_ends_at", "class_capacity", "class_status"];
  const uploaded = await uploadCsv(accessToken, folderId, fileName, csv(data, dataset === "attendance" ? attendanceHeaders : bookingHeaders));
  const { error: insertError } = await runDb.from("gym_data_archive_runs").upsert({ archive_date: archiveDate, dataset, drive_file_id: uploaded.id, drive_file_name: uploaded.name, row_count: data.length, exported_at: new Date().toISOString() }, { onConflict: "archive_date,dataset" });
  if (insertError) throw new Error(`Uploaded ${fileName} but could not record the archive run: ${insertError.message}`);
  return { dataset, rows: data.length, fileName, url: uploaded.url, skipped: false };
}

export async function runDailyGymDataArchive(db: SupabaseClient, dateToArchive?: string) {
  const runDb = db as any;
  const { data: gym, error: gymError } = await runDb.from("gym_settings").select("gym_name, timezone").order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (gymError) throw new Error(`Could not read gym timezone: ${gymError.message}`);
  const timeZone = gym?.timezone || "Asia/Kolkata";
  const currentLocalDate = localDate(new Date(), timeZone);
  const previousDay = new Date(`${currentLocalDate}T00:00:00.000Z`);
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  const archiveDate = dateToArchive || previousDay.toISOString().slice(0, 10);
  if (archiveDate >= currentLocalDate) throw new Error("Only a completed gym-local date can be archived.");
  const start = dayStartUtc(archiveDate, timeZone);
  const nextDay = new Date(`${archiveDate}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const end = dayStartUtc(nextDay.toISOString().slice(0, 10), timeZone);
  const { accessToken, row: oauthRow } = await getDriveArchiveAccessToken(db);
  if (!oauthRow.folder_id) throw new Error("Google Drive archive folder is missing. Disconnect and reconnect Google Drive in Admin Settings.");
  const results = [];
  for (const dataset of ["attendance", "class_bookings"] as const) {
    results.push(await exportDataset(db, accessToken, oauthRow.folder_id, archiveDate, start, end, dataset));
  }
  return { archiveDate, timeZone, results, gymName: gym?.gym_name || "GYM MANAGER" };
}
