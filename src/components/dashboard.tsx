import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Activity, Archive, Bell, CalendarDays, CheckCircle2, ChevronRight, CircleDollarSign, Clock3, CreditCard,
  Fingerprint, LayoutDashboard, Loader2, LogOut, Mail, Menu, Search, Settings, ShieldCheck,
  TrendingUp, UserRoundPlus, UserX, Users, WalletCards, X,
} from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/sign-out";
import { MembersAdmin, PaymentsAdmin, PlansAdmin } from "@/components/admin-modules";
import { InactiveMembers, NotificationsBell, useAdminRealtime } from "@/components/admin-live";
import { SettingsAdmin } from "@/components/settings-admin";
import { getExpiringMembers, getGymBranding, sendExpiringMemberReminder } from "@/lib/gym.functions";
import { useAdminDashboardData } from "@/components/admin-dashboard-data";
import { ClassesAdmin } from "@/components/classes-admin";
import { DataArchiveAdmin } from "@/components/data-archive-admin";
import { NfcAttendanceAdmin } from "@/components/nfc-attendance-admin";
import { formatGymDate, gymDateKey } from "@/lib/gym-time";
import { formatMoney } from "@/lib/currency";
import { useGymCurrency } from "@/lib/currency-context";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const nav = [
  ["Overview", LayoutDashboard], ["Members", Users], ["Inactive", UserX], ["Memberships", WalletCards],
  ["Classes", CalendarDays], ["Attendance", Fingerprint],
  ["Payments", CreditCard], ["Data archive", Archive], ["Reports", TrendingUp], ["Settings", Settings],
] as const;
export function Dashboard({ name = "Admin" }: { name?: string }) {
  const [active, setActive] = useState("Overview");
  const [expiringOpen, setExpiringOpen] = useState(false);
  const initials = name.split(" ").map((s) => s[0]).join("").slice(0, 2).toUpperCase();
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    if (window.location.hash === "#settings" || new URLSearchParams(window.location.search).has("gmailOAuth")) setActive("Settings");
  }, []);
  const currency = useGymCurrency();
  useAdminRealtime();
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const loadGymSettings = useServerFn(getGymBranding);
  const gymSettings = useQuery({ queryKey: ["gym-branding"], queryFn: () => loadGymSettings() });
  const gymName = gymSettings.data?.gym_name || "GYM MANAGER";
  const timeZone = gymSettings.data?.timezone ?? "Asia/Kolkata";
  const todayKey = gymDateKey(clock, timeZone);
  const live = useAdminDashboardData(timeZone, undefined, currency);
  const data = live.data;
  const monthLabel = new Intl.DateTimeFormat("en-IN", { timeZone, month: "long", year: "numeric" }).format(clock);
  const revenueChange = data && data.previousMonthRevenue > 0
    ? `${data.monthlyRevenue >= data.previousMonthRevenue ? "+" : "−"}${Math.abs((data.monthlyRevenue / data.previousMonthRevenue - 1) * 100).toFixed(1)}% vs last month`
    : "Verified collections this month";

  return <div className="min-h-screen bg-background text-foreground">
    <aside className={cn("fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-sidebar text-sidebar-foreground transition-transform lg:translate-x-0", mobileOpen ? "translate-x-0" : "-translate-x-full")}>
      <div className="flex h-20 items-center justify-between border-b border-sidebar-border px-5">
        <div className="flex min-w-0 items-center gap-3">{gymSettings.data?.logo_url ? <img src={gymSettings.data.logo_url} alt="" className="size-10 shrink-0 rounded-md bg-white object-contain"/> : <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary px-1 text-center text-[7px] font-extrabold leading-tight text-primary-foreground">GYM<br/>MANAGER</span>}<div className="min-w-0"><p className="truncate font-display text-lg font-bold uppercase">{gymName}</p><p className="truncate text-xs text-sidebar-muted">{gymSettings.data?.app_title || "GYM MANAGER"}</p></div></div>
        <Button aria-label="Close menu" variant="ghost" size="icon" className="lg:hidden" onClick={()=>setMobileOpen(false)}><X size={18}/></Button>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Main navigation">
        <p className="px-3 pb-2 pt-3 text-[11px] font-bold uppercase text-sidebar-muted">Operations</p>
        {nav.map(([label, Icon]) => <button key={label} onClick={()=>{setActive(label);setMobileOpen(false)}} className={cn("flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors", active===label ? "sidebar-active-glass text-primary" : "text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground")}><Icon size={18}/><span>{label}</span>{active===label && <ChevronRight className="ml-auto" size={15}/>}</button>)}
      </nav>
      <div className="border-t border-sidebar-border p-4"><div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-full bg-primary font-bold text-primary-foreground">{initials}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{name}</p><p className="text-xs text-sidebar-muted">Administrator</p></div><button aria-label="Sign out" onClick={signOut}><LogOut size={17} className="text-sidebar-muted hover:text-sidebar-foreground"/></button></div></div>
    </aside>

    <main className="lg:pl-64">
      <header className="sticky top-0 z-30 flex h-20 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur md:px-8">
        <Button aria-label="Open menu" variant="ghost" size="icon" className="lg:hidden" onClick={()=>setMobileOpen(true)}><Menu size={20}/></Button>
        
        <div className="ml-auto flex items-center gap-2"><span className="hidden rounded-full bg-success-soft px-3 py-1 text-xs font-semibold text-success md:inline">Gym open · 6:00–22:00</span><NotificationsBell/></div>
      </header>

      <div className="mx-auto max-w-[1500px] p-4 md:p-8">
        <section className="mb-7 flex flex-col justify-between gap-4 md:flex-row md:items-end"><div><p className="mb-2 text-xs font-bold uppercase text-primary">{formatGymDate(clock, timeZone)}</p><h1 className="font-display text-3xl font-bold uppercase md:text-4xl">{active}</h1><p className="mt-2 text-sm text-muted-foreground">Here’s what’s happening at {gymName} today.</p></div><div className="flex gap-2"><Button variant="outline" onClick={() => setActive("Classes")}><CalendarDays size={17}/> Schedule</Button><Button variant="secondary"><Activity size={17}/> Live floor</Button></div></section>

        {active === "Settings" ? <SettingsAdmin/> : active === "Data archive" ? <DataArchiveAdmin timeZone={timeZone}/> : active === "Attendance" ? <NfcAttendanceAdmin/> : active === "Classes" ? <ClassesAdmin timeZone={timeZone} todayKey={todayKey} currency={currency}/> : active === "Memberships" ? <PlansAdmin/> : active === "Members" ? <MembersAdmin/> : active === "Payments" ? <PaymentsAdmin/> : active === "Inactive" ? <InactiveMembers timeZone={timeZone}/> : active !== "Overview" ? <ModuleView title={active}/> : <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={CircleDollarSign} label={`Revenue · ${monthLabel}`} value={data ? formatMoney(data.monthlyRevenue, currency) : "—"} note={revenueChange} tone="positive"/>
            <Metric icon={Users} label="Active members" value={data ? String(data.activeMembers) : "—"} note="With a current membership" tone="neutral"/>
            <Metric icon={Fingerprint} label="Check-ins today" value={data ? String(data.todayCheckins) : "—"} note="Gym local day" tone="neutral"/>
            <Metric icon={Clock3} label="Expiring in 7 days" value={data ? String(data.expiringMembers) : "—"} note="Renewals due soon · view members" tone="warning" onClick={() => setExpiringOpen(true)}/>
          </section>
          {live.isError && <p role="alert" className="mt-3 text-sm text-destructive">Dashboard data could not be refreshed: {live.error instanceof Error ? live.error.message : "Please try again."}</p>}

          <section className="mt-5 grid gap-5 xl:grid-cols-[1.45fr_1fr]">
            <div className="panel p-5 md:p-6"><div className="mb-6 flex items-center justify-between"><div><h2 className="section-title">Revenue pulse</h2><p className="section-subtitle">Verified collections · last 7 days</p></div><span className="text-sm font-bold">{data ? formatMoney(data.weekRevenue, currency) : "—"}</span></div><div className="h-64"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data?.revenuePulse ?? []}><defs><linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.45}/><stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0}/></linearGradient></defs><CartesianGrid vertical={false} stroke="var(--border)"/><XAxis dataKey="day" axisLine={false} tickLine={false} tick={{fill:"var(--muted-foreground)",fontSize:12}}/><YAxis hide/><Tooltip contentStyle={{borderRadius:6,border:"1px solid var(--border)",background:"var(--card)"}} formatter={(v)=>[formatMoney(Number(v), currency),"Revenue"]}/><Area type="monotone" dataKey="amount" stroke="var(--chart-1)" strokeWidth={3} fill="url(#revenueFill)"/></AreaChart></ResponsiveContainer></div></div>
            <div className="panel overflow-hidden"><div className="flex items-start justify-between p-5 md:p-6"><div><h2 className="section-title">Today’s classes</h2><p className="section-subtitle">{data?.classBookings ?? 0} athletes booked</p></div><Button size="sm" variant="ghost" onClick={() => setActive("Classes")}>View all</Button></div><div className="divide-y divide-border">{(data?.todayClasses ?? []).map(c=><div key={c.id} className="flex items-center gap-4 px-5 py-3.5"><div className="w-12"><p className="text-sm font-bold">{c.time}</p><p className="text-[11px] text-muted-foreground">{c.duration} min</p></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{c.name}</p><p className="text-xs text-muted-foreground">{c.coach}</p></div><div className="text-right"><p className="text-sm font-bold">{c.booked}/{c.capacity}</p><div className="mt-1 h-1.5 w-14 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{width:`${c.capacity ? Math.min(100, c.booked/c.capacity*100) : 0}%`}}/></div></div></div>)}{!data?.todayClasses.length && <p className="px-5 pb-5 text-sm text-muted-foreground">No classes scheduled today.</p>}</div></div>
          </section>

          <section className="mt-5 grid gap-5">
                        <div className="panel overflow-hidden"><div className="flex items-center justify-between p-5 md:p-6"><div><h2 className="section-title">Member activity</h2><p className="section-subtitle">Latest recorded check-ins</p></div><Button size="sm" variant="outline">Export</Button></div><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="border-y border-border bg-muted text-xs uppercase text-muted-foreground"><tr><th className="px-5 py-3">Member</th><th className="px-4 py-3">Plan</th><th className="px-4 py-3">Status</th><th className="px-5 py-3">Last check-in</th></tr></thead><tbody className="divide-y divide-border">{(data?.memberActivity ?? []).map(m=><tr key={`${m.id}-${m.checkin}`} className="hover:bg-muted/60"><td className="px-5 py-3"><div className="flex items-center gap-3"><span className="grid size-8 place-items-center rounded-full bg-secondary text-xs font-bold">{m.initials}</span><b>{m.name}</b></div></td><td className="px-4 py-3 text-muted-foreground">{m.plan}</td><td className="px-4 py-3"><span className={cn("status",m.status==="Active"?"status-active":m.status==="Expiring"?"status-warning":"status-muted")}>{m.status}</span></td><td className="px-5 py-3 text-muted-foreground">{m.checkin}</td></tr>)}</tbody></table>{!data?.memberActivity.length && <p className="px-5 py-5 text-sm text-muted-foreground">No member check-ins recorded yet.</p>}</div></div>
          </section>
        </>}
      </div>
    </main>
    <ExpiringMembersDialog open={expiringOpen} onOpenChange={setExpiringOpen} timeZone={timeZone}/>
  </div>;
}

function Metric({icon:Icon,label,value,note,tone,onClick}:{icon:typeof Users;label:string;value:string;note:string;tone:"positive"|"warning"|"neutral";onClick?:()=>void}){
  const content = <><div className="flex items-start justify-between"><div><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 font-display text-3xl font-bold">{value}</p></div><span className="grid size-10 place-items-center rounded-md bg-secondary text-secondary-foreground"><Icon size={19}/></span></div><p className={cn("mt-4 text-xs font-medium",tone==="positive"?"text-success":tone==="warning"?"text-warning":"text-muted-foreground")}>{note}</p></>;
  return onClick
    ? <button type="button" onClick={onClick} aria-label={`${label}: ${value}. ${note}`} className="panel w-full cursor-pointer p-5 text-left transition hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{content}</button>
    : <article className="panel p-5">{content}</article>;
}

type ExpiringMember = {
  membershipId: string;
  memberId: string;
  memberCode: string;
  name: string;
  email: string | null;
  plan: string;
  endsOn: string;
  manualReminderStatus: string | null;
  manualReminderAt: string | null;
  latestReminderAt: string | null;
};

function ExpiringMembersDialog({open,onOpenChange,timeZone}:{open:boolean;onOpenChange:(open:boolean)=>void;timeZone:string}) {
  const queryClient = useQueryClient();
  const loadMembers = useServerFn(getExpiringMembers);
  const sendReminder = useServerFn(sendExpiringMemberReminder);
  const [sendingId,setSendingId] = useState("");
  const [error,setError] = useState("");
  const membersQuery = useQuery({
    queryKey: ["admin-expiring-members"],
    queryFn: () => loadMembers(),
    enabled: open,
    refetchInterval: open ? 60_000 : false,
  });

  async function send(member: ExpiringMember) {
    if (!member.email) { setError(`${member.name} has no email address on their profile.`); return; }
    setSendingId(member.membershipId); setError("");
    try {
      await sendReminder({ data: { membershipId: member.membershipId } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-expiring-members"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-live", "dashboard"] }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the reminder email.");
    } finally {
      setSendingId("");
    }
  }

  const rows = (membersQuery.data?.members ?? []) as ExpiringMember[];
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85vh] max-w-5xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Memberships expiring in 7 days</DialogTitle>
        <DialogDescription>Active members whose membership expires today or within the next seven days. Send an email reminder directly from this list.</DialogDescription>
      </DialogHeader>
      {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      {membersQuery.isLoading ? <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="animate-spin" size={18}/>Loading expiring memberships…</div>
        : membersQuery.isError ? <div role="alert" className="py-8 text-sm text-destructive">Could not load expiring members: {membersQuery.error instanceof Error ? membersQuery.error.message : "Please try again."}</div>
        : rows.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">No active memberships expire within the next seven days.</p>
        : <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-border bg-muted text-xs uppercase text-muted-foreground"><tr><th className="px-4 py-3">Member</th><th className="px-4 py-3">Plan</th><th className="px-4 py-3">Expires</th><th className="px-4 py-3">Reminder</th><th className="px-4 py-3 text-right">Action</th></tr></thead>
            <tbody className="divide-y divide-border">{rows.map((member) => {
              const daysLeft = Math.round((Date.parse(`${member.endsOn}T00:00:00.000Z`) - Date.parse(`${membersQuery.data?.today ?? ""}T00:00:00.000Z`)) / 86_400_000);
              const alreadySent = member.manualReminderStatus === "sent";
              const busy = sendingId === member.membershipId || member.manualReminderStatus === "sending";
              return <tr key={member.membershipId}>
                <td className="px-4 py-3"><p className="font-semibold">{member.name}</p><p className="text-xs text-muted-foreground">{member.memberCode} · {member.email || "No email address"}</p></td>
                <td className="px-4 py-3 text-muted-foreground">{member.plan}</td>
                <td className="px-4 py-3"><p>{new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(new Date(`${member.endsOn}T12:00:00.000Z`))}</p><p className="text-xs text-muted-foreground">{daysLeft === 0 ? "Expires today" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}</p></td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{alreadySent ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 size={14}/>Manual email sent</span> : member.latestReminderAt ? `Automated reminder sent ${new Date(member.latestReminderAt).toLocaleDateString("en-IN", { timeZone })}` : member.manualReminderStatus === "failed" ? "Previous attempt failed" : "No reminder sent"}</td>
                <td className="px-4 py-3 text-right"><Button size="sm" variant={alreadySent ? "secondary" : "default"} disabled={busy || alreadySent || !member.email} onClick={() => void send(member)}>{busy ? <Loader2 className="animate-spin" size={15}/> : alreadySent ? <CheckCircle2 size={15}/> : <Mail size={15}/>} {busy ? "Sending…" : alreadySent ? "Sent" : member.manualReminderStatus === "failed" ? "Retry email" : "Send reminder"}</Button></td>
              </tr>;
            })}</tbody>
          </table>
        </div>}
    </DialogContent>
  </Dialog>;
}

function ModuleView({title}:{title:string}){return <section className="panel min-h-[560px] p-6"><div className="flex flex-col justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-center"><div><h2 className="section-title">{title} workspace</h2><p className="section-subtitle">Search, filter, and manage {title.toLowerCase()} from one place.</p></div><Button><UserRoundPlus size={17}/>New record</Button></div><div className="grid place-items-center py-28 text-center"><span className="grid size-16 place-items-center rounded-md bg-secondary text-primary"><ShieldCheck size={28}/></span><h3 className="mt-5 text-lg font-bold">Secure module ready</h3><p className="mt-2 max-w-md text-sm text-muted-foreground">This area is connected to role-based access rules and is ready for your live gym records.</p></div></section>}
