import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Copy, CreditCard, Fingerprint, KeyRound, Loader2, Nfc, Pencil, Plus, Radio, ShieldAlert, Trash2, UserRound, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { checkInWithNfcCard, deleteEsslMemberMapping, getEsslAttendanceSetup, registerNfcMemberCard, revokeNfcMemberCard, saveEsslDevice, saveEsslMemberMapping, saveEsslWebhookToken, setEsslDeviceActive } from "@/lib/gym.functions";
import { scanMemberNfcToken, writeMemberNfcToken } from "@/lib/nfc-platform";
type MemberRow = { id: string; member_code: string; status: string; profiles: { display_name: string | null } | null };
type CredentialRow = { id: string; member_id: string; label: string | null; active: boolean; registered_at: string; members: { member_code: string; profiles: { display_name: string | null } | null } | null };

function makeCardToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function NfcAttendanceAdmin() {
  const queryClient = useQueryClient();
  const registerCard = useServerFn(registerNfcMemberCard);
  const revokeCard = useServerFn(revokeNfcMemberCard);
  const checkIn = useServerFn(checkInWithNfcCard);
  const loadEsslSetup = useServerFn(getEsslAttendanceSetup);
  const persistEsslDevice = useServerFn(saveEsslDevice);
  const persistEsslMapping = useServerFn(saveEsslMemberMapping);
  const removeEsslMapping = useServerFn(deleteEsslMemberMapping);
  const persistEsslWebhook = useServerFn(saveEsslWebhookToken);
  const toggleEsslDevice = useServerFn(setEsslDeviceActive);
  const [memberId, setMemberId] = useState("");
  const [label, setLabel] = useState("NFC card");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [esslBusy, setEsslBusy] = useState("");
  const [esslDeviceName, setEsslDeviceName] = useState("eSSL F22");
  const [esslSerial, setEsslSerial] = useState("");
  const [editingEsslDevice, setEditingEsslDevice] = useState("");
  const [mappingDeviceId, setMappingDeviceId] = useState("");
  const [mappingMemberId, setMappingMemberId] = useState("");
  const [mappingUserId, setMappingUserId] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");

  const members = useQuery({
    queryKey: ["nfc-admin-members"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("members").select("id, member_code, status, profiles(display_name)").order("created_at", { ascending: false });
      if (queryError) throw new Error(queryError.message);
      return (data ?? []) as MemberRow[];
    },
  });
  const credentials = useQuery({
    queryKey: ["nfc-admin-credentials"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("access_credentials")
        .select("id, member_id, label, active, registered_at, members(member_code, profiles(display_name))")
        .eq("credential_type", "nfc").order("registered_at", { ascending: false });
      if (queryError) throw new Error(queryError.message);
      return (data ?? []) as CredentialRow[];
    },
  });

  async function registerNfc() {
    if (!memberId) { setError("Choose a member first."); return; }
    setBusy("register"); setError(""); setMessage("");
    try {
      const token = makeCardToken();
      await writeMemberNfcToken(token);
      await registerCard({ data: { memberId, token, label: label.trim() || "NFC card" } });
      setMessage("NFC card registered. The member can tap it at the gym check-in station.");
      await queryClient.invalidateQueries({ queryKey: ["nfc-admin-credentials"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not register this NFC card.");
    } finally { setBusy(""); }
  }

  async function startScan() {
    setBusy("scan"); setError(""); setMessage("Follow the phone's NFC prompt, then hold the card near the phone to record today's attendance.");
    try {
      const token = await scanMemberNfcToken();
      const result = await checkIn({ data: { token } });
      if (result.decision === "granted") {
        setMessage(result.attendanceRecorded
          ? `Check-in recorded for ${result.memberName || result.memberCode || "member"}.`
          : `${result.memberName || result.memberCode || "Member"}: ${result.reason}`);
      } else setError(`${result.memberName || result.memberCode || "Check-in denied"}: ${result.reason}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the NFC scanner.");
    } finally { setBusy(""); }
  }

  async function revoke(id: string, memberName: string) {
    if (!window.confirm(`Revoke the NFC card for ${memberName}? The card will stop working immediately.`)) return;
    setBusy(`revoke:${id}`); setError(""); setMessage("");
    try {
      await revokeCard({ data: { credentialId: id } });
      setMessage("NFC card revoked.");
      await queryClient.invalidateQueries({ queryKey: ["nfc-admin-credentials"] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not revoke the NFC card."); }
    finally { setBusy(""); }
  }

  const esslSetup = useQuery({
    queryKey: ["essl-attendance-setup"],
    queryFn: () => loadEsslSetup(),
  });
  const activeMembers = (members.data ?? []).filter((member) => member.status === "active");
  const esslDevices = esslSetup.data?.devices ?? [];
  const esslMappings = esslSetup.data?.mappings ?? [];

  async function saveDevice() {
    if (!esslDeviceName.trim() || !esslSerial.trim()) { setError("Enter the eSSL device name and serial number."); return; }
    setEsslBusy("device"); setError(""); setMessage("");
    try {
      await persistEsslDevice({ data: { ...(editingEsslDevice ? { deviceId: editingEsslDevice } : {}), name: esslDeviceName.trim(), serialNumber: esslSerial.trim() } });
      setMessage("eSSL device saved. Add a member mapping using the EmployeeCode/User ID shown in eBioServer logs.");
      setEditingEsslDevice(""); setEsslDeviceName("eSSL F22"); setEsslSerial("");
      await queryClient.invalidateQueries({ queryKey: ["essl-attendance-setup"] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the eSSL device."); }
    finally { setEsslBusy(""); }
  }

  async function generateWebhookUrl() {
    setEsslBusy("webhook"); setError(""); setMessage(""); setWebhookUrl("");
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(48));
      const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const result = await persistEsslWebhook({ data: { token } });
      const endpoint = new URL(result.webhookPath, window.location.origin);
      endpoint.searchParams.set("token", token);
      setWebhookUrl(endpoint.toString());
      setMessage("Webhook URL generated. Copy it into eBioServer now; the secret is shown only this time.");
      await queryClient.invalidateQueries({ queryKey: ["essl-attendance-setup"] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not generate the eSSL webhook URL."); }
    finally { setEsslBusy(""); }
  }

  async function copyWebhookUrl() {
    if (!webhookUrl) return;
    try { await navigator.clipboard.writeText(webhookUrl); setMessage("Webhook URL copied."); }
    catch { setError("Could not access the clipboard. Select and copy the URL manually."); }
  }

  async function saveMapping() {
    if (!mappingDeviceId || !mappingMemberId || !mappingUserId.trim()) { setError("Choose a device and member, then enter the device EmployeeCode/User ID."); return; }
    setEsslBusy("mapping"); setError(""); setMessage("");
    try {
      await persistEsslMapping({ data: { deviceId: mappingDeviceId, memberId: mappingMemberId, deviceUserId: mappingUserId.trim() } });
      setMessage("Biometric ID mapped to the member."); setMappingUserId("");
      await queryClient.invalidateQueries({ queryKey: ["essl-attendance-setup"] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the member mapping."); }
    finally { setEsslBusy(""); }
  }

  async function deleteMapping(mappingId: string, memberName: string) {
    if (!window.confirm(`Remove the biometric ID mapping for ${memberName}?`)) return;
    setEsslBusy(`mapping:${mappingId}`); setError(""); setMessage("");
    try {
      await removeEsslMapping({ data: { mappingId } });
      setMessage("Member mapping removed.");
      await queryClient.invalidateQueries({ queryKey: ["essl-attendance-setup"] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove the mapping."); }
    finally { setEsslBusy(""); }
  }

  async function changeDeviceActive(deviceId: string, active: boolean) {
    setEsslBusy(`device:${deviceId}`); setError(""); setMessage("");
    try {
      await toggleEsslDevice({ data: { deviceId, active } });
      setMessage(active ? "eSSL device enabled." : "eSSL device paused.");
      await queryClient.invalidateQueries({ queryKey: ["essl-attendance-setup"] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the eSSL device."); }
    finally { setEsslBusy(""); }
  }

  function editEsslDevice(device: (typeof esslDevices)[number]) {
    setEditingEsslDevice(device.id); setEsslDeviceName(device.name); setEsslSerial(device.serialNumber);
  }

  function resetEsslDeviceForm() {
    setEditingEsslDevice(""); setEsslDeviceName("eSSL F22"); setEsslSerial("");
  }

  return <div className="space-y-5">
    <section className="panel p-5 md:p-7">
      <div className="mb-5 flex items-start gap-3 border-b border-border pb-5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Nfc size={22}/></span>
        <div><h2 className="section-title">Member check-in credentials</h2><p className="section-subtitle">Register NFC cards and scan attendance from a supported NFC-enabled Android browser.</p></div>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-xl border border-border p-4">
          <h3 className="flex items-center gap-2 font-semibold"><CreditCard size={17}/> Register an NFC card</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Select a member, then hold a writable NDEF-compatible NFC card/tag near the Android device when prompted. Registration replaces its current NDEF contents.</p>
          <label className="mt-4 block"><span className="form-label">Member</span><select className="form-input" value={memberId} onChange={(event) => setMemberId(event.target.value)}>
            <option value="">Select a member</option>{activeMembers.map((member) => <option key={member.id} value={member.id}>{member.profiles?.display_name || "Member"} · {member.member_code}</option>)}
          </select></label>
          <label className="mt-3 block"><span className="form-label">Card label</span><input className="form-input" maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Blue key fob"/></label>
          <Button className="mt-4 w-full" onClick={() => void registerNfc()} disabled={Boolean(busy) || !memberId}>{busy === "register" ? <Loader2 className="animate-spin" size={16}/> : <Nfc size={16}/>}Register card</Button>
          {!activeMembers.length && <p className="mt-2 text-xs text-warning">No active members are available to assign a card.</p>}
        </div>
        <div className="rounded-xl border border-border p-4">
          <h3 className="flex items-center gap-2 font-semibold"><Radio size={17}/> Daily attendance check-in</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Use a supported Android browser and NFC check-in station. A valid member card records one attendance check-in per gym-local day.</p>
          <div className="mt-6 flex min-h-24 flex-col items-center justify-center rounded-xl border border-dashed border-primary/40 bg-primary/5 px-4 text-center">
            <Nfc size={27} className="text-primary"/>
            <p className="mt-2 text-sm font-medium">{busy === "scan" ? "Ready to scan a card…" : "Tap a member card to check in"}</p>
            {busy === "scan" ? <Button className="mt-3" variant="outline" disabled><Loader2 className="animate-spin" size={16}/>Waiting for card…</Button>
              : <Button className="mt-3" variant="outline" disabled={Boolean(busy)} onClick={() => void startScan()}><Nfc size={16}/>Start NFC scanner</Button>}
          </div>
          <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-muted-foreground"><ShieldAlert size={15} className="mt-0.5 shrink-0"/>Card contents are a bearer credential. Keep cards supervised; anyone holding a card can present it. Revoking a card disables it immediately.</p>
        </div>
      </div>

      {(error || message) && <p role={error ? "alert" : "status"} className={`mt-4 rounded-lg px-3 py-2 text-sm ${error ? "bg-destructive-soft text-destructive" : "bg-success-soft text-success"}`}>{error || message}</p>}

      <div className="mt-6 border-t border-border pt-5">
        <h3 className="font-semibold">Registered NFC cards</h3>
        {credentials.isError && <p role="alert" className="mt-3 text-sm text-destructive">Could not load NFC credentials: {credentials.error.message}</p>}
        {credentials.isLoading ? <p className="mt-3 text-sm text-muted-foreground">Loading cards…</p> : credentials.data?.length ? <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="border-y border-border bg-muted text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Member</th><th className="px-3 py-2">Card</th><th className="px-3 py-2">Registered</th><th className="px-3 py-2">Status</th><th/></tr></thead><tbody className="divide-y divide-border">{credentials.data.map((credential) => {
          const name = credential.members?.profiles?.display_name || credential.members?.member_code || "Member";
          return <tr key={credential.id}><td className="px-3 py-3"><span className="inline-flex items-center gap-2"><UserRound size={15}/>{name}{credential.members?.member_code ? ` · ${credential.members.member_code}` : ""}</span></td><td className="px-3 py-3">{credential.label || "NFC card"}</td><td className="px-3 py-3 text-muted-foreground">{new Date(credential.registered_at).toLocaleDateString()}</td><td className="px-3 py-3"><span className={`status ${credential.active ? "status-active" : "status-muted"}`}>{credential.active ? "Active" : "Revoked"}</span></td><td className="px-3 py-3 text-right">{credential.active && <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void revoke(credential.id, name)}>{busy === `revoke:${credential.id}` ? <Loader2 className="animate-spin" size={14}/> : <XCircle size={14}/>}Revoke</Button>}</td></tr>;
        })}</tbody></table></div> : <p className="mt-3 text-sm text-muted-foreground">No NFC cards have been registered.</p>}
      </div>
    </section>

    <section className="panel space-y-6 p-5 md:p-7">
      <div className="flex items-start gap-3 border-b border-border pb-5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Fingerprint size={22}/></span>
        <div><h2 className="section-title">eSSL biometric attendance</h2><p className="section-subtitle">Receive eBioServer webhook punch records and map each device employee ID to a CRM member.</p></div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-xl border border-border p-4">
          <h3 className="flex items-center gap-2 font-semibold"><Radio size={17}/> Register eSSL device</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Add the device serial number shown in eBioServer. This can be your F22 or another eSSL attendance terminal.</p>
          <label className="mt-4 block"><span className="form-label">Device name</span><input className="form-input" maxLength={100} value={esslDeviceName} onChange={(event) => setEsslDeviceName(event.target.value)} placeholder="eSSL F22"/></label>
          <label className="mt-3 block"><span className="form-label">Device serial number</span><input className="form-input" maxLength={100} value={esslSerial} onChange={(event) => setEsslSerial(event.target.value)} placeholder="SerialNumber from the device"/></label>
          <div className="mt-4 flex gap-2"><Button className="flex-1" onClick={() => void saveDevice()} disabled={Boolean(esslBusy)}>{esslBusy === "device" ? <Loader2 className="animate-spin" size={16}/> : editingEsslDevice ? <Pencil size={16}/> : <Plus size={16}/>} {editingEsslDevice ? "Update device" : "Add device"}</Button>{editingEsslDevice && <Button variant="outline" onClick={resetEsslDeviceForm} disabled={Boolean(esslBusy)}>Cancel</Button>}</div>
          {esslSetup.isLoading ? <p className="mt-4 text-xs text-muted-foreground">Loading eSSL setup…</p> : esslSetup.isError ? <p role="alert" className="mt-4 text-xs text-destructive">Could not load eSSL setup: {esslSetup.error.message}</p> : esslDevices.length > 0 && <div className="mt-4 space-y-2">{esslDevices.map((device) => <div key={device.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-3 text-sm"><div className="min-w-0 flex-1"><p className="truncate font-semibold">{device.name} <span className={`status ml-1 ${device.active ? "status-active" : "status-muted"}`}>{device.active ? "Active" : "Paused"}</span></p><p className="text-xs text-muted-foreground">S/N {device.serialNumber}{device.lastSeenAt ? ` · Last punch ${new Date(device.lastSeenAt).toLocaleString()}` : " · No punches received yet"}</p></div><Button size="sm" variant="outline" onClick={() => editEsslDevice(device)} disabled={Boolean(esslBusy)}><Pencil size={14}/>Edit</Button><Button size="sm" variant="outline" onClick={() => void changeDeviceActive(device.id, !device.active)} disabled={Boolean(esslBusy)}>{esslBusy === `device:${device.id}` ? <Loader2 className="animate-spin" size={14}/> : device.active ? "Pause" : "Enable"}</Button></div>)}</div>}
        </div>

        <div className="rounded-xl border border-border p-4">
          <h3 className="flex items-center gap-2 font-semibold"><KeyRound size={17}/> Secure webhook URL</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Generate one secret URL for this gym and configure it in eBioServer New under Utilities → Web Hook. The raw secret is stored only as a server-side hash.</p>
          <Button className="mt-4 w-full" variant="outline" onClick={() => void generateWebhookUrl()} disabled={Boolean(esslBusy)}>{esslBusy === "webhook" ? <Loader2 className="animate-spin" size={16}/> : <KeyRound size={16}/>} Generate / rotate webhook URL</Button>
          {webhookUrl && <div className="mt-3 flex gap-2"><input aria-label="eSSL webhook URL" readOnly className="form-input min-w-0 flex-1 text-xs" value={webhookUrl}/><Button variant="outline" size="icon" aria-label="Copy webhook URL" onClick={() => void copyWebhookUrl()}><Copy size={15}/></Button></div>}
          <div className="mt-4 rounded-lg bg-muted/50 p-3 text-xs leading-5 text-muted-foreground"><p><b className="text-foreground">eBioServer settings</b></p><p>Use the URL above, enable webhook delivery, and disable payload encryption. HTTPS plus the long secret URL authenticates the sender. Set the response body to <code className="break-all">{"{\"StatusCode\":\"200\",\"Message\":\"Success\"}"}</code>.</p><p className="mt-2">The URL is shown once. If you rotate it, replace the old URL in eBioServer. Never post it publicly.</p></div>
          <p className="mt-3 text-xs text-muted-foreground">Status: {esslSetup.data?.webhookConfigured ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 size={14}/>Secret configured</span> : "Not configured"}</p>
        </div>
      </div>

      <div className="border-t border-border pt-5">
        <h3 className="flex items-center gap-2 font-semibold"><UserRound size={17}/> Map device users to members</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Use the exact EmployeeCode / User ID present in each eBioServer punch log. The CRM records one eligible check-in per gym-local day.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
          <label><span className="form-label">Device</span><select className="form-input" value={mappingDeviceId} onChange={(event) => setMappingDeviceId(event.target.value)}><option value="">Select device</option>{esslDevices.filter((device) => device.active).map((device) => <option key={device.id} value={device.id}>{device.name} · {device.serialNumber}</option>)}</select></label>
          <label><span className="form-label">CRM member</span><select className="form-input" value={mappingMemberId} onChange={(event) => setMappingMemberId(event.target.value)}><option value="">Select member</option>{activeMembers.map((member) => <option key={member.id} value={member.id}>{member.profiles?.display_name || "Member"} · {member.member_code}</option>)}</select></label>
          <label><span className="form-label">EmployeeCode / User ID</span><input className="form-input" value={mappingUserId} onChange={(event) => setMappingUserId(event.target.value)} maxLength={100} placeholder="Exact device ID"/></label>
          <Button onClick={() => void saveMapping()} disabled={Boolean(esslBusy) || !mappingDeviceId || !mappingMemberId || !mappingUserId.trim()}>{esslBusy === "mapping" ? <Loader2 className="animate-spin" size={16}/> : <Plus size={16}/>} Save mapping</Button>
        </div>
        {esslMappings.length > 0 ? <div className="mt-5 overflow-x-auto rounded-lg border border-border"><table className="w-full min-w-[680px] text-left text-sm"><thead className="border-b border-border bg-muted text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Device</th><th className="px-3 py-2">eSSL employee ID</th><th className="px-3 py-2">CRM member</th><th className="px-3 py-2">Status</th><th/></tr></thead><tbody className="divide-y divide-border">{esslMappings.map((mapping) => <tr key={mapping.id}><td className="px-3 py-3">{mapping.deviceName}<p className="text-xs text-muted-foreground">{mapping.serialNumber}</p></td><td className="px-3 py-3 font-mono">{mapping.deviceUserId}</td><td className="px-3 py-3">{mapping.memberName}<p className="text-xs text-muted-foreground">{mapping.memberCode}</p></td><td className="px-3 py-3"><span className={`status ${mapping.active ? "status-active" : "status-muted"}`}>{mapping.active ? "Active" : "Inactive"}</span></td><td className="px-3 py-3 text-right"><Button size="sm" variant="outline" disabled={Boolean(esslBusy)} onClick={() => void deleteMapping(mapping.id, mapping.memberName)}>{esslBusy === `mapping:${mapping.id}` ? <Loader2 className="animate-spin" size={14}/> : <Trash2 size={14}/>}Remove</Button></td></tr>)}</tbody></table></div> : <p className="mt-4 text-sm text-muted-foreground">No eSSL member mappings yet.</p>}
      </div>
    </section>
    <section className="panel flex gap-3 p-4 text-sm text-muted-foreground"><Fingerprint size={18} className="mt-0.5 shrink-0 text-primary"/><p><b className="text-foreground">Fingerprint devices:</b> a normal web browser cannot enroll or read raw fingerprints. To use fingerprint check-in, connect a biometric terminal and use its supported SDK/API integration.</p></section>
  </div>;
}

