"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ComputerPhase = "connecting" | "live" | "error" | "sleeping" | "offline" | "desktop-asleep";

/** Our own dark wallpaper: soft vignette plus one light swoosh. Pure SVG, no external image. */
export function Wallpaper({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice" className={cn("absolute inset-0 h-full w-full", className)}>
      <defs>
        <radialGradient id="wp-bg" cx="70%" cy="30%" r="90%">
          <stop offset="0" stopColor="#2b2d33" />
          <stop offset="0.55" stopColor="#17181c" />
          <stop offset="1" stopColor="#0b0b0e" />
        </radialGradient>
        <linearGradient id="wp-swoosh" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.45" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="160" height="100" fill="url(#wp-bg)" />
      <path d="M-10 78 C 30 70, 52 20, 92 24 S 140 60, 172 8 L 172 22 C 140 76, 100 40, 90 40 S 36 92, -10 92 Z" fill="url(#wp-swoosh)" />
    </svg>
  );
}

/** What the Computer card shows until the live frame is ready (or when it cannot be). */
export function ComputerState({
  phase,
  name,
  avatar,
  onRetry,
}: {
  phase: Exclude<ComputerPhase, "live">;
  name: string;
  avatar: ReactNode;
  onRetry: () => void;
}) {
  const copy = {
    connecting: { title: "Waking up…", sub: "Connecting" },
    sleeping: { title: `${name}'s computer is resting`, sub: "It wakes up when a task needs it" },
    "desktop-asleep": { title: "Desktop asleep", sub: "Wakes on demand. Jobs and files keep running." },
    error: { title: "Couldn't connect", sub: "The computer isn't answering" },
    offline: { title: "You're offline", sub: "Reconnecting when the network is back" },
  }[phase];
  return (
    <div
      data-testid="computer-state"
      data-phase={phase}
      role="status"
      aria-live="polite"
      className="motion-fade absolute inset-0 overflow-hidden bg-neutral-950 text-center"
    >
      <div data-testid={phase === "sleeping" || phase === "desktop-asleep" ? "computer-asleep" : undefined}><Wallpaper /></div>
      <div className="relative grid h-full place-items-center px-3">
        <div className="flex flex-col items-center gap-1.5">
          <div className={cn("grid h-10 w-10 place-items-center", phase === "connecting" && "animate-pulse motion-reduce:animate-none")}>{avatar}</div>
          <p data-testid="computer-state-title" className="text-xs font-medium text-neutral-300">{copy.title}</p>
          <p data-testid="computer-state-sub" className="text-[11px] leading-none text-neutral-500">{copy.sub}</p>
          {phase === "error" || phase === "sleeping" || phase === "desktop-asleep" ? (
            <Button
              type="button"
              data-no-expand
              data-testid="computer-retry"
              variant="secondary"
              size="sm"
              className="mt-1 h-6 rounded-full px-3 text-[11px]"
              onClick={(event) => { event.stopPropagation(); onRetry(); }}
            >
              <span data-testid={phase === "sleeping" || phase === "desktop-asleep" ? "computer-wake" : undefined}>{phase === "error" ? "Retry" : phase === "desktop-asleep" ? "Watch" : "Wake up"}</span>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Tiny page dots at the card's bottom-left: one per display, the active one brighter. */
export function DisplayDots({ count = 1, active = 0 }: { count?: number; active?: number }) {
  return (
    <div data-testid="computer-dots" aria-hidden className="pointer-events-none absolute bottom-1.5 left-2 flex items-center gap-1">
      {Array.from({ length: Math.max(1, count) }, (_, i) => (
        <span key={i} data-active={i === active ? "true" : undefined} className={cn("h-1 w-1 rounded-full", i === active ? "bg-white/80" : "bg-white/30")} />
      ))}
    </div>
  );
}
