"use client";

import { type ReactNode, useEffect, useRef } from "react";

/** Small anchored popover: closes on Esc and outside press, returns focus to its trigger. No new dependency. */
export function PopoverLite({ open, onClose, children, label, className = "", anchorRef }: {
  open: boolean; onClose: () => void; children: ReactNode; label: string; className?: string; anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); anchorRef?.current?.focus(); }
    }
    function onDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node) && !anchorRef?.current?.contains(event.target as Node)) onClose();
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onDown, true); };
  }, [open, onClose, anchorRef]);
  if (!open) return null;
  return <div ref={ref} role="dialog" aria-label={label} className={`motion-pop absolute z-40 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md ${className}`}>{children}</div>;
}
