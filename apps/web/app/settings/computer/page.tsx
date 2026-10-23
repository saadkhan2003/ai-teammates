"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

type ComputerStatus = { status?: string; healthy?: boolean; error?: string; computerId?: string };

export default function ComputerSettingsPage() {
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<"update" | "reset" | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api<ComputerStatus>("/api/computer"));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not read the computer."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(which: "update" | "reset") {
    if (armed !== which) {
      setArmed(which);
      return;
    }
    const path = which === "update" ? "/api/computer/restart" : "/api/computer/recreate";
    setBusy(which);
    setArmed(null);
    setError(null);
    try {
      await api(path, { method: "POST" });
      await load();
    } catch (caught) {
      setError(errorMessage(caught, which === "update" ? "Could not update the computer." : "Could not reset the computer."));
    } finally {
      setBusy(null);
    }
  }

  const absent = status?.status === "absent";

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Machines</h2>
        {!status && !error ? <Skeleton className="mt-2 h-4 w-48" /> : null}
        {status ? (
          <p className="mt-1 text-sm text-muted-foreground" data-testid="computer-status">
            {status.computerId ? `${status.computerId} · ` : ""}
            {status.status || "unknown"}
            {status.healthy === false ? " · a component is not healthy yet" : ""}
            {status.error ? ` · ${status.error}` : ""}
          </p>
        ) : null}
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <p className="text-sm">Update computer</p>
          <p className="text-xs text-muted-foreground">Restarts the machine and keeps the disk.</p>
        </div>
        <Button type="button" variant="outline" className="min-h-11" disabled={busy !== null || absent} onClick={() => void act("update")}>
          {busy === "update" ? "Updating…" : armed === "update" ? "Click again to confirm" : "Update computer"}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div>
          <p className="text-sm">Reset computer</p>
          <p className="text-xs text-muted-foreground">Rebuilds the machine from the same disk.</p>
        </div>
        <Button type="button" variant="outline" className="min-h-11" disabled={busy !== null || absent} onClick={() => void act("reset")}>
          {busy === "reset" ? "Resetting…" : armed === "reset" ? "Click again to confirm" : "Reset computer"}
        </Button>
      </div>
    </section>
  );
}
