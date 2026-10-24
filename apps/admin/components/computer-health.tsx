"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type Row = {
  computerId: string;
  owner: string;
  desktop: string;
  rssBytes: number;
  desktopRssBytes: number;
  containerBytes: number;
  cgroupBytes: number | null;
  chromeProcesses: number;
  sampledAt: string;
};

function mb(bytes: number | null | undefined) {
  if (bytes == null || bytes <= 0) return "—";
  return `${Math.round(bytes / (1024 * 1024)).toLocaleString()} MB`;
}

const rank = (row: Row) => (row.desktop === "on" ? 0 : row.desktop === "asleep" ? 1 : 2);

/** Per-computer memory: is the desktop on or asleep, and how much the computer is using. */
export function ComputerHealth() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      api<{ computerMemory?: Row[] }>("/api/admin/health")
        .then((health) => { if (live) { setRows(health.computerMemory ?? []); setError(null); } })
        .catch((caught: Error) => { if (live) setError(caught.message); });
    void load();
    const timer = window.setInterval(load, 15000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);
  return (
    <section data-testid="admin-computer-health" className="rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
      <h3 className="text-base font-medium">Computers</h3>
      <p className="mt-1 text-sm text-muted-foreground">Memory per computer. The desktop and browser start only when a task or a viewer needs them.</p>
      {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
      {rows && rows.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No running computers sampled yet.</p> : null}
      {rows && rows.length > 0 ? (
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th className="py-1 font-medium">Owner</th><th className="py-1 font-medium">Desktop</th><th className="py-1 text-right font-medium">Processes RSS</th><th className="py-1 text-right font-medium">Desktop RSS</th><th className="py-1 text-right font-medium">Container</th><th className="py-1 text-right font-medium">Chrome</th></tr>
          </thead>
          <tbody>
            {[...rows].sort((a, b) => rank(a) - rank(b)).map((row) => (
              <tr key={row.computerId} data-testid="admin-computer-row" data-desktop={row.desktop} className="border-t border-border">
                <td className="py-1.5">{row.owner || row.computerId.slice(0, 8)}</td>
                <td className="py-1.5">
                  <span className={row.desktop === "on" ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400" : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"}>
                    {row.desktop === "on" ? "On" : row.desktop === "asleep" ? "Off (asleep)" : row.desktop === "stopped" ? "Computer asleep" : "Unknown"}
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{mb(row.rssBytes)}</td>
                <td className="py-1.5 text-right tabular-nums">{mb(row.desktopRssBytes)}</td>
                <td className="py-1.5 text-right tabular-nums">{mb(row.cgroupBytes ?? row.containerBytes)}</td>
                <td className="py-1.5 text-right tabular-nums">{row.chromeProcesses}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
