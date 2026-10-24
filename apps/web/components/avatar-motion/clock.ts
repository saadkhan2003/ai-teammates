import { poseAt, REST_POSE, type AvatarPose } from "@/lib/avatar-motion";
import { bindAvatarLook, unbindAvatarLook } from "@/components/avatar-motion/look";

let subscribers = 0;
let running = false;
let reduced = false;
let media: MediaQueryList | null = null;

function readMotionSeconds() {
  if (window.__avatarMotionFreeze === true) {
    const injected = window.__avatarMotionNow;
    if (typeof injected === "number" && Number.isFinite(injected)) return injected;
  }
  return performance.now() / 1000;
}

function writePose(pose: AvatarPose, frameMs: number) {
  const root = document.documentElement;
  root.style.setProperty("--avatar-spin", `${pose.spinDeg.toFixed(3)}deg`);
  root.style.setProperty("--avatar-sx", pose.scaleX.toFixed(4));
  root.style.setProperty("--avatar-sy", pose.scaleY.toFixed(4));
  root.style.setProperty("--avatar-blink", pose.blink.toFixed(4));
  root.style.setProperty("--avatar-dart-x", pose.dartX.toFixed(4));
  root.style.setProperty("--avatar-dart-y", pose.dartY.toFixed(4));
  if (root.dataset.avatarDebug === "1") {
    root.dataset.avatarSpin = pose.spinDeg.toFixed(3);
    root.dataset.avatarBlink = pose.blink.toFixed(3);
    root.dataset.avatarDart = pose.dartX.toFixed(3);
    root.dataset.avatarSx = pose.scaleX.toFixed(4);
    root.dataset.avatarFrameMs = frameMs.toFixed(3);
  }
}

function tick() {
  if (!running) return;
  if (reduced) {
    writePose(REST_POSE, 0);
    return;
  }
  const started = performance.now();
  writePose(poseAt(readMotionSeconds()), 0);
  const frameMs = performance.now() - started;
  if (document.documentElement.dataset.avatarDebug === "1") {
    document.documentElement.dataset.avatarFrameMs = frameMs.toFixed(3);
  }
  if (running && !reduced) requestAnimationFrame(tick);
}

function applyReduced() {
  reduced = Boolean(media?.matches);
  document.documentElement.dataset.avatarReduced = reduced ? "1" : "0";
  if (reduced) writePose(REST_POSE, 0);
  else if (running) requestAnimationFrame(tick);
}

export function startAvatarClock() {
  if (typeof window === "undefined") return () => undefined;
  subscribers += 1;
  if (subscribers === 1) {
    running = true;
    media = window.matchMedia("(prefers-reduced-motion: reduce)");
    media.addEventListener("change", applyReduced);
    bindAvatarLook(() => reduced);
    applyReduced();
  }
  return () => {
    subscribers -= 1;
    if (subscribers > 0) return;
    subscribers = 0;
    running = false;
    media?.removeEventListener("change", applyReduced);
    media = null;
    unbindAvatarLook();
  };
}

declare global {
  interface Window {
    __avatarMotionNow?: number;
    __avatarMotionFreeze?: boolean;
  }
}
