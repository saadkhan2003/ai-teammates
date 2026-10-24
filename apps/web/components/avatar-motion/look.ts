import { lookVector } from "@/lib/avatar-motion";

type Center = { x: number; y: number; halfW: number; halfH: number };

const centers = new Map<HTMLElement, Center>();
let pointerX = 0;
let pointerY = 0;
let pointerSeen = false;
let lookFrame = 0;
let listening = false;
let reducedNow = () => false;

function measure(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  centers.set(el, {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    halfW: Math.max(rect.width / 2, 1),
    halfH: Math.max(rect.height / 2, 1),
  });
}

function measureAll() {
  for (const el of centers.keys()) {
    if (!el.isConnected) {
      centers.delete(el);
      continue;
    }
    measure(el);
  }
}

function applyLook() {
  lookFrame = 0;
  if (!pointerSeen || reducedNow()) return;
  for (const [el, center] of centers) {
    if (!el.isConnected) {
      centers.delete(el);
      continue;
    }
    const look = lookVector(pointerX - center.x, pointerY - center.y, center.halfW, center.halfH);
    el.style.setProperty("--look-x", look.x.toFixed(3));
    el.style.setProperty("--look-y", look.y.toFixed(3));
  }
}

function scheduleLook() {
  if (lookFrame) return;
  lookFrame = requestAnimationFrame(applyLook);
}

function onPointer(event: PointerEvent) {
  pointerX = event.clientX;
  pointerY = event.clientY;
  pointerSeen = true;
  scheduleLook();
}

export function bindAvatarLook(isReduced: () => boolean) {
  reducedNow = isReduced;
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("resize", measureAll, { passive: true });
  window.addEventListener("scroll", measureAll, { capture: true, passive: true });
}

export function unbindAvatarLook() {
  if (!listening || typeof window === "undefined") return;
  listening = false;
  window.removeEventListener("pointermove", onPointer);
  window.removeEventListener("resize", measureAll);
  window.removeEventListener("scroll", measureAll, true);
  if (lookFrame) cancelAnimationFrame(lookFrame);
  lookFrame = 0;
}

export function observeAvatarLook(el: HTMLElement) {
  measure(el);
  const observer = new ResizeObserver(() => measure(el));
  observer.observe(el);
  const onEnter = () => measure(el);
  el.addEventListener("pointerenter", onEnter, { passive: true });
  return () => {
    observer.disconnect();
    el.removeEventListener("pointerenter", onEnter);
    centers.delete(el);
    el.style.removeProperty("--look-x");
    el.style.removeProperty("--look-y");
  };
}
