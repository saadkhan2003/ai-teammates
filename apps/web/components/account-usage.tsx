"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { cardClass, PageError, PageSkeleton, pillClass, SectionTitle } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { type BillingSnapshot, formatDay } from "@/lib/account";
import { errorMessage } from "@/lib/utils";

const AdminAnalyticsChart = dynamic(() => import("@/components/widgets/admin-analytics-chart"), { ssr: false, loading: () => <div className="h-56 animate-pulse rounded-md bg-muted" /> });

type Usage = {
  modelCalls?: number;
  costUsd?: number;
  latencyMs?: number;
  computerMemoryBytes?: number;
  chromeProcesses?: number;
};

type Row = {
  id?: string;
  username?: string;
  role?: string;
  modelCalls?: number;
  costUsd?: number;
  latencyMs?: number;
};

type Quota = {
  bots?: number;
  maxBots?: number;
  secrets?: number;
  maxSecrets?: number;
  computers?: number;
  maxComputers?: number;
  memoryBytes?: number;
  cpuMillis?: number;
};

export function AccountUsage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);

  const [billing, setBilling] = useState<BillingSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [credits, mine, limits, report] = await Promise.allSettled([
        api<BillingSnapshot>("/api/billing"),
        api<Usage>("/api/usage"),
        api<Quota>("/api/quotas"),
        api<Row[]>("/api/admin/usage"),
      ]);
      setBilling(credits.status === "fulfilled" ? credits.value : null);
      setUsage(mine.status === "fulfilled" ? mine.value : null);
      setQuota(limits.status === "fulfilled" ? limits.value : null);
      setRows(report.status === "fulfilled" && Array.isArray(report.value) ? report.value : null);
      const failed = [credits, mine, limits].find((result) => result.status === "rejected");
      setError(failed?.status === "rejected" ? errorMessage(failed.reason, "Some usage details could not be loaded.") : null);
    } catch (caught) {
      setBilling(null);
      setError(errorMessage(caught, "Could not load usage."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div id="usage" className="flex flex-col gap-[var(--space-section)]">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-title">Usage</h2>
          <p className="mt-1 text-body-sm text-muted-foreground">Credits left for this account.</p>
        </div>
        <Button variant="outline" className={pillClass} asChild>
          <Link href="/account/billing">Plans</Link>
        </Button>
      </header>
      {loading ? <PageSkeleton /> : null}
      {error ? <PageError title="Could not load usage." detail={error} onRetry={() => void load()} /> : null}
      {billing ? (
        <section data-testid="usage-report" className={`${cardClass} p-4`}>
          <div className="flex items-baseline justify-between gap-3">
            <SectionTitle>Credits</SectionTitle>
            <p className="text-body-sm text-muted-foreground">Resets {formatDay(billing.renewsAt)}</p>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {[
              ["Left", billing.creditBalance.toLocaleString()],
              ["Used", billing.usedCredits.toLocaleString()],
              ["Grant", billing.creditAllowance.toLocaleString()],
            ].map(([label, value]) => (
              <article key={label}>
                <p className="text-meta font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                <p className="mt-2 text-h1 tabular-nums">{value}</p>
              </article>
            ))}
          </div>
          <div className="mt-4">
            <div className="mb-2 flex justify-between text-body-sm tabular-nums">
              <span>{billing.usedCredits.toLocaleString()} used</span>
              <span className="text-muted-foreground">{billing.usedPercent}% of {billing.creditAllowance.toLocaleString()}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-brand" style={{ width: `${billing.usedPercent}%` }} />
            </div>
          </div>
        </section>
      ) : null}
      {usage ? (
        <section className="grid gap-[var(--space-card)] sm:grid-cols-3">
          <article className="rounded-lg border border-border bg-card p-4">
            <p className="text-body-sm text-muted-foreground">Calls</p>
            <p className="text-h2">{usage.modelCalls ?? 0}</p>
          </article>
          <article className="rounded-lg border border-border bg-card p-4">
            <p className="text-body-sm text-muted-foreground">Cost</p>
            <p className="text-h2">${Number(usage.costUsd ?? 0).toFixed(4)}</p>
          </article>
          <article className="rounded-lg border border-border bg-card p-4">
            <p className="text-body-sm text-muted-foreground">Latency</p>
            <p className="text-h2">{Math.round(Number(usage.latencyMs ?? 0))} ms</p>
          </article>
        </section>
      ) : null}
      {quota ? (
        <section className="rounded-lg border border-border bg-card p-4 text-body-sm">
          <h2 className="mb-2 text-body-sm font-medium">Quota</h2>
          <p className="text-muted-foreground">
            Bots {quota.bots ?? 0}/{quota.maxBots ?? "—"} · Secrets {quota.secrets ?? 0}/{quota.maxSecrets ?? "—"} · Computers {quota.computers ?? 0}/{quota.maxComputers ?? "—"}
          </p>
          <p className="text-muted-foreground">
            Memory {quota.memoryBytes ? `${Math.round(quota.memoryBytes / (1024 * 1024))} MB` : "—"} · CPU {quota.cpuMillis ?? "—"} ms
          </p>
        </section>
      ) : null}
      {rows?.length ? (
        <section className={`${cardClass} p-4`}>
          <h2 className="mb-3 text-body-sm font-medium">Activity overview</h2>
          <AdminAnalyticsChart rows={rows} />
        </section>
      ) : null}
      {rows ? (
        <section data-testid="usage-user-report" className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-body-sm font-medium">Per-user report</h2>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Refresh
            </Button>
          </div>
          <div className="mt-3 flex flex-col md:hidden">
            {rows.map((row) => (
              <article key={row.id || row.username} className="flex min-h-11 flex-col justify-center border-t border-border py-2 text-body-sm">
                <p className="break-words font-medium">{row.username}</p>
                <p className="text-muted-foreground">
                  {row.role} · {row.modelCalls ?? 0} calls · ${Number(row.costUsd ?? 0).toFixed(4)} · {Math.round(Number(row.latencyMs ?? 0))} ms
                </p>
              </article>
            ))}
          </div>
          <div className="mt-3 hidden min-w-0 md:block">
            <table className="w-full table-fixed text-left text-body-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">User</th>
                  <th className="py-2 pr-3 font-medium">Role</th>
                  <th className="py-2 pr-3 font-medium">Calls</th>
                  <th className="py-2 pr-3 font-medium">Cost</th>
                  <th className="py-2 font-medium">Latency</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id || row.username} className="min-h-11 border-t border-border">
                    <td className="break-words py-2 pr-3">{row.username}</td>
                    <td className="py-2 pr-3">{row.role}</td>
                    <td className="py-2 pr-3">{row.modelCalls ?? 0}</td>
                    <td className="py-2 pr-3">${Number(row.costUsd ?? 0).toFixed(4)}</td>
                    <td className="py-2">{Math.round(Number(row.latencyMs ?? 0))} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
