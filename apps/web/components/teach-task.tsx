"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { api, apiFetch } from "@/lib/api";
import { BotAvatar } from "@/components/bot-avatar";
import { CHUNK_BYTES, DEMO_MESSAGE, formatTimer, startDemoRecorder, type DemoRecorder } from "@/lib/recording";

function b64(bytes: Uint8Array) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

async function upload(botId: string, path: string, blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  for (let offset = 0; offset < bytes.length || offset === 0; offset += CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
    const response = await apiFetch(`/api/bots/${botId}/files`, { method: "PUT", headers: { "x-path": path, "x-append": offset === 0 ? "0" : "1", "Content-Type": "application/octet-stream" }, body: chunk as unknown as BodyInit });
    if (!response.ok) throw new Error("upload_failed");
    if (bytes.length === 0) break;
  }
}

/** "Teach a task": records the live desktop while the user demonstrates, then asks the bot to learn the task from it. */
export function useTeachTask({ botId, conversationId, onBegin, onEnd, onSent }: { botId: string; conversationId?: string; onBegin: () => void; onEnd: () => void; onSent: () => void }) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const recorder = useRef<DemoRecorder | null>(null);
  const starting = useRef(false);

  const start = useCallback(async () => {
    if (starting.current || recorder.current) return;
    starting.current = true;
    setBusy(true);
    onBegin();
    try {
      let canvas: HTMLCanvasElement | null = null;
      for (let i = 0; i < 40 && !canvas; i++) {
        await new Promise(resolve => window.setTimeout(resolve, 250));
        canvas = document.querySelector<HTMLCanvasElement>("[data-testid='desktop-frame'] canvas");
      }
      const handle = canvas ? startDemoRecorder(canvas) : null;
      if (!handle) {
        toast.error(canvas ? "This browser cannot record the screen." : "The desktop is not connected yet. Try again in a moment.");
        onEnd();
        return;
      }
      recorder.current = handle;
      setStartedAt(Date.now());
    } finally { starting.current = false; setBusy(false); }
  }, [botId, onBegin, onEnd]);

  /** Stop, check the recording is not blank or idle, upload it and post the learn message as the user. */
  const finish = useCallback(async () => {
    const handle = recorder.current;
    if (!handle) return;
    recorder.current = null;
    setStartedAt(null);
    const { blob, verdict } = await handle.stop();
    onEnd();
    if (!blob || verdict !== "ok") {
      toast.error(verdict === "blank" ? "The screen stayed blank, so nothing was recorded. Nothing was sent." : "Nothing changed on the screen, so there was nothing to learn from. Nothing was sent.");
      return;
    }
    if (!conversationId) { toast.error("Open a chat first."); return; }
    try {
      const path = `/workspace/recordings/demo-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}.webm`;
      await upload(botId, path, blob);
      await api(`/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ content: DEMO_MESSAGE, skill: "learn-from-demonstration", recording: path }) });
      toast.success("Recording sent. I will learn the task from it.");
      onSent();
    } catch { toast.error("Could not send the recording. Try teaching the task again."); }
  }, [botId, conversationId, onEnd, onSent]);

  const cancel = useCallback(async () => {
    recorder.current?.cancel();
    recorder.current = null;
    setStartedAt(null);
    onEnd();
    toast("Recording discarded.");
    onSent();
  }, [onEnd, onSent]);

  useEffect(() => () => { recorder.current?.cancel(); recorder.current = null; }, [botId]);
  return { recording: startedAt !== null, startedAt, busy, start, finish, cancel };
}

export function RecordingBanner({ botName, shape, color, startedAt, onCancel }: { botName: string; shape?: string; color?: string; startedAt: number; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 500); return () => window.clearInterval(timer); }, []);
  return <div role="status" data-testid="recording-banner" className="fixed left-1/2 top-3 z-[95] flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-red-500/40 bg-neutral-900/95 py-1.5 pl-2 pr-1.5 text-sm text-neutral-100 shadow-lg backdrop-blur">
    <BotAvatar animated shape={shape} color={color} size={24} />
    <span className="truncate font-medium">{botName} is watching and learning</span>
    <span data-testid="recording-timer" className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold tabular-nums text-white"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none" aria-hidden />{formatTimer(now - startedAt)}</span>
    <button type="button" data-testid="recording-cancel" aria-label="Discard recording" onClick={onCancel} className="grid h-7 w-7 place-items-center rounded-full text-neutral-300 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"><X className="h-4 w-4" /></button>
  </div>;
}
