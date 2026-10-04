import { useState, type FormEvent } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { completeProfile, getGymBranding } from "@/lib/gym.functions";
import { signOut } from "@/lib/sign-out";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({ meta: [
    { title: "Complete your profile | GYM MANAGER" },
    { name: "description", content: "Add your details to complete your gym profile." },
    { property: "og:title", content: "Complete your profile | GYM MANAGER" },
    { property: "og:description", content: "Add your details to complete your profile." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ]}),
  loader: async () => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data } = await supabase.from("profiles").select("*").eq("id", user!.id).single();
    return data!;
  },
  errorComponent: ({ error }) => <p className="p-8 text-sm text-destructive">{error.message}</p>,
  component: Onboarding,
});

function Onboarding() {
  const profile = Route.useLoaderData();
  const navigate = useNavigate(); const router = useRouter();
  const loadBranding = useServerFn(getGymBranding); const { data: branding } = useQuery({ queryKey: ["gym-branding"], queryFn: () => loadBranding() });
  const save = useServerFn(completeProfile);
  const [illness, setIllness] = useState<boolean | null>(profile.has_illness);
  const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  
  const run = async (k: string, fn: () => Promise<void>) => { setBusy(k); setError(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong"); } setBusy(""); };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    if (illness === null) return setError("Please tell us about any illness condition.");
    await run("save", async () => {
      await save({ data: { display_name: String(f.get("name")), phone: String(f.get("phone") ?? ""), address: String(f.get("address")), gender: String(f.get("gender")) as "male", has_illness: illness, medical_notes: String(f.get("notes") ?? "") } });
      await router.invalidate(); navigate({ to: "/dashboard" });
    });
  }

  return <main className="min-h-screen bg-auth p-5 sm:p-10"><div className="mx-auto max-w-xl">
    <div className="mb-8 flex items-center justify-between"><span className="flex items-center gap-3">{branding?.logo_url?<img src={branding.logo_url} alt="" className="size-10 rounded-md bg-white object-contain"/>:<span className="grid size-10 place-items-center rounded-md bg-primary px-1 text-center text-[7px] font-extrabold leading-tight text-primary-foreground">GYM<br/>MANAGER</span>}<span className="font-display text-lg font-bold uppercase">{branding?.gym_name || "GYM MANAGER"}</span></span><Button variant="ghost" size="sm" onClick={signOut}>Sign out</Button></div>
    <p className="text-xs font-bold uppercase text-primary">Profile setup</p>
    <h1 className="mt-2 font-display text-4xl font-bold uppercase">Complete your profile</h1>
    <p className="mt-2 text-sm text-muted-foreground">Add your details before choosing a membership. A phone number is optional.</p>
    <form onSubmit={submit} className="panel mt-8 space-y-5 p-6">
      <label className="block"><span className="form-label">Full name</span><input name="name" required minLength={2} maxLength={100} defaultValue={profile.display_name} className="form-input"/></label>
      <label className="block"><span className="form-label">Phone number (optional)</span><input name="phone" type="tel" maxLength={30} defaultValue={profile.phone ?? ""} placeholder="Phone number for contact" className="form-input"/></label>
      <label className="block"><span className="form-label">Communication address</span><textarea name="address" required minLength={5} maxLength={500} defaultValue={profile.address ?? ""} rows={3} className="form-input h-auto py-2"/></label>
      <label className="block"><span className="form-label">Gender</span><select name="gender" required defaultValue={profile.gender ?? ""} className="form-input"><option value="" disabled>Select</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></label>
      <div><span className="form-label">Any illness or medical condition?</span><div className="flex gap-2">{[true,false].map(v=><Button key={String(v)} type="button" variant={illness===v?"default":"outline"} onClick={()=>setIllness(v)}>{v?"Yes":"No"}</Button>)}</div></div>
      {illness && <label className="block"><span className="form-label">Please describe (optional)</span><textarea name="notes" maxLength={1000} defaultValue={profile.medical_notes ?? ""} rows={2} className="form-input h-auto py-2"/></label>}
      {error && <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>}
      <Button className="w-full" disabled={busy==="save"}>{busy==="save"?<Loader2 className="animate-spin" size={18}/>:"Save and continue"}</Button>
    </form>
  </div></main>;
}
