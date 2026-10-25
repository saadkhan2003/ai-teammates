"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, asList } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { lastBotPath } from "@/lib/last-bot";

type HomeBot = { id: string };

export default function DashboardPage() {
  const router = useRouter();
  const [bots, setBots] = useState<HomeBot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<unknown>("/api/bots");
      setBots(
        asList(data, ["bots", "items"])
          .map((entry) => ({ id: String(((entry ?? {}) as Record<string, unknown>).id ?? "") }))
          .filter((bot) => bot.id),
      );
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load teammates."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("teammates-bots-changed", refresh);
    return () => window.removeEventListener("teammates-bots-changed", refresh);
  }, [load]);

  useEffect(() => {
    if (loading || error || bots.length === 0) return;
    let last = "";
    try { last = window.localStorage.getItem("teammates-last-bot") || ""; } catch { /* storage unavailable */ }
    const target = lastBotPath(bots, last);
    if (target) router.replace(target);
  }, [bots, error, loading, router]);

  return (
    <div className="grid h-full min-h-0 place-items-center px-4">
      {loading ? (
        <div className="w-full max-w-sm space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
      ) : null}
      {!loading && error ? (
        <div role="alert" className="text-center">
          <p className="text-body-sm">{error}</p>
          <Button variant="outline" className="mt-3" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : null}
      {!loading && !error && bots.length === 0 ? (
        <div className="w-full max-w-md rounded-lg border border-border bg-card px-6 py-8 text-center">
          <img src="/favicon.svg" alt="" className="mx-auto h-10 w-10 rounded-md" />
          <p className="mt-3 text-body-sm font-medium">No teammates yet</p>
          <p className="mt-1 text-body-sm text-muted-foreground">Create one to start a conversation and a computer.</p>
          <Button className="mt-4" onClick={() => window.dispatchEvent(new Event("teammates-open-create"))}>
            New Bot
          </Button>
        </div>
      ) : null}
    </div>
  );
}
