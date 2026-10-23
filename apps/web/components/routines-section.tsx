"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { cronToWords } from "@/lib/cron";
import type { Routine } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

/** The Routines card on the Details tab: name, schedule in words, and an accent-coloured on/off switch. */
export function RoutinesSection({
  routines,
  loaded,
  error,
  onRetry,
  onChanged,
}: {
  routines: Routine[];
  loaded: boolean;
  error: string | null;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<Record<string, boolean>>({});

  async function toggle(routine: Routine, enabled: boolean) {
    setPending((current) => ({ ...current, [routine.id]: enabled }));
    try {
      await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      onChanged();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not update that routine."));
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[routine.id];
        return next;
      });
    }
  }

  return (
    <section data-testid="routines-section" className="border-b border-border px-3 py-3">
      <div>
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Routines</h2>
      </div>
      <div className="mt-2 overflow-hidden rounded-2xl border border-border bg-card">
        {!loaded ? (
          <div role="status" aria-busy="true" data-testid="routines-skeleton" className="divide-y divide-border">
            <span className="sr-only">Loading routines</span>
            {[0, 1].map((row) => (
              <div key={row} aria-hidden className="flex items-center gap-3 px-3 py-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
                <Skeleton className="h-5 w-9 rounded-full" />
              </div>
            ))}
          </div>
        ) : null}
        {loaded && error ? (
          <div data-testid="routines-error" className="flex items-center justify-between gap-2 px-3 py-3">
            <p role="alert" className="text-sm text-destructive">Couldn&apos;t load routines.</p>
            <Button type="button" variant="outline" size="sm" data-testid="routines-retry" onClick={onRetry}>Try again</Button>
          </div>
        ) : null}
        {loaded && !error && routines.length === 0 ? (
          <p data-testid="routines-empty" className="px-3 py-4 text-sm text-muted-foreground">No routines yet</p>
        ) : null}
        {loaded && !error && routines.length > 0 ? (
          <ul className="divide-y divide-border">
            {routines.map((routine) => {
              const enabled = pending[routine.id] ?? routine.enabled !== false;
              return (
                <li key={routine.id} data-testid="routine-row" className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={routine.name}>{routine.name}</p>
                    <p data-testid="routine-schedule" className="truncate text-xs text-muted-foreground">{cronToWords(routine.cron)}</p>
                  </div>
                  <Switch
                    data-testid="routine-toggle"
                    aria-label={`${routine.name} enabled`}
                    checked={enabled}
                    onCheckedChange={(value) => void toggle(routine, value)}
                    className="duration-200 motion-reduce:transition-none data-[state=checked]:bg-[var(--bot-accent,var(--primary))] data-[state=unchecked]:bg-muted-foreground/30"
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
