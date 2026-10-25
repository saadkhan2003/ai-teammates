"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { button } from "@/lib/ai";

type BotSpend = { bot_id: string | null; bot_name: string | null; today: number; month: number };
type OwnerSpend = { owner_id: string; owner_name: string | null; owner_username: string | null; today: number; month: number; bots: BotSpend[] };
type SpendCap = { daily?: number | null; monthly?: number | null; action?: string; downgrade?: { provider: string; model: string } | null };
type SpendCaps = { plans?: Record<string, SpendCap>; users?: Record<string, SpendCap>; bots?: Record<string, SpendCap> };
export type SpendPage = { owners: OwnerSpend[]; total: { today: number; month: number }; page: number; page_size: number; total_owners: number; caps?: SpendCaps | null };

const usd = (n: number) => `$${Number(n).toFixed(6)}`;
const short = (id: string) => id.replaceAll("-", "").slice(0, 8);

function CapValue({ value }: { value?: number | null }) {
  return <>{value == null ? "—" : usd(value)}</>;
}

function SpendCaps({ caps, loaded, error }: { caps?: SpendCaps | null; loaded: boolean; error: string }) {
  const rows = [
    ...Object.entries(caps?.plans ?? {}).map(([id, cap]) => ({ scope: "Plan", id, cap })),
    ...Object.entries(caps?.users ?? {}).map(([id, cap]) => ({ scope: "Owner", id, cap })),
    ...Object.entries(caps?.bots ?? {}).map(([id, cap]) => ({ scope: "Bot", id, cap })),
  ];

  return <section aria-label="Spending caps" className="mt-4">
    <h4 className="font-medium">Configured caps</h4>
    <p className="text-xs text-muted-foreground">Plan and owner limits both apply. Bot limits apply to that bot. A dash means no limit is set.</p>
    {!loaded ? <p className="mt-2 text-sm text-muted-foreground">{error ? "Caps unavailable." : "Loading caps…"}</p>
      : rows.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No spending caps configured.</p>
      : <div className="mt-2 overflow-x-auto"><table className="w-full text-left text-xs">
        <thead><tr>{["Scope", "Daily", "Monthly", "Action", "Downgrade target"].map(label => <th className="p-1" key={label}>{label}</th>)}</tr></thead>
        <tbody>{rows.map(({ scope, id, cap }) => <tr className="border-t border-border" key={`${scope}:${id}`}>
          <td className="p-1">{scope === "Plan" ? `${scope}: ${id}` : <>{scope}<CopyId id={id} label={scope.toLowerCase()} /></>}</td>
          <td className="p-1"><CapValue value={cap.daily} /></td>
          <td className="p-1"><CapValue value={cap.monthly} /></td>
          <td className="p-1 capitalize">{cap.action ?? "block"}</td>
          <td className="p-1">{cap.downgrade ? <span>{cap.downgrade.model} · provider <CopyId id={cap.downgrade.provider} label="provider" /></span> : "—"}</td>
        </tr>)}</tbody>
      </table></div>}
  </section>;
}

/** Short id chip; click copies the full id. */
export function CopyId({ id, label }: { id: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" title={`Copy ${label} ID ${id}`} aria-label={`Copy ${label} ID`}
    className="ml-2 rounded border border-border px-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
    onClick={() => { void navigator.clipboard?.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>
    {copied ? "copied" : short(id)}
  </button>;
}

const BOTS_SHOWN = 5;

/** One owner: total row, live bots (top 5, then "Show more"), and deleted bots folded into one row. */
function OwnerRows({ owner: o }: { owner: OwnerSpend }) {
  const [all, setAll] = useState(false); const [deletedOpen, setDeletedOpen] = useState(false);
  const live = o.bots.filter(b => b.bot_id && b.bot_name); const deleted = o.bots.filter(b => b.bot_id && !b.bot_name); const system = o.bots.filter(b => !b.bot_id);
  const shown = all ? live : live.slice(0, BOTS_SHOWN);
  const sum = (rows: BotSpend[], k: "today" | "month") => rows.reduce((n, r) => n + Number(r[k]), 0);
  const row = (b: BotSpend, label: React.ReactNode) => <tr key={b.bot_id ?? "none"}><td className="p-1 pl-5">{label}</td><td className="p-1">{usd(b.today)}</td><td className="p-1">{usd(b.month)}</td></tr>;
  return <tbody className="border-t border-border" data-testid="spend-owner">
    <tr className="font-medium"><td className="p-1">{o.owner_name || "Unknown owner"}{o.owner_username && o.owner_username !== o.owner_name ? <span className="ml-1 font-normal text-muted-foreground">({o.owner_username})</span> : null}<CopyId id={o.owner_id} label="owner" /><span className="ml-2 font-normal text-muted-foreground">{o.bots.length} bot{o.bots.length === 1 ? "" : "s"}</span></td><td className="p-1">{usd(o.today)}</td><td className="p-1">{usd(o.month)}</td></tr>
    {shown.map(b => row(b, <>{b.bot_name}<CopyId id={b.bot_id!} label="bot" /></>))}
    {live.length > BOTS_SHOWN && <tr><td className="p-1 pl-5" colSpan={3}><button type="button" className="text-xs underline" onClick={() => setAll(v => !v)}>{all ? "Show fewer bots" : `Show ${live.length - BOTS_SHOWN} more bots`}</button></td></tr>}
    {deleted.length > 0 && <tr className="text-muted-foreground"><td className="p-1 pl-5"><button type="button" className="underline" aria-expanded={deletedOpen} onClick={() => setDeletedOpen(v => !v)}>{deleted.length} deleted bot{deleted.length === 1 ? "" : "s"}</button></td><td className="p-1">{usd(sum(deleted, "today"))}</td><td className="p-1">{usd(sum(deleted, "month"))}</td></tr>}
    {deletedOpen && deleted.map(b => row(b, <span className="pl-4 text-muted-foreground">Deleted bot<CopyId id={b.bot_id!} label="bot" /></span>))}
    {system.map(b => row(b, <span className="text-muted-foreground">No bot (system)</span>))}
  </tbody>;
}

export function SpendTable({ pageSize = 10, onLoaded }: { pageSize?: number; onLoaded?: (s: SpendPage) => void }) {
  const [page, setPage] = useState(1); const [data, setData] = useState<SpendPage>(); const [error, setError] = useState("");
  const load = useCallback(async (p: number) => {
    try {
      const d = await api<SpendPage>(`/api/admin/ai/spend?page=${p}&page_size=${pageSize}`);
      if (d && Array.isArray(d.owners)) { setData(d); onLoaded?.(d); } setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); }
  }, [pageSize, onLoaded]);
  useEffect(() => { void load(page); }, [load, page]);
  const pages = Math.max(1, Math.ceil(Number(data?.total_owners ?? 0) / (data?.page_size ?? pageSize)));
  return <div aria-label="Spend by owner">
    {error && <p role="alert">{error}</p>}
    <div className="overflow-x-auto"><table className="w-full text-left text-xs">
      <thead><tr><th className="p-1">Owner / bot</th><th className="p-1">Today</th><th className="p-1">Month</th></tr></thead>
      {data?.owners.length === 0 && <tbody><tr><td className="p-1" colSpan={3}>No model spend this month.</td></tr></tbody>}
      {data?.owners.map(o => <OwnerRows key={o.owner_id} owner={o} />)}
    </table></div>
    {pages > 1 && <div className="mt-2 flex items-center gap-2 text-xs">
      <button className={button} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
      <span>Page {page} of {pages} · {data?.total_owners} owners</span>
      <button className={button} disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
    </div>}
    <SpendCaps caps={data?.caps} loaded={!!data} error={error} />
  </div>;
}
