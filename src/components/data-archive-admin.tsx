import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Archive, Download, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { deleteArchivedGymData } from "@/lib/gym.functions";
import { gymDateStartUtc } from "@/lib/gym-time";
import { supabase } from "@/integrations/supabase/client";

type Dataset = "payments" | "attendance" | "classes";
type PageResponse<T> = { data: T[] | null; error: { message: string } | null };
type PendingDelete = { dataset: Dataset; before: string; exportedAt: string; counts: Record<string, number> };

const DATASETS: Record<Dataset, { label: string; description: string }> = {
  payments: { label: "Payments", description: "Payment and related gateway event records, selected by payment creation date." },
  attendance: { label: "Attendance", description: "Check-in history, selected by check-in time." },
  classes: { label: "Class booking history", description: "Schedules and related bookings, waitlists, and trainer assignments. Class definitions, schedules, and attendance links are retained when deleting history." },
};

async function fetchAllPages<T>(fetchPage: (from: number, to: number) => PromiseLike<PageResponse<T>>) {
  const pageSize = 500;
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) return rows;
  }
}

function chunks<T>(items: T[], size = 100) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function oneYearAgo(gymTimeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: gymTimeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const day = new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
  day.setUTCFullYear(day.getUTCFullYear() - 1);
  return day.toISOString().slice(0, 10);
}

function downloadJson(fileName: string, archive: unknown) {
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function DataArchiveAdmin({ timeZone }: { timeZone: string }) {
  const deleteRows = useServerFn(deleteArchivedGymData);
  const [dataset, setDataset] = useState<Dataset>("attendance");
  const [cutoff, setCutoff] = useState(() => oneYearAgo(timeZone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  async function exportData() {
    if (!cutoff) { setError("Choose a cutoff date first."); return; }
    setBusy(true); setError(""); setMessage("");
    const before = gymDateStartUtc(cutoff, timeZone).toISOString();
    const exportedAt = new Date().toISOString();
    try {
      let archive: Record<string, unknown>;
      let counts: Record<string, number>;

      if (dataset === "attendance") {
        const attendance = await fetchAllPages((from, to) => supabase.from("attendance").select("*")
          .lt("checked_in_at", before).lte("created_at", exportedAt).order("checked_in_at").range(from, to));
        archive = { dataset, exportedAt, before, timeZone, attendance };
        counts = { attendance: attendance.length };
      } else if (dataset === "payments") {
        const payments = await fetchAllPages((from, to) => supabase.from("payments").select("*")
          .lt("created_at", before).lte("created_at", exportedAt).order("created_at").range(from, to));
        const paymentEvents: unknown[] = [];
        for (const group of chunks(payments.map((payment) => payment.id))) {
          paymentEvents.push(...await fetchAllPages((from, to) => supabase.from("payment_events").select("*")
            .in("payment_id", group).lte("created_at", exportedAt).order("created_at").range(from, to)));
        }
        archive = { dataset, exportedAt, before, timeZone, payments, paymentEvents };
        counts = { payments: payments.length, paymentEvents: paymentEvents.length };
      } else {
        const schedules = await fetchAllPages((from, to) => supabase.from("class_schedules").select("*")
          .lt("starts_at", before).lte("created_at", exportedAt).order("starts_at").range(from, to));
        const scheduleGroups = chunks(schedules.map((schedule) => schedule.id));
        const bookings: unknown[] = [];
        const waitlists: unknown[] = [];
        const trainerAssignments: unknown[] = [];
        for (const group of scheduleGroups) {
          const [bookingRows, waitlistRows, assignmentRows] = await Promise.all([
            fetchAllPages((from, to) => supabase.from("class_bookings").select("*").in("schedule_id", group).lte("booked_at", exportedAt).order("booked_at").range(from, to)),
            fetchAllPages((from, to) => supabase.from("class_waitlists").select("*").in("schedule_id", group).lte("joined_at", exportedAt).order("joined_at").range(from, to)),
            fetchAllPages((from, to) => supabase.from("trainer_assignments").select("*").in("schedule_id", group).lte("created_at", exportedAt).order("created_at").range(from, to)),
          ]);
          bookings.push(...bookingRows); waitlists.push(...waitlistRows); trainerAssignments.push(...assignmentRows);
        }
        const classIds = [...new Set(schedules.map((schedule) => schedule.class_id))];
        const classes: unknown[] = [];
        for (const group of chunks(classIds)) {
          classes.push(...await fetchAllPages((from, to) => supabase.from("classes").select("*").in("id", group).order("name").range(from, to)));
        }
        archive = { dataset, exportedAt, before, timeZone, classes, schedules, bookings, waitlists, trainerAssignments };
        counts = { classes: classes.length, schedules: schedules.length, bookings: bookings.length, waitlists: waitlists.length, trainerAssignments: trainerAssignments.length };
      }

      downloadJson(`${dataset}-archive-before-${cutoff.replaceAll("-", "")}.json`, archive);
      const countSummary = Object.entries(counts).map(([key, count]) => `${count} ${key}`).join(" · ");
      const hasRowsToDelete = dataset === "payments"
        ? counts.payments > 0
        : dataset === "attendance"
          ? counts.attendance > 0
          : (counts.bookings ?? 0) + (counts.waitlists ?? 0) + (counts.trainerAssignments ?? 0) > 0;
      setPendingDelete(hasRowsToDelete ? { dataset, before, exportedAt, counts } : null);
      setMessage(`Archive download started. ${countSummary}.${hasRowsToDelete ? " Choose whether to delete the exported history." : " There are no matching history rows to delete."}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export the selected data.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setBusy(true); setError("");
    try {
      const result = await deleteRows({ data: pendingDelete });
      const deletedCounts = Object.entries(result.deleted).filter(([key]) => key !== "schedulesRetained").map(([key, count]) => `${count} ${key}`).join(" · ");
      const retainedSchedules = result.deleted.schedulesRetained;
      setMessage(`Deleted the archived records: ${deletedCounts || "none"}.${retainedSchedules === undefined ? "" : ` Preserved ${retainedSchedules} schedule rows so attendance links remain valid.`}`);
      setPendingDelete(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the exported records.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <section className="panel max-w-4xl p-5 md:p-7">
      <div className="mb-6 flex items-start gap-4 border-b border-border pb-5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Archive size={21}/></span>
        <div><h2 className="section-title">Data archive & cleanup</h2><p className="section-subtitle">Download older operational records, then choose whether to remove those records from the live database.</p></div>
      </div>

      <div className="grid gap-3 md:grid-cols-3" role="radiogroup" aria-label="Data type to archive">
        {(Object.keys(DATASETS) as Dataset[]).map((key) => <label key={key} className={`cursor-pointer rounded-xl border p-4 transition-colors ${dataset === key ? "border-primary bg-primary/10" : "border-border bg-card/50 hover:bg-accent/60"}`}>
          <input className="sr-only" type="radio" name="archiveDataset" value={key} checked={dataset === key} onChange={() => { setDataset(key); setPendingDelete(null); setMessage(""); setError(""); }}/>
          <span className="block font-semibold">{DATASETS[key].label}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{DATASETS[key].description}</span>
        </label>)}
      </div>

      <label className="mt-6 block max-w-sm"><span className="form-label">Export records before</span><input type="date" value={cutoff} onChange={(event) => { setCutoff(event.target.value); setPendingDelete(null); setMessage(""); setError(""); }} className="form-input"/><span className="mt-1 block text-xs text-muted-foreground">Uses the gym’s local timezone ({timeZone}). Records before the selected date are included.</span></label>

      {dataset === "payments" && <p className="mt-5 rounded-xl border border-warning/30 bg-warning-soft p-4 text-sm text-warning">Deleting payment records removes payment and gateway-event history, including receipt history from the portal. It does not issue refunds or cancel memberships.</p>}
      {dataset === "attendance" && <p className="mt-5 rounded-xl border border-border bg-muted/50 p-4 text-sm text-muted-foreground">This archive contains attendance rows only. Biometric/access-device event logs are not included.</p>}
      {dataset === "classes" && <p className="mt-5 rounded-xl border border-border bg-muted/50 p-4 text-sm text-muted-foreground">Cleanup removes old bookings, waitlists, and trainer assignments. Class definitions, schedules, and attendance links stay in place.</p>}

      {(error || message) && <p role={error ? "alert" : "status"} className={`mt-5 rounded-lg px-3 py-2 text-sm ${error ? "bg-destructive-soft text-destructive" : "bg-success-soft text-success"}`}>{error || message}</p>}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <p className="max-w-xl text-xs leading-5 text-muted-foreground">Exports are JSON files and include database IDs so related records can be matched later. Save downloaded files securely; they contain private member and payment data.</p>
        <Button onClick={() => void exportData()} disabled={busy || !cutoff}><Download size={16}/>{busy ? "Preparing archive…" : "Download archive"}</Button>
      </div>
    </section>

    <Dialog open={Boolean(pendingDelete)} onOpenChange={(open) => { if (!open && !busy) setPendingDelete(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldAlert className="text-warning" size={20}/>Delete the downloaded records?</DialogTitle>
          <DialogDescription>
            {pendingDelete?.dataset === "payments"
              ? "This permanently removes the exported payment records, related gateway events, and their receipt history from this database."
              : pendingDelete?.dataset === "attendance"
                ? "This permanently removes the exported check-in history from this database."
                : "This permanently removes the exported class bookings, waitlists, and trainer assignments. Class definitions, schedules, and attendance links will remain."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setPendingDelete(null)}>Keep records</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>{busy ? <Loader2 className="animate-spin" size={16}/> : <Trash2 size={16}/>}Delete exported records</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
