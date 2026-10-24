"use client";

import { AccountUsage } from "@/components/account-usage";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ListSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { SettingsSelect } from "@/components/settings-select";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { barWidth, bytesLabel, coresLabel, creditsLabel, onDemandOptions, percentLabel, resetsLabel, storageTone } from "@/lib/usage-format.mjs";

type Credits = {
  planId: string; planName: string; planPriceUsd: number; upgradeTo?: string | null;
  allowance: number; aiCredits: number; computerCredits: number; storageCredits: number; usedCredits: number;
  percent: number; computerMinutes: number; backgroundMinutes: number; resetsAt: string; resetsInDays: number;
  onDemandLimitUsd?: number | null; onDemandCapUsd: number; onDemandUsedUsd: number; state: string; paused: boolean;
};
type Storage = { usedBytes: number; quotaBytes: number; percent: number; warnPct: number; state: "ok" | "warning" | "full"; filesBytes: number; artifactsBytes: number; message?: string | null };
type ComputerUse = { id: string; power: string; memoryBytes: number; memoryLimitBytes: number; memoryPeakBytes: number; cpuMinCores: number; cpuMaxCores: number };
type CreditsResponse = {
  credits: Credits; message?: string | null; onDemandOptions: number[]; upgrade?: { id: string; name: string; priceUsd: number; weeklyCredits: number } | null;
  storage?: Storage; computers?: ComputerUse[];
};

const card = "rounded-xl border border-border bg-card px-4 py-3.5";

function resetDate(iso: string) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function UsagePage() {
  const [data, setData] = useState<CreditsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<CreditsResponse>("/api/usage/credits"));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load usage."));
    }
  }, []);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const setOnDemand = async (value: string) => {
    setSaving(true);
    try {
      await api("/api/usage/on-demand", { method: "PUT", body: JSON.stringify({ limitUsd: value === "none" ? null : Number(value) }) });
      await load();
      toast.success(value === "none" ? "On-demand usage turned off" : `On-demand limit set to $${value} a month`);
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not update the limit."));
    } finally {
      setSaving(false);
    }
  };

  const upgrade = async () => {
    if (!data?.upgrade) return;
    try {
      const result = await api<{ message?: string }>("/api/usage/plan-request", { method: "POST", body: JSON.stringify({ planId: data.upgrade.id }) });
      toast.success(result.message ?? "Upgrade requested");
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not request the upgrade."));
    }
  };

  const c = data?.credits;
  return (
    <div id="usage" className="thin-type flex flex-col gap-5 text-sm" data-testid="usage-billing">
      <AccountUsage /><h2 className="t-head text-lg">Usage &amp; Billing</h2>
      {!data && !error ? <ListSkeleton label="Loading usage" rows={3} /> : null}
      {error ? <p className="text-sm text-clay">{error}</p> : null}
      {c ? (
        <>
          {c.paused && data?.message ? (
            <p role="status" data-testid="usage-paused" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px]">{data.message}</p>
          ) : null}
          <div className="flex flex-col gap-2">
            <section className={card} data-testid="usage-weekly">
              <p className="t-label text-[13px]">Weekly usage limit</p>
              <p className="mt-2 flex items-baseline gap-1.5">
                <span className="t-head text-2xl" data-testid="usage-percent">{percentLabel(c.percent)}</span>
                <span className="text-[13px] text-muted-foreground">used</span>
              </p>
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Weekly usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(c.percent))}>
                <div data-testid="usage-bar" className={`h-full rounded-full ${c.paused ? "bg-amber-500" : "bg-[#1d9bf0]"}`} style={{ width: barWidth(c.percent) }} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground" data-testid="usage-resets">{resetsLabel(c.resetsInDays)}</p>
              <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-xs" data-testid="usage-breakdown">
                <div><dt className="text-muted-foreground">AI</dt><dd>{creditsLabel(c.aiCredits)}</dd></div>
                <div><dt className="text-muted-foreground">Computer</dt><dd>{creditsLabel(c.computerCredits)}</dd></div>
                <div><dt className="text-muted-foreground">Storage</dt><dd>{creditsLabel(c.storageCredits)}</dd></div>
              </dl>
            </section>
            <p className="px-1 text-xs text-muted-foreground">Included usage with your subscription. Resets weekly. {creditsLabel(c.usedCredits)} of {creditsLabel(c.allowance)} credits used.</p>
          </div>

          {data?.storage ? (
            <section className={card} data-testid="usage-storage">
              <div className="flex items-baseline justify-between gap-3">
                <p className="t-label text-[13px]">Storage</p>
                <p className="text-xs text-muted-foreground tabular-nums" data-testid="usage-storage-amount">
                  {bytesLabel(data.storage.usedBytes)} of {bytesLabel(data.storage.quotaBytes)}
                </p>
              </div>
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(data.storage.percent))}>
                <div data-testid="usage-storage-bar" className={`h-full rounded-full ${storageTone(data.storage.state)}`} style={{ width: barWidth(data.storage.percent) }} />
              </div>
              <p className={`mt-2 text-xs ${data.storage.state === "ok" ? "text-muted-foreground" : "text-foreground"}`} data-testid="usage-storage-note" role={data.storage.state === "ok" ? undefined : "status"}>
                {data.storage.message ?? `Saved files and artifacts. You'll get a warning at ${data.storage.warnPct}%.`}
              </p>
            </section>
          ) : null}

          {data?.computers?.length ? (
            <section className={card} data-testid="usage-computers">
              <p className="t-label text-[13px]">Computer memory</p>
              <ul className="mt-2 flex flex-col gap-2.5">
                {data.computers.map((computer, index) => {
                  const percent = computer.memoryLimitBytes ? (computer.memoryBytes * 100) / computer.memoryLimitBytes : 0;
                  return (
                    <li key={computer.id} data-testid="usage-computer">
                      <div className="flex items-baseline justify-between gap-3 text-xs">
                        <span>{data.computers!.length > 1 ? `Computer ${index + 1}` : "Your computer"}<span className="text-muted-foreground"> · {computer.power === "awake" ? "awake" : "asleep"}</span></span>
                        <span className="tabular-nums text-muted-foreground" data-testid="usage-computer-ram">
                          {computer.power === "awake" ? `${bytesLabel(computer.memoryBytes)} of ${bytesLabel(computer.memoryLimitBytes)} RAM` : `Up to ${bytesLabel(computer.memoryLimitBytes)} RAM`}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Memory used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(percent))}>
                        <div className="h-full rounded-full bg-[#1d9bf0]" style={{ width: barWidth(percent) }} />
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">{coresLabel(computer.cpuMinCores, computer.cpuMaxCores)}</p>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <section className={`${card} flex items-center justify-between gap-4`}>
            <div className="min-w-0">
              <p className="t-label text-[13px]">On-demand monthly limit</p>
              <p className="text-xs text-muted-foreground">
                Pay as you go after your weekly usage, up to this amount a month.
                {c.onDemandLimitUsd ? ` $${c.onDemandUsedUsd.toFixed(2)} used this month.` : ""}
              </p>
            </div>
            <div className="w-28 shrink-0">
              <SettingsSelect
                value={c.onDemandLimitUsd ? String(Number(c.onDemandLimitUsd)) : "none"}
                onValueChange={(value) => void setOnDemand(value)}
                options={onDemandOptions(data?.onDemandOptions)}
                disabled={saving}
                aria-label="On-demand monthly limit"
                data-testid="usage-on-demand"
              />
            </div>
          </section>

          <div className="flex flex-col gap-2">
            <p className="t-label px-1 text-[13px] text-muted-foreground">Manage Plan</p>
            <section className={`${card} flex items-center justify-between gap-4`} data-testid="usage-plan">
              <div className="min-w-0">
                <p className="t-label text-[13px]">Current plan: {c.planName}</p>
                <p className="text-xs text-muted-foreground">
                  ${Number(c.planPriceUsd).toFixed(0)}/month. Usage resets on {resetDate(c.resetsAt)}.{data?.upgrade ? " Upgrade for more usage." : ""}
                </p>
              </div>
              {data?.upgrade ? (
                <Button size="sm" className="shrink-0 rounded-full" data-testid="usage-upgrade" onClick={() => void upgrade()}>
                  Upgrade to {data.upgrade.name}
                </Button>
              ) : null}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
