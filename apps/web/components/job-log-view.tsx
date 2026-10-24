"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";

type StreamEvent = { type: string; data?: { lines?: string[]; total?: number; status?: string; asleep?: boolean; maxLines?: number } };

const MAX_LINES = 2000;

/** Terminal-style live log for one background job. Streams over SSE from /api/jobs/{id}/log/stream;
 * reading it never wakes the desktop. Auto-scrolls while at the bottom; scrolling up or Pause holds the view. */
export function JobLogView({ jobId, name, dark = false }: { jobId: string; name: string; dark?: boolean }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("running");
  const [asleep, setAsleep] = useState(false);
  const [ended, setEnded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState(0);
  const pausedRef = useRef(false);
  const pending = useRef<string[]>([]);
  const ref = useRef<HTMLPreElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    setLines(null); setEnded(false); pending.current = [];
    const source = new EventSource(`/api/jobs/${jobId}/log/stream`);
    const add = (next: string[]) => setLines((current) => {
      const merged = [...(current ?? []), ...next];
      return merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged;
    });
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      let event: StreamEvent;
      try { event = JSON.parse(message.data) as StreamEvent; } catch { return; }
      const data = event.data ?? {};
      if (event.type === "snapshot") {
        pending.current = [];
        setLines(data.lines ?? []);
        setTotal(data.total ?? 0);
        if (data.status) setStatus(data.status);
        setAsleep(!!data.asleep);
      } else if (event.type === "lines" && data.lines?.length) {
        setTotal(data.total ?? 0);
        if (pausedRef.current) { pending.current.push(...data.lines); setHeld(pending.current.length); }
        else add(data.lines);
      } else if (event.type === "status" && data.status) {
        setStatus(data.status);
      } else if (event.type === "asleep" || event.type === "awake") {
        setAsleep(event.type === "asleep");
      } else if (event.type === "end") {
        setEnded(true);
        if (data.status) setStatus(data.status);
        source.close();
        setConnected(false);
      }
    };
    return () => source.close();
  }, [jobId]);

  const togglePause = () => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next) {
      const flushed = pending.current;
      pending.current = [];
      setHeld(0);
      if (flushed.length) setLines((current) => [...(current ?? []), ...flushed].slice(-MAX_LINES));
      follow.current = true;
    }
  };

  useEffect(() => {
    const el = ref.current;
    if (el && follow.current && !paused) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const live = connected && !ended && !asleep;
  const state = ended ? "Ended" : asleep ? "Computer asleep" : paused ? "Paused" : live ? "Live" : "Connecting…";
  return (
    <div data-testid="job-log-view" data-state={state.toLowerCase()} className={cn("mt-2 overflow-hidden rounded-md border", dark ? "border-white/10 bg-[#05070a]" : "border-border bg-neutral-950")}>
      <div className="flex items-center gap-2 border-b border-white/10 px-2 py-1 text-[11px] text-neutral-300">
        <span data-testid="job-log-live" className="inline-flex items-center gap-1">
          <span className={cn("h-1.5 w-1.5 rounded-full", live && !paused ? "bg-emerald-400" : ended ? "bg-neutral-500" : "bg-amber-400")} aria-hidden />
          {state}
        </span>
        <span className="text-neutral-500" data-testid="job-log-count">· {lines?.length ?? 0} lines{total > (lines?.length ?? 0) ? ` (last ${MAX_LINES} of ${total})` : ""}{held ? ` · ${held} new` : ""}</span>
        <span className="flex-1" />
        <span className="text-neutral-500">{status}</span>
        {!ended ? (
          <button type="button" data-testid="job-log-pause" aria-pressed={paused} onClick={togglePause}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-200 hover:bg-white/10">
            {paused ? <Play className="h-3 w-3" aria-hidden /> : <Pause className="h-3 w-3" aria-hidden />}
            {paused ? "Resume" : "Pause"}
          </button>
        ) : null}
      </div>
      <pre ref={ref} onScroll={onScroll} data-testid="job-log" aria-label={`${name} log`} aria-readonly="true" aria-live="off" tabIndex={0}
        className="max-h-64 min-h-24 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px] leading-4 text-[#d1fae5]">
        {lines == null ? "Loading log…" : lines.length ? lines.join("\n") : "No output yet."}
        {asleep ? "\n(The computer is asleep. Output resumes when it wakes.)" : ""}
      </pre>
    </div>
  );
}
