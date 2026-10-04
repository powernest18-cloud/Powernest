import { useEffect, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bell, CalendarClock, CalendarDays, CheckCircle2, Clock3, Loader2, LogOut, Receipt, RefreshCw, Tag, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { createRazorpayOrder, createStripeCheckout, enrollMemberInClass, getGymBranding, getMemberClassSchedule, quotePlan, verifyRazorpayPayment, verifyStripeCheckout } from "@/lib/gym.functions";
import { signOut } from "@/lib/sign-out";
import { formatMoney } from "@/lib/currency";
import { useGymCurrency } from "@/lib/currency-context";
import { cn } from "@/lib/utils";

declare global { interface Window { Razorpay?: new (o: Record<string, unknown>) => { open: () => void } } }

function loadRazorpay() {
  return new Promise<void>((res, rej) => {
    if (window.Razorpay) return res();
    const s = document.createElement("script"); s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => res(); s.onerror = () => rej(new Error("Could not load payment window")); document.body.appendChild(s);
  });
}

export function MemberDashboard({ profile }: { profile: Tables<"profiles"> }) {
  const currency = useGymCurrency();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["member-home", profile.id],
    queryFn: async () => {
      const { data: member } = await supabase.from("members").select("id, member_code, status").eq("profile_id", profile.id).single();
      const [plans, memberships, payments, notes] = await Promise.all([
        supabase.from("membership_plans").select("*").eq("active", true).order("price_amount"),
        member ? supabase.from("memberships").select("*, membership_plans(name)").eq("member_id", member.id).order("ends_on", { ascending: false }) : Promise.resolve({ data: [] }),
        member ? supabase.from("payments").select("*").eq("member_id", member.id).eq("status", "verified").order("paid_at", { ascending: false }) : Promise.resolve({ data: [] }),
        supabase.from("notifications").select("*").eq("user_id", profile.id).order("created_at", { ascending: false }).limit(5),
      ]);
      return { member, plans: plans.data ?? [], memberships: memberships.data ?? [], payments: payments.data ?? [], notes: notes.data ?? [] };
    },
  });
  const loadGymSettings = useServerFn(getGymBranding);
  const verifyStripe = useServerFn(verifyStripeCheckout);
  const [stripeMessage, setStripeMessage] = useState("");
  const router = useRouter();
  const gymSettings = useQuery({ queryKey: ["gym-branding"], queryFn: () => loadGymSettings() });
  const gymName = gymSettings.data?.gym_name || "GYM MANAGER";
  const current = data?.memberships.find((m) => m.status === "active") ?? data?.memberships[0];
  const daysLeft = current ? Math.ceil((new Date(current.ends_on).getTime() - Date.now()) / 86400000) : null;
  const expiringSoon = daysLeft !== null && daysLeft <= 7;

  useEffect(() => {
    const url = new URL(window.location.href);
    const sessionId = url.searchParams.get("session_id");
    const cancelled = url.searchParams.has("checkout_cancelled");
    if (cancelled) {
      setStripeMessage("Checkout was cancelled. No payment was taken.");
      url.searchParams.delete("checkout_cancelled");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      return;
    }
    if (!sessionId) return;
    setStripeMessage("Confirming your payment…");
    void verifyStripe({ data: { sessionId } }).then(() => {
      setStripeMessage("Payment confirmed. Your membership is active.");
      void qc.invalidateQueries({ queryKey: ["member-home"] });
      void router.invalidate();
    }).catch((error: unknown) => {
      setStripeMessage(error instanceof Error ? error.message : "Could not confirm the Stripe payment.");
    }).finally(() => {
      url.searchParams.delete("session_id");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    });
  }, [qc, router, verifyStripe]);

  return <div className="min-h-screen bg-background">
    <header className="border-b border-border bg-sidebar text-sidebar-foreground"><div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
      {gymSettings.data?.logo_url ? <img src={gymSettings.data.logo_url} alt="" className="size-9 rounded-md bg-white object-contain"/> : <span className="grid size-9 place-items-center rounded-md bg-primary px-1 text-center text-[7px] font-extrabold leading-tight text-primary-foreground">GYM<br/>MANAGER</span>}<span className="font-display text-lg font-bold uppercase">{gymName}</span>
      <span className="ml-auto hidden text-sm sm:inline">{profile.display_name}</span>
      <Button variant="ghost" size="sm" onClick={signOut}><LogOut size={16}/> Sign out</Button>
    </div></header>
    <main className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <div><p className="text-xs font-bold uppercase text-primary">Member portal · {data?.member?.member_code}</p><h1 className="font-display text-4xl font-bold uppercase">Hey {profile.display_name.split(" ")[0]}</h1></div>

      {expiringSoon && current && <div className="flex flex-col gap-3 rounded-md border border-warning bg-warning-soft p-4 sm:flex-row sm:items-center"><CalendarClock className="text-warning"/><p className="flex-1 text-sm"><b>Your membership {daysLeft! < 0 ? "has expired" : `expires in ${daysLeft} day${daysLeft===1?"":"s"}`}.</b> Renew now — your details are already saved.</p><Button size="sm" onClick={()=>document.getElementById("plans")?.scrollIntoView({behavior:"smooth"})}><RefreshCw size={15}/> Renew</Button></div>}

      <section className="grid gap-5 md:grid-cols-[1.2fr_1fr]">
        <div className="panel bg-feature p-6 text-feature-foreground">
          <p className="text-xs font-bold uppercase text-primary">Your membership</p>
          {current ? <><h2 className="mt-2 font-display text-3xl font-bold uppercase">{current.membership_plans?.name}</h2><p className="mt-1 text-sm text-feature-muted">{current.starts_on} → {current.ends_on}</p><p className="mt-5 font-display text-5xl font-bold">{Math.max(daysLeft ?? 0, 0)}<span className="ml-2 text-base font-normal text-feature-muted">days left</span></p></>
          : <><h2 className="mt-2 font-display text-3xl font-bold uppercase">No active plan</h2><p className="mt-2 text-sm text-feature-muted">Choose a plan below to start training.</p></>}
        </div>
        <div className="panel p-5"><h2 className="section-title flex items-center gap-2"><Bell size={17}/> Updates</h2><div className="mt-3 space-y-3">{data?.notes.length ? data.notes.map(n=><div key={n.id} className="border-l-2 border-primary pl-3"><p className="text-sm font-semibold">{n.title}</p><p className="text-xs text-muted-foreground">{n.message}</p></div>) : <p className="text-sm text-muted-foreground">No updates yet.</p>}</div></div>
      </section>

      <MemberClassSchedule />

      <section id="plans"><h2 className="section-title">{current ? "Renew or change plan" : "Choose your plan"}</h2>
        {stripeMessage && <p role="status" className="mt-3 text-sm text-muted-foreground">{stripeMessage}</p>}
        <div className="mt-4 grid gap-4 md:grid-cols-3">{data?.plans.map(p=><PlanCard key={p.id} plan={p} gymName={gymName} currency={currency} paymentGateway={gymSettings.data?.payment_gateway ?? "razorpay"} onPaid={()=>qc.invalidateQueries({queryKey:["member-home"]})}/>)}</div>
      </section>

      <section className="panel overflow-hidden"><div className="p-5"><h2 className="section-title">Payment receipts</h2></div>
        {data?.payments.length ? <table className="w-full text-left text-sm"><thead className="border-y border-border bg-muted text-xs uppercase text-muted-foreground"><tr><th className="px-5 py-3">Receipt</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Amount</th><th className="px-5 py-3"/></tr></thead><tbody className="divide-y divide-border">{data.payments.map(p=><tr key={p.id}><td className="px-5 py-3 font-semibold">{p.receipt_number}</td><td className="px-4 py-3 text-muted-foreground">{p.paid_at?.slice(0,10)}</td><td className="px-4 py-3">{formatMoney(p.amount, p.currency)}</td><td className="px-5 py-3 text-right"><Button asChild size="sm" variant="outline"><Link to="/receipt/$paymentId" params={{paymentId:p.id}}><Receipt size={15}/> Download</Link></Button></td></tr>)}</tbody></table>
        : <p className="px-5 pb-5 text-sm text-muted-foreground">No payments yet.</p>}
      </section>
    </main>
  </div>;
}

function MemberClassSchedule() {
  const queryClient = useQueryClient();
  const loadSchedule = useServerFn(getMemberClassSchedule);
  const enroll = useServerFn(enrollMemberInClass);
  const schedule = useQuery({
    queryKey: ["member-class-schedule"],
    queryFn: () => loadSchedule(),
    refetchInterval: 30_000,
  });
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function book(scheduleId: string) {
    setBusyId(scheduleId); setError(""); setMessage("");
    try {
      const result = await enroll({ data: { scheduleId } });
      if (result.status === "booked" || result.status === "already_booked") setMessage("You’re enrolled in this class.");
      else setMessage(`This class is full. You’re on the waitlist${result.waitlistPosition ? ` at position ${result.waitlistPosition}` : ""}.`);
      await queryClient.invalidateQueries({ queryKey: ["member-class-schedule"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not enroll in this class.");
      await queryClient.invalidateQueries({ queryKey: ["member-class-schedule"] });
    } finally { setBusyId(""); }
  }

  const classes = schedule.data?.classes ?? [];
  return <section className="panel overflow-hidden">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-5 md:p-6">
      <div><h2 className="section-title flex items-center gap-2"><CalendarDays size={19}/> Upcoming classes</h2><p className="section-subtitle">Enroll in a scheduled session before it starts.</p></div>
      {schedule.isFetching && <Loader2 className="mt-1 animate-spin text-muted-foreground" size={17} aria-label="Refreshing classes"/>}
    </div>
    {error && <p role="alert" className="mx-5 mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="mx-5 mt-4 rounded-md bg-success-soft px-3 py-2 text-sm text-success">{message}</p>}
    {!schedule.data && schedule.isLoading ? <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="animate-spin" size={17}/>Loading upcoming classes…</div>
      : schedule.isError ? <p role="alert" className="p-5 text-sm text-destructive">{schedule.error instanceof Error ? schedule.error.message : "Could not load upcoming classes."}</p>
      : classes.length === 0 ? <p className="p-6 text-sm text-muted-foreground">There are no upcoming classes open for enrollment right now.</p>
      : <div className="grid gap-3 p-4 md:grid-cols-2">{classes.map((session) => {
        const alreadyBooked = Boolean(session.bookingStatus && session.bookingStatus !== "cancelled");
        const waitlisted = session.waitlistPosition != null;
        const full = session.booked >= session.capacity;
        const canEnroll = Boolean(schedule.data?.hasActiveMembership);
        const starts = new Date(session.startsAt);
        return <article key={session.id} className="rounded-md border border-border bg-card/60 p-4">
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate font-display text-lg font-bold uppercase">{session.className}</h3><p className="mt-1 text-xs text-muted-foreground">{session.category}{session.category && session.coach ? " · " : ""}{session.coach}</p></div>
            {alreadyBooked ? <span className="shrink-0 rounded-full bg-success-soft px-2.5 py-1 text-xs font-semibold text-success">Enrolled</span> : waitlisted ? <span className="shrink-0 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-semibold text-warning">Waitlist #{session.waitlistPosition}</span> : null}
          </div>
          {session.description && <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{session.description}</p>}
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><CalendarDays size={14}/>{new Intl.DateTimeFormat("en-IN", { timeZone: schedule.data?.timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(starts)}</span>
            <span className="inline-flex items-center gap-1.5"><Clock3 size={14}/>{new Intl.DateTimeFormat("en-IN", { timeZone: schedule.data?.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(starts)} · {session.durationMinutes} min</span>
            <span className="inline-flex items-center gap-1.5"><Users size={14}/>{session.booked}/{session.capacity} booked</span>
          </div>
          {!canEnroll && <p className="mt-3 text-xs text-warning">An active membership is required to enroll.</p>}
          <Button className="mt-4 w-full" variant={alreadyBooked ? "secondary" : "default"} disabled={!canEnroll || alreadyBooked || busyId !== ""} onClick={() => void book(session.id)}>
            {busyId === session.id ? <Loader2 className="animate-spin" size={15}/> : alreadyBooked ? <CheckCircle2 size={15}/> : <CalendarDays size={15}/>}
            {busyId === session.id ? "Enrolling…" : alreadyBooked ? "Enrolled" : waitlisted ? `Join waitlist · #${session.waitlistPosition}` : full ? "Join waitlist" : "Enroll in class"}
          </Button>
        </article>;
      })}</div>}
  </section>;
}

function PlanCard({ plan, gymName, currency, paymentGateway, onPaid }: { plan: Tables<"membership_plans">; gymName: string; currency: string; paymentGateway: string; onPaid: () => void }) {
  const router = useRouter();
  const quote = useServerFn(quotePlan); const order = useServerFn(createRazorpayOrder); const verify = useServerFn(verifyRazorpayPayment); const stripeCheckout = useServerFn(createStripeCheckout);
  const [coupon, setCoupon] = useState(""); const [q, setQ] = useState<Awaited<ReturnType<typeof quotePlan>> | null>(null);
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [done, setDone] = useState<string | null>(null);

  async function apply() { setBusy("q"); setErr(""); try { setQ(await quote({ data: { planId: plan.id, coupon } })); } catch (e) { setErr((e as Error).message); setQ(null); } setBusy(""); }
  async function pay() {
    setBusy("pay"); setErr("");
    try {
      if (paymentGateway === "stripe") {
        const session = await stripeCheckout({ data: q?.couponCode ? { planId: plan.id, coupon: q.couponCode } : { planId: plan.id } });
        window.location.assign(session.checkoutUrl);
        return;
      }
      const o = await order({ data: q?.couponCode ? { planId: plan.id, coupon: q.couponCode } : { planId: plan.id } });
      await loadRazorpay();
      new window.Razorpay!({
        key: o.keyId, order_id: o.orderId, amount: o.amount, currency: o.currency, name: gymName, description: plan.name,
        prefill: { name: o.name, email: o.email, contact: o.phone }, theme: { color: "#9be22d" },
        handler: async (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          try { const v = await verify({ data: { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature } }); setDone(v.paymentId); onPaid(); router.invalidate(); }
          catch (e) { setErr((e as Error).message); }
        },
        modal: { ondismiss: () => setBusy("") },
      }).open();
    } catch (e) { setErr((e as Error).message); }
    setBusy("");
  }

  return <article className="panel flex flex-col p-5">
    <h3 className="font-display text-2xl font-bold uppercase">{plan.name}</h3><p className="text-sm text-muted-foreground">{plan.duration_days} days</p>
    <p className="mt-3 font-display text-3xl font-bold">{formatMoney(plan.price_amount, currency)}</p>
    {Number(plan.joining_fee_amount) > 0 && <p className="text-xs text-muted-foreground">+ {formatMoney(plan.joining_fee_amount, currency)} joining fee for new members</p>}
    <ul className="mt-4 flex-1 space-y-1.5 text-sm">{plan.benefits.map(b=><li key={b} className="flex gap-2"><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success"/>{b}</li>)}</ul>
    <div className="mt-4 flex gap-2"><div className="relative flex-1"><Tag size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"/><input value={coupon} onChange={(e)=>setCoupon(e.target.value.toUpperCase())} placeholder="Coupon code" maxLength={40} className="form-input h-10 pl-8"/></div><Button variant="outline" size="sm" className="h-10" onClick={apply} disabled={busy!==""}>{busy==="q"?<Loader2 size={15} className="animate-spin"/>:"Apply"}</Button></div>
    {q && <div className="mt-3 space-y-1 rounded-md bg-muted p-3 text-sm"><p className="flex justify-between"><span>Plan</span><span>{formatMoney(q.base, currency)}</span></p>{q.joiningFee>0&&<p className="flex justify-between"><span>Joining fee</span><span>{formatMoney(q.joiningFee, currency)}</span></p>}{q.discount>0&&<p className="flex justify-between text-success"><span>Coupon {q.couponCode}</span><span>−{formatMoney(q.discount, currency)}</span></p>}<p className="flex justify-between border-t border-border pt-1 font-bold"><span>Total</span><span>{formatMoney(q.total, currency)}</span></p></div>}
    {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
    {done ? <Button asChild className="mt-4"><Link to="/receipt/$paymentId" params={{paymentId:done}}><Receipt size={16}/> Payment done — view receipt</Link></Button>
      : <Button className={cn("mt-4")} onClick={pay} disabled={busy!==""}>{busy==="pay"?<Loader2 size={16} className="animate-spin"/>:"Pay & activate"}</Button>}
  </article>;
}
