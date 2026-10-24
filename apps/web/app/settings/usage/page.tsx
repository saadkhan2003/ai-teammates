"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { StateMessage } from "@/components/state-message";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

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

export default function UsagePage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [mine, limits, report] = await Promise.all([
        api<Usage>("/api/usage"),
        api<Quota>("/api/quotas"),
        api<Row[]>("/api/admin/usage").catch(() => null),
      ]);
      setUsage(mine);
      setQuota(limits);
      setRows(Array.isArray(report) ? report : null);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load usage."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <header>
        <h2 className="text-sm font-medium">Usage and billing</h2>
        <p className="mt-1 text-sm text-muted-foreground">Model calls, cost, and the quota for this account.</p>
      </header>
      {loading ? <StateMessage title="Loading usage…" detail="Reading model calls, cost, and the quota for this account." /> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {usage ? (
        <section className="grid gap-[var(--space-card)] sm:grid-cols-3">
          <article className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm text-muted-foreground">Model calls</p>
            <p className="text-xl font-medium">{usage.modelCalls ?? 0}</p>
          </article>
          <article className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm text-muted-foreground">Cost</p>
            <p className="text-xl font-medium">${Number(usage.costUsd ?? 0).toFixed(4)}</p>
          </article>
          <article className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm text-muted-foreground">Latency</p>
            <p className="text-xl font-medium">{Math.round(Number(usage.latencyMs ?? 0))} ms</p>
          </article>
        </section>
      ) : null}
      {quota ? (
        <section className="rounded-lg border border-border bg-card p-4 text-sm">
          <h2 className="mb-2 text-sm font-medium">Quota</h2>
          <p className="text-muted-foreground">
            Bots {quota.bots ?? 0}/{quota.maxBots ?? "—"} · Secrets {quota.secrets ?? 0}/{quota.maxSecrets ?? "—"} · Computers {quota.computers ?? 0}/{quota.maxComputers ?? "—"}
          </p>
          <p className="text-muted-foreground">
            Memory {quota.memoryBytes ? `${Math.round(quota.memoryBytes / (1024 * 1024))} MB` : "—"} · CPU {quota.cpuMillis ?? "—"} ms
          </p>
        </section>
      ) : null}
      {rows ? (
        <section data-testid="usage-report" className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">Per-user report</h2>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Refresh
            </Button>
          </div>
          <div className="mt-3 flex flex-col md:hidden">
            {rows.map((row) => (
              <article key={row.id || row.username} className="flex min-h-11 flex-col justify-center border-t border-border py-2 text-sm">
                <p className="break-words font-medium">{row.username}</p>
                <p className="text-muted-foreground">
                  {row.role} · {row.modelCalls ?? 0} calls · ${Number(row.costUsd ?? 0).toFixed(4)} · {Math.round(Number(row.latencyMs ?? 0))} ms
                </p>
              </article>
            ))}
          </div>
          <div className="mt-3 hidden min-w-0 md:block">
            <table className="w-full table-fixed text-left text-sm">
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
    </>
  );
}
