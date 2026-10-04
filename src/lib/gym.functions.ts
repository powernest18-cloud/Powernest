import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { fromMinorUnits, toMinorUnits } from "@/lib/currency";
import { gymDateKey, gymDateStartUtc, shiftDateKey } from "@/lib/gym-time";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

function gymShortCode(gymName?: string | null) {
  const normalizedName = gymName === "Forge Functional Fitness" ? "GYM MANAGER" : gymName;
  const words = normalizedName?.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  if (words.length === 0) return "GYM";
  if (words.length === 1) return words[0]!.slice(0, 3);
  return words.map((word) => word[0]).join("").slice(0, 6) || "GYM";
}

/* ---------------- Profile completion ---------------- */

const profileSchema = z.object({
  display_name: z.string().trim().min(2, "Enter your full name").max(100),
  phone: z.string().trim().max(30).optional().default(""),
  address: z.string().trim().min(5, "Enter your address").max(500),
  gender: z.enum(["male", "female", "other"]),
  has_illness: z.boolean(),
  medical_notes: z.string().trim().max(1000).optional().default(""),
});

export const completeProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: z.input<typeof profileSchema>) => profileSchema.parse(d))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { error } = await db.from("profiles").update({
      ...data,
      phone: data.phone || null,
      medical_notes: data.has_illness ? data.medical_notes || null : null,
      onboarding_completed: true,
    }).eq("id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/* ---------------- Pricing & coupons ---------------- */

type Quote = { planId: string; planName: string; base: number; joiningFee: number; discount: number; total: number; currency: string; couponId: string | null; couponCode: string | null };

async function buildQuote(db: Awaited<ReturnType<typeof admin>>, userId: string, planId: string, code?: string): Promise<Quote> {
  const { data: plan } = await db.from("membership_plans").select("*").eq("id", planId).eq("active", true).single();
  if (!plan) throw new Error("This plan is not available.");
  const { data: gym } = await db.from("gym_settings").select("currency").limit(1).maybeSingle();
  const currency = gym?.currency ?? "INR";
  if (!SUPPORTED_BILLING_CURRENCIES.includes(currency as typeof SUPPORTED_BILLING_CURRENCIES[number])) {
    throw new Error("The gym billing currency is not supported for checkout.");
  }
  const { data: member } = await db.from("members").select("id").eq("profile_id", userId).single();
  let joiningFee = fromMinorUnits(toMinorUnits(Number(plan.joining_fee_amount), currency), currency);
  if (member) {
    const { count } = await db.from("memberships").select("id", { count: "exact", head: true }).eq("member_id", member.id);
    if ((count ?? 0) > 0) joiningFee = 0; // renewals skip the joining fee
  }
  const base = fromMinorUnits(toMinorUnits(Number(plan.price_amount), currency), currency);
  let discount = 0; let couponId: string | null = null; let couponCode: string | null = null;
  if (code?.trim()) {
    const { data: c } = await db.from("coupons").select("*").ilike("code", code.trim()).eq("active", true).maybeSingle();
    const today = new Date().toISOString().slice(0, 10);
    if (!c) throw new Error("Coupon code not found.");
    if (c.plan_id && c.plan_id !== planId) throw new Error("This coupon doesn't apply to this plan.");
    if ((c.valid_from && today < c.valid_from) || (c.valid_until && today > c.valid_until)) throw new Error("This coupon has expired.");
    if (c.max_redemptions != null && c.redemptions_count >= c.max_redemptions) throw new Error("This coupon has been fully used.");
    const discountMinor = c.discount_type === "percent"
      ? Math.round((toMinorUnits(base, currency) * Number(c.discount_value)) / 100)
      : toMinorUnits(Number(c.discount_value), currency);
    discount = fromMinorUnits(Math.min(discountMinor, toMinorUnits(base, currency)), currency);
    couponId = c.id; couponCode = c.code;
  }
  const total = fromMinorUnits(toMinorUnits(base + joiningFee - discount, currency), currency);
  return { planId, planName: plan.name, base, joiningFee, discount, total, currency, couponId, couponCode };
}

const SUPPORTED_BILLING_CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "CAD", "AUD", "SGD", "NZD", "JPY"] as const;

export const quotePlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { planId: string; coupon?: string }) => z.object({ planId: z.string().uuid(), coupon: z.string().max(40).optional() }).parse(d))
  .handler(async ({ data, context }) => buildQuote(await admin(), context.userId, data.planId, data.coupon));

/* ---------------- Member: upcoming classes and enrollment ---------------- */

export const getMemberClassSchedule = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await admin();
    const [{ data: member, error: memberError }, { data: gym, error: gymError }] = await Promise.all([
      db.from("members").select("id, member_code, status").eq("profile_id", context.userId).maybeSingle(),
      db.from("gym_settings").select("timezone, booking_window_days").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (memberError) throw new Error(`Could not load your member record: ${memberError.message}`);
    if (gymError) throw new Error(`Could not load gym scheduling settings: ${gymError.message}`);
    if (!member || member.status !== "active") return { memberId: null, hasActiveMembership: false, timeZone: gym?.timezone || "Asia/Kolkata", classes: [] };

    const timeZone = gym?.timezone || "Asia/Kolkata";
    const today = gymDateKey(new Date(), timeZone);
    const now = new Date();
    const windowEnd = new Date(now.getTime() + Math.max(1, Number(gym?.booking_window_days || 14)) * 86_400_000);
    const [{ data: memberships, error: membershipError }, { data: schedules, error: scheduleError }] = await Promise.all([
      db.from("memberships").select("id, starts_on, ends_on").eq("member_id", member.id).eq("status", "active").lte("starts_on", today).gte("ends_on", today),
      db.from("class_schedules").select("id, class_id, trainer_id, starts_at, ends_at, capacity")
        .eq("status", "scheduled").gt("starts_at", now.toISOString()).lte("starts_at", windowEnd.toISOString()).order("starts_at").limit(100),
    ]);
    if (membershipError) throw new Error(`Could not check your membership: ${membershipError.message}`);
    if (scheduleError) throw new Error(`Could not load upcoming classes: ${scheduleError.message}`);
    const upcoming = schedules ?? [];
    const scheduleIds = upcoming.map((schedule) => schedule.id);
    const classIds = [...new Set(upcoming.map((schedule) => schedule.class_id))];
    const trainerIds = [...new Set(upcoming.flatMap((schedule) => schedule.trainer_id ? [schedule.trainer_id] : []))];
    const [{ data: classRows, error: classesError }, { data: trainerRows, error: trainersError }] = await Promise.all([
      classIds.length ? db.from("classes").select("id, name, category, description, duration_minutes, active").in("id", classIds) : Promise.resolve({ data: [], error: null }),
      trainerIds.length ? db.from("trainers").select("id, profile_id").in("id", trainerIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (classesError) throw new Error(`Could not load class details: ${classesError.message}`);
    if (trainersError) throw new Error(`Could not load trainer details: ${trainersError.message}`);
    const profileIds = [...new Set((trainerRows ?? []).map((trainer) => trainer.profile_id))];
    const { data: trainerProfiles, error: trainerProfilesError } = profileIds.length
      ? await db.from("profiles").select("id, display_name").in("id", profileIds)
      : { data: [], error: null };
    if (trainerProfilesError) throw new Error(`Could not load trainer names: ${trainerProfilesError.message}`);

    const activeClasses = (classRows ?? []).filter((gymClass) => gymClass.active);
    const activeClassIds = new Set(activeClasses.map((gymClass) => gymClass.id));
    const visibleSchedules = upcoming.filter((schedule) => activeClassIds.has(schedule.class_id));
    const visibleScheduleIds = visibleSchedules.map((schedule) => schedule.id);
    const [{ data: allBookings, error: bookingsError }, { data: myBookings, error: myBookingsError }, { data: myWaitlist, error: waitlistError }] = await Promise.all([
      visibleScheduleIds.length ? db.from("class_bookings").select("schedule_id").in("schedule_id", visibleScheduleIds).eq("status", "booked") : Promise.resolve({ data: [], error: null }),
      visibleScheduleIds.length ? db.from("class_bookings").select("schedule_id, status").eq("member_id", member.id).in("schedule_id", visibleScheduleIds) : Promise.resolve({ data: [], error: null }),
      visibleScheduleIds.length ? db.from("class_waitlists").select("schedule_id, position").eq("member_id", member.id).in("schedule_id", visibleScheduleIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (bookingsError) throw new Error(`Could not load class availability: ${bookingsError.message}`);
    if (myBookingsError) throw new Error(`Could not load your class bookings: ${myBookingsError.message}`);
    if (waitlistError) throw new Error(`Could not load your waitlist entries: ${waitlistError.message}`);

    const classById = new Map((activeClasses).map((gymClass) => [gymClass.id, gymClass]));
    const trainerById = new Map((trainerRows ?? []).map((trainer) => [trainer.id, trainer.profile_id]));
    const profileById = new Map((trainerProfiles ?? []).map((profile) => [profile.id, profile.display_name]));
    const bookedCount = new Map<string, number>();
    for (const booking of allBookings ?? []) bookedCount.set(booking.schedule_id, (bookedCount.get(booking.schedule_id) ?? 0) + 1);
    const bookingBySchedule = new Map((myBookings ?? []).map((booking) => [booking.schedule_id, booking.status]));
    const waitlistBySchedule = new Map((myWaitlist ?? []).map((entry) => [entry.schedule_id, entry.position]));
    return {
      memberId: member.id,
      hasActiveMembership: Boolean(memberships?.length),
      timeZone,
      classes: visibleSchedules.map((schedule) => {
        const gymClass = classById.get(schedule.class_id);
        const trainerProfile = schedule.trainer_id ? trainerById.get(schedule.trainer_id) : null;
        return {
          id: schedule.id,
          className: gymClass?.name || "Class",
          category: gymClass?.category || "",
          description: gymClass?.description || "",
          durationMinutes: gymClass?.duration_minutes || Math.max(1, Math.round((new Date(schedule.ends_at).getTime() - new Date(schedule.starts_at).getTime()) / 60_000)),
          coach: trainerProfile ? profileById.get(trainerProfile) || "Coach" : "Coach to be assigned",
          startsAt: schedule.starts_at,
          endsAt: schedule.ends_at,
          capacity: schedule.capacity,
          booked: bookedCount.get(schedule.id) ?? 0,
          bookingStatus: bookingBySchedule.get(schedule.id) || null,
          waitlistPosition: waitlistBySchedule.get(schedule.id) ?? null,
        };
      }),
    };
  });

export const enrollMemberInClass = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { scheduleId: string }) => z.object({ scheduleId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { data: member, error: memberError } = await db.from("members").select("id, status").eq("profile_id", context.userId).maybeSingle();
    if (memberError || !member || member.status !== "active") throw new Error("An active member profile is required to enroll in a class.");
    const { data: result, error } = await (db as any).rpc("enroll_member_in_class", {
      p_schedule_id: data.scheduleId,
      p_member_id: member.id,
      p_user_id: context.userId,
    });
    if (error) throw new Error(error.message || "Could not enroll in this class.");
    const enrollment = Array.isArray(result) ? result[0] : result;
    if (!enrollment?.outcome) throw new Error("The database returned an unexpected enrollment result.");
    return { status: enrollment.outcome as "booked" | "waitlisted" | "already_booked", waitlistPosition: enrollment.waitlist_position == null ? null : Number(enrollment.waitlist_position) };
  });

/* ---------------- Razorpay ---------------- */

export const createRazorpayOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { planId: string; coupon?: string }) => z.object({ planId: z.string().uuid(), coupon: z.string().max(40).optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { loadPaymentGatewayCredentials } = await import("@/lib/payment-gateway.server");
    const credentials = await loadPaymentGatewayCredentials(db);
    const keyId = credentials.razorpayKeyId; const secret = credentials.razorpayKeySecret;
    if (!keyId || !secret) throw new Error("Online payments are not switched on yet. Please pay at the front desk or try again later.");
    const { data: gym } = await db.from("gym_settings").select("gym_name, country_code, currency, payment_gateway").order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (gym?.payment_gateway !== "razorpay" || gym.country_code !== "IN" || gym.currency !== "INR") throw new Error("Razorpay checkout requires India and INR and must be selected in Gym Settings.");
    const { data: profile } = await db.from("profiles").select("onboarding_completed, display_name, email, phone").eq("id", context.userId).single();
    if (!profile?.onboarding_completed) throw new Error("Complete your profile first.");
    const { data: member } = await db.from("members").select("id").eq("profile_id", context.userId).single();
    if (!member) throw new Error("Member record not found.");
    const q = await buildQuote(db, context.userId, data.planId, data.coupon);
    const receipt = `${gymShortCode(gym.gym_name)}${Date.now()}`;
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${btoa(`${keyId}:${secret}`)}` },
      body: JSON.stringify({ amount: toMinorUnits(q.total, q.currency), currency: q.currency, receipt, notes: { plan: q.planName, member: member.id } }),
    });
    const order = (await res.json()) as { id?: string; error?: { description?: string } };
    if (!res.ok || !order.id) throw new Error(order.error?.description || "Could not start payment.");
    const { error } = await db.from("payments").insert({
      member_id: member.id, plan_id: q.planId, coupon_id: q.couponId, amount: q.total, base_amount: q.base + q.joiningFee,
      discount_amount: q.discount, currency: q.currency, method: "razorpay", status: "created", provider_order_id: order.id, receipt_number: receipt, created_by: context.userId,
    });
    if (error) throw new Error(error.message);
    return { keyId, orderId: order.id, amount: toMinorUnits(q.total, q.currency), currency: q.currency, name: profile.display_name, email: profile.email, phone: profile.phone ?? "" };
  });

export const verifyRazorpayPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { orderId: string; paymentId: string; signature: string }) =>
    z.object({ orderId: z.string().min(5).max(64), paymentId: z.string().min(5).max(64), signature: z.string().min(10).max(256) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { loadPaymentGatewayCredentials } = await import("@/lib/payment-gateway.server");
    const credentials = await loadPaymentGatewayCredentials(db);
    const secret = credentials.razorpayKeySecret;
    if (!secret) throw new Error("Payments not configured.");
    const { createHmac, timingSafeEqual } = await import("node:crypto");
    const expected = createHmac("sha256", secret).update(`${data.orderId}|${data.paymentId}`).digest("hex");
    const a = Buffer.from(expected); const b = Buffer.from(data.signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Payment could not be verified.");
    const { data: pay } = await db.from("payments").select("*").eq("provider_order_id", data.orderId).eq("method", "razorpay").single();
    const { data: member } = await db.from("members").select("id").eq("profile_id", context.userId).single();
    if (!pay || !member || pay.member_id !== member.id) throw new Error("Payment not found.");
    const keyId = credentials.razorpayKeyId;
    if (!keyId) throw new Error("Payments not configured.");
    const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(data.paymentId)}`, {
      headers: { authorization: `Basic ${btoa(`${keyId}:${secret}`)}` },
    });
    const gatewayPayment = await paymentResponse.json() as { id?: string; order_id?: string; amount?: number; currency?: string; status?: string };
    if (!paymentResponse.ok || gatewayPayment.id !== data.paymentId || gatewayPayment.order_id !== data.orderId || gatewayPayment.status !== "captured") {
      throw new Error("Razorpay has not confirmed a captured payment for this order.");
    }
    const { completeMembershipPayment } = await import("@/lib/payment.server");
    const completion = await completeMembershipPayment(pay.id, data.paymentId, gatewayPayment.currency ?? "", gatewayPayment.amount ?? 0);
    if (completion.completed && pay.coupon_id) {
      const { data: c } = await db.from("coupons").select("redemptions_count").eq("id", pay.coupon_id).single();
      if (c) await db.from("coupons").update({ redemptions_count: c.redemptions_count + 1 }).eq("id", pay.coupon_id);
    }
    return { paymentId: pay.id };
  });

export const createStripeCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { planId: string; coupon?: string }) => z.object({ planId: z.string().uuid(), coupon: z.string().max(40).optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { loadPaymentGatewayCredentials } = await import("@/lib/payment-gateway.server");
    const credentials = await loadPaymentGatewayCredentials(db);
    const secret = credentials.stripeSecretKey;
    const appUrl = process.env["APP_URL"] ?? process.env["URL"];
    if (!secret) throw new Error("Stripe is selected, but its Secret Key is not configured in Admin Settings.");
    if (!appUrl) throw new Error("Set APP_URL in the server environment before using Stripe checkout.");
    const { data: gym } = await db.from("gym_settings").select("gym_name, payment_gateway, currency").order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (gym?.payment_gateway !== "stripe") throw new Error("Stripe is not the active payment gateway. Update Gym Settings first.");
    if (!SUPPORTED_BILLING_CURRENCIES.includes(gym.currency as typeof SUPPORTED_BILLING_CURRENCIES[number])) throw new Error("The selected billing currency is not supported by this checkout.");
    const { data: profile } = await db.from("profiles").select("onboarding_completed, display_name, email").eq("id", context.userId).single();
    if (!profile?.onboarding_completed) throw new Error("Complete your profile first.");
    const { data: member } = await db.from("members").select("id").eq("profile_id", context.userId).single();
    if (!member) throw new Error("Member record not found.");
    const quote = await buildQuote(db, context.userId, data.planId, data.coupon);
    const receipt = `${gymShortCode(gym.gym_name)}${Date.now()}`;
    const { data: payment, error: paymentError } = await db.from("payments").insert({
      member_id: member.id, plan_id: quote.planId, coupon_id: quote.couponId,
      amount: quote.total, base_amount: quote.base + quote.joiningFee, discount_amount: quote.discount,
      currency: quote.currency, method: "stripe", status: "created", receipt_number: receipt, created_by: context.userId,
    }).select("id").single();
    if (paymentError || !payment) throw new Error(paymentError?.message ?? "Could not create payment record.");

    const origin = appUrl.replace(/\/$/, "");
    const parameters = new URLSearchParams({
      mode: "payment",
      success_url: `${origin}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/dashboard?checkout_cancelled=1`,
      client_reference_id: payment.id,
      "line_items[0][price_data][currency]": quote.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(toMinorUnits(quote.total, quote.currency)),
      "line_items[0][price_data][product_data][name]": quote.planName,
      "line_items[0][quantity]": "1",
      "metadata[payment_id]": payment.id,
      "metadata[member_id]": member.id,
      "metadata[plan_id]": quote.planId,
    });
    if (profile.email) parameters.set("customer_email", profile.email);
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: parameters.toString(),
    });
    const session = await response.json() as { id?: string; url?: string; error?: { message?: string } };
    if (!response.ok || !session.id || !session.url) {
      await db.from("payments").update({ status: "failed" }).eq("id", payment.id).eq("status", "created");
      throw new Error(session.error?.message ?? "Stripe could not create a checkout session.");
    }
    const { error: updateError } = await db.from("payments").update({ provider_order_id: session.id }).eq("id", payment.id);
    if (updateError) throw new Error("Stripe created checkout but the gym could not save its payment reference.");
    return { checkoutUrl: session.url };
  });

export const verifyStripeCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { sessionId: string }) => z.object({ sessionId: z.string().regex(/^cs_(test|live)_[A-Za-z0-9]+$/) }).parse(d))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { loadPaymentGatewayCredentials } = await import("@/lib/payment-gateway.server");
    const credentials = await loadPaymentGatewayCredentials(db);
    const secret = credentials.stripeSecretKey;
    if (!secret) throw new Error("Stripe payments are not configured in Admin Settings.");
    const { data: member } = await db.from("members").select("id").eq("profile_id", context.userId).single();
    if (!member) throw new Error("Member record not found.");
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(data.sessionId)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const session = await response.json() as { id?: string; payment_status?: string; currency?: string; amount_total?: number | null; payment_intent?: string | { id?: string } | null; metadata?: Record<string, string | undefined> | null; error?: { message?: string } };
    if (!response.ok) throw new Error(session.error?.message ?? "Could not verify this Stripe checkout.");
    if (session.metadata?.member_id !== member.id) throw new Error("This checkout does not belong to your member account.");
    const { completeStripeSession } = await import("@/lib/payment.server");
    return completeStripeSession(session);
  });

/* ---------------- Admin: delete inactive member profile ---------------- */

export const deleteMemberProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { memberId: string }) => z.object({ memberId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: roleRow } = await context.supabase.from("user_roles").select("role").eq("user_id", context.userId).eq("role", "admin").maybeSingle();
    if (!roleRow) throw new Error("Only administrators can delete profiles");
    const db = await admin();
    const { data: member, error: mErr } = await db.from("members").select("id, profile_id").eq("id", data.memberId).single();
    if (mErr || !member) throw new Error("Member not found");
    if (member.profile_id === context.userId) throw new Error("You cannot delete your own profile");
    const { data: pays } = await db.from("payments").select("id").eq("member_id", member.id);
    const payIds = (pays ?? []).map((p) => p.id);
    if (payIds.length) await db.from("payment_events").delete().in("payment_id", payIds);
    await db.from("payments").delete().eq("member_id", member.id);
    await db.from("attendance").delete().eq("member_id", member.id);
    await db.from("access_events").delete().eq("member_id", member.id);
    await db.from("members").delete().eq("id", member.id);
    await db.from("user_roles").delete().eq("user_id", member.profile_id);
    await db.from("notifications").delete().eq("user_id", member.profile_id);
    await db.from("profiles").delete().eq("id", member.profile_id);
    const { error } = await db.auth.admin.deleteUser(member.profile_id);
    if (error) throw new Error(error.message);
    return { deleted: true };
  });

/* ---------------- Admin: gym branding settings ---------------- */

const gymSettingsSchema = z.object({
  gym_name: z.string().trim().min(2, "Enter a gym name").max(100),
  app_title: z.string().trim().min(2, "Enter a web app title").max(100),
  color_theme: z.enum(["forge-green", "ocean-blue", "ember-orange", "violet", "rose"]),
  currency: z.enum(["INR", "USD", "EUR", "GBP", "AED", "CAD", "AUD", "SGD", "NZD", "JPY"]),
  country_code: z.enum(["IN", "US", "GB", "CA", "AU", "SG", "AE", "NZ", "JP", "DE", "FR", "IE"]),
  payment_gateway: z.enum(["razorpay", "stripe"]),
  logoDataUrl: z.string().max(2_800_000).optional(),
  clearLogo: z.boolean().optional().default(false),
}).superRefine((settings, context) => {
  if (settings.payment_gateway === "razorpay" && (settings.country_code !== "IN" || settings.currency !== "INR")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Razorpay requires gym country India and billing currency INR." });
  }
});

async function requireAdmin(context: { supabase: import("@supabase/supabase-js").SupabaseClient; userId: string }) {
  const { data: roleRow, error } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error || !roleRow) throw new Error("Only administrators can perform this action.");
}

const nfcCredentialSchema = z.object({
  memberId: z.string().uuid(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid NFC card token."),
  label: z.string().trim().max(80).optional().default("NFC card"),
});

const nfcTokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid NFC card token.") });

async function hashNfcToken(token: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `nfc-sha256:${hex}`;
}

export const registerNfcMemberCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.input<typeof nfcCredentialSchema>) => nfcCredentialSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await admin();
    const { data: member, error: memberError } = await db.from("members").select("id, status").eq("id", data.memberId).single();
    if (memberError || !member) throw new Error("Member not found.");
    if (member.status !== "active") throw new Error("Only active members can be issued an NFC check-in card.");
    const { data: credential, error } = await db.from("access_credentials").insert({
      member_id: member.id,
      credential_type: "nfc",
      external_reference: await hashNfcToken(data.token),
      label: data.label || "NFC card",
      active: true,
    }).select("id").single();
    if (error || !credential) throw new Error(error?.code === "23505" ? "This NFC card is already registered." : error?.message ?? "Could not register the NFC card.");
    return { credentialId: credential.id };
  });

export const revokeNfcMemberCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { credentialId: string }) => z.object({ credentialId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await admin();
    const { data: credential, error } = await db.from("access_credentials").update({ active: false, revoked_at: new Date().toISOString() })
      .eq("id", data.credentialId).eq("credential_type", "nfc").eq("active", true).select("id").maybeSingle();
    if (error || !credential) throw new Error(error?.message ?? "Active NFC card not found.");
    return { revoked: true };
  });

export const checkInWithNfcCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.input<typeof nfcTokenSchema>) => nfcTokenSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await admin();
    const occurredAt = new Date();
    const externalEventId = globalThis.crypto.randomUUID();
    const { data: credential } = await db.from("access_credentials").select("id, member_id")
      .eq("credential_type", "nfc").eq("external_reference", await hashNfcToken(data.token)).eq("active", true).maybeSingle();

    let decision: "granted" | "denied" = "denied";
    let reason: string | null = "Unknown or revoked NFC card.";
    let memberCode: string | null = null;
    let memberName: string | null = null;
    let attendanceRecorded = false;
    let alreadyCheckedIn = false;

    if (credential) {
      const [{ data: member }, { data: gym }] = await Promise.all([
        db.from("members").select("id, member_code, status, profiles(display_name)").eq("id", credential.member_id).maybeSingle(),
        db.from("gym_settings").select("timezone").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      memberCode = member?.member_code ?? null;
      memberName = member?.profiles?.display_name ?? null;
      const timeZone = gym?.timezone ?? "Asia/Kolkata";
      const today = gymDateKey(occurredAt, timeZone);
      if (!member || member.status !== "active") {
        reason = "Member is not active.";
      } else {
        const { data: memberships } = await db.from("memberships").select("id").eq("member_id", member.id)
          .eq("status", "active").lte("starts_on", today).gte("ends_on", today).limit(1);
        if (!memberships?.length) {
          reason = "Member has no active membership today.";
        } else {
          const dayStart = gymDateStartUtc(today, timeZone).toISOString();
          const tomorrowStart = gymDateStartUtc(shiftDateKey(today, 1), timeZone).toISOString();
          const { data: existing } = await db.from("attendance").select("id").eq("member_id", member.id)
            .gte("checked_in_at", dayStart).lt("checked_in_at", tomorrowStart).limit(1).maybeSingle();
          if (existing) {
            decision = "granted";
            reason = "Already checked in today.";
            alreadyCheckedIn = true;
          } else {
            const { error: attendanceError } = await db.from("attendance").insert({
              member_id: member.id,
              checked_in_at: occurredAt.toISOString(),
              source: "nfc",
              recorded_by: context.userId,
              external_event_id: externalEventId,
            });
            if (attendanceError) reason = `Attendance could not be recorded: ${attendanceError.message}`;
            else {
              decision = "granted";
              reason = "NFC check-in recorded.";
              attendanceRecorded = true;
            }
          }
        }
      }
    }

    const { error: eventError } = await db.from("access_events").insert({
      credential_id: credential?.id ?? null,
      member_id: credential?.member_id ?? null,
      external_event_id: externalEventId,
      decision,
      reason,
      occurred_at: occurredAt.toISOString(),
    });
    if (eventError) throw new Error(`Could not save access event: ${eventError.message}`);
    return { decision, reason, memberCode, memberName, attendanceRecorded, alreadyCheckedIn };
  });

const esslDeviceSchema = z.object({
  deviceId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  serialNumber: z.string().trim().min(1).max(100),
});

export const getEsslAttendanceSetup = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const db = await admin();
    const [{ data: devices, error: devicesError }, { data: mappings, error: mappingsError }, { data: webhook, error: webhookError }] = await Promise.all([
      db.from("access_devices").select("id, name, external_id, active, last_seen_at").eq("vendor", "eSSL").order("created_at", { ascending: false }),
      db.from("essl_member_mappings").select("id, device_id, member_id, device_user_id, active, created_at").order("created_at", { ascending: false }),
      db.from("essl_webhook_config").select("id").eq("id", 1).maybeSingle(),
    ]);
    if (devicesError) throw new Error(devicesError.message);
    if (mappingsError) throw new Error(mappingsError.message);
    if (webhookError) throw new Error(webhookError.message);

    const deviceById = new Map((devices ?? []).map((device) => [device.id, device]));
    const memberIds = [...new Set((mappings ?? []).map((mapping) => mapping.member_id))];
    const { data: members, error: membersError } = memberIds.length
      ? await db.from("members").select("id, member_code, profile_id").in("id", memberIds)
      : { data: [], error: null };
    if (membersError) throw new Error(membersError.message);
    const profileIds = [...new Set((members ?? []).map((member) => member.profile_id))];
    const { data: profiles, error: profilesError } = profileIds.length
      ? await db.from("profiles").select("id, display_name, email").in("id", profileIds)
      : { data: [], error: null };
    if (profilesError) throw new Error(profilesError.message);
    const memberById = new Map((members ?? []).map((member) => [member.id, member]));
    const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
    return {
      webhookConfigured: Boolean(webhook),
      webhookPath: "/.netlify/functions/essl-attendance",
      devices: (devices ?? []).map((device) => ({
        id: device.id,
        name: device.name,
        serialNumber: device.external_id ?? "",
        active: device.active,
        lastSeenAt: device.last_seen_at,
      })),
      mappings: (mappings ?? []).flatMap((mapping) => {
        const device = deviceById.get(mapping.device_id);
        const member = memberById.get(mapping.member_id);
        const profile = member ? profileById.get(member.profile_id) : null;
        if (!device || !member) return [];
        return [{
          id: mapping.id,
          deviceId: mapping.device_id,
          deviceName: device.name,
          serialNumber: device.external_id ?? "",
          memberId: mapping.member_id,
          memberCode: member.member_code,
          memberName: profile?.display_name || profile?.email || member.member_code,
          deviceUserId: mapping.device_user_id,
          active: mapping.active,
        }];
      }),
    };
  });

export const saveEsslDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.input<typeof esslDeviceSchema>) => esslDeviceSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await admin();
    const deviceValues = {
      name: data.name,
      vendor: "eSSL",
      device_type: "fingerprint",
      external_id: data.serialNumber,
      active: true,
    };
    if (data.deviceId) {
      const { data: existing, error: existingError } = await db.from("access_devices").select("id, vendor").eq("id", data.deviceId).maybeSingle();
      if (existingError) throw new Error(existingError.message);
      if (!existing || existing.vendor !== "eSSL") throw new Error("eSSL device not found.");
      const { error } = await db.from("access_devices").update(deviceValues).eq("id", data.deviceId);
      if (error) throw new Error(error.code === "23505" ? "That device serial number is already registered." : error.message);
      return { saved: true, deviceId: data.deviceId };
    }
    const { data: device, error } = await db.from("access_devices").insert(deviceValues).select("id").single();
    if (error || !device) throw new Error(error?.code === "23505" ? "That device serial number is already registered." : error?.message ?? "Could not save the eSSL device.");
    return { saved: true, deviceId: device.id };
  });

export const setEsslDeviceActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { deviceId: string; active: boolean }) => z.object({ deviceId: z.string().uuid(), active: z.boolean() }).parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await admin();
    const { data: device, error } = await db.from("access_devices").update({ active: data.active }).eq("id", data.deviceId).eq("vendor", "eSSL").select("id").maybeSingle();
    if (error || !device) throw new Error(error?.message ?? "eSSL device not found.");
    return { saved: true };
  });

export const saveEsslWebhookToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { token: string }) => z.object({ token: z.string().min(32).max(256) }).parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const { createHash } = await import("node:crypto");
    const tokenHash = createHash("sha256").update(data.token).digest("hex");
    const db = await admin();
    const { error } = await db.from("essl_webhook_config").upsert({ id: 1, token_hash: tokenHash, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) throw new Error(error.message);
    return { saved: true, webhookPath: "/.netlify/functions/essl-attendance" };
  });

const esslMemberMappingSchema = z.object({
  deviceId: z.string().uuid(),
  memberId: z.string().uuid(),
  deviceUserId: z.string().trim().min(1).max(100),
});

export const saveEsslMemberMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.input<typeof esslMemberMappingSchema>) => esslMemberMappingSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await admin();
    const [{ data: device, error: deviceError }, { data: member, error: memberError }] = await Promise.all([
      db.from("access_devices").select("id").eq("id", data.deviceId).eq("vendor", "eSSL").eq("active", true).maybeSingle(),
      db.from("members").select("id").eq("id", data.memberId).maybeSingle(),
    ]);
    if (deviceError) throw new Error(deviceError.message);
    if (memberError) throw new Error(memberError.message);
    if (!device) throw new Error("Select an active eSSL device.");
    if (!member) throw new Error("Member not found.");
    const { data: mapping, error } = await db.from("essl_member_mappings").upsert({
      device_id: data.deviceId,
      member_id: data.memberId,
      device_user_id: data.deviceUserId,
      active: true,
    }, { onConflict: "device_id,device_user_id" }).select("id").single();
    if (error || !mapping) throw new Error(error?.message ?? "Could not save the member mapping.");
    return { saved: true, mappingId: mapping.id };
  });

export const deleteEsslMemberMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { mappingId: string }) => z.object({ mappingId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await admin();
    const { error } = await db.from("essl_member_mappings").delete().eq("id", data.mappingId);
    if (error) throw new Error(error.message);
    return { deleted: true };
  });
const archivedGymDataSchema = z.object({
  dataset: z.enum(["payments", "attendance", "classes"]),
  before: z.string().datetime(),
  exportedAt: z.string().datetime(),
});

export const deleteArchivedGymData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.input<typeof archivedGymDataSchema>) => archivedGymDataSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await admin();
    const { data: result, error } = await db.rpc("delete_archived_gym_data", {
      p_dataset: data.dataset,
      p_before: data.before,
      p_exported_at: data.exportedAt,
    });
    if (error) throw new Error(`Could not delete archived data: ${error.message}`);
    if (!result || typeof result !== "object" || Array.isArray(result) || !("deleted" in result)) {
      throw new Error("The database returned an unexpected archive cleanup result.");
    }
    const deletedValue = (result as { deleted: unknown }).deleted;
    if (!deletedValue || typeof deletedValue !== "object" || Array.isArray(deletedValue)) {
      throw new Error("The database returned invalid archive cleanup counts.");
    }
    const deleted = Object.fromEntries(Object.entries(deletedValue).map(([key, value]) => [key, Number(value)]));
    return { deleted };
  });

/* ---------------- Admin: Gmail OAuth for renewal email ---------------- */

/* ---------------- Admin: Google Drive daily archives ---------------- */

const driveArchiveSetupSchema = z.object({
  clientId: z.string().trim().min(10).max(300),
  clientSecret: z.string().trim().max(500).optional().default(""),
});

export const getDriveArchiveSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const [{ supabaseAdmin }, { getRequest }, oauth] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@tanstack/react-start/server"),
      import("@/lib/drive-archive-oauth.server"),
    ]);
    const row = await oauth.readDriveArchiveOAuthRow(supabaseAdmin);
    const request = getRequest();
    const { data: runs, error } = await (supabaseAdmin as any).from("gym_data_archive_runs")
      .select("archive_date, dataset, drive_file_name, row_count, exported_at, drive_file_id")
      .order("exported_at", { ascending: false }).limit(10);
    if (error) throw new Error(`Could not load archive run history: ${error.message}`);
    return {
      clientId: row?.client_id || "",
      senderEmail: row?.sender_email || null,
      connectedAt: row?.connected_at || null,
      folderUrl: row?.folder_url || null,
      callbackUrl: request ? oauth.driveArchiveCallbackUrl(request.url) : "",
      configured: Boolean(row?.refresh_token_ciphertext && row.sender_email && row.folder_id),
      recentRuns: (runs || []).map((run: { archive_date: string; dataset: string; drive_file_name: string; row_count: number; exported_at: string; drive_file_id: string }) => ({
        ...run,
        url: `https://drive.google.com/file/d/${run.drive_file_id}/view`,
      })),
    };
  });

export const beginDriveArchiveOAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.input<typeof driveArchiveSetupSchema>) => driveArchiveSetupSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const request = (await import("@tanstack/react-start/server")).getRequest();
    if (!request) throw new Error("Could not read the current request. Reload Settings and try again.");
    const [{ supabaseAdmin }, oauth] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@/lib/drive-archive-oauth.server"),
    ]);
    const previous = await oauth.readDriveArchiveOAuthRow(supabaseAdmin);
    const clientId = data.clientId.trim();
    if (!clientId.endsWith(".apps.googleusercontent.com")) throw new Error("Enter a Google OAuth Web client ID ending in .apps.googleusercontent.com.");
    const submittedSecret = data.clientSecret.trim();
    if (previous && previous.client_id !== clientId && !submittedSecret) throw new Error("Enter the client secret that belongs to the new client ID.");
    const priorSecret = !submittedSecret && previous?.client_secret_ciphertext ? oauth.decryptDriveSecret(previous.client_secret_ciphertext) : "";
    const clientSecret = submittedSecret || priorSecret;
    if (!clientSecret) throw new Error("Enter your Google OAuth client secret.");
    const changed = Boolean(previous && (previous.client_id !== clientId || submittedSecret));
    const { error } = await (supabaseAdmin as any).from("gym_drive_archive_oauth").upsert({
      id: 1,
      client_id: clientId,
      client_secret_ciphertext: oauth.encryptDriveSecret(clientSecret),
      refresh_token_ciphertext: changed ? null : previous?.refresh_token_ciphertext ?? null,
      sender_email: changed ? null : previous?.sender_email ?? null,
      folder_id: changed ? null : previous?.folder_id ?? null,
      folder_url: changed ? null : previous?.folder_url ?? null,
      connected_at: changed ? null : previous?.connected_at ?? null,
      updated_by: context.userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
    if (error) throw new Error(`Could not save Google Drive OAuth settings: ${error.message}`);
    const redirectUri = oauth.driveArchiveCallbackUrl(request.url);
    const state = oauth.sealDriveOAuthState({ adminId: context.userId, issuedAt: Math.floor(Date.now() / 1000), nonce: oauth.createDriveOAuthNonce(), redirectUri });
    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code",
      scope: `openid email ${oauth.DRIVE_FILE_SCOPE}`, access_type: "offline",
      include_granted_scopes: "true", prompt: "consent", state,
    }).toString();
    return { authorizationUrl: authorizationUrl.toString() };
  });

export const disconnectDriveArchive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any).from("gym_drive_archive_oauth").delete().eq("id", 1);
    if (error) throw new Error(`Could not disconnect Google Drive: ${error.message}`);
    return { disconnected: true };
  });

export const runDriveArchiveNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const [{ supabaseAdmin }, archive] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@/lib/drive-archive.server"),
    ]);
    return archive.runDailyGymDataArchive(supabaseAdmin);
  });

const gmailOAuthSetupSchema = z.object({
  clientId: z.string().trim().min(10).max(300),
  clientSecret: z.string().trim().max(500).optional().default(""),
});

export const getGmailOAuthSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const [{ supabaseAdmin }, { getRequest }, oauth] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@tanstack/react-start/server"),
      import("@/lib/gmail-oauth.server"),
    ]);
    const row = await oauth.readGmailOAuthRow(supabaseAdmin);
    const request = getRequest();
    return {
      clientId: row?.client_id ?? "",
      senderEmail: row?.sender_email ?? null,
      connectedAt: row?.connected_at ?? null,
      callbackUrl: request ? oauth.gmailCallbackUrl(request.url) : "",
      configured: Boolean(row?.refresh_token_ciphertext && row.sender_email),
    };
  });

export const beginGmailOAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.input<typeof gmailOAuthSetupSchema>) => gmailOAuthSetupSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const request = (await import("@tanstack/react-start/server")).getRequest();
    if (!request) throw new Error("Could not read the current request. Reload Settings and try again.");
    const [{ supabaseAdmin }, oauth] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@/lib/gmail-oauth.server"),
    ]);
    const previous = await oauth.readGmailOAuthRow(supabaseAdmin);
    const clientId = data.clientId.trim();
    if (!clientId.endsWith(".apps.googleusercontent.com")) throw new Error("Enter the Google OAuth Web client ID ending in .apps.googleusercontent.com.");
    const submittedSecret = data.clientSecret.trim();
    if (previous && previous.client_id !== clientId && !submittedSecret) {
      throw new Error("Enter the client secret that belongs to the new client ID.");
    }
    const priorSecret = !submittedSecret && previous?.client_secret_ciphertext ? oauth.decryptGmailSecret(previous.client_secret_ciphertext) : "";
    const clientSecret = submittedSecret || priorSecret;
    if (!clientSecret) throw new Error("Enter your Google OAuth client secret.");
    const credentialsChanged = Boolean(previous && (previous.client_id !== clientId || submittedSecret));
    const { error } = await supabaseAdmin.from("gym_gmail_oauth").upsert({
      id: 1,
      client_id: clientId,
      client_secret_ciphertext: oauth.encryptGmailSecret(clientSecret),
      refresh_token_ciphertext: credentialsChanged ? null : previous?.refresh_token_ciphertext ?? null,
      sender_email: credentialsChanged ? null : previous?.sender_email ?? null,
      connected_at: credentialsChanged ? null : previous?.connected_at ?? null,
      updated_by: context.userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
    if (error) throw new Error(`Could not save Gmail OAuth settings: ${error.message}`);

    const redirectUri = oauth.gmailCallbackUrl(request.url);
    const state = oauth.sealOAuthState({ adminId: context.userId, issuedAt: Math.floor(Date.now() / 1000), nonce: oauth.createOAuthNonce(), redirectUri });
    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: `openid email ${oauth.GMAIL_SEND_SCOPE}`,
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      state,
    }).toString();
    return { authorizationUrl: authorizationUrl.toString() };
  });

export const disconnectGmailOAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: authHook } = await supabaseAdmin.from("gym_send_email_auth_hook").select("enabled").eq("id", 1).maybeSingle();
    if (authHook?.enabled) throw new Error("Disable the Send Email Auth Hook before disconnecting Gmail. Supabase Auth is currently using this Gmail account for member verification emails.");
    const { error } = await supabaseAdmin.from("gym_gmail_oauth").delete().eq("id", 1);
    if (error) throw new Error(`Could not disconnect Gmail: ${error.message}`);
    return { disconnected: true };
  });

/* ---------------- Admin: Supabase Send Email Auth Hook ---------------- */

const sendEmailHookSetupSchema = z.object({
  accessToken: z.string().trim().min(20).max(500),
  enabled: z.boolean(),
});

function supabaseProjectDetails() {
  const rawUrl = process.env["SUPABASE_URL"];
  if (!rawUrl) throw new Error("The server Supabase URL is not configured.");
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new Error("The server Supabase URL is invalid."); }
  const match = url.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i);
  if (url.protocol !== "https:" || !match) throw new Error("Automatic hook setup requires a hosted Supabase project URL ending in .supabase.co.");
  const projectRef = match[1]!;
  return {
    projectRef,
    projectUrl: `https://${projectRef}.supabase.co`,
    functionUrl: `https://${projectRef}.supabase.co/functions/v1/send-email`,
  };
}

async function managementApiRequest(path: string, accessToken: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`https://api.supabase.com/v1${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(12_000),
  });
  const bodyText = await response.text();
  let body: unknown = null;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = bodyText; }
  if (!response.ok) {
    const detail = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
      ? body.message
      : typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : "";
    if (response.status === 401 || response.status === 403) {
      throw new Error("Supabase rejected this access token. Use a project-scoped token with Auth Config read/write, Project Admin write, and Edge Function Secrets write permissions.");
    }
    throw new Error(detail.slice(0, 240) || `Supabase setup request failed (HTTP ${response.status}).`);
  }
  return body;
}

export const getSendEmailAuthHookSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.from("gym_send_email_auth_hook")
      .select("enabled, configured_at, updated_at")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw new Error(`Could not load email authentication settings: ${error.message}`);
    const project = supabaseProjectDetails();
    return {
      enabled: Boolean(data?.enabled),
      configuredAt: data?.configured_at ?? null,
      updatedAt: data?.updated_at ?? null,
      functionUrl: project.functionUrl,
    };
  });

export const configureSendEmailAuthHook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.input<typeof sendEmailHookSetupSchema>) => sendEmailHookSetupSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const [{ supabaseAdmin }, oauth] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@/lib/gmail-oauth.server"),
    ]);
    const project = supabaseProjectDetails();
    const token = data.accessToken.trim();
    const currentRow = await oauth.readGmailOAuthRow(supabaseAdmin);
    const wasGmailConfigured = Boolean(currentRow?.refresh_token_ciphertext && currentRow.sender_email);
    if (data.enabled && !wasGmailConfigured) {
      throw new Error("Connect and authorize Gmail in Admin Settings before enabling the Send Email Auth Hook.");
    }

    const currentSettings = await managementApiRequest(`/projects/${project.projectRef}/config/auth`, token) as {
      external_email_enabled?: boolean;
      hook_send_email_enabled?: boolean;
      hook_send_email_uri?: string;
    };
    const hookIsOurEndpoint = currentSettings.hook_send_email_uri === project.functionUrl;
    if (data.enabled && currentSettings.hook_send_email_enabled && !hookIsOurEndpoint) {
      throw new Error("A different Send Email Auth Hook is already enabled for this Supabase project. Disable or replace it in Supabase first.");
    }
    if (!data.enabled && currentSettings.hook_send_email_enabled && !hookIsOurEndpoint) {
      throw new Error("A different Send Email Auth Hook is enabled. This app will not change another hook’s configuration.");
    }
    if (data.enabled && currentSettings.external_email_enabled === false) {
      throw new Error("Email authentication is disabled in Supabase. Enable the Email provider before configuring this hook.");
    }

    if (data.enabled) {
      const functionResponse = await fetch(project.functionUrl, { method: "GET", signal: AbortSignal.timeout(5_000) });
      if (functionResponse.status !== 405) {
        throw new Error("The send-email function is not deployed yet. Deploy it from the GitHub Actions workflow, then retry.");
      }

      const { randomBytes } = await import("node:crypto");
      const hookSecret = `v1,whsec_${randomBytes(32).toString("base64")}`;
      const secrets = [{ name: "SEND_EMAIL_HOOK_SECRET", value: hookSecret }];
      const encryptionKey = process.env["GMAIL_CREDENTIALS_ENCRYPTION_KEY"];
      if (encryptionKey) secrets.push({ name: "GMAIL_CREDENTIALS_ENCRYPTION_KEY", value: encryptionKey });

      await managementApiRequest(`/projects/${project.projectRef}/secrets`, token, {
        method: "POST",
        body: JSON.stringify(secrets),
      });
      await managementApiRequest(`/projects/${project.projectRef}/config/auth`, token, {
        method: "PATCH",
        body: JSON.stringify({
          hook_send_email_enabled: true,
          hook_send_email_uri: project.functionUrl,
          hook_send_email_secrets: hookSecret,
        }),
      });
    } else {
      await managementApiRequest(`/projects/${project.projectRef}/config/auth`, token, {
        method: "PATCH",
        body: JSON.stringify({ hook_send_email_enabled: false }),
      });
    }

    const now = new Date().toISOString();
    const { error } = await supabaseAdmin.from("gym_send_email_auth_hook").upsert({
      id: 1,
      enabled: data.enabled,
      configured_at: data.enabled ? now : null,
      updated_by: context.userId,
      updated_at: now,
    }, { onConflict: "id" });
    if (error) throw new Error(`Supabase hook updated, but its status could not be saved: ${error.message}`);
    return { enabled: data.enabled, functionUrl: project.functionUrl };
  });

/* ---------------- Admin: payment gateway credentials ---------------- */

const paymentGatewayCredentialsSchema = z.object({
  provider: z.enum(["razorpay", "stripe"]),
  keyId: z.string().trim().max(300).optional().default(""),
  keySecret: z.string().trim().max(1000).optional().default(""),
  webhookSecret: z.string().trim().max(1000).optional().default(""),
}).superRefine((data, context) => {
  if (!data.keyId && !data.keySecret && !data.webhookSecret) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Enter at least one credential to save." });
  }
  if (data.provider === "razorpay" && (!data.keyId || !data.keySecret)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Enter both the Razorpay Key ID and Key Secret together." });
  }
  if (data.provider === "razorpay" && data.keyId && !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(data.keyId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["keyId"], message: "Razorpay Key ID should start with rzp_test_ or rzp_live_." });
  }
  if (data.provider === "razorpay" && data.keySecret && data.keySecret.length < 8) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["keySecret"], message: "Enter a valid Razorpay Key Secret." });
  }
  if (data.provider === "stripe" && data.keyId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["keyId"], message: "Stripe does not use a publishable key for this server checkout. Enter the Secret Key below." });
  }
  if (data.provider === "stripe" && data.keySecret && !/^(sk|rk)_(test|live)_[A-Za-z0-9_]+$/.test(data.keySecret)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["keySecret"], message: "Stripe Secret Key should be an sk_test_, sk_live_, rk_test_, or rk_live_ key." });
  }
  if (data.provider === "stripe" && data.webhookSecret && !/^whsec_[A-Za-z0-9_-]+$/.test(data.webhookSecret)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["webhookSecret"], message: "Stripe webhook signing secret should start with whsec_." });
  }
  if (data.provider === "razorpay" && data.webhookSecret) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["webhookSecret"], message: "Razorpay credentials do not use the Stripe webhook secret field." });
  }
});

export const getPaymentGatewaySettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const [{ supabaseAdmin }, { getRequest }, gateway] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@tanstack/react-start/server"),
      import("@/lib/payment-gateway.server"),
    ]);
    const request = getRequest();
    const baseUrl = process.env["APP_URL"] || process.env["URL"] || (request ? new URL(request.url).origin : "");
    return {
      ...await gateway.getPaymentGatewayCredentialStatus(supabaseAdmin),
      stripeWebhookUrl: baseUrl ? new URL("/api/stripe-webhook", baseUrl).toString() : "",
    };
  });

export const savePaymentGatewayCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.input<typeof paymentGatewayCredentialsSchema>) => paymentGatewayCredentialsSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const [{ supabaseAdmin }, gateway] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@/lib/payment-gateway.server"),
    ]);
    const updates = {
      id: 1,
      updated_by: context.userId,
      updated_at: new Date().toISOString(),
      ...(data.provider === "razorpay" ? {
        ...(data.keyId ? { razorpay_key_id_ciphertext: gateway.encryptPaymentSecret(data.keyId) } : {}),
        ...(data.keySecret ? { razorpay_key_secret_ciphertext: gateway.encryptPaymentSecret(data.keySecret) } : {}),
      } : {
        ...(data.keySecret ? { stripe_secret_key_ciphertext: gateway.encryptPaymentSecret(data.keySecret) } : {}),
        ...(data.webhookSecret ? { stripe_webhook_secret_ciphertext: gateway.encryptPaymentSecret(data.webhookSecret) } : {}),
      }),
    };
    const { error } = await supabaseAdmin.from("gym_payment_gateway_credentials").upsert(updates, { onConflict: "id" });
    if (error) throw new Error(`Could not save payment gateway credentials: ${error.message}`);
    return { saved: true, ...(await gateway.getPaymentGatewayCredentialStatus(supabaseAdmin)) };
  });

export const disconnectPaymentGateway = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { provider: "razorpay" | "stripe" }) => z.object({ provider: z.enum(["razorpay", "stripe"]) }).parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const empty = data.provider === "razorpay"
      ? { razorpay_key_id_ciphertext: null, razorpay_key_secret_ciphertext: null }
      : { stripe_secret_key_ciphertext: null, stripe_webhook_secret_ciphertext: null };
    const { error } = await supabaseAdmin.from("gym_payment_gateway_credentials").update({ ...empty, updated_by: context.userId, updated_at: new Date().toISOString() }).eq("id", 1);
    if (error) throw new Error(`Could not remove ${data.provider} credentials: ${error.message}`);
    return { disconnected: true };
  });

const expiringMembershipSchema = z.object({
  membershipId: z.string().uuid(),
  reminderType: z.enum(["expiring", "expired"]).default("expiring"),
});

export const getExpiringMembers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const db = await admin();
    const { data: gym, error: gymError } = await db.from("gym_settings").select("timezone").order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (gymError) throw new Error(gymError.message);
    const timeZone = gym?.timezone || "Asia/Kolkata";
    const today = gymDateKey(new Date(), timeZone);
    const throughDate = shiftDateKey(today, 7);
    const { data: memberships, error: membershipsError } = await db.from("memberships")
      .select("id, member_id, plan_id, starts_on, ends_on")
      .eq("status", "active")
      .lte("starts_on", today)
      .gte("ends_on", today)
      .lte("ends_on", throughDate)
      .order("ends_on", { ascending: true });
    if (membershipsError) throw new Error(membershipsError.message);
    if (!memberships?.length) return { today, timeZone, members: [] };

    const memberIds = [...new Set(memberships.map((membership) => membership.member_id))];
    const membershipIds = memberships.map((membership) => membership.id);
    const planIds = [...new Set(memberships.flatMap((membership) => membership.plan_id ? [membership.plan_id] : []))];
    const [{ data: members, error: membersError }, { data: reminders, error: remindersError }, plansResult] = await Promise.all([
      db.from("members").select("id, member_code, profile_id").in("id", memberIds),
      db.from("renewal_reminders").select("id, membership_id, days_before, delivery_status, sent_at, attempted_at, last_error").in("membership_id", membershipIds),
      planIds.length ? db.from("membership_plans").select("id, name").in("id", planIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (membersError) throw new Error(membersError.message);
    if (remindersError) throw new Error(remindersError.message);
    if (plansResult.error) throw new Error(plansResult.error.message);
    const profileIds = [...new Set((members ?? []).map((member) => member.profile_id))];
    const { data: profiles, error: profilesError } = profileIds.length
      ? await db.from("profiles").select("id, display_name, email").in("id", profileIds)
      : { data: [], error: null };
    if (profilesError) throw new Error(profilesError.message);

    const memberById = new Map((members ?? []).map((member) => [member.id, member]));
    const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
    const planById = new Map((plansResult.data ?? []).map((plan) => [plan.id, plan.name]));
    const reminderByKey = new Map((reminders ?? []).map((reminder) => [`${reminder.membership_id}:${reminder.days_before}`, reminder]));
    const listedMemberIds = new Set<string>();
    return {
      today,
      timeZone,
      members: memberships.flatMap((membership) => {
        const member = memberById.get(membership.member_id);
        const profile = member ? profileById.get(member.profile_id) : null;
        if (!member || !profile || listedMemberIds.has(member.id)) return [];
        listedMemberIds.add(member.id);
        const manualReminder = reminderByKey.get(`${membership.id}:0`);
        const scheduledReminders = [reminderByKey.get(`${membership.id}:7`), reminderByKey.get(`${membership.id}:4`)].filter(Boolean);
        const latestSentAt = [manualReminder, ...scheduledReminders]
          .filter((reminder) => reminder?.delivery_status === "sent")
          .map((reminder) => reminder!.sent_at)
          .sort((left, right) => right.localeCompare(left))[0] ?? null;
        return [{
          membershipId: membership.id,
          memberId: member.id,
          memberCode: member.member_code,
          name: profile.display_name || member.member_code,
          email: profile.email,
          plan: membership.plan_id ? planById.get(membership.plan_id) ?? "Membership" : "Membership",
          endsOn: membership.ends_on,
          manualReminderStatus: manualReminder?.delivery_status ?? null,
          manualReminderAt: manualReminder?.sent_at ?? null,
          latestReminderAt: latestSentAt,
        }];
      }),
    };
  });

export const getExpiredMembers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const db = await admin();
    const { data: gym, error: gymError } = await db.from("gym_settings")
      .select("timezone")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (gymError) throw new Error(gymError.message);
    const timeZone = gym?.timezone || "Asia/Kolkata";
    const today = gymDateKey(new Date(), timeZone);
    const { data: expiredMemberships, error: membershipsError } = await db.from("memberships")
      .select("id, member_id, starts_on, ends_on")
      .in("status", ["active", "expired"])
      .lte("starts_on", today)
      .lt("ends_on", today)
      .order("ends_on", { ascending: false });
    if (membershipsError) throw new Error(membershipsError.message);
    if (!expiredMemberships?.length) return { today, timeZone, members: [] };

    const latestExpiredByMember = new Map<string, NonNullable<typeof expiredMemberships>[number]>();
    for (const membership of expiredMemberships) {
      if (!latestExpiredByMember.has(membership.member_id)) latestExpiredByMember.set(membership.member_id, membership);
    }
    const candidateMemberIds = [...latestExpiredByMember.keys()];
    const [{ data: currentOrUpcoming, error: currentError }, { data: members, error: membersError }, { data: roles, error: rolesError }] = await Promise.all([
      db.from("memberships").select("member_id").in("member_id", candidateMemberIds).in("status", ["active", "pending"]).gte("ends_on", today),
      db.from("members").select("id, member_code, profile_id").in("id", candidateMemberIds),
      db.from("user_roles").select("user_id").eq("role", "admin"),
    ]);
    if (currentError) throw new Error(currentError.message);
    if (membersError) throw new Error(membersError.message);
    if (rolesError) throw new Error(rolesError.message);
    const blockedMemberIds = new Set((currentOrUpcoming ?? []).map((membership) => membership.member_id));
    const admins = new Set((roles ?? []).map((role) => role.user_id));
    const eligibleMembers = (members ?? []).filter((member) => !blockedMemberIds.has(member.id) && !admins.has(member.profile_id));
    if (!eligibleMembers.length) return { today, timeZone, members: [] };

    const eligibleIds = eligibleMembers.map((member) => member.id);
    const profileIds = [...new Set(eligibleMembers.map((member) => member.profile_id))];
    const membershipIds = eligibleIds.map((memberId) => latestExpiredByMember.get(memberId)!.id);
    const [{ data: profiles, error: profilesError }, { data: reminders, error: remindersError }] = await Promise.all([
      db.from("profiles").select("id, display_name, email, phone").in("id", profileIds),
      db.from("renewal_reminders").select("membership_id, delivery_status, sent_at").in("membership_id", membershipIds).eq("days_before", -1),
    ]);
    if (profilesError) throw new Error(profilesError.message);
    if (remindersError) throw new Error(remindersError.message);

    const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
    const reminderByMembership = new Map((reminders ?? []).map((reminder) => [reminder.membership_id, reminder]));
    return {
      today,
      timeZone,
      members: eligibleMembers.flatMap((member) => {
        const profile = profileById.get(member.profile_id);
        const membership = latestExpiredByMember.get(member.id);
        if (!profile || !membership) return [];
        return [{
          id: member.id,
          memberCode: member.member_code,
          profileId: member.profile_id,
          name: profile.display_name || profile.email || member.member_code,
          email: profile.email,
          phone: profile.phone,
          membershipId: membership.id,
          endsOn: membership.ends_on,
          manualReminder: reminderByMembership.get(membership.id) ?? null,
        }];
      }),
    };
  });

export const sendExpiringMemberReminder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { membershipId: string; reminderType?: "expiring" | "expired" }) => expiringMembershipSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await admin();
    const { data: gym, error: gymError } = await db.from("gym_settings")
      .select("gym_name, timezone")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (gymError) throw new Error(gymError.message);
    if (!gym) throw new Error("Gym settings have not been initialized.");
    const timeZone = gym.timezone || "Asia/Kolkata";
    const today = gymDateKey(new Date(), timeZone);
    const { data: membership, error: membershipError } = await db.from("memberships")
      .select("id, member_id, starts_on, ends_on, status")
      .eq("id", data.membershipId)
      .maybeSingle();
    if (membershipError) throw new Error(membershipError.message);
    if (!membership) throw new Error("Membership record not found.");
    if (data.reminderType === "expired") {
      if (!["active", "expired"].includes(membership.status) || membership.starts_on > today || membership.ends_on >= today) {
        throw new Error("This membership has not expired or is no longer eligible for an expired-membership reminder.");
      }
      const { data: newerMemberships, error: newerMembershipsError } = await db.from("memberships")
        .select("id")
        .eq("member_id", membership.member_id)
        .in("status", ["active", "expired", "pending"])
        .gt("ends_on", membership.ends_on)
        .limit(1);
      if (newerMembershipsError) throw new Error(newerMembershipsError.message);
      if (newerMemberships?.length) throw new Error("A newer membership exists. Refresh the expired-membership list before sending a reminder.");
    } else {
      const throughDate = shiftDateKey(today, 7);
      if (membership.status !== "active" || membership.starts_on > today || membership.ends_on < today || membership.ends_on > throughDate) {
        throw new Error("This membership is no longer active or does not expire within the next seven days.");
      }
    }

    const { data: member, error: memberError } = await db.from("members").select("id, profile_id").eq("id", membership.member_id).maybeSingle();
    if (memberError) throw new Error(memberError.message);
    if (!member) throw new Error("Member record not found.");
    const { data: profile, error: profileError } = await db.from("profiles").select("display_name, email").eq("id", member.profile_id).maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!profile?.email) throw new Error("This member does not have an email address on their profile.");

    const reminderDaysBefore = data.reminderType === "expired" ? -1 : 0;
    const { data: existing, error: reminderError } = await db.from("renewal_reminders")
      .select("id, delivery_status, attempt_count, attempted_at, sent_at")
      .eq("membership_id", membership.id)
      .eq("days_before", reminderDaysBefore)
      .maybeSingle();
    if (reminderError) throw new Error(reminderError.message);
    if (existing?.delivery_status === "sent") return { sent: true, alreadySent: true, sentAt: existing.sent_at };

    const now = new Date().toISOString();
    let reminderId: string;
    if (!existing) {
      const { data: claimed, error: claimError } = await db.from("renewal_reminders").insert({
        membership_id: membership.id,
        days_before: reminderDaysBefore,
        channels: [],
        delivery_status: "sending",
        attempt_count: 1,
        attempted_at: now,
        recipient_email: profile.email,
      }).select("id").single();
      if (claimError?.code === "23505") throw new Error("A manual reminder has already been sent or is currently being sent for this membership.");
      if (claimError || !claimed) throw new Error(claimError?.message ?? "Could not prepare the reminder email.");
      reminderId = claimed.id;
    } else {
      const staleBefore = new Date(Date.now() - 20 * 60_000).toISOString();
      let update = db.from("renewal_reminders").update({
        delivery_status: "sending",
        attempt_count: existing.attempt_count + 1,
        attempted_at: now,
        recipient_email: profile.email,
        last_error: null,
      }).eq("id", existing.id);
      if (existing.delivery_status === "failed") update = update.eq("delivery_status", "failed");
      else if (existing.delivery_status === "sending" && existing.attempted_at && existing.attempted_at < staleBefore) {
        update = update.eq("delivery_status", "sending").lt("attempted_at", staleBefore);
      } else throw new Error("A manual reminder is already being sent. Please wait a moment and refresh the list.");
      const { data: claimed, error: claimError } = await update.select("id").maybeSingle();
      if (claimError) throw new Error(claimError.message);
      if (!claimed) throw new Error("A manual reminder is already being sent. Please wait a moment and refresh the list.");
      reminderId = claimed.id;
    }

    try {
      const [{ getGmailAccessToken, sendRenewalEmail }, { loadGmailOAuthCredentials }] = await Promise.all([
        import("@/lib/renewal-email.server"),
        import("@/lib/gmail-oauth.server"),
      ]);
      const gmailCredentials = await loadGmailOAuthCredentials(db);
      const accessToken = await getGmailAccessToken(gmailCredentials);
      const providerMessageId = await sendRenewalEmail({
        accessToken,
        senderEmail: gmailCredentials.senderEmail,
        gymName: gym.gym_name || "GYM MANAGER",
        memberName: profile.display_name || "",
        email: profile.email,
        expiresOn: membership.ends_on,
        timeZone,
        appUrl: process.env["APP_URL"] || process.env["URL"] || "",
        reminderDaysBefore,
        membershipExpired: data.reminderType === "expired",
        reminderId,
      });
      const sentAt = new Date().toISOString();
      const { error: updateError } = await db.from("renewal_reminders").update({
        delivery_status: "sent",
        channels: ["email"],
        provider_message_id: providerMessageId,
        sent_at: sentAt,
        last_error: null,
      }).eq("id", reminderId);
      if (updateError) throw new Error(`Gmail accepted the email, but its delivery record could not be saved: ${updateError.message}`);
      return { sent: true, alreadySent: false, sentAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown email delivery error.";
      await db.from("renewal_reminders").update({ delivery_status: "failed", last_error: message.slice(0, 1000) }).eq("id", reminderId);
      throw new Error(message);
    }
  });

export const getGymSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("gym_settings")
      .select("gym_name, logo_url, app_title, color_theme, timezone, currency, country_code, payment_gateway")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { gym_name: "GYM MANAGER", logo_url: null, app_title: "GYM MANAGER", color_theme: "forge-green", timezone: "Asia/Kolkata", currency: "INR", country_code: "IN", payment_gateway: "razorpay" };
    return {
      ...data,
      gym_name: data.gym_name === "Forge Functional Fitness" ? "GYM MANAGER" : data.gym_name,
      app_title: data.app_title === "Forge Fitness Pal" ? "GYM MANAGER" : data.app_title,
    };
  });

// Public web-app branding only; operational settings remain behind authenticated admin flows.
export const getGymBranding = createServerFn({ method: "GET" })
  .handler(async () => {
    const db = await admin();
    const { data, error } = await db
      .from("gym_settings")
      .select("gym_name, logo_url, app_title, color_theme, timezone, currency, country_code, payment_gateway")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { gym_name: "GYM MANAGER", logo_url: null, app_title: "GYM MANAGER", color_theme: "forge-green", timezone: "Asia/Kolkata", currency: "INR", country_code: "IN", payment_gateway: "razorpay" };
    return {
      ...data,
      gym_name: data.gym_name === "Forge Functional Fitness" ? "GYM MANAGER" : data.gym_name,
      app_title: data.app_title === "Forge Fitness Pal" ? "GYM MANAGER" : data.app_title,
    };
  });

export const saveGymSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: z.input<typeof gymSettingsSchema>) => gymSettingsSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    let logoUrl: string | null | undefined;

    if (data.logoDataUrl) {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data.logoDataUrl);
      if (!match) throw new Error("Choose a PNG, JPG, or WebP image.");
      const mimeType = match[1];
      const encodedImage = match[2];
      if (!mimeType || !encodedImage) throw new Error("The selected logo is invalid.");
      const bytes = Buffer.from(encodedImage, "base64");
      if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024) {
        throw new Error("The logo must be smaller than 2 MB.");
      }
      const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
      const objectPath = `logo.${extension}`;
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const storage = supabaseAdmin.storage.from("gym-branding");
      const { error: uploadError } = await storage.upload(objectPath, bytes, {
        contentType: mimeType,
        cacheControl: "0",
        upsert: true,
      });
      if (uploadError) throw new Error(uploadError.message);
      logoUrl = `${storage.getPublicUrl(objectPath).data.publicUrl}?v=${Date.now()}`;
    } else if (data.clearLogo) {
      logoUrl = null;
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: settings, error: readError } = await supabaseAdmin
      .from("gym_settings")
      .select("id")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!settings) throw new Error("Gym settings have not been initialized.");

    const updates = {
      gym_name: data.gym_name,
      app_title: data.app_title,
      color_theme: data.color_theme,
      currency: data.currency,
      country_code: data.country_code,
      payment_gateway: data.payment_gateway,
      ...(logoUrl !== undefined ? { logo_url: logoUrl } : {}),
    };
    const { error } = await supabaseAdmin.from("gym_settings").update(updates).eq("id", settings.id);
    if (error) throw new Error(error.message);
    if (data.logoDataUrl) {
      const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
      const extension = logoUrl?.split("/logo.")[1]?.split("?")[0];
      await db.storage.from("gym-branding").remove(
        ["png", "jpg", "webp"].filter((ext) => ext !== extension).map((ext) => `logo.${ext}`),
      );
    } else if (data.clearLogo) {
      const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
      await db.storage.from("gym-branding").remove(["logo.png", "logo.jpg", "logo.webp"]);
    }
    return { ...updates, ...(logoUrl !== undefined ? { logo_url: logoUrl } : {}) };
  });

