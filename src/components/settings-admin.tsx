import { useEffect, useState, type FormEvent, type ChangeEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, CreditCard, ExternalLink, HardDrive, ImagePlus, Loader2, Mail, RefreshCw, Save, Trash2, Unplug, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { configureSendEmailAuthHook, disconnectDriveArchive, disconnectPaymentGateway, getDriveArchiveSettings, getGymSettings, getGmailOAuthSettings, getPaymentGatewaySettings, getSendEmailAuthHookSettings, runDriveArchiveNow, saveGymSettings, savePaymentGatewayCredentials, beginDriveArchiveOAuth, beginGmailOAuth, disconnectGmailOAuth } from "@/lib/gym.functions";
import { CURRENCIES, GYM_COUNTRIES, type CountryCode, type CurrencyCode } from "@/lib/currency";

const MAX_LOGO_SIZE = 2 * 1024 * 1024;
const ACCEPTED_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const THEMES = [
  { id: "forge-green", name: "Green", color: "#8bdd20", foreground: "#17200b" },
  { id: "ocean-blue", name: "Ocean Blue", color: "#2875d6", foreground: "#ffffff" },
  { id: "ember-orange", name: "Ember Orange", color: "#d88720", foreground: "#251603" },
  { id: "violet", name: "Violet", color: "#8052cf", foreground: "#ffffff" },
  { id: "rose", name: "Rose", color: "#d33b65", foreground: "#ffffff" },
] as const;
type ThemeId = (typeof THEMES)[number]["id"];

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read the logo file."));
    reader.onerror = () => reject(new Error("Could not read the logo file."));
    reader.readAsDataURL(file);
  });
}

export function SettingsAdmin() {
  const queryClient = useQueryClient();
  const loadSettings = useServerFn(getGymSettings);
  const saveSettings = useServerFn(saveGymSettings);
  const settings = useQuery({ queryKey: ["gym-settings"], queryFn: () => loadSettings() });
  const [logoDataUrl, setLogoDataUrl] = useState("");
  const [clearLogo, setClearLogo] = useState(false);
  const [selectedTheme, setSelectedTheme] = useState<ThemeId>("forge-green");
  const [selectedCurrency, setSelectedCurrency] = useState<CurrencyCode>("INR");
  const [selectedCountry, setSelectedCountry] = useState<CountryCode>("IN");
  const [selectedGateway, setSelectedGateway] = useState<"razorpay" | "stripe">("razorpay");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const savedTheme = THEMES.find((theme) => theme.id === settings.data?.color_theme);
    if (savedTheme) setSelectedTheme(savedTheme.id);
  }, [settings.data?.color_theme]);

  useEffect(() => {
    const savedCurrency = CURRENCIES.find((currency) => currency.code === settings.data?.currency);
    if (savedCurrency) setSelectedCurrency(savedCurrency.code);
  }, [settings.data?.currency]);

  useEffect(() => {
    const savedCountry = GYM_COUNTRIES.find((country) => country.code === settings.data?.country_code);
    if (savedCountry) setSelectedCountry(savedCountry.code);
    if (settings.data?.payment_gateway === "stripe" || settings.data?.payment_gateway === "razorpay") {
      setSelectedGateway(settings.data.payment_gateway);
    }
  }, [settings.data?.country_code, settings.data?.payment_gateway]);

  async function pickLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setError("");
    setMessage("");
    if (!ACCEPTED_LOGO_TYPES.includes(file.type)) {
      setError("Choose a PNG, JPG, or WebP image.");
      return;
    }
    if (file.size > MAX_LOGO_SIZE) {
      setError("The logo must be smaller than 2 MB.");
      return;
    }
    try {
      setLogoDataUrl(await readAsDataUrl(file));
      setClearLogo(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the logo file.");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await saveSettings({
        data: {
          gym_name: String(form.get("gymName")),
          app_title: String(form.get("appTitle")),
          color_theme: selectedTheme,
          currency: selectedCurrency,
          country_code: selectedCountry,
          payment_gateway: selectedGateway,
          ...(logoDataUrl ? { logoDataUrl } : {}),
          clearLogo,
        },
      });
      setLogoDataUrl("");
      setClearLogo(false);
      setMessage("Branding settings saved.");
      await queryClient.invalidateQueries({ queryKey: ["gym-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["gym-branding"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  const previewUrl = clearLogo ? "" : logoDataUrl || settings.data?.logo_url || "";

  if (settings.isLoading) {
    return <section className="panel flex min-h-64 items-center justify-center p-6"><Loader2 className="animate-spin text-primary" size={22}/><span className="ml-3 text-sm text-muted-foreground">Loading gym settings…</span></section>;
  }

  if (settings.isError || !settings.data) {
    return <section className="panel p-6"><h2 className="section-title">Gym branding</h2><p className="mt-3 text-sm text-destructive">{settings.error instanceof Error ? settings.error.message : "Could not load gym settings."}</p></section>;
  }

  return <section className="panel max-w-4xl p-5 md:p-7">
    <div className="mb-6 border-b border-border pb-5">
      <h2 className="section-title">Gym branding</h2>
      <p className="section-subtitle">Update the name, logo, browser tab title, colors, and currency presentation used throughout the web app.</p>
    </div>

    <form key={`${settings.data.gym_name}:${settings.data.app_title}:${settings.data.logo_url ?? ""}:${settings.data.color_theme}:${settings.data.currency}:${settings.data.country_code}:${settings.data.payment_gateway}`} onSubmit={submit} className="space-y-6">
      <label className="block">
        <span className="form-label">Gym name</span>
        <input name="gymName" required minLength={2} maxLength={100} defaultValue={settings.data.gym_name} className="form-input" />
        <span className="mt-1 block text-xs text-muted-foreground">Shown in the admin and member app navigation.</span>
      </label>

      <div>
        <span className="form-label">Gym logo</span>
        <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-muted/30 p-4">
          <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-card">
            {previewUrl ? <img src={previewUrl} alt="Gym logo preview" className="size-full object-contain" /> : <span className="text-center text-[8px] font-extrabold leading-tight text-primary">GYM<br/>MANAGER</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-border bg-background px-4 text-sm font-semibold transition-colors hover:bg-accent">
              <ImagePlus size={16}/>{previewUrl ? "Replace logo" : "Upload logo"}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={pickLogo} />
            </label>
            {previewUrl && <Button type="button" variant="outline" onClick={() => { setLogoDataUrl(""); setClearLogo(true); }}><Trash2 size={15}/>Remove logo</Button>}
          </div>
          <p className="w-full text-xs text-muted-foreground">PNG, JPG, or WebP. Maximum file size: 2 MB.</p>
        </div>
      </div>

      <fieldset>
        <legend className="form-label">Color theme</legend>
        <p className="mb-3 text-xs text-muted-foreground">Choose the accent colors used across the admin and member app. Changes apply after you save.</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Color theme">
          {THEMES.map((theme) => <label key={theme.id} className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 transition-colors ${selectedTheme === theme.id ? "border-primary bg-secondary" : "border-border hover:bg-muted/50"}`}>
            <input type="radio" name="colorTheme" value={theme.id} checked={selectedTheme === theme.id} onChange={() => setSelectedTheme(theme.id)} className="peer sr-only" />
            <span className="grid size-9 shrink-0 place-items-center rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-ring" style={{ backgroundColor: theme.color, color: theme.foreground }}><span className="text-sm font-bold">A</span></span>
            <span><span className="block text-sm font-semibold">{theme.name}</span><span className="mt-1 flex gap-1" aria-hidden="true">{[theme.color, theme.foreground, "var(--secondary)"].map((color, index) => <span key={index} className="size-3 rounded-full border border-border/70" style={{ backgroundColor: color }} />)}</span></span>
          </label>)}
        </div>
      </fieldset>

      <label className="block max-w-md">
        <span className="form-label">Gym country</span>
        <select name="country" value={selectedCountry} onChange={(event) => {
          const country = GYM_COUNTRIES.find((item) => item.code === event.target.value);
          if (!country) return;
          setSelectedCountry(country.code);
          setSelectedCurrency(country.currency);
          if (country.code !== "IN" && selectedGateway === "razorpay") setSelectedGateway("stripe");
          if (country.code === "IN" && selectedGateway === "razorpay") setSelectedCurrency("INR");
        }} className="form-input">
          {GYM_COUNTRIES.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
        </select>
      </label>

      <label className="block max-w-md">
        <span className="form-label">Billing currency</span>
        <select name="currency" value={selectedCurrency} onChange={(event) => setSelectedCurrency(event.target.value as CurrencyCode)} disabled={selectedGateway === "razorpay"} className="form-input">
          {CURRENCIES.map((currency) => <option key={currency.code} value={currency.code}>{currency.name} ({currency.code})</option>)}
        </select>
        <span className="mt-1 block text-xs text-muted-foreground">New plan prices, coupons, and payments use this currency. Changing it reinterprets existing numeric plan and flat-coupon values without converting them; review prices before switching. Historical payments keep their recorded currency.</span>
      </label>

      <label className="block max-w-md">
        <span className="form-label">Member payment gateway</span>
        <select name="paymentGateway" value={selectedGateway} onChange={(event) => {
          const gateway = event.target.value as "razorpay" | "stripe";
          setSelectedGateway(gateway);
          if (gateway === "razorpay") setSelectedCurrency("INR");
        }} className="form-input">
          <option value="razorpay" disabled={selectedCountry !== "IN"}>Razorpay{selectedCountry === "IN" ? " (recommended for India)" : " (India only; select Stripe outside India)"}</option>
          <option value="stripe">Stripe</option>
        </select>
        <span className="mt-1 block text-xs text-muted-foreground">Configure the selected gateway’s credentials in the integration section below before members check out.</span>
      </label>

      <label className="block">
        <span className="form-label">Web app title</span>
        <input name="appTitle" required minLength={2} maxLength={100} defaultValue={settings.data.app_title} className="form-input" />
        <span className="mt-1 block text-xs text-muted-foreground">Shown as the browser tab title when an app page is open.</span>
      </label>

      {(error || message) && <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-destructive" : "text-success"}`}>{error || message}</p>}
      <div className="flex justify-end border-t border-border pt-5">
        <Button disabled={busy}>{busy ? <Loader2 className="animate-spin" size={16}/> : <Save size={16}/>}Save settings</Button>
      </div>
    </form>
    <PaymentGatewaySettings />
    <GmailOAuthSettings />
    <GoogleDriveArchiveSettings />
    <SendEmailAuthHookSettings />
  </section>;
}

function GoogleDriveArchiveSettings() {
  const queryClient = useQueryClient();
  const loadSettings = useServerFn(getDriveArchiveSettings);
  const beginOAuth = useServerFn(beginDriveArchiveOAuth);
  const disconnect = useServerFn(disconnectDriveArchive);
  const runArchive = useServerFn(runDriveArchiveNow);
  const settings = useQuery({ queryKey: ["drive-archive-settings"], queryFn: () => loadSettings() });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("driveArchiveOAuth");
    if (!outcome) return;
    const messages: Record<string, string> = {
      connected: "Google Drive connected. Daily attendance and class booking CSV exports are ready.",
      denied: "Google authorization was cancelled. Existing archive settings were left unchanged.",
      invalid: "The Google Drive authorization request was invalid or expired. Start again from Settings.",
      admin_required: "The administrator account could not be confirmed. Sign in again and retry.",
      setup_missing: "Google Drive OAuth settings were removed before authorization completed. Start again from Settings.",
      exchange_failed: "Google could not exchange the authorization code. Check the OAuth client and callback URL.",
      scope_missing: "Google Drive file access was not granted. Reconnect and approve the requested permission.",
      email_missing: "Google did not return a verified account email. Reconnect with a Google account.",
      refresh_missing: "Google did not issue an offline refresh token. Reconnect and approve access again.",
      folder_failed: "Google authorization succeeded, but the archive folder could not be created. Confirm the Google Drive API is enabled.",
      failed: "Google Drive could not be connected. Verify Google Cloud OAuth setup and retry.",
    };
    if (outcome === "connected") void queryClient.invalidateQueries({ queryKey: ["drive-archive-settings"] });
    setNotice(messages[outcome] || "Google Drive setup finished.");
    const url = new URL(window.location.href);
    url.searchParams.delete("driveArchiveOAuth");
    window.history.replaceState({}, "", url.toString());
  }, [queryClient]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy("connect"); setError(""); setNotice("");
    try {
      const result = await beginOAuth({ data: { clientId: String(form.get("driveClientId") || ""), clientSecret: String(form.get("driveClientSecret") || "") } });
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start Google Drive authorization.");
      setBusy("");
    }
  }

  async function disconnectDrive() {
    setBusy("disconnect"); setError(""); setNotice("");
    try {
      await disconnect();
      await queryClient.invalidateQueries({ queryKey: ["drive-archive-settings"] });
      setNotice("Google Drive disconnected. Existing archive files remain in Drive.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect Google Drive.");
    } finally { setBusy(""); }
  }

  async function archiveNow() {
    setBusy("archive"); setError(""); setNotice("");
    try {
      const result = await runArchive();
      const summary = result.results.map((entry) => `${entry.dataset}: ${entry.rows} rows${entry.skipped ? " (already archived)" : ""}`).join(" · ");
      setNotice(`Archive for ${result.archiveDate} finished. ${summary}.`);
      await queryClient.invalidateQueries({ queryKey: ["drive-archive-settings"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not run the archive.");
    } finally { setBusy(""); }
  }

  if (settings.isLoading) return <div className="mt-8 flex items-center gap-3 border-t border-border pt-6 text-sm text-muted-foreground"><Loader2 className="animate-spin" size={17}/>Loading Google Drive archive settings…</div>;
  if (settings.isError || !settings.data) return <div className="mt-8 border-t border-border pt-6"><h3 className="font-semibold">Google Drive data archive</h3><p className="mt-2 text-sm text-destructive">{settings.error instanceof Error ? settings.error.message : "Could not load Drive archive settings."}</p></div>;

  const current = settings.data;
  return <div className="mt-8 border-t border-border pt-6">
    <div className="mb-5 flex items-start gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><HardDrive size={19}/></span>
      <div><h3 className="font-display text-lg font-bold">Daily data archive to Google Drive</h3><p className="mt-1 text-sm text-muted-foreground">Automatically export daily attendance and class booking history as CSV files to a private Drive folder. Source records stay in Supabase.</p></div>
    </div>
    {current.configured ? <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-success/30 bg-success-soft px-4 py-3">
      <div className="text-sm"><div className="flex items-center gap-2"><CheckCircle2 className="text-success" size={17}/><span><strong>{current.senderEmail}</strong> is connected</span></div>{current.folderUrl && <a className="ml-6 inline-block text-xs font-semibold text-primary hover:underline" href={current.folderUrl} target="_blank" rel="noreferrer">Open archive folder <ExternalLink className="inline" size={12}/></a>}</div>
      <div className="flex gap-2"><Button type="button" variant="outline" disabled={busy !== ""} onClick={() => void archiveNow()}>{busy === "archive" ? <Loader2 className="animate-spin" size={15}/> : <RefreshCw size={15}/>}Run archive now</Button><Button type="button" variant="outline" disabled={busy !== ""} onClick={() => void disconnectDrive()}><Unplug size={15}/>Disconnect</Button></div>
    </div> : <p className="mb-4 rounded-md border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">Connect Google Drive to enable scheduled CSV archives. Once connected, the Netlify job runs daily at 03:15 UTC and archives the previous day using the gym timezone.</p>}
    <form key={`${current.clientId}:${current.configured}`} onSubmit={(event) => void connect(event)} className="space-y-4">
      <label className="block max-w-2xl"><span className="form-label">Google OAuth Web client ID</span><input name="driveClientId" type="text" required maxLength={300} defaultValue={current.clientId} placeholder="...apps.googleusercontent.com" className="form-input" autoComplete="off"/><span className="mt-1 block text-xs text-muted-foreground">Reuse your Gmail OAuth Web client if you already created one. Enable the Google Drive API in that same Google Cloud project.</span></label>
      <label className="block max-w-2xl"><span className="form-label">Google OAuth client secret</span><input name="driveClientSecret" type="password" maxLength={500} required={!current.clientId} placeholder={current.clientId ? "Leave blank to keep saved" : "Paste the client secret"} className="form-input" autoComplete="new-password"/><span className="mt-1 block text-xs text-muted-foreground">The secret and refresh token are encrypted and stored server-side.</span></label>
      <div className="max-w-2xl rounded-md border border-border bg-muted/30 p-4"><p className="text-sm font-semibold">Authorized redirect URI</p><code className="mt-2 block break-all text-xs text-foreground">{current.callbackUrl || "Loading callback URL…"}</code><p className="mt-2 text-xs text-muted-foreground">Add this exact URI to the OAuth client’s authorized redirect URIs in Google Cloud.</p></div>
      <div className="max-w-2xl rounded-md border border-border bg-muted/30 p-4 text-xs leading-5 text-muted-foreground">The schedule is provided by Netlify; no Supabase Cron setup is needed. Exports contain member identifiers, names, email addresses, attendance details, and booking details. Restrict access to the connected Google account and archive folder.</div>
      {(error || notice) && <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-destructive" : "text-success"}`}>{error || notice}</p>}
      <div className="flex flex-wrap items-center gap-3"><Button disabled={busy !== ""}>{busy === "connect" ? <Loader2 className="animate-spin" size={16}/> : <ExternalLink size={16}/>} {current.configured ? "Reconnect Google Drive" : "Save credentials and connect Drive"}</Button><a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer" className="text-sm font-semibold text-primary hover:underline">Open Google Drive API <ExternalLink className="inline" size={13}/></a></div>
    </form>
    {current.recentRuns.length > 0 && <div className="mt-6 border-t border-border pt-5"><h4 className="text-sm font-semibold">Recent archive files</h4><div className="mt-2 space-y-2">{current.recentRuns.map((run) => <div key={`${run.archive_date}:${run.dataset}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"><span>{run.archive_date} · {run.dataset.replace("_", " ")} · {run.row_count} rows</span><a className="font-semibold text-primary hover:underline" href={run.url} target="_blank" rel="noreferrer">{run.drive_file_name} <ExternalLink className="inline" size={12}/></a></div>)}</div></div>}
  </div>;
}

function PaymentGatewaySettings() {
  const queryClient = useQueryClient();
  const loadSettings = useServerFn(getPaymentGatewaySettings);
  const saveCredentials = useServerFn(savePaymentGatewayCredentials);
  const disconnect = useServerFn(disconnectPaymentGateway);
  const settings = useQuery({ queryKey: ["payment-gateway-settings"], queryFn: () => loadSettings() });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function save(provider: "razorpay" | "stripe", event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(provider); setError(""); setNotice("");
    try {
      await saveCredentials({ data: {
        provider,
        keyId: String(values.get("keyId") || ""),
        keySecret: String(values.get("keySecret") || ""),
        webhookSecret: String(values.get("webhookSecret") || ""),
      } });
      form.reset();
      await queryClient.invalidateQueries({ queryKey: ["payment-gateway-settings"] });
      setNotice(`${provider === "razorpay" ? "Razorpay" : "Stripe"} credentials saved securely.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save payment gateway credentials.");
    } finally { setBusy(""); }
  }

  async function remove(provider: "razorpay" | "stripe") {
    setBusy(provider); setError(""); setNotice("");
    try {
      await disconnect({ data: { provider } });
      await queryClient.invalidateQueries({ queryKey: ["payment-gateway-settings"] });
      setNotice(`${provider === "razorpay" ? "Razorpay" : "Stripe"} credentials removed from Settings.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove gateway credentials.");
    } finally { setBusy(""); }
  }

  if (settings.isLoading) return <div className="mt-8 flex items-center gap-3 border-t border-border pt-6 text-sm text-muted-foreground"><Loader2 className="animate-spin" size={17}/>Loading payment gateway settings…</div>;
  if (settings.isError || !settings.data) return <div className="mt-8 border-t border-border pt-6"><h3 className="font-semibold">Payment gateway integrations</h3><p className="mt-2 text-sm text-destructive">{settings.error instanceof Error ? settings.error.message : "Could not load payment gateway settings."}</p></div>;

  const current = settings.data;
  return <div className="mt-8 border-t border-border pt-6">
    <div className="mb-5 flex items-start gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><CreditCard size={19}/></span>
      <div><h3 className="font-display text-lg font-bold">Payment gateway integrations</h3><p className="mt-1 text-sm text-muted-foreground">Save the API credentials used for member checkout. Credentials are encrypted on the server and never returned to this page.</p></div>
    </div>
    {(error || notice) && <p role={error ? "alert" : "status"} className={`mb-4 text-sm ${error ? "text-destructive" : "text-success"}`}>{error || notice}</p>}
    <div className="grid gap-5 lg:grid-cols-2">
      <article className="rounded-lg border border-border p-4">
        <div className="mb-4 flex items-center justify-between gap-3"><h4 className="font-semibold">Razorpay</h4><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${current.razorpayConfigured ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"}`}>{current.razorpayConfigured ? `Connected${current.razorpaySource === "environment" ? " · deployment" : ""}` : "Not connected"}</span></div>
        <form onSubmit={(event) => save("razorpay", event)} className="space-y-3">
          <label className="block"><span className="form-label">Razorpay Key ID</span><input name="keyId" type="password" autoComplete="new-password" maxLength={300} required placeholder={current.razorpayConfigured ? "Re-enter Key ID to save or rotate the pair" : "rzp_test_… or rzp_live_…"} className="form-input" /></label>
          <label className="block"><span className="form-label">Razorpay Key Secret</span><input name="keySecret" type="password" autoComplete="new-password" maxLength={1000} required placeholder={current.razorpayConfigured ? "Re-enter Key Secret to save or rotate the pair" : "Enter the Key Secret"} className="form-input" /></label>
          <p className="text-xs text-muted-foreground">Razorpay checkout is available for gyms in India using INR. Enter both matching keys together.</p>
          <div className="flex flex-wrap gap-2"><Button disabled={busy !== ""}>{busy === "razorpay" ? <Loader2 className="animate-spin" size={15}/> : <Save size={15}/>}Save Razorpay keys</Button>{current.razorpaySource === "settings" && <Button type="button" variant="outline" disabled={busy !== ""} onClick={() => void remove("razorpay")}><Unplug size={15}/>Remove saved keys</Button>}</div>
        </form>
      </article>

      <article className="rounded-lg border border-border p-4">
        <div className="mb-4 flex items-center justify-between gap-3"><h4 className="font-semibold">Stripe</h4><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${current.stripeConfigured && current.stripeWebhookConfigured ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"}`}>{current.stripeConfigured && current.stripeWebhookConfigured ? `Connected${current.stripeSource === "environment" || current.stripeWebhookSource === "environment" ? " · deployment" : ""}` : "Needs setup"}</span></div>
        <form onSubmit={(event) => save("stripe", event)} className="space-y-3">
          <label className="block"><span className="form-label">Stripe Secret Key</span><input name="keySecret" type="password" autoComplete="new-password" maxLength={1000} required={!current.stripeConfigured} placeholder={current.stripeConfigured ? "Leave blank to keep saved" : "sk_test_… or sk_live_…"} className="form-input" /></label>
          <label className="block"><span className="form-label">Stripe webhook signing secret</span><input name="webhookSecret" type="password" autoComplete="new-password" maxLength={1000} required={!current.stripeWebhookConfigured} placeholder={current.stripeWebhookConfigured ? "Leave blank to keep saved" : "whsec_…"} className="form-input" /></label>
          <div className="rounded-md border border-border bg-muted/30 p-3"><span className="text-xs font-semibold">Webhook endpoint URL</span><code className="mt-1 block break-all text-xs">{current.stripeWebhookUrl || "Set APP_URL to display this URL."}</code><span className="mt-1 block text-xs text-muted-foreground">Enable checkout.session.completed and checkout.session.async_payment_succeeded events.</span></div>
          <div className="flex flex-wrap gap-2"><Button disabled={busy !== ""}>{busy === "stripe" ? <Loader2 className="animate-spin" size={15}/> : <Save size={15}/>}Save Stripe keys</Button>{(current.stripeSource === "settings" || current.stripeWebhookSource === "settings") && <Button type="button" variant="outline" disabled={busy !== ""} onClick={() => void remove("stripe")}><Unplug size={15}/>Remove saved keys</Button>}</div>
        </form>
      </article>
    </div>
  </div>;
}

function GmailOAuthSettings() {
  const queryClient = useQueryClient();
  const loadOAuthSettings = useServerFn(getGmailOAuthSettings);
  const beginOAuth = useServerFn(beginGmailOAuth);
  const disconnect = useServerFn(disconnectGmailOAuth);
  const oauthSettings = useQuery({ queryKey: ["gmail-oauth-settings"], queryFn: () => loadOAuthSettings() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("gmailOAuth");
    if (!outcome) return;
    const notices: Record<string, string> = {
      connected: "Gmail connected. Renewal reminders can now be sent from this account.",
      denied: "Google authorization was cancelled. Any previous Gmail connection is unchanged.",
      invalid: "The authorization request was invalid or expired. Start again from Settings.",
      admin_required: "The administrator account could not be confirmed. Sign in again and retry.",
      setup_missing: "OAuth settings were removed before authorization completed. Start again from Settings.",
      exchange_failed: "Google could not exchange the authorization code. Check the OAuth client and callback URL, then retry.",
      scope_missing: "Gmail send permission was not granted. Reconnect and allow the requested permission.",
      email_missing: "Google did not return a verified sender email. Reconnect with a Gmail account.",
      refresh_missing: "Google did not issue an offline refresh token. Reconnect and approve access again.",
      failed: "Gmail could not be connected. Verify Google Cloud OAuth setup and retry.",
    };
    if (outcome === "connected") void queryClient.invalidateQueries({ queryKey: ["gmail-oauth-settings"] });
    setNotice(notices[outcome] || "Gmail OAuth setup finished.");
    const url = new URL(window.location.href);
    url.searchParams.delete("gmailOAuth");
    window.history.replaceState({}, "", url.toString());
  }, [queryClient]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await beginOAuth({ data: { clientId: String(form.get("gmailClientId") || ""), clientSecret: String(form.get("gmailClientSecret") || "") } });
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start Gmail authorization.");
      setBusy(false);
    }
  }

  async function disconnectAccount() {
    setBusy(true); setError(""); setNotice("");
    try {
      await disconnect();
      await queryClient.invalidateQueries({ queryKey: ["gmail-oauth-settings"] });
      setNotice("Gmail disconnected. Renewal reminders will remain unsent until an account is connected again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect Gmail.");
    } finally { setBusy(false); }
  }

  if (oauthSettings.isLoading) return <div className="mt-8 flex items-center gap-3 border-t border-border pt-6 text-sm text-muted-foreground"><Loader2 className="animate-spin" size={17}/>Loading reminder email settings…</div>;
  if (oauthSettings.isError || !oauthSettings.data) return <div className="mt-8 border-t border-border pt-6"><h3 className="font-semibold">Reminder email sender</h3><p className="mt-2 text-sm text-destructive">{oauthSettings.error instanceof Error ? oauthSettings.error.message : "Could not load Gmail OAuth settings."}</p></div>;

  const current = oauthSettings.data;
  return <div className="mt-8 border-t border-border pt-6">
    <div className="mb-5 flex items-start gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><Mail size={19}/></span>
      <div><h3 className="font-display text-lg font-bold">Membership reminder email</h3><p className="mt-1 text-sm text-muted-foreground">Connect the Gmail account that should send scheduled and manual membership renewal reminders.</p></div>
    </div>
    {current.configured ? <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-success/30 bg-success-soft px-4 py-3">
      <div className="flex items-center gap-2 text-sm"><CheckCircle2 className="text-success" size={17}/><span><strong>{current.senderEmail}</strong> is connected</span></div>
      <Button type="button" variant="outline" disabled={busy} onClick={disconnectAccount}><Unplug size={15}/>Disconnect</Button>
    </div> : <p className="mb-4 rounded-md border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">No Gmail account is connected. Automatic and manual renewal reminder emails are currently unavailable.</p>}
    <form key={`${current.clientId}:${current.configured}`} onSubmit={connect} className="space-y-4">
      <label className="block max-w-2xl"><span className="form-label">Google OAuth Web client ID</span><input name="gmailClientId" type="text" required maxLength={300} defaultValue={current.clientId} placeholder="...apps.googleusercontent.com" className="form-input" autoComplete="off"/><span className="mt-1 block text-xs text-muted-foreground">Create a Web application OAuth client in Google Cloud and enable the Gmail API.</span></label>
      <label className="block max-w-2xl"><span className="form-label">Google OAuth client secret</span><input name="gmailClientSecret" type="password" maxLength={500} required={!current.clientId} placeholder={current.clientId ? "Leave blank to keep the saved secret" : "Paste the client secret"} className="form-input" autoComplete="new-password"/><span className="mt-1 block text-xs text-muted-foreground">Enter the secret if changing the client ID. The secret and refresh token are encrypted and stored server-side, and are never returned to this page.</span></label>
      <div className="max-w-2xl rounded-md border border-border bg-muted/30 p-4">
        <p className="text-sm font-semibold">Authorized redirect URI</p>
        <code className="mt-2 block break-all text-xs text-foreground">{current.callbackUrl || "Loading callback URL…"}</code>
        <p className="mt-2 text-xs text-muted-foreground">Add this exact URL in Google Cloud Console under your OAuth client’s authorized redirect URIs. Google requires the redirect URI to match exactly.</p>
      </div>
      {(error || notice) && <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-destructive" : "text-success"}`}>{error || notice}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy}>{busy ? <Loader2 className="animate-spin" size={16}/> : <ExternalLink size={16}/>} {current.configured ? "Reconnect Gmail" : "Save credentials and connect Gmail"}</Button>
        <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" className="text-sm font-semibold text-primary hover:underline">Open Google Cloud credentials <ExternalLink className="inline" size={13}/></a>
      </div>
    </form>
  </div>;
}

function SendEmailAuthHookSettings() {
  const queryClient = useQueryClient();
  const loadSettings = useServerFn(getSendEmailAuthHookSettings);
  const loadOAuthSettings = useServerFn(getGmailOAuthSettings);
  const configureHook = useServerFn(configureSendEmailAuthHook);
  const oauthSettings = useQuery({ queryKey: ["gmail-oauth-settings"], queryFn: () => loadOAuthSettings() });
  const hookSettings = useQuery({ queryKey: ["send-email-auth-hook-settings"], queryFn: () => loadSettings() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>, enabled: boolean) {
    event.preventDefault();
    const form = event.currentTarget;
    const accessToken = String(new FormData(form).get("supabaseAccessToken") || "");
    setBusy(true); setError(""); setNotice("");
    try {
      await configureHook({ data: { accessToken, enabled } });
      form.reset();
      await queryClient.invalidateQueries({ queryKey: ["send-email-auth-hook-settings"] });
      setNotice(enabled
        ? "Member authentication emails will now be sent through the connected Gmail account."
        : "The hook is disabled. Supabase will use its built-in email sender again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the Send Email Auth Hook.");
    } finally { form.reset(); setBusy(false); }
  }

  if (hookSettings.isLoading || oauthSettings.isLoading) {
    return <div className="mt-8 flex items-center gap-3 border-t border-border pt-6 text-sm text-muted-foreground"><Loader2 className="animate-spin" size={17}/>Loading authentication email setup…</div>;
  }
  if (hookSettings.isError || !hookSettings.data || oauthSettings.isError || !oauthSettings.data) {
    return <div className="mt-8 border-t border-border pt-6"><h3 className="font-semibold">Member authentication emails</h3><p className="mt-2 text-sm text-destructive">Could not load the Send Email Auth Hook settings.</p></div>;
  }

  const current = hookSettings.data;
  const gmailConnected = oauthSettings.data.configured;
  return <div className="mt-8 border-t border-border pt-6">
    <div className="mb-5 flex items-start gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><ShieldCheck size={19}/></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-display text-lg font-bold">Member authentication emails</h3><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${current.enabled ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"}`}>{current.enabled ? "Custom sender active" : "Supabase sender active"}</span></div>
        <p className="mt-1 text-sm text-muted-foreground">After setup, member verification, password reset, invite, and other Supabase Auth emails will be sent by the Gmail account above. The first admin can register with Supabase’s built-in email before enabling this.</p>
      </div>
    </div>
    <div className="mb-4 rounded-md border border-border bg-muted/30 p-4 text-sm">
      <p className="font-semibold">One-time setup requirements</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>Connect Gmail above and make sure the <code>send-email</code> Edge Function has been deployed from GitHub.</li>
        <li>Create a Supabase project-scoped personal access token with <strong>Auth Config read and write</strong>, <strong>Project Admin write</strong>, and <strong>Edge Function Secrets write</strong> permissions.</li>
        <li>Enter the token below. It is sent only to the server for this setup request and is not saved.</li>
      </ol>
      <a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 font-semibold text-primary hover:underline">Create a Supabase access token <ExternalLink size={13}/></a>
    </div>
    <form onSubmit={(event) => void submit(event, !current.enabled)} className="max-w-2xl space-y-3">
      <label className="block"><span className="form-label">Supabase personal access token</span><input name="supabaseAccessToken" type="password" required minLength={20} maxLength={500} autoComplete="new-password" className="form-input" placeholder="Paste a scoped Supabase token"/><span className="mt-1 block text-xs text-muted-foreground">The token is never stored in the database. Re-enter it whenever you enable or disable the hook.</span></label>
      <div className="rounded-md border border-border bg-muted/30 p-3"><span className="text-xs font-semibold">Send Email Hook endpoint</span><code className="mt-1 block break-all text-xs">{current.functionUrl}</code></div>
      {(error || notice) && <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-destructive" : "text-success"}`}>{error || notice}</p>}
      <div className="flex flex-wrap gap-2">
        {!current.enabled
          ? <Button disabled={busy || !gmailConnected}>{busy ? <Loader2 className="animate-spin" size={15}/> : <ShieldCheck size={15}/>}Enable custom auth emails</Button>
          : <Button variant="outline" disabled={busy}>{busy ? <Loader2 className="animate-spin" size={15}/> : <Unplug size={15}/>}Disable and use Supabase email</Button>}
        {!gmailConnected && <span className="self-center text-xs text-warning">Connect Gmail before enabling.</span>}
      </div>
    </form>
  </div>;
}
