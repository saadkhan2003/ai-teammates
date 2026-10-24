// Content-free, bounded real-user measurements. All clocks are browser monotonic clocks.
export type PerfSample = { name: string; value_ms: number; at: number };
declare global { interface Window { __teammatesPerf?: PerfSample[] } }
const marks = new Map<string, number>();
const pending: Array<{ name: string; value_ms: number; route: string; attrs?: Record<string, number | boolean> }> = [];
let initialized = false;
let sequence = 0;
let switchTarget: string | null = null;
export function clampMs(value: number): number | null {
  return Number.isFinite(value) ? Math.max(0, Math.min(600000, value)) : null;
}
export function routeTemplate(path: string): string {
  if (/^\/bots\/[^/]+\/?$/.test(path)) return "/bots/[id]";
  return ["/", "/login", "/settings", "/library", "/routines"].includes(path) ? path : "/";
}
export function recordPerf(name: string, value: number, attrs?: Record<string, number | boolean>) {
  if (typeof window === "undefined") return;
  const value_ms = clampMs(value);
  if (value_ms === null) return;
  const history = window.__teammatesPerf ??= [];
  history.push({ name, value_ms, at: performance.now() });
  if (history.length > 1000) history.splice(0, history.length - 1000);
  if (pending.length < 200) pending.push({ name, value_ms, route: routeTemplate(location.pathname), attrs });
}
export function markPerf(key: string) {
  if (typeof window === "undefined") return;
  marks.set(key, performance.now());
  // Keep the browser's own timeline bounded too.
  performance.clearMarks(`teammates:${key}`);
  performance.mark(`teammates:${key}`);
  if (marks.size > 100) cancelPerf(marks.keys().next().value!);
}
export function cancelPerf(key: string) {
  marks.delete(key);
  if (typeof window !== "undefined") performance.clearMarks(`teammates:${key}`);
}
export function measurePerf(name: string, start: number, end?: number) {
  if (typeof window === "undefined") return;
  const at = end ?? performance.now();
  performance.clearMeasures(`teammates:${name}`);
  performance.measure(`teammates:${name}`, { start, end: at });
  recordPerf(name, at - start);
}
export function paintedPerf(key: string, name: string) {
  if (typeof window === "undefined") return;
  const start = marks.get(key);
  if (start === undefined) return;
  cancelPerf(key); // Consume before scheduling so repeated commits cannot duplicate a measure.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    performance.clearMarks(`teammates:${name}:paint`);
    performance.mark(`teammates:${name}:paint`);
    measurePerf(name, start);
  }));
}
export function beginSendPerf(): string {
  const id = `send:${++sequence}`;
  if (typeof window !== "undefined") {
    performance.clearMarks("teammates:send"); performance.mark("teammates:send");
  }
  for (const metric of ["echo_ms", "ack_ms", "first_token_screen_ms", "tool_chip_ms"]) markPerf(`${id}:${metric}`);
  return id;
}
export function endSendPerf(id: string) {
  for (const metric of ["echo_ms", "ack_ms", "first_token_screen_ms", "tool_chip_ms"]) cancelPerf(`${id}:${metric}`);
}
export function chatPaintedPerf(botId?: string) {
  if (switchTarget && switchTarget === `/bots/${botId}`) {
    paintedPerf("chat-switch", "chat_switch_ms");
    switchTarget = null;
  }
}
function flushPerf(beacon = false) {
  if (!pending.length) return;
  const events = pending.splice(0, 50);
  const body = JSON.stringify({ events });
  if (beacon && navigator.sendBeacon?.("/api/rum", new Blob([body], { type: "application/json" }))) return;
  void fetch("/api/rum", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body, keepalive: true }).catch(() => {});
}
export function initPerf() {
  if (typeof window === "undefined" || initialized) return;
  initialized = true;
  window.setInterval(() => flushPerf(), 5000);
  window.addEventListener("pagehide", () => { while (pending.length) flushPerf(true); });
  document.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const a = event.target.closest<HTMLAnchorElement>('a[href^="/bots/"]');
    if (!a || (event instanceof MouseEvent && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0))) return;
    if (a.pathname === location.pathname) return;
    switchTarget = a.pathname;
    markPerf("chat-switch");
  }, true);
  void import("web-vitals").then(({ onLCP, onINP }) => {
    onLCP(metric => recordPerf("lcp_ms", metric.value));
    onINP(metric => recordPerf("inp_ms", metric.value));
  }).catch(() => {});
}
