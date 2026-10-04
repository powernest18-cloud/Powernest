CREATE TYPE public.app_role AS ENUM ('admin', 'coach', 'member');
CREATE TYPE public.member_status AS ENUM ('active', 'inactive', 'frozen', 'expired', 'lead');
CREATE TYPE public.membership_status AS ENUM ('pending', 'active', 'frozen', 'expired', 'cancelled');
CREATE TYPE public.payment_status AS ENUM ('created', 'pending', 'verified', 'failed', 'refunded', 'partially_refunded');
CREATE TYPE public.payment_method AS ENUM ('razorpay', 'cash', 'upi', 'bank_transfer', 'card_recorded');
CREATE TYPE public.booking_status AS ENUM ('booked', 'cancelled', 'attended', 'no_show');
CREATE TYPE public.access_decision AS ENUM ('granted', 'denied');

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  phone text,
  avatar_url text,
  date_of_birth date,
  gender text,
  address text,
  emergency_contact_name text,
  emergency_contact_phone text,
  medical_notes text,
  fitness_goals text,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;

CREATE POLICY profiles_own_read ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid() OR public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'coach'));
CREATE POLICY profiles_own_update ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid() OR public.has_role(auth.uid(), 'admin')) WITH CHECK (id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY profiles_own_insert ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY roles_own_read ON public.user_roles FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ BEGIN INSERT INTO public.profiles (id,email,display_name,avatar_url) VALUES (NEW.id, COALESCE(NEW.email,''), COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(COALESCE(NEW.email,''),'@',1)), NEW.raw_user_meta_data->>'avatar_url'); INSERT INTO public.user_roles(user_id,role) VALUES (NEW.id,'member'); RETURN NEW; END; $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid UNIQUE NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, member_code text UNIQUE NOT NULL, status public.member_status NOT NULL DEFAULT 'lead', joined_on date, notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.members TO authenticated; GRANT ALL ON public.members TO service_role; ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;
CREATE POLICY members_read ON public.members FOR SELECT TO authenticated USING (profile_id=auth.uid() OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach'));
CREATE POLICY members_admin_write ON public.members FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER members_updated BEFORE UPDATE ON public.members FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.trainers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid UNIQUE NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, specialties text[] NOT NULL DEFAULT '{}', certifications text[] NOT NULL DEFAULT '{}', bio text, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
); GRANT SELECT, INSERT, UPDATE, DELETE ON public.trainers TO authenticated; GRANT ALL ON public.trainers TO service_role; ALTER TABLE public.trainers ENABLE ROW LEVEL SECURITY;
CREATE POLICY trainers_read ON public.trainers FOR SELECT TO authenticated USING (true);
CREATE POLICY trainers_admin_write ON public.trainers FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER trainers_updated BEFORE UPDATE ON public.trainers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.membership_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, description text, duration_days int NOT NULL CHECK(duration_days>0), price_inr numeric(12,2) NOT NULL CHECK(price_inr>=0), joining_fee_inr numeric(12,2) NOT NULL DEFAULT 0, class_limit int, freeze_days int NOT NULL DEFAULT 0, benefits text[] NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
); GRANT SELECT ON public.membership_plans TO authenticated; GRANT INSERT,UPDATE,DELETE ON public.membership_plans TO authenticated; GRANT ALL ON public.membership_plans TO service_role; ALTER TABLE public.membership_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY plans_read ON public.membership_plans FOR SELECT TO authenticated USING (true); CREATE POLICY plans_admin_write ON public.membership_plans FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin')); CREATE TRIGGER plans_updated BEFORE UPDATE ON public.membership_plans FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.memberships (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE, plan_id uuid NOT NULL REFERENCES public.membership_plans(id), status public.membership_status NOT NULL DEFAULT 'pending', starts_on date NOT NULL, ends_on date NOT NULL, frozen_from date, frozen_until date, cancelled_at timestamptz, auto_renew boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK(ends_on>=starts_on), CHECK(frozen_until IS NULL OR frozen_from IS NOT NULL)
); GRANT SELECT,INSERT,UPDATE,DELETE ON public.memberships TO authenticated; GRANT ALL ON public.memberships TO service_role; ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_read ON public.memberships FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach'));
CREATE POLICY memberships_admin_write ON public.memberships FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin')); CREATE TRIGGER memberships_updated BEFORE UPDATE ON public.memberships FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid NOT NULL REFERENCES public.members(id), membership_id uuid REFERENCES public.memberships(id), amount_inr numeric(12,2) NOT NULL CHECK(amount_inr>0), method public.payment_method NOT NULL, status public.payment_status NOT NULL DEFAULT 'created', provider_order_id text UNIQUE, provider_payment_id text UNIQUE, receipt_number text UNIQUE, refund_amount_inr numeric(12,2) NOT NULL DEFAULT 0, verified_at timestamptz, paid_at timestamptz, notes text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
); GRANT SELECT,INSERT,UPDATE ON public.payments TO authenticated; GRANT ALL ON public.payments TO service_role; ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY payments_read ON public.payments FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin'));
CREATE POLICY payments_admin_write ON public.payments FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin')); CREATE TRIGGER payments_updated BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.payment_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid REFERENCES public.payments(id), provider_event_id text UNIQUE NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb, processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()); GRANT SELECT ON public.payment_events TO authenticated; GRANT ALL ON public.payment_events TO service_role; ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY; CREATE POLICY payment_events_admin ON public.payment_events FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE TABLE public.classes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, description text, category text NOT NULL, difficulty text NOT NULL DEFAULT 'all-levels', default_capacity int NOT NULL CHECK(default_capacity>0), duration_minutes int NOT NULL CHECK(duration_minutes>0), active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()); GRANT SELECT,INSERT,UPDATE,DELETE ON public.classes TO authenticated; GRANT ALL ON public.classes TO service_role; ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY; CREATE POLICY classes_read ON public.classes FOR SELECT TO authenticated USING (true); CREATE POLICY classes_staff_write ON public.classes FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')) WITH CHECK (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')); CREATE TRIGGER classes_updated BEFORE UPDATE ON public.classes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.class_schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), class_id uuid NOT NULL REFERENCES public.classes(id), trainer_id uuid REFERENCES public.trainers(id), starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, capacity int NOT NULL CHECK(capacity>0), cancellation_deadline_minutes int NOT NULL DEFAULT 120, status text NOT NULL DEFAULT 'scheduled', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK(ends_at>starts_at)); GRANT SELECT,INSERT,UPDATE,DELETE ON public.class_schedules TO authenticated; GRANT ALL ON public.class_schedules TO service_role; ALTER TABLE public.class_schedules ENABLE ROW LEVEL SECURITY; CREATE POLICY schedules_read ON public.class_schedules FOR SELECT TO authenticated USING (true); CREATE POLICY schedules_staff_write ON public.class_schedules FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')) WITH CHECK (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')); CREATE TRIGGER schedules_updated BEFORE UPDATE ON public.class_schedules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.class_bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), schedule_id uuid NOT NULL REFERENCES public.class_schedules(id) ON DELETE CASCADE, member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE, status public.booking_status NOT NULL DEFAULT 'booked', booked_at timestamptz NOT NULL DEFAULT now(), cancelled_at timestamptz, UNIQUE(schedule_id,member_id)); GRANT SELECT,INSERT,UPDATE,DELETE ON public.class_bookings TO authenticated; GRANT ALL ON public.class_bookings TO service_role; ALTER TABLE public.class_bookings ENABLE ROW LEVEL SECURITY; CREATE POLICY bookings_read ON public.class_bookings FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')); CREATE POLICY bookings_own_insert ON public.class_bookings FOR INSERT TO authenticated WITH CHECK (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin')); CREATE POLICY bookings_own_update ON public.class_bookings FOR UPDATE TO authenticated USING (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')) WITH CHECK (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach'));

CREATE TABLE public.class_waitlists (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), schedule_id uuid NOT NULL REFERENCES public.class_schedules(id) ON DELETE CASCADE, member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE, position int NOT NULL CHECK(position>0), joined_at timestamptz NOT NULL DEFAULT now(), promoted_at timestamptz, UNIQUE(schedule_id,member_id)); GRANT SELECT,INSERT,DELETE ON public.class_waitlists TO authenticated; GRANT ALL ON public.class_waitlists TO service_role; ALTER TABLE public.class_waitlists ENABLE ROW LEVEL SECURITY; CREATE POLICY waitlists_read ON public.class_waitlists FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')); CREATE POLICY waitlists_own_insert ON public.class_waitlists FOR INSERT TO authenticated WITH CHECK (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin')); CREATE POLICY waitlists_own_delete ON public.class_waitlists FOR DELETE TO authenticated USING (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin'));

CREATE TABLE public.workouts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, workout_date date NOT NULL, stimulus text, description text NOT NULL, scoring_type text NOT NULL DEFAULT 'time', time_cap_minutes int, scaling_notes text, published boolean NOT NULL DEFAULT false, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workout_date,title)); GRANT SELECT,INSERT,UPDATE,DELETE ON public.workouts TO authenticated; GRANT ALL ON public.workouts TO service_role; ALTER TABLE public.workouts ENABLE ROW LEVEL SECURITY; CREATE POLICY workouts_read ON public.workouts FOR SELECT TO authenticated USING (published OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')); CREATE POLICY workouts_staff_write ON public.workouts FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')) WITH CHECK (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')); CREATE TRIGGER workouts_updated BEFORE UPDATE ON public.workouts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.workout_exercises (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workout_id uuid NOT NULL REFERENCES public.workouts(id) ON DELETE CASCADE, exercise_name text NOT NULL, sequence int NOT NULL, prescription text NOT NULL, movement_standard text); GRANT SELECT,INSERT,UPDATE,DELETE ON public.workout_exercises TO authenticated; GRANT ALL ON public.workout_exercises TO service_role; ALTER TABLE public.workout_exercises ENABLE ROW LEVEL SECURITY; CREATE POLICY exercises_read ON public.workout_exercises FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.workouts w WHERE w.id=workout_id AND (w.published OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')))); CREATE POLICY exercises_staff_write ON public.workout_exercises FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')) WITH CHECK (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach'));

CREATE TABLE public.workout_results (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workout_id uuid NOT NULL REFERENCES public.workouts(id) ON DELETE CASCADE, member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE, score text NOT NULL, rx boolean NOT NULL DEFAULT false, notes text, recorded_by uuid, recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workout_id,member_id)); GRANT SELECT,INSERT,UPDATE ON public.workout_results TO authenticated; GRANT ALL ON public.workout_results TO service_role; ALTER TABLE public.workout_results ENABLE ROW LEVEL SECURITY; CREATE POLICY results_read ON public.workout_results FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')); CREATE POLICY results_write ON public.workout_results FOR ALL TO authenticated USING (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')) WITH CHECK (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach'));

CREATE TABLE public.attendance (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid NOT NULL REFERENCES public.members(id), schedule_id uuid REFERENCES public.class_schedules(id), checked_in_at timestamptz NOT NULL DEFAULT now(), source text NOT NULL DEFAULT 'manual', external_event_id text UNIQUE, recorded_by uuid, created_at timestamptz NOT NULL DEFAULT now()); GRANT SELECT,INSERT,UPDATE ON public.attendance TO authenticated; GRANT ALL ON public.attendance TO service_role; ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY; CREATE POLICY attendance_read ON public.attendance FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')); CREATE POLICY attendance_staff_write ON public.attendance FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach')) WITH CHECK (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach'));

CREATE TABLE public.access_devices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, vendor text NOT NULL, device_type text NOT NULL, external_id text UNIQUE, location text, active boolean NOT NULL DEFAULT true, last_seen_at timestamptz, configuration jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()); GRANT SELECT,INSERT,UPDATE,DELETE ON public.access_devices TO authenticated; GRANT ALL ON public.access_devices TO service_role; ALTER TABLE public.access_devices ENABLE ROW LEVEL SECURITY; CREATE POLICY devices_admin ON public.access_devices FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin')); CREATE TRIGGER devices_updated BEFORE UPDATE ON public.access_devices FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TABLE public.access_credentials (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE, credential_type text NOT NULL, external_reference text UNIQUE NOT NULL, label text, active boolean NOT NULL DEFAULT true, registered_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz); GRANT SELECT,INSERT,UPDATE,DELETE ON public.access_credentials TO authenticated; GRANT ALL ON public.access_credentials TO service_role; ALTER TABLE public.access_credentials ENABLE ROW LEVEL SECURITY; CREATE POLICY credentials_read ON public.access_credentials FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin')); CREATE POLICY credentials_admin_write ON public.access_credentials FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TABLE public.access_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid REFERENCES public.access_devices(id), credential_id uuid REFERENCES public.access_credentials(id), member_id uuid REFERENCES public.members(id), external_event_id text UNIQUE NOT NULL, decision public.access_decision NOT NULL, reason text, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()); GRANT SELECT ON public.access_events TO authenticated; GRANT ALL ON public.access_events TO service_role; ALTER TABLE public.access_events ENABLE ROW LEVEL SECURITY; CREATE POLICY access_events_read ON public.access_events FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.members m WHERE m.id=member_id AND m.profile_id=auth.uid()) OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'coach'));

CREATE TABLE public.trainer_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trainer_id uuid NOT NULL REFERENCES public.trainers(id) ON DELETE CASCADE, schedule_id uuid NOT NULL REFERENCES public.class_schedules(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(trainer_id,schedule_id)); GRANT SELECT,INSERT,DELETE ON public.trainer_assignments TO authenticated; GRANT ALL ON public.trainer_assignments TO service_role; ALTER TABLE public.trainer_assignments ENABLE ROW LEVEL SECURITY; CREATE POLICY assignments_read ON public.trainer_assignments FOR SELECT TO authenticated USING (true); CREATE POLICY assignments_admin_write ON public.trainer_assignments FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE TABLE public.notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text NOT NULL, message text NOT NULL, category text NOT NULL DEFAULT 'general', read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()); GRANT SELECT,UPDATE ON public.notifications TO authenticated; GRANT ALL ON public.notifications TO service_role; ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY; CREATE POLICY notifications_own_read ON public.notifications FOR SELECT TO authenticated USING (user_id=auth.uid() OR public.has_role(auth.uid(),'admin')); CREATE POLICY notifications_own_update ON public.notifications FOR UPDATE TO authenticated USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());
CREATE TABLE public.gym_settings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), gym_name text NOT NULL DEFAULT 'Forge Functional Fitness', timezone text NOT NULL DEFAULT 'Asia/Kolkata', currency text NOT NULL DEFAULT 'INR', booking_window_days int NOT NULL DEFAULT 14, default_cancellation_minutes int NOT NULL DEFAULT 120, contact_email text, contact_phone text, address text, updated_at timestamptz NOT NULL DEFAULT now()); GRANT SELECT,UPDATE ON public.gym_settings TO authenticated; GRANT ALL ON public.gym_settings TO service_role; ALTER TABLE public.gym_settings ENABLE ROW LEVEL SECURITY; CREATE POLICY settings_read ON public.gym_settings FOR SELECT TO authenticated USING (true); CREATE POLICY settings_admin_write ON public.gym_settings FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin')); CREATE TRIGGER settings_updated BEFORE UPDATE ON public.gym_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TABLE public.audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid, action text NOT NULL, entity_type text NOT NULL, entity_id uuid, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, ip_address inet, created_at timestamptz NOT NULL DEFAULT now()); GRANT SELECT ON public.audit_logs TO authenticated; GRANT ALL ON public.audit_logs TO service_role; ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY; CREATE POLICY audits_admin_read ON public.audit_logs FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE INDEX idx_members_status ON public.members(status); CREATE INDEX idx_memberships_member_status ON public.memberships(member_id,status); CREATE INDEX idx_schedules_starts ON public.class_schedules(starts_at); CREATE INDEX idx_bookings_schedule_status ON public.class_bookings(schedule_id,status); CREATE INDEX idx_attendance_member_time ON public.attendance(member_id,checked_in_at DESC); CREATE INDEX idx_access_events_time ON public.access_events(occurred_at DESC); CREATE INDEX idx_payments_member_status ON public.payments(member_id,status); CREATE INDEX idx_notifications_user_unread ON public.notifications(user_id,read_at);

INSERT INTO public.membership_plans(name,description,duration_days,price_inr,joining_fee_inr,freeze_days,benefits) VALUES ('Foundation','Unlimited group classes and progress tracking',30,3499,499,3,ARRAY['Unlimited classes','WOD tracking','Open gym']),('Performance','Coaching support with extended freeze flexibility',90,8999,0,10,ARRAY['Unlimited classes','Monthly coach review','10 freeze days']),('Annual Athlete','Best value for committed athletes',365,29999,0,30,ARRAY['Unlimited classes','Quarterly assessment','30 freeze days','Priority booking']);
INSERT INTO public.classes(name,description,category,difficulty,default_capacity,duration_minutes) VALUES ('CrossFit','Strength and conditioning with a coached daily workout','CrossFit','all-levels',18,60),('Engine Room','Interval conditioning across rower, bike, and ski','Conditioning','intermediate',16,50),('Barbell Club','Technique and strength work for Olympic lifts','Weightlifting','intermediate',12,75),('Mobility Reset','Guided mobility and recovery session','Recovery','all-levels',20,45);
INSERT INTO public.gym_settings(gym_name,timezone,currency,contact_email) VALUES ('Forge Functional Fitness','Asia/Kolkata','INR','hello@forgefit.example');
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
ALTER FUNCTION public.has_role(uuid, public.app_role) SET SCHEMA private;
ALTER FUNCTION public.handle_new_user() SET SCHEMA private;
REVOKE ALL ON FUNCTION private.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.has_role(uuid, public.app_role) TO authenticated, service_role;
REVOKE ALL ON FUNCTION private.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.handle_new_user() TO service_role;
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS has_illness boolean,
  ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_completed boolean NOT NULL DEFAULT false;

CREATE TABLE public.coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  description text,
  discount_type text NOT NULL DEFAULT 'percent' CHECK (discount_type IN ('percent','flat')),
  discount_value numeric NOT NULL CHECK (discount_value > 0),
  plan_id uuid REFERENCES public.membership_plans(id) ON DELETE CASCADE,
  valid_from date,
  valid_until date,
  max_redemptions integer,
  redemptions_count integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.coupons TO authenticated;
GRANT ALL ON public.coupons TO service_role;
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
CREATE POLICY coupons_admin_all ON public.coupons FOR ALL TO authenticated
  USING (private.has_role(auth.uid(),'admin')) WITH CHECK (private.has_role(auth.uid(),'admin'));
CREATE TRIGGER coupons_updated BEFORE UPDATE ON public.coupons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES public.membership_plans(id),
  ADD COLUMN IF NOT EXISTS coupon_id uuid REFERENCES public.coupons(id),
  ADD COLUMN IF NOT EXISTS base_amount_inr numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_inr numeric NOT NULL DEFAULT 0;

CREATE TABLE public.renewal_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES public.memberships(id) ON DELETE CASCADE,
  days_before integer NOT NULL,
  channels text[] NOT NULL DEFAULT '{}',
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_id, days_before)
);
GRANT ALL ON public.renewal_reminders TO service_role;
ALTER TABLE public.renewal_reminders ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION private.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE is_first boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(424242);
  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role='admin') INTO is_first;
  INSERT INTO public.profiles (id,email,display_name,avatar_url)
  VALUES (NEW.id, COALESCE(NEW.email,''), COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(COALESCE(NEW.email,''),'@',1)), NEW.raw_user_meta_data->>'avatar_url');
  IF is_first THEN
    INSERT INTO public.user_roles(user_id,role) VALUES (NEW.id,'admin');
  ELSE
    INSERT INTO public.user_roles(user_id,role) VALUES (NEW.id,'member');
    INSERT INTO public.members(profile_id, member_code, status, joined_on)
    VALUES (NEW.id, 'FRG-' || upper(substr(replace(NEW.id::text,'-',''),1,8)), 'lead', current_date);
  END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION private.guard_profile_verification()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.phone IS DISTINCT FROM OLD.phone THEN
      NEW.phone_verified_at := NULL;
    ELSE
      NEW.phone_verified_at := OLD.phone_verified_at;
    END IF;
    IF NEW.onboarding_completed AND NOT OLD.onboarding_completed THEN
      NEW.onboarding_completed := OLD.onboarding_completed;
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER profiles_guard_verification BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION private.guard_profile_verification();
ALTER PUBLICATION supabase_realtime ADD TABLE public.payments, public.members, public.memberships, public.attendance;
ALTER TABLE public.gym_settings
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS app_title text NOT NULL DEFAULT 'Forge Fitness Pal';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'gym-branding',
  'gym-branding',
  true,
  2097152,
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

ALTER TABLE public.gym_settings
  ADD COLUMN IF NOT EXISTS color_theme text NOT NULL DEFAULT 'forge-green'
  CHECK (color_theme IN ('forge-green', 'ocean-blue', 'ember-orange', 'violet', 'rose'));
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'class_schedules'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.class_schedules;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'class_bookings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.class_bookings;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'classes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.classes;
  END IF;
END $$;
ALTER TABLE public.gym_settings
  ADD COLUMN country_code text NOT NULL DEFAULT 'IN',
  ADD COLUMN payment_gateway text NOT NULL DEFAULT 'razorpay';

ALTER TABLE public.gym_settings
  ADD CONSTRAINT gym_settings_country_code_check
    CHECK (country_code IN ('IN','US','GB','CA','AU','SG','AE','NZ','JP','DE','FR','IE')),
  ADD CONSTRAINT gym_settings_currency_check
    CHECK (currency IN ('INR','USD','EUR','GBP','AED','CAD','AUD','SGD','NZD','JPY')),
  ADD CONSTRAINT gym_settings_payment_gateway_check
    CHECK (payment_gateway IN ('razorpay','stripe')),
  ADD CONSTRAINT gym_settings_razorpay_region_check
    CHECK (payment_gateway <> 'razorpay' OR (country_code = 'IN' AND currency = 'INR'));

ALTER TABLE public.membership_plans RENAME COLUMN price_inr TO price_amount;
ALTER TABLE public.membership_plans RENAME COLUMN joining_fee_inr TO joining_fee_amount;

ALTER TABLE public.payments RENAME COLUMN amount_inr TO amount;
ALTER TABLE public.payments RENAME COLUMN base_amount_inr TO base_amount;
ALTER TABLE public.payments RENAME COLUMN discount_inr TO discount_amount;
ALTER TABLE public.payments RENAME COLUMN refund_amount_inr TO refund_amount;
ALTER TABLE public.payments ADD COLUMN currency text NOT NULL DEFAULT 'INR'
  CHECK (currency IN ('INR','USD','EUR','GBP','AED','CAD','AUD','SGD','NZD','JPY'));

ALTER TYPE public.payment_method ADD VALUE IF NOT EXISTS 'stripe';

CREATE OR REPLACE FUNCTION public.complete_membership_payment(
  p_payment_id uuid,
  p_provider_payment_id text,
  p_currency text,
  p_amount_minor bigint
)
RETURNS TABLE(new_membership_id uuid, completed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payment_row public.payments%ROWTYPE;
  scale_factor numeric;
  plan_days integer;
  today_date date := current_date;
  membership_start date;
  membership_end date;
  created_membership_id uuid;
BEGIN
  SELECT * INTO payment_row FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment record not found'; END IF;

  scale_factor := CASE upper(p_currency) WHEN 'JPY' THEN 1 ELSE 100 END;
  IF payment_row.currency <> upper(p_currency)
     OR round(payment_row.amount * scale_factor) <> p_amount_minor THEN
    RAISE EXCEPTION 'Gateway amount or currency does not match the payment record';
  END IF;

  IF payment_row.status = 'verified' THEN
    IF payment_row.provider_payment_id IS DISTINCT FROM p_provider_payment_id THEN
      RAISE EXCEPTION 'Payment was already completed with a different provider reference';
    END IF;
    RETURN QUERY SELECT payment_row.membership_id, false;
    RETURN;
  END IF;
  IF payment_row.status <> 'created' THEN RAISE EXCEPTION 'Payment is not awaiting confirmation'; END IF;

  SELECT duration_days INTO plan_days FROM public.membership_plans WHERE id = payment_row.plan_id;
  IF plan_days IS NULL THEN RAISE EXCEPTION 'Membership plan not found'; END IF;
  SELECT ends_on INTO membership_end FROM public.memberships
    WHERE member_id = payment_row.member_id AND status IN ('active','pending')
    ORDER BY ends_on DESC LIMIT 1;
  membership_start := CASE WHEN membership_end IS NOT NULL AND membership_end >= today_date
    THEN membership_end + 1 ELSE today_date END;
  membership_end := membership_start + plan_days - 1;

  INSERT INTO public.memberships(member_id, plan_id, status, starts_on, ends_on)
    VALUES (payment_row.member_id, payment_row.plan_id,
      CASE WHEN membership_start > today_date THEN 'pending'::public.membership_status ELSE 'active'::public.membership_status END,
      membership_start, membership_end)
    RETURNING id INTO created_membership_id;

  UPDATE public.payments SET status = 'verified', provider_payment_id = p_provider_payment_id,
    membership_id = created_membership_id, verified_at = now(), paid_at = now()
    WHERE id = p_payment_id;
  UPDATE public.members SET status = 'active' WHERE id = payment_row.member_id;

  RETURN QUERY SELECT created_membership_id, true;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_membership_payment(uuid, text, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_membership_payment(uuid, text, text, bigint) TO service_role;
ALTER TABLE public.gym_settings
  ALTER COLUMN gym_name SET DEFAULT 'GYM MANAGER',
  ALTER COLUMN app_title SET DEFAULT 'GYM MANAGER';

UPDATE public.gym_settings
SET gym_name = 'GYM MANAGER'
WHERE gym_name = 'Forge Functional Fitness';

UPDATE public.gym_settings
SET app_title = 'GYM MANAGER'
WHERE app_title = 'Forge Fitness Pal';
CREATE OR REPLACE FUNCTION private.gym_name_short_code(p_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $$
DECLARE
  cleaned_name text;
  prefix text;
BEGIN
  cleaned_name := upper(coalesce(p_name, ''));
  cleaned_name := regexp_replace(cleaned_name, '[^A-Z0-9]+', ' ', 'g');
  cleaned_name := btrim(regexp_replace(cleaned_name, '\s+', ' ', 'g'));

  IF cleaned_name = '' THEN
    RETURN 'GYM';
  END IF;

  IF position(' ' IN cleaned_name) = 0 THEN
    RETURN left(cleaned_name, 3);
  END IF;

  SELECT string_agg(left(word, 1), '')
  INTO prefix
  FROM regexp_split_to_table(cleaned_name, ' ') AS word;

  RETURN coalesce(nullif(left(prefix, 6), ''), 'GYM');
END;
$$;

CREATE OR REPLACE FUNCTION private.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  is_first boolean;
  gym_name text;
  member_prefix text;
BEGIN
  PERFORM pg_advisory_xact_lock(424242);
  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'admin') INTO is_first;
  SELECT settings.gym_name
  INTO gym_name
  FROM public.gym_settings AS settings
  ORDER BY settings.updated_at DESC
  LIMIT 1;
  member_prefix := private.gym_name_short_code(gym_name);

  INSERT INTO public.profiles (id, email, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(COALESCE(NEW.email, ''), '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url'
  );

  IF is_first THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'member');
    INSERT INTO public.members (profile_id, member_code, status, joined_on)
    VALUES (
      NEW.id,
      member_prefix || '-' || upper(substr(replace(NEW.id::text, '-', ''), 1, 8)),
      'lead',
      current_date
    );
  END IF;

  RETURN NEW;
END;
$$;
ALTER TABLE public.renewal_reminders
  ADD COLUMN delivery_status text NOT NULL DEFAULT 'sent',
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN attempted_at timestamptz,
  ADD COLUMN recipient_email text,
  ADD COLUMN provider_message_id text,
  ADD COLUMN last_error text,
  ADD CONSTRAINT renewal_reminders_delivery_status_check
    CHECK (delivery_status IN ('sending', 'sent', 'failed')),
  ADD CONSTRAINT renewal_reminders_attempt_count_check
    CHECK (attempt_count >= 0);

CREATE INDEX renewal_reminders_delivery_retry_idx
  ON public.renewal_reminders (delivery_status, attempted_at)
  WHERE delivery_status <> 'sent';
-- Gmail OAuth data is stored separately from public-facing gym settings.
-- Client secret and refresh token fields contain AES-GCM ciphertext produced on the server.
CREATE TABLE IF NOT EXISTS public.gym_gmail_oauth (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  client_id text NOT NULL,
  client_secret_ciphertext text NOT NULL,
  refresh_token_ciphertext text,
  sender_email text,
  connected_at timestamptz,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gym_gmail_oauth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gym_gmail_oauth FROM anon, authenticated;
GRANT ALL ON TABLE public.gym_gmail_oauth TO service_role;
-- Payment gateway credentials are kept separate from general gym settings.
-- Values are encrypted by the application before they are written to the database.
CREATE TABLE IF NOT EXISTS public.gym_payment_gateway_credentials (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  razorpay_key_id_ciphertext text,
  razorpay_key_secret_ciphertext text,
  stripe_secret_key_ciphertext text,
  stripe_webhook_secret_ciphertext text,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gym_payment_gateway_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gym_payment_gateway_credentials FROM anon, authenticated;
GRANT ALL ON TABLE public.gym_payment_gateway_credentials TO service_role;
-- Store only whether the hook was configured through Admin Settings.
-- The Supabase PAT is never persisted; the signing secret lives in Supabase's function/auth configuration.
CREATE TABLE IF NOT EXISTS public.gym_send_email_auth_hook (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT false,
  configured_at timestamptz,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gym_send_email_auth_hook ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gym_send_email_auth_hook FROM anon, authenticated;
GRANT ALL ON TABLE public.gym_send_email_auth_hook TO service_role;
CREATE INDEX IF NOT EXISTS idx_payment_events_payment_id ON public.payment_events(payment_id);
CREATE INDEX IF NOT EXISTS idx_attendance_checked_in_at ON public.attendance(checked_in_at);
CREATE INDEX IF NOT EXISTS idx_trainer_assignments_schedule_id ON public.trainer_assignments(schedule_id);

CREATE OR REPLACE FUNCTION public.delete_archived_gym_data(
  p_dataset text,
  p_before timestamptz,
  p_exported_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted jsonb := '{}'::jsonb;
  v_payments integer := 0;
  v_payment_events integer := 0;
  v_attendance integer := 0;
  v_bookings integer := 0;
  v_waitlists integer := 0;
  v_assignments integer := 0;
  v_schedules integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can delete archived gym data';
  END IF;
  IF p_before IS NULL OR p_exported_at IS NULL OR p_before > now() OR p_exported_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Invalid archive cutoff or export timestamp';
  END IF;

  IF p_dataset = 'payments' THEN
    DELETE FROM public.payment_events AS event
    USING public.payments AS payment
    WHERE event.payment_id = payment.id
      AND payment.created_at < p_before
      AND payment.created_at <= p_exported_at
      AND event.created_at <= p_exported_at;
    GET DIAGNOSTICS v_payment_events = ROW_COUNT;

    DELETE FROM public.payments
    WHERE created_at < p_before AND created_at <= p_exported_at;
    GET DIAGNOSTICS v_payments = ROW_COUNT;
    v_deleted := jsonb_build_object('payments', v_payments, 'paymentEvents', v_payment_events);
  ELSIF p_dataset = 'attendance' THEN
    DELETE FROM public.attendance
    WHERE checked_in_at < p_before AND created_at <= p_exported_at;
    GET DIAGNOSTICS v_attendance = ROW_COUNT;
    v_deleted := jsonb_build_object('attendance', v_attendance);
  ELSIF p_dataset = 'classes' THEN
    SELECT count(*) INTO v_schedules
    FROM public.class_schedules
    WHERE starts_at < p_before AND created_at <= p_exported_at;

    DELETE FROM public.trainer_assignments AS assignment
    USING public.class_schedules AS schedule
    WHERE assignment.schedule_id = schedule.id
      AND schedule.starts_at < p_before AND schedule.created_at <= p_exported_at
      AND assignment.created_at <= p_exported_at;
    GET DIAGNOSTICS v_assignments = ROW_COUNT;

    DELETE FROM public.class_waitlists AS waitlist
    USING public.class_schedules AS schedule
    WHERE waitlist.schedule_id = schedule.id
      AND schedule.starts_at < p_before AND schedule.created_at <= p_exported_at
      AND waitlist.joined_at <= p_exported_at;
    GET DIAGNOSTICS v_waitlists = ROW_COUNT;

    DELETE FROM public.class_bookings AS booking
    USING public.class_schedules AS schedule
    WHERE booking.schedule_id = schedule.id
      AND schedule.starts_at < p_before AND schedule.created_at <= p_exported_at
      AND booking.booked_at <= p_exported_at;
    GET DIAGNOSTICS v_bookings = ROW_COUNT;

    v_deleted := jsonb_build_object(
      'schedulesRetained', v_schedules,
      'bookings', v_bookings,
      'waitlists', v_waitlists,
      'trainerAssignments', v_assignments
    );
  ELSE
    RAISE EXCEPTION 'Unsupported archive dataset';
  END IF;

  RETURN jsonb_build_object('dataset', p_dataset, 'deleted', v_deleted);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_archived_gym_data(text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_archived_gym_data(text, timestamptz, timestamptz) TO authenticated;
CREATE TABLE IF NOT EXISTS public.gym_drive_archive_oauth (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  client_id text NOT NULL,
  client_secret_ciphertext text NOT NULL,
  refresh_token_ciphertext text,
  sender_email text,
  folder_id text,
  folder_url text,
  connected_at timestamptz,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gym_drive_archive_oauth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gym_drive_archive_oauth FROM anon, authenticated;
GRANT ALL ON TABLE public.gym_drive_archive_oauth TO service_role;

CREATE TABLE IF NOT EXISTS public.gym_data_archive_runs (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  archive_date date NOT NULL,
  dataset text NOT NULL CHECK (dataset IN ('attendance', 'class_bookings')),
  drive_file_id text NOT NULL,
  drive_file_name text NOT NULL,
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  exported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (archive_date, dataset)
);

ALTER TABLE public.gym_data_archive_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gym_data_archive_runs FROM anon, authenticated;
GRANT ALL ON TABLE public.gym_data_archive_runs TO service_role;
CREATE OR REPLACE FUNCTION public.enroll_member_in_class(
  p_schedule_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS TABLE(outcome text, waitlist_position integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_schedule public.class_schedules%ROWTYPE;
  v_member_id uuid;
  v_booking public.class_bookings%ROWTYPE;
  v_waitlist public.class_waitlists%ROWTYPE;
  v_booked_count integer;
  v_waitlist_position integer;
  v_timezone text;
  v_today date;
BEGIN
  SELECT m.id INTO v_member_id
  FROM public.members AS m
  WHERE m.id = p_member_id AND m.profile_id = p_user_id AND m.status = 'active';
  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'An active member profile is required to enroll in classes';
  END IF;

  SELECT COALESCE((
    SELECT gs.timezone FROM public.gym_settings AS gs ORDER BY gs.updated_at DESC LIMIT 1
  ), 'Asia/Kolkata') INTO v_timezone;
  v_today := (now() AT TIME ZONE v_timezone)::date;
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships AS membership
    WHERE membership.member_id = v_member_id
      AND membership.status = 'active'
      AND membership.starts_on <= v_today
      AND membership.ends_on >= v_today
  ) THEN
    RAISE EXCEPTION 'An active membership is required to enroll in a class';
  END IF;

  SELECT * INTO v_schedule
  FROM public.class_schedules
  WHERE id = p_schedule_id AND status = 'scheduled'
  FOR UPDATE;
  IF NOT FOUND OR v_schedule.starts_at <= now() THEN
    RAISE EXCEPTION 'This class is no longer open for enrollment';
  END IF;

  SELECT * INTO v_booking FROM public.class_bookings
  WHERE schedule_id = p_schedule_id AND member_id = v_member_id;
  SELECT * INTO v_waitlist FROM public.class_waitlists
  WHERE schedule_id = p_schedule_id AND member_id = v_member_id;

  IF v_booking.id IS NOT NULL AND v_booking.status <> 'cancelled' THEN
    RETURN QUERY SELECT 'already_booked'::text, NULL::integer;
    RETURN;
  END IF;

  SELECT count(*)::integer INTO v_booked_count
  FROM public.class_bookings
  WHERE schedule_id = p_schedule_id AND status = 'booked';

  IF v_waitlist.id IS NOT NULL THEN
    SELECT min(position) INTO v_waitlist_position
    FROM public.class_waitlists WHERE schedule_id = p_schedule_id;
    IF v_booked_count < v_schedule.capacity AND v_waitlist.position = v_waitlist_position THEN
      DELETE FROM public.class_waitlists WHERE id = v_waitlist.id;
      IF v_booking.id IS NULL THEN
        INSERT INTO public.class_bookings(schedule_id, member_id, status)
        VALUES (p_schedule_id, v_member_id, 'booked');
      ELSE
        UPDATE public.class_bookings SET status = 'booked', booked_at = now(), cancelled_at = NULL
        WHERE id = v_booking.id;
      END IF;
      RETURN QUERY SELECT 'booked'::text, NULL::integer;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'waitlisted'::text, v_waitlist.position;
    RETURN;
  END IF;

  IF v_booked_count < v_schedule.capacity AND NOT EXISTS (
    SELECT 1 FROM public.class_waitlists WHERE schedule_id = p_schedule_id
  ) THEN
    IF v_booking.id IS NULL THEN
      INSERT INTO public.class_bookings(schedule_id, member_id, status)
      VALUES (p_schedule_id, v_member_id, 'booked');
    ELSE
      UPDATE public.class_bookings SET status = 'booked', booked_at = now(), cancelled_at = NULL
      WHERE id = v_booking.id;
    END IF;
    RETURN QUERY SELECT 'booked'::text, NULL::integer;
    RETURN;
  END IF;

  SELECT COALESCE(max(position), 0) + 1 INTO v_waitlist_position
  FROM public.class_waitlists WHERE schedule_id = p_schedule_id;
  INSERT INTO public.class_waitlists(schedule_id, member_id, position)
  VALUES (p_schedule_id, v_member_id, v_waitlist_position);
  RETURN QUERY SELECT 'waitlisted'::text, v_waitlist_position;
END;
$$;

REVOKE ALL ON FUNCTION public.enroll_member_in_class(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enroll_member_in_class(uuid, uuid, uuid) TO service_role;
CREATE TABLE IF NOT EXISTS public.essl_webhook_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  token_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.essl_webhook_config ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.essl_webhook_config TO service_role;

CREATE TABLE IF NOT EXISTS public.essl_member_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES public.access_devices(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  device_user_id text NOT NULL CHECK (length(btrim(device_user_id)) BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, device_user_id)
);
CREATE INDEX IF NOT EXISTS essl_member_mappings_member_idx ON public.essl_member_mappings (member_id);
CREATE INDEX IF NOT EXISTS essl_member_mappings_device_active_idx ON public.essl_member_mappings (device_id, active);
ALTER TABLE public.essl_member_mappings ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.essl_member_mappings TO service_role;
DROP POLICY IF EXISTS essl_member_mappings_admin_all ON public.essl_member_mappings;
CREATE POLICY essl_member_mappings_admin_all ON public.essl_member_mappings
  FOR ALL TO authenticated
  USING (private.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));
DROP TRIGGER IF EXISTS essl_member_mappings_updated ON public.essl_member_mappings;
CREATE TRIGGER essl_member_mappings_updated
  BEFORE UPDATE ON public.essl_member_mappings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
