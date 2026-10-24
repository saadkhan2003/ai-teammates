"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { button } from "@/lib/ai";

type BotSpend = { bot_id: string | null; bot_name: string | null; today: number; month: number };
type OwnerSpend = { owner_id: string; owner_name: string | null; owner_username: string | null; today: number; month: number; bots: BotSpend[] };
export type SpendPage = { owners: OwnerSpend[]; total: { today: number; month: number }; page: number; page_size: number; total_owners: number; caps: unknown };

const usd = (n: number) => `$${Number(n).toFixed(6)}`;
const short = (id: string) => id.replaceAll("-", "").slice(0, 8);

/** Short id chip; click copies the full id. */
export function CopyId({ id, label }: { id: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" title={`Copy ${label} ID ${id}`} aria-label={`Copy ${label} ID`}
    className="ml-2 rounded border border-border px-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
    onClick={() => { void navigator.clipboard?.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>
    {copied ? "copied" : short(id)}
  </button>;
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
      {data?.owners.map(o => <tbody key={o.owner_id} className="border-t border-border">
        <tr className="font-medium"><td className="p-1">{o.owner_name || "Unknown owner"}{o.owner_username && o.owner_username !== o.owner_name ? <span className="ml-1 text-muted-foreground">({o.owner_username})</span> : null}<CopyId id={o.owner_id} label="owner" /></td><td className="p-1">{usd(o.today)}</td><td className="p-1">{usd(o.month)}</td></tr>
        {o.bots.map(b => <tr key={b.bot_id ?? "none"}><td className="p-1 pl-5">{b.bot_id ? <>{b.bot_name || "Deleted bot"}<CopyId id={b.bot_id} label="bot" /></> : <span className="text-muted-foreground">No bot (system)</span>}</td><td className="p-1">{usd(b.today)}</td><td className="p-1">{usd(b.month)}</td></tr>)}
      </tbody>)}
    </table></div>
    {pages > 1 && <div className="mt-2 flex items-center gap-2 text-xs">
      <button className={button} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
      <span>Page {page} of {pages} · {data?.total_owners} owners</span>
      <button className={button} disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
    </div>}
  </div>;
}
