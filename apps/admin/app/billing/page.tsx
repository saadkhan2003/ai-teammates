"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { button, card, input } from "@/lib/ai";

type Plan = { id: string; name: string; priceUsd: number; weeklyCredits: number; onDemandCapUsd: number; jobDefaultMinutes: number; jobMaxMinutes: number; maxRunningJobs: number; upgradeTo?: string | null; storageQuotaGb: number; storageWarnPct: number; ramMb: number; cpuMinCores: number; cpuMaxCores: number };
type Rates = { usdPerCredit: number; computerCreditsPerMinute: number; storageFreeGb: number; storageCreditsPerGbWeek: number };
type UserUsage = { id: string; username: string; displayName: string; plan: string; allowance: number; ai: number; computer: number; storage: number; used: number; percent: number; computerMinutes: number; backgroundMinutes: number; state: string; onDemandLimitUsd?: number | null; onDemandUsedUsd: number; storageUsedBytes: number; storageQuotaBytes: number; storagePercent: number; storageState: string; computers: number; ramBytes: number; ramLimitBytes: number };
type Resources = { baseImage: string; imagesInUse: string[]; maxComputers: number; memoryCeilingBytes: number; objectStore: { name: string; enabled: boolean; files: number; bytes: number; lastPushAt?: string | null }; cleanup: { hourUtc: number; keepBackups: number; downloadDays: number; backups: number; runs: Array<{ id: number; trigger: string; startedAt: string; finishedAt?: string | null; computers: number; removedFiles: number; removedBytes: number; removedBackups: number }> } };
const gb = (b: number) => { const n = Number(b) / 1024 ** 3; return n >= 10 ? `${Math.round(n)} GB` : `${n.toFixed(1)} GB`; };
const fmt = (v: number) => Math.round(Number(v)).toLocaleString("en-US");
const planFields: Array<[keyof Plan, string]> = [["weeklyCredits", "Weekly credits"], ["onDemandCapUsd", "On-demand cap ($/mo)"], ["jobDefaultMinutes", "Job default (min)"], ["jobMaxMinutes", "Job max (min)"], ["maxRunningJobs", "Running jobs"], ["storageQuotaGb", "Storage quota (GB)"], ["storageWarnPct", "Storage warn (%)"], ["ramMb", "RAM per computer (MB)"], ["cpuMinCores", "CPU min cores"], ["cpuMaxCores", "CPU max cores"]];
const rateFields: Array<[keyof Rates, string]> = [["usdPerCredit", "USD per credit"], ["computerCreditsPerMinute", "Computer credits / awake min"], ["storageFreeGb", "Free storage (GB)"], ["storageCreditsPerGbWeek", "Storage credits / GB / week"]];

export default function BillingPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [rates, setRates] = useState<Rates | null>(null);
  const [users, setUsers] = useState<UserUsage[]>([]);
  const [resources, setResources] = useState<Resources | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true); setError("");
    try {
      const [config, usage, res] = await Promise.all([api<{ plans: Plan[]; rates: Rates }>("/api/admin/billing"), api<{ users: UserUsage[] }>("/api/admin/billing/usage"), api<Resources>("/api/admin/billing/resources")]);
      setPlans(config.plans); setRates(config.rates); setUsers(usage.users); setResources(res);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load billing."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function savePlan(plan: Plan) {
    setMsg(""); setError("");
    try {
      await api(`/api/admin/billing/plans/${plan.id}`, { method: "PUT", body: JSON.stringify(Object.fromEntries(planFields.map(([k]) => [k, Number(plan[k])]))) });
      setMsg(`${plan.name} saved.`); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save the plan."); }
  }
  async function saveRates() {
    if (!rates) return;
    setMsg(""); setError("");
    try {
      await api("/api/admin/billing/rates", { method: "PUT", body: JSON.stringify(Object.fromEntries(rateFields.map(([k]) => [k, Number(rates[k])]))) });
      setMsg("Rates saved."); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save rates."); }
  }
  async function runCleanup() {
    setMsg(""); setError("");
    try {
      const r = await api<{ computers: number; removedFiles: number; removedBytes: number; removedBackups: number }>("/api/admin/billing/cleanup/run", { method: "POST" });
      setMsg(`Cleanup removed ${r.removedFiles} files (${gb(r.removedBytes)}) and ${r.removedBackups} old backups on ${r.computers} awake computers.`); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not run cleanup."); }
  }
  async function assign(userId: string, planId: string) {
    try { await api(`/api/admin/billing/plans/${planId}/assign/${userId}`, { method: "PUT" }); setMsg("Plan assigned."); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not assign the plan."); }
  }

  return <div className="space-y-4" data-testid="admin-billing">
    <section className={card}>
      <div className="flex justify-between"><h2 className="text-xl font-semibold">Billing &amp; credits</h2><button className={button} disabled={loading} onClick={() => void load()}>Refresh</button></div>
      <p className="text-sm text-muted-foreground">One weekly credit meter covers AI (model cost), computer (awake minutes, including background jobs) and storage above the free amount. No payment is processed here; on-demand and upgrade requests are recorded in the audit log.</p>
      {loading && <p role="status">Loading billing…</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {msg && <p role="status" className="text-sm text-green-600 dark:text-green-400">{msg}</p>}
    </section>
    {rates && <section className={card} data-testid="billing-rates"><h3 className="font-semibold">Credit rates</h3>
      <div className="grid gap-3 sm:grid-cols-4">{rateFields.map(([k, label]) => <label key={k} className="text-sm">{label}<input className={input} type="number" step="any" min={0} value={rates[k]} onChange={e => setRates({ ...rates, [k]: Number(e.target.value) })} /></label>)}</div>
      <button className={button} onClick={() => void saveRates()}>Save rates</button></section>}
    {plans.length > 0 && <section className={card} data-testid="billing-plans"><h3 className="font-semibold">Plans</h3>
      {plans.map((plan, i) => <div key={plan.id} data-testid="billing-plan" className="space-y-2 border-t border-border pt-3 first-of-type:border-t-0 first-of-type:pt-0">
        <p className="text-sm"><span className="font-semibold">{plan.name}</span> · ${Number(plan.priceUsd).toFixed(0)}/month{plan.upgradeTo ? ` · upgrades to ${plan.upgradeTo}` : ""}</p>
        <div className="grid gap-3 sm:grid-cols-5">{planFields.map(([k, label]) => <label key={k} className="text-sm">{label}<input aria-label={`${plan.name} ${label}`} className={input} type="number" min={0} step="any" value={Number(plan[k])} onChange={e => setPlans(plans.map((p, j) => j === i ? { ...p, [k]: Number(e.target.value) } : p))} /></label>)}</div>
        <button className={button} data-testid={`save-plan-${plan.id}`} onClick={() => void savePlan(plan)}>Save {plan.name}</button>
      </div>)}</section>}
    {resources && <section className={card} data-testid="billing-resources"><h3 className="font-semibold">Computers &amp; storage</h3>
      <dl className="grid gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-muted-foreground">Shared base image</dt><dd className="break-all font-mono text-xs" data-testid="billing-base-image">{resources.baseImage}</dd><dd className="text-xs text-muted-foreground">{resources.imagesInUse.length <= 1 ? "All computers use it" : `${resources.imagesInUse.length} images in use`}</dd></div>
        <div><dt className="text-muted-foreground">Computers per host</dt><dd data-testid="billing-max-computers">{resources.maxComputers}</dd><dd className="text-xs text-muted-foreground">RAM can overcommit across the host</dd></div>
        <div><dt className="text-muted-foreground">Object storage</dt><dd>{resources.objectStore.enabled ? `${resources.objectStore.files.toLocaleString("en-US")} files · ${gb(resources.objectStore.bytes)}` : "Sync off"}</dd><dd className="text-xs text-muted-foreground">Saved on sleep, restored on wake</dd></div>
        <div><dt className="text-muted-foreground">Nightly cleanup</dt><dd>{String(resources.cleanup.hourUtc).padStart(2, "0")}:00 UTC · keep {resources.cleanup.keepBackups} backups</dd><dd className="text-xs text-muted-foreground">Downloads older than {resources.cleanup.downloadDays} days · {resources.cleanup.backups} backups now</dd></div>
      </dl>
      {resources.cleanup.runs[0] && <p className="text-xs text-muted-foreground" data-testid="billing-last-cleanup">Last cleanup ({resources.cleanup.runs[0].trigger}): {resources.cleanup.runs[0].removedFiles} files, {gb(resources.cleanup.runs[0].removedBytes)}, {resources.cleanup.runs[0].removedBackups} backups.</p>}
      <button className={button} data-testid="billing-run-cleanup" onClick={() => void runCleanup()}>Run cleanup now</button></section>}
    {users.length > 0 && <section className={card} data-testid="billing-usage"><h3 className="font-semibold">Usage this week by user</h3>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["User", "Plan", "AI", "Computer", "Storage", "Used / allowance", "Awake min (bg)", "Disk", "RAM", "On-demand", "State"].map(t => <th key={t} className="p-2 font-medium">{t}</th>)}</tr></thead>
        <tbody>{users.map(u => <tr key={u.id} data-testid="billing-user" className="border-t border-border">
          <td className="p-2">{u.displayName}<small className="block text-muted-foreground">@{u.username}</small></td>
          <td className="p-2"><select aria-label={`Plan for ${u.username}`} className="rounded-[6px] border border-input bg-card px-2 py-1" value={plans.find(p => p.name === u.plan)?.id ?? ""} onChange={e => void assign(u.id, e.target.value)}>{plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
          <td className="p-2 tabular-nums">{fmt(u.ai)}</td><td className="p-2 tabular-nums">{fmt(u.computer)}</td><td className="p-2 tabular-nums">{fmt(u.storage)}</td>
          <td className="p-2 tabular-nums">{fmt(u.used)} / {fmt(u.allowance)} <small className="text-muted-foreground">({Math.floor(Number(u.percent))}%)</small></td>
          <td className="p-2 tabular-nums">{u.computerMinutes} ({u.backgroundMinutes})</td>
          <td className="p-2 tabular-nums" data-testid="billing-user-storage">{gb(u.storageUsedBytes)} / {gb(u.storageQuotaBytes)}{u.storageState !== "ok" ? <small className={u.storageState === "full" ? "block text-destructive" : "block text-amber-600"}>{u.storageState}</small> : null}</td>
          <td className="p-2 tabular-nums" data-testid="billing-user-ram">{u.computers ? `${gb(u.ramBytes)} / ${gb(u.ramLimitBytes)}` : "—"}<small className="block text-muted-foreground">{u.computers} computer{u.computers === 1 ? "" : "s"}</small></td>
          <td className="p-2 tabular-nums">{u.onDemandLimitUsd ? `$${Number(u.onDemandUsedUsd).toFixed(2)} / $${Number(u.onDemandLimitUsd).toFixed(0)}` : "None"}</td>
          <td className="p-2">{u.state}</td></tr>)}</tbody></table></div></section>}
  </div>;
}
