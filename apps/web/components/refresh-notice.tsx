"use client";

import { RotateCw, TriangleAlert } from "lucide-react";
import { retryNow, useConnection } from "@/lib/connection";
import { cn } from "@/lib/utils";

// Sidebar variant: grey text and a small round refresh button above the bot card.
// Chat variant: a warning row with a "Try again" pill under the working indicator.
export function RefreshNotice({ variant }: { variant: "sidebar" | "chat" }) {
  const { failed, retrying } = useConnection();
  if (!failed) return null;
  if (variant === "sidebar") {
    return (
      <div data-testid="refresh-notice-sidebar" role="status" className="flex items-center justify-between gap-2 px-4 pb-2 text-sm text-muted-foreground">
        <span>Couldn&apos;t refresh</span>
        <button
          type="button"
          data-testid="refresh-retry-sidebar"
          aria-label="Refresh"
          disabled={retrying}
          onClick={retryNow}
          className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          <RotateCw className={cn("h-4 w-4", retrying && "animate-spin motion-reduce:animate-none")} aria-hidden />
        </button>
      </div>
    );
  }
  return (
    <div data-testid="refresh-notice-chat" role="alert" className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2 text-sm">
      <TriangleAlert className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
      <span className="flex-1">Couldn&apos;t refresh</span>
      <button
        type="button"
        data-testid="refresh-retry-chat"
        disabled={retrying}
        onClick={retryNow}
        className="rounded-full bg-muted px-3 py-1 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      >
        {retrying ? "Trying…" : "Try again"}
      </button>
    </div>
  );
}
