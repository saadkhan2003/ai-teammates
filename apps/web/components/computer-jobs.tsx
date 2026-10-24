"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { parseAgentEvent, subscribeEvents } from "@/lib/events";
import { cn, errorMessage } from "@/lib/utils";
import { JobLogView } from "@/components/job-log-view";
import { elapsedLabel, isActiveJob, jobStatusLabel, screenLastUsedLabel, showBackgroundPill } from "@/lib/usage-format.mjs";

type Job = { id: string; botId: string; name: string; status: string; exitCode?: number | null; reason?: string | null; startedAt: string; elapsedSeconds: number; maxSeconds: number };
type JobsResponse = { jobs: Job[]; running: number; screenLastUsedAt?: string | null };

const SCREEN_BUSY_MS = 90_000;

/** Background jobs on the bot's computer: a "Working in background" pill, a live list with Stop, and a live, read-only log. */
export function ComputerJobs({ botId, controlled = false, dark = false }: { botId: string; controlled?: boolean; dark?: boolean }) {
  const [data, setData] = useState<JobsResponse | null>(null);
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const raw = await api<Partial<JobsResponse> | null>(`/api/bots/${botId}/jobs`);
      // Never let an unexpected payload take down the chat view.
      setData({ jobs: Array.isArray(raw?.jobs) ? raw.jobs : [], running: typeof raw?.running === "number" ? raw.running : 0, screenLastUsedAt: raw?.screenLastUsedAt ?? null });
      setLoadedAt(Date.now());
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load background jobs."));
    }
  }, [botId]);

  useEffect(() => {
    void load();
    return subscribeEvents((raw) => {
      const event = parseAgentEvent(raw);
      if (event?.type === "job" && (!event.botId || event.botId === botId)) void load();
    });
  }, [botId, load]);

  const running = data?.running ?? 0;
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const refresh = running > 0 ? window.setInterval(() => void load(), 10_000) : undefined;
    return () => { window.clearInterval(tick); if (refresh) window.clearInterval(refresh); };
  }, [running, load]);

  const stop = async (id: string) => {
    if (confirm !== id) { setConfirm(id); return; }
    setConfirm(null);
    try {
      await api(`/api/jobs/${id}/cancel`, { method: "POST" });
      await load();
    } catch (caught) {
      setError(errorMessage(caught, "Could not stop the job."));
    }
  };

  if (!data) return null;
  const lastUsed = data.screenLastUsedAt ? Date.parse(data.screenLastUsedAt) : NaN;
  const screenBusy = controlled || (Number.isFinite(lastUsed) && now - lastUsed < SCREEN_BUSY_MS);
  const note = screenLastUsedLabel(data.screenLastUsedAt, now);
  if (data.jobs.length === 0 && !note) return null;
  const muted = dark ? "text-neutral-400" : "text-muted-foreground";
  const drift = Math.floor((now - loadedAt) / 1000);

  return (
    <section data-testid="computer-jobs" className={cn("thin-type flex shrink-0 flex-col gap-2 text-[13px]", dark && "text-[#e7e9ea]")}>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {showBackgroundPill(running, screenBusy) ? (
          <span data-testid="background-pill" role="status" className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs", dark ? "border-white/10 bg-white/[0.04]" : "border-border bg-card")}>
            <Loader2 className="h-3 w-3 animate-spin text-[#1d9bf0] motion-reduce:animate-none" aria-hidden />
            <span className="t-label">Working in background</span>
            <span className={muted}>· {running} {running === 1 ? "job" : "jobs"}</span>
          </span>
        ) : null}
        {note ? <span data-testid="screen-last-used" className={cn("text-xs", muted)}>{note}</span> : null}
      </div>
      {data.jobs.length > 0 ? (
        <ul data-testid="jobs-list" className={cn("divide-y overflow-hidden rounded-xl border", dark ? "divide-white/10 border-white/10" : "divide-border border-border bg-card")}>
          {data.jobs.slice(0, 6).map((job) => {
            const active = isActiveJob(job.status);
            const elapsed = active ? job.elapsedSeconds + drift : job.elapsedSeconds;
            return (
              <li key={job.id} data-testid="job-row" data-status={job.status} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <button type="button" className="min-w-0 flex-1 truncate text-left" aria-expanded={open === job.id} data-testid="job-open" onClick={() => setOpen(open === job.id ? null : job.id)}>
                    <span className="t-label">{job.name}</span>
                  </button>
                  <span data-testid="job-elapsed" className={cn("tabular-nums text-xs", muted)}>{elapsedLabel(elapsed)}</span>
                  <span data-testid="job-status" className={cn("rounded-full px-2 py-0.5 text-[11px]", active ? "bg-[#1d9bf0]/15 text-[#1d9bf0]" : job.status === "done" ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500")}>{jobStatusLabel(job.status)}</span>
                  {active ? (
                    <button type="button" data-testid="job-stop" className={cn("rounded-full px-2 py-0.5 text-[11px]", confirm === job.id ? "bg-red-600 text-white" : dark ? "bg-white/10 hover:bg-white/15" : "bg-secondary hover:bg-accent")} onClick={() => void stop(job.id)} onBlur={() => setConfirm(null)}>
                      {confirm === job.id ? "Confirm stop" : "Stop"}
                    </button>
                  ) : null}
                </div>
                {open === job.id ? (
                  <JobLogView jobId={job.id} name={job.name} dark={dark} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {error ? <p className="text-center text-xs text-amber-500">{error}</p> : null}
    </section>
  );
}
