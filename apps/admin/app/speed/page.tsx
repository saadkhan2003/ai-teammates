"use client";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { button, card } from "@/lib/ai";
type Metric = { key: string; label: string; unit: string; p50: number | null; p95: number | null; count: number; target_p50: number | null; target_p95: number | null; source: string };
type Speed = { window_hours: number; generated_at: string; metrics: Metric[] };
export default function SpeedPage() {
  const [data, setData] = useState<Speed | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true); setError("");
    try { setData(await api<Speed>("/api/admin/speed")); }
    catch (e) { if (e instanceof ApiError && e.status === 404) setData(null); else setError(e instanceof Error ? e.message : "Could not load speed metrics."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  const value = (v: number | null, unit: string) => v == null ? "—" : `${Number(v.toFixed(2))} ${unit}`;
  return <section className={card}><div className="flex justify-between"><h2 className="text-xl font-semibold">Speed</h2><button className={button} disabled={loading} onClick={() => void load()}>Refresh</button></div>
    {loading && <p role="status">Loading metrics…</p>}{error && <p role="alert" className="text-destructive">{error}</p>}
    {!loading && !error && !data?.metrics?.length && <p>No data yet.</p>}
    {!!data?.metrics?.length && <><p className="text-sm text-muted-foreground">Last {data.window_hours} hours · {new Date(data.generated_at).toLocaleString()}</p><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["Metric", "p50 / target", "p95 / target", "Count", "Status / source"].map(t => <th key={t} className="p-2">{t}</th>)}</tr></thead><tbody>{data.metrics.map(m => {
      // Share metrics have minimum targets; durations have maximum targets.
      const share = /share|cache.hit/.test(m.key) || m.unit === "%";
      const ratios = [[m.p50, m.target_p50], [m.p95, m.target_p95]].flatMap(([v, t]) => v == null || t == null || t <= 0 ? [] : [share ? t / Math.max(v, 0.0001) : v / t]);
      const ratio = Math.max(0, ...ratios);
      const status = !m.count || !ratios.length ? "No data yet" : ratio <= 1 ? "On target" : ratio <= 1.25 ? "Near target" : "Over target";
      const color = status === "On target" ? "text-green-600 dark:text-green-400" : status === "Near target" ? "text-amber-600 dark:text-amber-400" : status === "Over target" ? "text-red-600 dark:text-red-400" : "text-muted-foreground";
      return <tr key={m.key} className="border-t border-border"><td className="p-2">{m.label}</td><td className="p-2 tabular-nums">{value(m.p50, m.unit)} / {value(m.target_p50, m.unit)}</td><td className="p-2 tabular-nums">{value(m.p95, m.unit)} / {value(m.target_p95, m.unit)}</td><td className="p-2">{m.count}</td><td className="p-2"><span className={color}>{status}</span><small className="block text-muted-foreground">{m.source}</small></td></tr>;
    })}</tbody></table></div></>}
  </section>;
}
