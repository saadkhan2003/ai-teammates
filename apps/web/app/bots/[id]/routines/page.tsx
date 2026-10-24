"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { cardClass, PageEmpty, PageError, PageSkeleton, SectionTitle } from "@/components/account/chrome";
import { api, normalizeRoutines } from "@/lib/api";
import { formatWhen, errorMessage } from "@/lib/utils";

export default function RoutinesPage() {
  const params = useParams<{ id: string }>();
  const botId = typeof params.id === "string" ? params.id : "";
  const [rows, setRows] = useState<ReturnType<typeof normalizeRoutines> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!botId) return;
    let live = true;
    api<unknown>(`/api/bots/${botId}/routines`)
      .then((body) => {
        if (!live) return;
        const next = normalizeRoutines(body);
        setRows(next);
        setSelected(next[0]?.id ?? null);
      })
      .catch((caught) => {
        if (live) setError(errorMessage(caught, "Routines could not be loaded."));
      });
    return () => {
      live = false;
    };
  }, [botId]);

  const current = rows?.find((row) => row.id === selected) ?? null;

  return (
    <main data-testid="routines-page" className="mx-auto flex w-full max-w-[56rem] flex-col gap-8 px-6 py-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href={botId ? `/bots/${botId}` : "/"} className="underline">
              Back to chat
            </Link>
          </p>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">Routines</h1>
          <p className="mt-1 text-sm text-muted-foreground">Scheduled work for this teammate.</p>
        </div>
        <ButtonLink href={botId ? `/bots/${botId}/jobs` : "/"}>Coding jobs</ButtonLink>
      </header>
      {error ? <PageError title="Could not load routines." detail={error} /> : null}
      {!rows && !error ? <PageSkeleton /> : null}
      {rows && rows.length === 0 ? <PageEmpty title="No routines yet" detail="A schedule shows up here after you create one." /> : null}
      {rows && rows.length > 0 ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <section className={`${cardClass} overflow-x-auto`}>
            <div className="px-4 pt-4">
              <SectionTitle>Schedule</SectionTitle>
            </div>
            <table className="mt-2 w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b border-border">
                  <th scope="col" className="px-4 py-3 text-left font-medium">Name</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium">Cron</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-testid="routine-row" className="cursor-pointer border-b border-border last:border-0 hover:bg-accent/40" onClick={() => setSelected(row.id)}>
                    <td className="px-4 py-3 font-medium">
                      <Link href={`/bots/${botId}/routines/${row.id}`} className="underline-offset-2 hover:underline">
                        {row.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{row.cron || "—"}</td>
                    <td className="px-4 py-3 text-right">
                      <span className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-xs">{row.enabled === false ? "Paused" : "Active"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {current ? (
            <article data-testid="routine-detail" className={`${cardClass} flex h-full flex-col gap-3 p-4`}>
              <SectionTitle>{current.name}</SectionTitle>
              <p className="text-sm text-muted-foreground">{current.instruction || "No instruction yet."}</p>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Next run</dt>
                  <dd className="mt-1 tabular-nums">{current.nextRunAt ? formatWhen(current.nextRunAt) : "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Watch</dt>
                  <dd className="mt-1">{current.watchKind || "None"}</dd>
                </div>
              </dl>
            </article>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function ButtonLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-border px-4 text-sm hover:bg-accent">
      {children}
    </Link>
  );
}
