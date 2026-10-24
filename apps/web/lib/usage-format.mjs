// Pure helpers for the Usage & Billing page and the computer view (node --test friendly).

export function percentLabel(percent) {
  const value = Number(percent ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "0%";
  if (value < 1) return "<1%";
  return `${Math.min(999, Math.floor(value))}%`;
}

export function barWidth(percent) {
  const value = Number(percent ?? 0);
  return `${Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))}%`;
}

export function resetsLabel(days) {
  const value = Math.max(0, Math.round(Number(days ?? 0)));
  if (value === 0) return "Resets today";
  return value === 1 ? "Resets in 1 day" : `Resets in ${value} days`;
}

export function creditsLabel(value) {
  const n = Math.round(Number(value ?? 0));
  return n.toLocaleString("en-US");
}

export function onDemandOptions(options) {
  return [{ value: "none", label: "None" }, ...(options ?? []).map((usd) => ({ value: String(usd), label: `$${Number(usd).toFixed(0)}` }))];
}

export function elapsedLabel(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds ?? 0)));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

export function screenLastUsedLabel(iso, now = Date.now()) {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return "Screen last used just now";
  if (minutes < 60) return `Screen last used ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Screen last used ${hours} h ago`;
  return `Screen last used ${Math.floor(hours / 24)} d ago`;
}

const STATUS = { starting: "Starting", running: "Running", done: "Done", failed: "Failed", timed_out: "Timed out", cancelled: "Stopped", blocked_cap: "Paused" };
export function jobStatusLabel(status) {
  return STATUS[status] ?? "Unknown";
}

export function isActiveJob(status) {
  return status === "starting" || status === "running";
}

/** Working in background: jobs run but the screen is not in active use. */
export function showBackgroundPill(running, screenBusy) {
  return Number(running ?? 0) > 0 && !screenBusy;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export function bytesLabel(bytes) {
  const n = Math.max(0, Number(bytes ?? 0));
  if (!Number.isFinite(n) || n === 0) return "0 GB";
  if (n >= 10 * GIB) return `${Math.round(n / GIB)} GB`;
  if (n >= GIB) return `${(n / GIB).toFixed(1)} GB`;
  if (n >= MIB) return `${Math.round(n / MIB)} MB`;
  return "<1 MB";
}

export function coresLabel(min, max) {
  const lo = Number(min ?? 0);
  const hi = Number(max ?? 0);
  const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (!hi) return "";
  return lo && lo !== hi ? `${fmt(lo)}–${fmt(hi)} CPU cores` : `${fmt(hi)} CPU ${hi === 1 ? "core" : "cores"}`;
}

export function storageTone(state) {
  return state === "full" ? "bg-clay" : state === "warning" ? "bg-amber-500" : "bg-[#1d9bf0]";
}
