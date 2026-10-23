"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, asList } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

type HomeBot = { id: string; name: string; role: string; avatar: string };

function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "T";
}

export default function DashboardPage() {
  const [bots, setBots] = useState<HomeBot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<unknown>("/api/bots");
      setBots(
        asList(data, ["bots", "items"])
          .map((entry) => {
            const record = (entry ?? {}) as Record<string, unknown>;
            return {
              id: String(record.id ?? ""),
              name: String(record.name ?? "Teammate"),
              role: String(record.role ?? ""),
              avatar: String(record.avatar ?? ""),
            };
          })
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
    const query = window.matchMedia("(max-width: 767px)");
    const apply = () => setMobile(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  if (mobile) {
    return (
      <div data-testid="mobile-list" className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm font-medium">Teammates</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : null}
          {!loading && error ? (
            <div role="alert" className="p-4 text-center">
              <p className="text-sm">{error}</p>
              <Button variant="outline" className="mt-3" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : null}
          {!loading && !error && bots.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">No teammates yet</p>
              <Button className="mt-3" onClick={() => window.dispatchEvent(new Event("teammates-open-create"))}>
                New
              </Button>
            </div>
          ) : null}
          {!loading && !error
            ? bots.map((bot) => (
                <Link key={bot.id} href={`/bots/${bot.id}`} className="flex items-center gap-3 border-b border-border px-4 py-3">
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-muted text-xs font-medium">
                    {bot.avatar || initials(bot.name)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{bot.name}</span>
                    {bot.role ? <span className="block truncate text-xs text-muted-foreground">{bot.role}</span> : null}
                  </span>
                </Link>
              ))
            : null}
        </div>
      </div>
    );
  }

  const roster = !loading && !error && bots.length > 0;

  return (
    <div className={roster ? "h-full min-h-0" : "grid h-full place-items-center px-4"}>
      {loading ? (
        <div className="w-full max-w-sm space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
      ) : null}
      {!loading && error ? (
        <div role="alert" className="text-center">
          <p className="text-sm">{error}</p>
          <Button variant="outline" className="mt-3" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : null}
      {!loading && !error && bots.length === 0 ? (
        <div className="w-full max-w-md rounded-lg border border-border bg-card px-6 py-8 text-center">
          <img src="/favicon.svg" alt="" className="mx-auto h-10 w-10 rounded-md" />
          <p className="mt-3 text-sm font-medium">No teammates yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Create one to start a conversation and a computer.</p>
          <Button className="mt-4" onClick={() => window.dispatchEvent(new Event("teammates-open-create"))}>
            New
          </Button>
        </div>
      ) : null}
      {!loading && !error && bots.length > 0 ? (
        <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto px-6 py-6">
          <h1 className="text-lg font-medium">Teammates</h1>
          <p className="mt-1 text-sm text-muted-foreground">Open a conversation. Each one keeps the same computer.</p>
          <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {bots.map((bot) => (
              <li key={bot.id}>
                <Link
                  href={`/bots/${bot.id}`}
                  className="flex h-full flex-col items-center rounded-lg border border-border bg-card px-3 py-4 text-center hover:bg-accent"
                >
                  <span className="grid h-14 w-14 place-items-center rounded-xl bg-muted text-sm font-medium">
                    {bot.avatar || initials(bot.name)}
                  </span>
                  <span className="mt-2 max-w-full truncate text-sm font-medium">{bot.name}</span>
                  {bot.role ? <span className="mt-1 max-w-full truncate text-xs text-muted-foreground">{bot.role}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
