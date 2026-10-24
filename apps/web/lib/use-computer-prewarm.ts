"use client";

import { useCallback } from "react";

const lastAttempt = new Map<string, number>();

// Shared across composer mounts/chat switches. The server checks ownership, policy,
// existing inventory and rate limits; this hint never creates a computer.
export function useComputerPrewarm(botId?: string) {
  return useCallback(() => {
    if (!botId) return;
    const now = performance.now();
    if (now - (lastAttempt.get(botId) ?? -Infinity) < 30_000) return;
    for (const [id, at] of lastAttempt) if (now - at >= 30_000) lastAttempt.delete(id);
    lastAttempt.set(botId, now);
    void fetch(`/api/bots/${encodeURIComponent(botId)}/computer/prewarm`, {
      method: "POST", credentials: "same-origin", cache: "no-store",
    }).catch(() => { /* focus remains instant when a computer is unavailable */ });
  }, [botId]);
}
