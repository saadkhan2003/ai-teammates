/** Sanity checks and capture helpers for "Teach a task" screen recordings (captured in the browser from the desktop canvas). */

export type Verdict = "ok" | "blank" | "idle";

const W = 32;
const H = 18;

export function lumaOf(rgba: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) out.push(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  return out;
}

export function isBlankFrame(luma: number[]): boolean {
  if (!luma.length) return true;
  let min = 255; let max = 0;
  for (const v of luma) { if (v < min) min = v; if (v > max) max = v; }
  return max - min < 6;
}

export function frameDelta(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

/** blank: the screen never showed anything; idle: nothing moved or changed; ok: there is a real demonstration. */
export function judgeFrames(frames: number[][]): { verdict: Verdict; changes: number } {
  if (frames.length < 2) return { verdict: "idle", changes: 0 };
  const blank = frames.filter(isBlankFrame).length;
  if (blank / frames.length >= 0.9) return { verdict: "blank", changes: 0 };
  let changes = 0;
  for (let i = 1; i < frames.length; i++) if (frameDelta(frames[i - 1], frames[i]) > 0.8) changes++;
  return { verdict: changes >= 2 ? "ok" : "idle", changes };
}

export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export const CHUNK_BYTES = 60 * 1024;
export const MAX_RECORDING_BYTES = 60 * 1024 * 1024;
export const DEMO_MESSAGE = "The recording is finished. Learn the task from it.";

export type DemoRecorder = { stop: () => Promise<{ blob: Blob | null; verdict: Verdict }>; cancel: () => void };

/** Starts recording a canvas (the noVNC desktop). Returns null when the browser cannot record. */
export function startDemoRecorder(canvas: HTMLCanvasElement): DemoRecorder | null {
  if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") return null;
  const stream = canvas.captureStream(8);
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(m => MediaRecorder.isTypeSupported(m));
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 1_200_000 } : undefined);
  const chunks: Blob[] = [];
  let size = 0;
  recorder.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); size += event.data.size; } };
  const probe = document.createElement("canvas");
  probe.width = W; probe.height = H;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  const frames: number[][] = [];
  const sample = () => {
    if (!ctx || !canvas.width) return;
    try { ctx.drawImage(canvas, 0, 0, W, H); frames.push(lumaOf(ctx.getImageData(0, 0, W, H).data)); } catch { /* tainted or detached canvas: skip */ }
  };
  const timer = window.setInterval(() => { sample(); if (size > MAX_RECORDING_BYTES && recorder.state === "recording") recorder.stop(); }, 1000);
  sample();
  recorder.start(2000);
  const finish = () => { window.clearInterval(timer); stream.getTracks().forEach(track => track.stop()); };
  return {
    stop: () => new Promise(resolve => {
      sample();
      const done = () => { finish(); resolve({ blob: new Blob(chunks, { type: "video/webm" }), verdict: judgeFrames(frames).verdict }); };
      if (recorder.state === "inactive") { done(); return; }
      recorder.onstop = done;
      recorder.stop();
    }),
    cancel: () => { try { if (recorder.state !== "inactive") { recorder.onstop = null; recorder.stop(); } } catch { /* already stopped */ } finish(); },
  };
}
