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
