import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { getGymBranding } from "@/lib/gym.functions";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [
    { title: "Reset password | GYM MANAGER" },
    { name: "description", content: "Set a new password for your gym account." },
    { property: "og:title", content: "Reset password | GYM MANAGER" },
    { property: "og:description", content: "Secure account recovery for your gym account." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ]}),
  component: ResetPassword,
});

function ResetPassword() {
  const navigate = useNavigate();
  const loadBranding = useServerFn(getGymBranding);
  const { data: branding } = useQuery({ queryKey: ["gym-branding"], queryFn: () => loadBranding() });
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const recovery = window.location.hash.includes("type=recovery");
    supabase.auth.getSession().then(({ data }) => setReady(recovery || Boolean(data.session)));
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const values = new FormData(e.currentTarget);
    const password = String(values.get("password") ?? "");
    const confirm = String(values.get("confirm") ?? "");
    if (password.length < 8) { setError("Use at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords do not match."); return; }
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) setError(updateError.message);
    else {
      setMessage("Password updated. Taking you to your dashboard…");
      setTimeout(() => navigate({ to: "/dashboard" }), 900);
    }
  }

  return <main className="grid min-h-screen place-items-center bg-auth p-5"><section className="w-full max-w-md panel p-7 sm:p-9">
    <Link to="/" className="mb-8 flex items-center gap-3">
      {branding?.logo_url ? <img src={branding.logo_url} alt="" className="size-10 rounded-md bg-white object-contain" /> : <span className="grid size-10 place-items-center rounded-md bg-primary px-1 text-center text-[7px] font-extrabold leading-tight text-primary-foreground">GYM<br/>MANAGER</span>}
      <span className="font-display text-lg font-bold uppercase">{branding?.gym_name || "GYM MANAGER"}</span>
    </Link>
    <h1 className="font-display text-3xl font-bold uppercase">Choose a new password</h1>
    <p className="mt-2 text-sm text-muted-foreground">Use a strong password you have not used before.</p>
    {!ready ? <p className="mt-7 rounded-md bg-warning-soft p-3 text-sm text-warning">Open this page from the password-reset link in your email.</p> : <form className="mt-7 space-y-5" onSubmit={submit}>
      <label className="block"><span className="form-label">New password</span><input className="form-input" type="password" name="password" minLength={8} maxLength={72} required /></label>
      <label className="block"><span className="form-label">Confirm password</span><input className="form-input" type="password" name="confirm" minLength={8} maxLength={72} required /></label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="flex gap-2 text-sm text-success"><CheckCircle2 size={17}/>{message}</p>}
      <Button className="w-full">Update password</Button>
    </form>}
  </section></main>;
}