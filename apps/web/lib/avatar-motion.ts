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
export const LOBES = 6;
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

/** Closed smooth curve with six rounded lobes, as an SVG path string in a 0..100 box. */
export function lobePath(amp = 0.08, phase = 0, samples = 36): string {
  const cx = 50, cy = 50, base = 38;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const r = base * (1 + amp * Math.cos(LOBES * a + phase)) * (1 - amp * 0.6);
    pts.push([cx + r * Math.cos(a - Math.PI / 2), cy + r * Math.sin(a - Math.PI / 2)]);
  }
  const f = (n: number) => n.toFixed(2);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < samples; i++) {
    const p0 = pts[(i - 1 + samples) % samples], p1 = pts[i], p2 = pts[(i + 1) % samples], p3 = pts[(i + 2) % samples];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}

export const LOBE_STATIC_PATH = lobePath(0.16, 0, 36);

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
