"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { cronToWords } from "@/lib/cron";
import type { Routine, RoutineRun } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

const FlowDiagram = dynamic(() => import("@/components/widgets/flow-view").then(m => m.FlowDiagram), { ssr: false, loading: () => <div className="h-60 animate-pulse rounded-md bg-muted" /> });
const pausedText: Record<string, string> = {
  failed_repeatedly: "Paused after repeated failures", expired: "Expired", ran: "Completed",
};
const skipText: Record<string, string> = {
  previous_run_active: "Previous run still active", missed_window: "Missed run window", missed: "Missed",
  nothing_changed: "Nothing changed", user_skipped: "Skipped",
};

function runLabel(status: string) {
  if (["completed", "succeeded", "success"].includes(status)) return "Completed";
  if (["failed", "error"].includes(status)) return "Failed";
  if (["queued", "running", "planning"].includes(status)) return "Running";
  return "Skipped";
}

function dateTime(value?: string | null, timezone = "UTC") {
  if (!value) return "—";
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value)); }
  catch { return new Date(value).toLocaleString(); }
}

function nextWords(routine: Routine) {
  if (!routine.enabled) return "Paused";
  if (routine.kind === "once" && routine.runAt) return dateTime(routine.runAt, routine.timezone);
  if (!routine.nextRunAt) return "Next run scheduled soon";
  const when = new Date(routine.nextRunAt);
  const now = new Date();
  const minutes = Math.max(0, Math.round((when.getTime() - now.getTime()) / 60000));
  if (minutes < 1) return "Next run now";
  if (minutes < 60) return `Next run in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  if (minutes < 1440) return `Next run in ${Math.floor(minutes / 60)} ${Math.floor(minutes / 60) === 1 ? "hour" : "hours"}`;
  return `Next run ${dateTime(routine.nextRunAt, routine.timezone)}`;
}

export function RoutinesSection({
  routines, loaded, error, onRetry, onChanged, onEdit,
}: {
  routines: Routine[]; loaded: boolean; error: string | null; onRetry: () => void; onChanged: () => void; onEdit: (text: string) => void;
}) {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Routine | null>(null);
  const [history, setHistory] = useState<RoutineRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function refreshHistory(routine: Routine) {
    setHistoryLoading(true); setHistoryError(null);
    try {
      const detail = await api<Routine>(`/api/routines/${routine.id}`);
      setHistory(detail.runs ?? []);
    } catch (caught) { setHistoryError(errorMessage(caught, "Could not load run history.")); }
    finally { setHistoryLoading(false); }
  }
  useEffect(() => { if (selected) void refreshHistory(selected); else { setHistory([]); setHistoryError(null); } }, [selected?.id]);

  async function toggle(routine: Routine, enabled: boolean) {
    setPending((current) => ({ ...current, [routine.id]: true }));
    try {
      await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      onChanged();
      if (selected?.id === routine.id) setSelected({ ...routine, enabled });
      toast.success(enabled ? "Routine resumed." : "Routine paused.");
    } catch (caught) { toast.error(errorMessage(caught, "Could not update that routine.")); }
    finally { setPending((current) => { const next = { ...current }; delete next[routine.id]; return next; }); }
  }
  async function testRun(routine: Routine) {
    try {
      await api(`/api/routines/${routine.id}/test`, { method: "POST" });
      toast.success("Test run queued.");
      await refreshHistory(routine);
      onChanged();
    } catch (caught) { toast.error(errorMessage(caught, "Could not start a test run.")); }
  }
  async function deleteRoutine(routine: Routine) {
    if (!window.confirm(`Delete “${routine.name}”? This cannot be undone.`)) return;
    setDeleting(true);
    try { await api(`/api/routines/${routine.id}`, { method: "DELETE" }); setSelected(null); onChanged(); toast.success("Routine deleted."); }
    catch (caught) { toast.error(errorMessage(caught, "Could not delete that routine.")); }
    finally { setDeleting(false); }
  }
  const selectedRow = selected;

  return (
    <section data-testid="routines-section" className="border-b border-border px-3 py-3">
      <div><h2 className="text-xs font-medium text-muted-foreground">Routines</h2></div>
      <div className="mt-2 overflow-hidden rounded-2xl border border-border bg-card">
        {!loaded ? <div role="status" aria-busy="true" data-testid="routines-skeleton" className="divide-y divide-border"><span className="sr-only">Loading routines</span>{[0, 1].map((row) => <div key={row} aria-hidden className="flex items-center gap-3 px-3 py-3"><div className="min-w-0 flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-3 w-1/2" /></div><Skeleton className="h-5 w-9 rounded-full" /></div>)}</div> : null}
        {loaded && error ? <div data-testid="routines-error" className="flex items-center justify-between gap-2 px-3 py-3"><p role="alert" className="text-sm text-destructive">Couldn&apos;t load routines.</p><Button type="button" variant="outline" size="sm" data-testid="routines-retry" onClick={onRetry}>Try again</Button></div> : null}
        {loaded && !error && routines.length === 0 ? <p data-testid="routines-empty" className="px-3 py-4 text-sm text-muted-foreground">No routines yet. Ask in chat to set one up.</p> : null}
        {loaded && !error && routines.length > 0 ? <ul className="divide-y divide-border">{routines.map((routine) => {
          const enabled = routine.enabled !== false;
          return <li key={routine.id} data-testid="routine-row" className="flex items-center gap-3 px-3 py-2.5">
            <button type="button" className="min-w-0 flex-1 text-left" aria-label={`Open ${routine.name}`} onClick={() => setSelected(routine)}>
              <p className="truncate text-sm font-medium" title={routine.name}>{routine.name}</p>
              <p data-testid="routine-schedule" className="truncate text-xs text-muted-foreground">{routine.kind === "once" && routine.runAt ? dateTime(routine.runAt, routine.timezone) : cronToWords(routine.cron)} · {routine.timezone || "UTC"}</p>
              <p className="truncate text-xs text-muted-foreground">{!enabled ? "Paused" : nextWords(routine)}</p>
            </button>
            <Switch data-testid="routine-toggle" aria-label={`${routine.name} enabled`} checked={enabled} disabled={!!pending[routine.id]} onCheckedChange={(value) => void toggle(routine, value)} className="duration-200 motion-reduce:transition-none data-[state=checked]:bg-[var(--bot-accent,var(--primary))] data-[state=unchecked]:bg-muted-foreground/30" />
          </li>;
        })}</ul> : null}
      </div>
      <Sheet open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent data-testid="routine-drawer" side="right" className="w-[min(100vw,28rem)] max-w-full overflow-y-auto p-4 sm:p-6">
          {selectedRow ? <>
            <SheetHeader className="pr-8 text-left"><SheetTitle>{selectedRow.name}</SheetTitle><SheetDescription>{selectedRow.kind === "once" && selectedRow.runAt ? `${dateTime(selectedRow.runAt, selectedRow.timezone)} · ${selectedRow.timezone || "UTC"}` : `${cronToWords(selectedRow.cron)} · ${selectedRow.timezone || "UTC"}`}</SheetDescription></SheetHeader>
            <div className="mt-5 space-y-4">
              <p data-testid="routine-status" className="text-sm text-muted-foreground">{selectedRow.enabled ? nextWords(selectedRow) : pausedText[selectedRow.pausedReason ?? ""] ?? "Paused"}</p>
              <section><h3 className="text-xs font-medium text-muted-foreground">Instructions</h3><p className="mt-1 whitespace-pre-wrap break-words text-sm">{selectedRow.instruction || "No instruction available."}</p></section>
              {selectedRow.quietRule ? <section><h3 className="text-xs font-medium text-muted-foreground">Quiet rule</h3><p className="mt-1 whitespace-pre-wrap break-words text-sm">{selectedRow.quietRule}</p></section> : null}
              <section><h3 className="mb-2 text-xs font-medium text-muted-foreground">Run history</h3>
                {historyLoading ? <div data-testid="routine-history-skeleton" role="status" aria-busy="true" className="space-y-2">{[0, 1, 2].map((n) => <Skeleton key={n} className="h-12 w-full" />)}</div> : null}
                {!historyLoading && historyError ? <div data-testid="routine-history-error" className="text-sm text-destructive"><p>{historyError}</p><Button variant="outline" size="sm" className="mt-2" onClick={() => void refreshHistory(selectedRow)}>Try again</Button></div> : null}
                {!historyLoading && !historyError && history.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : null}
                {!historyLoading && !historyError && history.length > 1 ? <FlowDiagram label="Routine run flow" nodes={history.slice(0, 20).map((run, index) => ({ id: run.id, position: { x: index * 150, y: 0 }, data: { label: `${runLabel(run.status)} · ${dateTime(run.triggeredAt, selectedRow.timezone)}` }, type: "input" }))} edges={history.slice(0, 19).map((run, index) => ({ id: `routine-edge-${index}`, source: run.id, target: history[index + 1].id }))} /> : null}
                {!historyLoading && !historyError ? <ul className="space-y-2">{history.slice(0, 20).map((run) => <li key={run.id} data-testid="routine-run" className="rounded-md border border-border p-2.5 text-sm"><div className="flex justify-between gap-2"><span className="font-medium">{runLabel(run.status)}</span><time className="text-xs text-muted-foreground">{dateTime(run.triggeredAt, selectedRow.timezone)}</time></div>{run.skipReason ? <p className="mt-1 text-xs text-muted-foreground">{skipText[run.skipReason] ?? run.skipReason.replaceAll("_", " ")}</p> : null}{run.summary || run.error ? <p className="mt-1 break-words text-xs text-muted-foreground">{run.summary || run.error}</p> : null}</li>)}</ul> : null}
              </section>
              <div className="grid grid-cols-2 gap-2 border-t border-border pt-4">
                <Button variant="outline" onClick={() => void toggle(selectedRow, !selectedRow.enabled)}>{selectedRow.enabled ? "Pause" : "Resume"}</Button>
                <Button variant="outline" onClick={() => void testRun(selectedRow)}>Test</Button>
                <Button variant="outline" onClick={() => { setSelected(null); onEdit(`Edit your routine: ${selectedRow.name}`); }}>Edit</Button>
                <Button variant="destructive" disabled={deleting} onClick={() => void deleteRoutine(selectedRow)}>Delete</Button>
              </div>
            </div>
          </> : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}
