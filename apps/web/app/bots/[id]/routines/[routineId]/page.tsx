"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { cardClass, PageError, PageSkeleton, SectionTitle } from "@/components/account/chrome";
import { api, normalizeRoutines } from "@/lib/api";
import { errorMessage, formatWhen } from "@/lib/utils";

export default function RoutineDetailPage() {
  const params = useParams<{ id: string; routineId: string }>();
  const botId = typeof params.id === "string" ? params.id : "";
  const routineId = typeof params.routineId === "string" ? params.routineId : "";
  const [row, setRow] = useState<ReturnType<typeof normalizeRoutines>[number] | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!botId) return;
    let live = true;
    api<unknown>(`/api/bots/${botId}/routines`)
      .then((body) => {
        if (!live) return;
        const found = normalizeRoutines(body).find((item) => item.id === routineId) ?? null;
        setRow(found);
        setMissing(!found);
      })
      .catch((caught) => {
        if (live) setError(errorMessage(caught, "This routine could not be loaded."));
      });
    return () => {
      live = false;
    };
  }, [botId, routineId]);

  return (
    <main data-testid="routine-page" className="mx-auto flex w-full max-w-[var(--content-width)] flex-col gap-[var(--space-section)] px-[var(--space-page)] py-[var(--space-page)]">
      <header>
        <Link href={`/bots/${botId}/routines`} className="text-body-sm text-muted-foreground underline">
          All routines
        </Link>
        <h1 className="mt-2 text-title">{row?.name ?? "Routine"}</h1>
      </header>
      {error ? <PageError title="Could not load this routine." detail={error} /> : null}
      {!row && !error && !missing ? <PageSkeleton /> : null}
      {missing ? <PageError title="That routine is not here." detail="It may have been removed." /> : null}
      {row ? (
        <section className={`${cardClass} grid gap-4 p-4 sm:grid-cols-3`}>
          <article>
            <SectionTitle>Status</SectionTitle>
            <p className="mt-2">
              <span className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-meta">{row.enabled === false ? "Paused" : "Active"}</span>
            </p>
          </article>
          <article>
            <p className="text-meta font-medium uppercase tracking-wide text-muted-foreground">Cron</p>
            <p className="mt-2 font-mono text-body-sm">{row.cron || "—"}</p>
          </article>
          <article>
            <p className="text-meta font-medium uppercase tracking-wide text-muted-foreground">Next run</p>
            <p className="mt-2 text-body-sm tabular-nums">{row.nextRunAt ? formatWhen(row.nextRunAt) : "—"}</p>
          </article>
          <article className="sm:col-span-3">
            <p className="text-meta font-medium uppercase tracking-wide text-muted-foreground">Instruction</p>
            <p className="mt-2 text-body-sm text-muted-foreground">{row.instruction || "No instruction yet."}</p>
          </article>
        </section>
      ) : null}
    </main>
  );
}
