import { useSyncExternalStore } from "react";

// One shared "couldn't refresh" state for the whole app. Any failed request,
// dropped stream or offline event marks it failed; any success clears it.
// While failed it retries with backoff by firing "teammates-refresh", which the
// shell, workspace and event stream listen for. Retry now fires the same event.
export type ConnectionState = { failed: boolean; retrying: boolean; attempt: number };

export const REFRESH_EVENT = "teammates-refresh";
export const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];

let state: ConnectionState = { failed: false, retrying: false, attempt: 0 };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let spinTimer: ReturnType<typeof setTimeout> | null = null;

function set(next: ConnectionState) {
  if (next.failed === state.failed && next.retrying === state.retrying && next.attempt === state.attempt) return;
  state = next;
  listeners.forEach(listener => listener());
}

function schedule() {
  if (timer || typeof window === "undefined") return;
  const delay = BACKOFF_MS[Math.min(state.attempt, BACKOFF_MS.length - 1)];
  timer = setTimeout(() => { timer = null; fire(); }, delay);
}

function fire() {
  if (!state.failed || typeof window === "undefined") return;
  set({ ...state, retrying: true, attempt: state.attempt + 1 });
  window.dispatchEvent(new Event(REFRESH_EVENT));
  if (spinTimer) clearTimeout(spinTimer);
  spinTimer = setTimeout(() => { spinTimer = null; set({ ...state, retrying: false }); }, 1200);
  schedule();
}

export function reportFailure() {
  if (typeof window === "undefined") return;
  if (!state.failed) set({ failed: true, retrying: false, attempt: 0 });
  schedule();
}

export function reportSuccess() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (spinTimer) { clearTimeout(spinTimer); spinTimer = null; }
  set({ failed: false, retrying: false, attempt: 0 });
}

// The Try again / refresh button. Resets the backoff and refetches now.
export function retryNow() {
  if (typeof window === "undefined") return;
  if (timer) { clearTimeout(timer); timer = null; }
  if (!state.failed) { window.dispatchEvent(new Event(REFRESH_EVENT)); return; }
  set({ ...state, attempt: 0 });
  fire();
}

export function getConnectionState() { return state; }

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const serverState: ConnectionState = { failed: false, retrying: false, attempt: 0 };

export function useConnection(): ConnectionState {
  return useSyncExternalStore(subscribe, () => state, () => serverState);
}

let wired = false;
// Browser offline / online events. Safe to call more than once.
export function wireConnectionEvents() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("offline", () => reportFailure());
  window.addEventListener("online", () => retryNow());
  if (navigator.onLine === false) reportFailure();
}
