import { lobePath, LOBES, LOBE_STATIC_PATH } from "@/lib/avatar-shapes";
export { lobePath, LOBES, LOBE_STATIC_PATH } from "@/lib/avatar-shapes";
import { BOT_AVATARS, defaultBotAvatar } from "./avatars";

/** One clockwise turn of the live avatars. */
export const SPIN_PERIOD_S = 40;
/** One blink. The gap between blinks stays inside 4–5s. */
export const BLINK_PERIOD_S = 4.6;
/** Left / right eye darts. The move itself is a short ease-out, then a hold. */
export const DART_PERIOD_S = 3.2;
export const DART_SNAP_S = 0.14;
/** How far a full dart shifts the eyes, in avatar viewBox units. */
export const DART_AMPLITUDE = 3.6;

const BLINK_SHUT_S = 4.15;
const BLINK_CLOSE_S = 0.07;
const BLINK_HOLD_S = 0.04;
const BLINK_OPEN_S = 0.12;

export type AvatarPose = {
  spinDeg: number;
  scaleX: number;
  scaleY: number;
  blink: number;
  dartX: number;
  dartY: number;
};

export const REST_POSE: AvatarPose = {
  spinDeg: 0,
  scaleX: 1,
  scaleY: 1,
  blink: 1,
  dartX: 0,
  dartY: 0,
};

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function wrap(value: number, period: number) {
  if (!Number.isFinite(value) || !(period > 0)) return 0;
  return ((value % period) + period) % period;
}

/** Fast at the start, then settles. Used for blinks and eye darts. */
export function easeOutCubic(amount: number) {
  const t = clamp(amount, 0, 1);
  return 1 - (1 - t) ** 3;
}

export function spinDegrees(timeSec: number) {
  return wrap(timeSec, SPIN_PERIOD_S) * (360 / SPIN_PERIOD_S);
}

export function breatheScales(timeSec: number) {
  const primary = Math.sin((timeSec * Math.PI * 2) / 3.4);
  const secondary = Math.sin((timeSec * Math.PI * 2) / 5.1 + 0.9);
  return {
    scaleX: 1 + primary * 0.028 + secondary * 0.012,
    scaleY: 1 + Math.sin((timeSec * Math.PI * 2) / 3.4 + 2.1) * 0.034 + secondary * 0.01,
  };
}

export function blinkAmount(timeSec: number) {
  const phase = wrap(timeSec, BLINK_PERIOD_S);
  const closeEnd = BLINK_SHUT_S + BLINK_CLOSE_S;
  const holdEnd = closeEnd + BLINK_HOLD_S;
  const openEnd = holdEnd + BLINK_OPEN_S;
  if (phase < BLINK_SHUT_S || phase >= openEnd) return 1;
  if (phase < closeEnd) return 1 - easeOutCubic((phase - BLINK_SHUT_S) / BLINK_CLOSE_S) * 0.9;
  if (phase < holdEnd) return 0.1;
  return 0.1 + easeOutCubic((phase - holdEnd) / BLINK_OPEN_S) * 0.9;
}

type Stop = { t: number; v: number };

export function snapped(phase: number, stops: Stop[], snap: number) {
  if (stops.length === 0) return 0;
  let current = stops[0].v;
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const next = stops[index];
    const begin = next.t;
    const end = next.t + snap;
    if (phase < begin) return previous.v;
    if (phase < end) {
      const progress = snap <= 0 ? 1 : (phase - begin) / snap;
      return previous.v + (next.v - previous.v) * easeOutCubic(progress);
    }
    current = next.v;
  }
  return current;
}

export function dartOffset(timeSec: number) {
  const phase = wrap(timeSec, DART_PERIOD_S);
  return snapped(
    phase,
    [
      { t: 0, v: 0 },
      { t: 0.55, v: -DART_AMPLITUDE },
      { t: 1.35, v: DART_AMPLITUDE },
      { t: 2.15, v: 0 },
    ],
    DART_SNAP_S,
  );
}

export function poseAt(timeSec: number): AvatarPose {
  const breath = breatheScales(timeSec);
  return {
    spinDeg: spinDegrees(timeSec),
    scaleX: breath.scaleX,
    scaleY: breath.scaleY,
    blink: blinkAmount(timeSec),
    dartX: dartOffset(timeSec),
    dartY: 0,
  };
}

/** Cursor offset in viewBox units. `dx`/`dy` are pixels from the avatar center. */
export function lookVector(dx: number, dy: number, halfW: number, halfH: number) {
  const nx = clamp(dx / Math.max(halfW, 1), -1, 1);
  const ny = clamp(dy / Math.max(halfH, 1), -1, 1);
  return { x: nx * 4.4, y: ny * 3.1 };
}

export function resolveAvatarAppearance(shape: string | undefined, color: string | undefined, botId: string | undefined) {
  const fallback = defaultBotAvatar(botId ?? "new-bot");
  const found = BOT_AVATARS.findIndex((item) => item.id === shape);
  const selectedIndex = found >= 0 ? found : BOT_AVATARS.findIndex((item) => item.id === fallback.shape);
  const selected = BOT_AVATARS[selectedIndex] ?? BOT_AVATARS[0];
  const alt = BOT_AVATARS[(selectedIndex + 1) % BOT_AVATARS.length];
  const fill = /^#[0-9a-fA-F]{6}$/.test(color ?? "") ? (color as string) : fallback.color;
  return { path: selected.path, altPath: alt.path, fill, shapeId: selected.id };
}

export function lastMessagePreview(content: string, max = 72) {
  const trimmed = content.trim();
  if (!trimmed) return "";
  const fenced = trimmed.match(/```(?:[\w-]+)?\s*([\s\S]*?)```/);
  const source = (fenced?.[1] ?? trimmed).trim();
  let text = source;
  if (source.startsWith("{") || source.startsWith("[")) {
    try {
      const json = JSON.parse(source) as Record<string, unknown>;
      const prompt = json.prompt ?? json.title ?? json.content ?? json.text;
      if (typeof prompt === "string" && prompt.trim()) text = prompt.trim();
    } catch {
      text = source;
    }
  }
  text = text
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

// Shared animation clock for bot avatars. Every animated avatar reads the same frame function and the same
// clock, so the sidebar card, the chat header pill and any other copy move in perfect sync.
// Original artwork: a six-lobed blob built from a polar curve, plus eyes that morph between shapes.

export type AvatarMode = "idle" | "working";

export type EyeFrame = { w: number; h: number; rx: number; rot: number; dx: number; dy: number };
export type AvatarFrame = {
  sx: number; sy: number; tx: number; rot: number;
  lobeAmp: number; lobePhase: number;
  eye: EyeFrame;
};

export const IDLE_LOOP_S = 8.5;

const PILL: EyeFrame = { w: 11, h: 18, rx: 5.5, rot: -14, dx: 0, dy: 0 };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => { const x = clamp01(v); return x * x * (3 - 2 * x); };
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
/** 0 → 1 → 0 bump over [from, to]. */
const bump = (t: number, from: number, to: number) => smooth((t - from) / ((to - from) / 2)) * (1 - smooth((t - (from + to) / 2) / ((to - from) / 2)));

/** Damped spring after the squash: starts at 1 and rings down to 0. */
export function elastic(sinceS: number): number {
  if (sinceS < 0) return 0;
  return Math.exp(-5.5 * sinceS) * Math.cos(2 * Math.PI * 2.3 * sinceS);
}

function mixEye(a: EyeFrame, b: EyeFrame, k: number): EyeFrame {
  return { w: mix(a.w, b.w, k), h: mix(a.h, b.h, k), rx: mix(a.rx, b.rx, k), rot: mix(a.rot, b.rot, k), dx: mix(a.dx, b.dx, k), dy: mix(a.dy, b.dy, k) };
}

/** Pure frame function: time in seconds and the mode give every number the renderer needs. */
export function avatarFrame(t: number, mode: AvatarMode, reduced = false): AvatarFrame {
  if (reduced) {
    const eye = mode === "working" ? { w: 13, h: 13, rx: 6.5, rot: 0, dx: 0, dy: 0 } : PILL;
    return { sx: 1, sy: 1, tx: 0, rot: 0, lobeAmp: 0.08, lobePhase: 0, eye };
  }
  if (mode === "working") {
    const lobePhase = t * 2 * Math.PI / 1.4;
    const dart = Math.floor(t / 0.55);
    const frac = smooth((t % 0.55) / 0.12);
    const pos = (n: number) => ({ x: Math.sin(n * 12.9898) * 3.2, y: Math.cos(n * 78.233) * 2.2 });
    const from = pos(dart - 1), to = pos(dart);
    const breathe = Math.sin(t * 2 * Math.PI / 0.9);
    return {
      sx: 1 + 0.025 * breathe, sy: 1 - 0.025 * breathe, tx: 0, rot: 1.5 * Math.sin(t * 2 * Math.PI / 1.4),
      lobeAmp: 0.115 + 0.02 * Math.sin(t * 3), lobePhase,
      eye: { w: 13, h: 13, rx: 6.5, rot: 0, dx: mix(from.x, to.x, frac), dy: mix(from.y, to.y, frac) },
    };
  }
  const p = ((t % IDLE_LOOP_S) + IDLE_LOOP_S) % IDLE_LOOP_S;
  const breathe = Math.sin(2 * Math.PI * p / 4.25);
  // wobble 1.6s..3.8s: side-to-side, eyes parallax against the body
  const wobEnv = bump(p, 1.6, 3.8);
  const wob = Math.sin((p - 1.6) * 2 * Math.PI / 1.1) * wobEnv;
  // squash 5.6s..5.9s then elastic bounce
  const squash = bump(p, 5.5, 5.9);
  const ring = p > 5.9 ? elastic(p - 5.9) : 0;
  const sy = 1 + 0.02 * breathe - 0.16 * squash + 0.08 * ring;
  const sx = 1 - 0.01 * breathe + 0.12 * squash - 0.06 * ring;
  let eye = PILL;
  // eyes: pills → short rectangles while squashed → angled teardrops while wobbling
  eye = mixEye(eye, { w: 15, h: 9, rx: 2.5, rot: 0, dx: 0, dy: 1 }, squash);
  eye = mixEye(eye, { w: 11, h: 17, rx: 5.5, rot: -22 * Math.sign(wob || 1), dx: 0, dy: 0 }, Math.min(1, Math.abs(wob) * 0.9));
  // blink around 7.6s
  const blink = bump(p, 7.5, 7.75);
  eye = { ...eye, h: eye.h * (1 - 0.7 * blink), dx: eye.dx - wob * 2.6, dy: eye.dy + ring * 1.2 };
  return {
    sx, sy, tx: wob * 3, rot: wob * 4, lobeAmp: 0.075 + 0.012 * breathe, lobePhase: p * 0.15 + 0.35 * wob, eye,
  };
}

// ---- clock ----

type Listener = (frame: AvatarFrame) => void;
const listeners = new Set<Listener>();
let mode: AvatarMode = "idle";
let raf = 0;
let startedAt = 0;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function getAvatarMode(): AvatarMode { return mode; }

export function setAvatarMode(next: AvatarMode) {
  if (mode === next) return;
  mode = next;
  startedAt = typeof performance !== "undefined" ? performance.now() : 0;
  tick(true);
}

function frameNow(): AvatarFrame {
  const t = ((typeof performance !== "undefined" ? performance.now() : 0) - startedAt) / 1000;
  return avatarFrame(t, mode, prefersReducedMotion());
}

function tick(once = false) {
  if (listeners.size === 0) { raf = 0; return; }
  const frame = frameNow();
  listeners.forEach(listener => listener(frame));
  if (once || prefersReducedMotion() || (typeof document !== "undefined" && document.hidden)) { raf = 0; if (!once && typeof document !== "undefined" && document.hidden) wake(); return; }
  raf = requestAnimationFrame(() => tick());
}

function wake() {
  if (typeof document === "undefined") return;
  const resume = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", resume); if (!raf && listeners.size) raf = requestAnimationFrame(() => tick()); } };
  document.addEventListener("visibilitychange", resume);
}

export function subscribeAvatar(listener: Listener): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (listeners.size === 0 && !startedAt) startedAt = performance.now();
  listeners.add(listener);
  listener(frameNow());
  if (!raf && !prefersReducedMotion()) raf = requestAnimationFrame(() => tick());
  return () => { listeners.delete(listener); if (listeners.size === 0 && raf) { cancelAnimationFrame(raf); raf = 0; } };
}
