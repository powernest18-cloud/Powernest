import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bell, CheckCircle2, CreditCard, Loader2, Mail, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { deleteMemberProfile, getExpiredMembers, sendExpiringMemberReminder } from "@/lib/gym.functions";
import { formatMoney } from "@/lib/currency";
import { useGymCurrency } from "@/lib/currency-context";

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Subscribes once to database changes and refreshes admin queries. */
export function useAdminRealtime() {
  const qc = useQueryClient();
  useEffect(() => {
    const ch = supabase.channel("admin-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, () => qc.invalidateQueries({ queryKey: ["admin-live"] }))
      .on("postgres_changes", { event: "*", schema: "public", table: "members" }, () => qc.invalidateQueries({ queryKey: ["admin-live"] }))
      .on("postgres_changes", { event: "*", schema: "public", table: "memberships" }, () => qc.invalidateQueries({ queryKey: ["admin-live"] }))
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, () => qc.invalidateQueries({ queryKey: ["admin-live"] }))
      .on("postgres_changes", { event: "*", schema: "public", table: "class_schedules" }, () => qc.invalidateQueries({ queryKey: ["admin-live"] }))
      .on("postgres_changes", { event: "*", schema: "public", table: "class_bookings" }, () => qc.invalidateQueries({ queryKey: ["admin-live"] }))
      .on("postgres_changes", { event: "*", schema: "public", table: "classes" }, () => {
        qc.invalidateQueries({ queryKey: ["admin-live"] });
        qc.invalidateQueries({ queryKey: ["admin-classes"] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);
}

export function useLiveStats() {
  return useQuery({
    queryKey: ["admin-live", "stats"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const today = new Date(); const start = new Date(); start.setHours(0, 0, 0, 0);
      const week = new Date(); week.setDate(week.getDate() + 7);
      const [active, checkins, expiring] = await Promise.all([
        supabase.from("memberships").select("member_id", { count: "exact", head: true }).eq("status", "active").gte("ends_on", iso(today)),
        supabase.from("attendance").select("id", { count: "exact", head: true }).gte("checked_in_at", start.toISOString()),
        supabase.from("memberships").select("id", { count: "exact", head: true }).eq("status", "active").gte("ends_on", iso(today)).lte("ends_on", iso(week)),
      ]);
      return { active: active.count ?? 0, checkins: checkins.count ?? 0, expiring: expiring.count ?? 0 };
    },
  });
}

type Note = { id: string; kind: "payment" | "member"; text: string; at: string };

export function NotificationsBell() {
  const currency = useGymCurrency();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => (typeof window === "undefined" ? "" : localStorage.getItem("admin-notes-seen") ?? ""));
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ["admin-live", "notes", currency],
    queryFn: async (): Promise<Note[]> => {
      const [pays, mems] = await Promise.all([
        supabase.from("payments").select("id, amount, currency, status, updated_at, members(profiles(display_name))").order("updated_at", { ascending: false }).limit(10),
        supabase.from("members").select("id, created_at, profiles(display_name)").order("created_at", { ascending: false }).limit(10),
      ]);
      const notes: Note[] = [
        ...(pays.data ?? []).map((p) => ({ id: "p" + p.id, kind: "payment" as const, at: p.updated_at, text: `${p.members?.profiles?.display_name || "Member"} · payment ${formatMoney(p.amount, p.currency || currency)} ${p.status}` })),
        ...(mems.data ?? []).map((m) => ({ id: "m" + m.id, kind: "member" as const, at: m.created_at, text: `${m.profiles?.display_name || "New member"} registered` })),
      ];
      return notes.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15);
    },
  });
  const unread = (q.data ?? []).filter((n) => !seen || n.at > seen).length;
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);
  function toggle() {
    setOpen(!open);
    if (!open && q.data?.[0]) { localStorage.setItem("admin-notes-seen", q.data[0].at); setSeen(q.data[0].at); }
  }
  return <div ref={ref} className="relative">
    <Button aria-label="Notifications" variant="outline" size="icon" className="relative" onClick={toggle}><Bell size={18}/>{unread > 0 && <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">{unread}</span>}</Button>
    {open && <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-md border border-border bg-card shadow-lg">
      <p className="border-b border-border px-4 py-3 text-sm font-bold">Recent activity</p>
      <div className="max-h-96 divide-y divide-border overflow-y-auto">
        {(q.data ?? []).length === 0 && <p className="p-4 text-sm text-muted-foreground">No activity yet.</p>}
        {q.data?.map((n) => <div key={n.id} className="flex gap-3 px-4 py-3 text-sm">{n.kind === "payment" ? <CreditCard size={16} className="mt-0.5 shrink-0 text-primary"/> : <UserPlus size={16} className="mt-0.5 shrink-0 text-primary"/>}<div><p>{n.text}</p><p className="text-xs text-muted-foreground">{new Date(n.at).toLocaleString("en-IN")}</p></div></div>)}
      </div>
    </div>}
  </div>;
}

export function InactiveMembers({ timeZone }: { timeZone: string }) {
  const qc = useQueryClient();
  const del = useServerFn(deleteMemberProfile);
  const loadExpired = useServerFn(getExpiredMembers);
  const sendReminder = useServerFn(sendExpiringMemberReminder);
  const [busy, setBusy] = useState(""); const [err, setErr] = useState("");
  const q = useQuery({
    queryKey: ["admin-live", "inactive", timeZone],
    queryFn: () => loadExpired(),
    refetchInterval: 60_000,
  });
  async function remove(id: string, name: string) {
    if (!confirm(`Permanently delete ${name}'s profile, payments and history? This cannot be undone.`)) return;
    setBusy(id); setErr("");
    try { await del({ data: { memberId: id } }); qc.invalidateQueries({ queryKey: ["admin-live"] }); }
    catch (e) { setErr(e instanceof Error ? e.message : "Delete failed"); }
    setBusy("");
  }
  async function remind(membershipId: string, email: string | null, name: string) {
    if (!email) { setErr(`${name} has no email address on their profile.`); return; }
    setBusy(membershipId); setErr("");
    try {
      await sendReminder({ data: { membershipId, reminderType: "expired" } });
      await qc.invalidateQueries({ queryKey: ["admin-live", "inactive"] });
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not send the expired membership email."); }
    finally { setBusy(""); }
  }
  return <section className="panel overflow-hidden">
    <div className="p-5"><h2 className="section-title">Expired memberships</h2><p className="section-subtitle">Members whose latest membership has expired and who do not have a current or upcoming membership.</p>{err && <p role="alert" className="mt-2 text-sm text-destructive">{err}</p>}</div>
    <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="border-y border-border bg-muted text-xs uppercase text-muted-foreground"><tr><th className="px-5 py-3">Member</th><th className="px-4 py-3">Contact</th><th className="px-4 py-3">Membership ended</th><th className="px-4 py-3">Reminder</th><th className="px-5 py-3"/></tr></thead>
      <tbody className="divide-y divide-border">
        {q.isLoading && <tr><td colSpan={5} className="p-5"><Loader2 className="animate-spin" size={18}/></td></tr>}
        {q.isError && <tr><td colSpan={5} className="p-5 text-destructive">Could not load expired memberships: {q.error instanceof Error ? q.error.message : "Please try again."}</td></tr>}
        {q.data?.members.length === 0 && <tr><td colSpan={5} className="p-5 text-muted-foreground">No expired memberships.</td></tr>}
        {q.data?.members.map((m) => { const name = m.name; const reminderSent = m.manualReminder?.delivery_status === "sent"; const reminderBusy = busy === m.membershipId; return <tr key={m.id}>
          <td className="px-5 py-3"><b>{name}</b><p className="text-xs text-muted-foreground">{m.memberCode}</p></td>
          <td className="px-4 py-3 text-muted-foreground">{m.email || "No email address"}<br/>{m.phone}</td>
          <td className="px-4 py-3">{m.endsOn}</td>
          <td className="px-4 py-3 text-xs text-muted-foreground">{reminderSent ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 size={14}/>Sent {m.manualReminder?.sent_at ? new Date(m.manualReminder.sent_at).toLocaleDateString("en-IN", { timeZone }) : ""}</span> : m.manualReminder?.delivery_status === "failed" ? "Previous attempt failed" : "Not sent"}</td>
          <td className="px-5 py-3 text-right"><div className="flex justify-end gap-2"><Button size="sm" disabled={reminderBusy || reminderSent || !m.email} onClick={() => void remind(m.membershipId, m.email, name)}>{reminderBusy ? <Loader2 className="animate-spin" size={15}/> : reminderSent ? <CheckCircle2 size={15}/> : <Mail size={15}/>} {reminderBusy ? "Sending…" : reminderSent ? "Sent" : m.manualReminder?.delivery_status === "failed" ? "Retry reminder" : "Send reminder"}</Button><Button size="sm" variant="destructive" disabled={busy === m.id} onClick={() => void remove(m.id, name)}>{busy === m.id ? <Loader2 className="animate-spin" size={15}/> : <Trash2 size={15}/>} Delete Profile</Button></div></td>
        </tr>; })}
      </tbody></table></div>
  </section>;
}
