"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api } from "@/lib/api";

export function useConsole<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load this section.");
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setError };
}

const ToastContext = createContext<(message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const push = useCallback((next: string) => setMessage(next), []);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 6000);
    return () => window.clearTimeout(timer);
  }, [message]);
  return (
    <ToastContext.Provider value={push}>
      {children}
      {message ? (
        <p role="status" className="fixed bottom-4 right-4 z-50 max-w-sm rounded-[12px] border border-border bg-card px-4 py-3 text-sm shadow-(--shadow-card)">
          {message}
        </p>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

export function Section({ title, detail, testid, action, children }: { title: string; detail: string; testid: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div data-testid={testid} className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">{detail}</p>
        </div>
        {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function Card({ title, help, children, testid }: { title?: string; help?: string; children: ReactNode; testid?: string }) {
  return (
    <section data-testid={testid} className="rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
      {title ? <h3 className="text-base font-medium">{title}</h3> : null}
      {help ? <p className="mt-1 text-sm leading-5 text-muted-foreground">{help}</p> : null}
      {children}
    </section>
  );
}

export function Empty({ title, detail, action, testid }: { title: string; detail?: string; action?: ReactNode; testid?: string }) {
  return (
    <div role="status" data-testid={testid} className="rounded-[12px] border border-border bg-card px-4 py-8 text-center shadow-(--shadow-card)">
      <span aria-hidden className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M8 9h8M8 13h5" />
        </svg>
      </span>
      <p className="mt-3 text-sm font-medium">{title}</p>
      {detail ? <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{detail}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function SkeletonBlock() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <div className="h-16 animate-pulse rounded-[12px] bg-muted" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="h-24 animate-pulse rounded-[12px] bg-muted" />
        <div className="h-24 animate-pulse rounded-[12px] bg-muted" />
        <div className="h-24 animate-pulse rounded-[12px] bg-muted" />
        <div className="h-24 animate-pulse rounded-[12px] bg-muted" />
      </div>
      <div className="h-40 animate-pulse rounded-[12px] bg-muted" />
    </div>
  );
}

export function Spark({ points }: { points?: number[] }) {
  if (!points || points.length < 2) return null;
  const max = Math.max(...points, 0.0001);
  const width = 84;
  const height = 28;
  const d = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - 4 - (point / max) * (height - 8);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-7 w-20" aria-hidden>
      <path d={d} fill="none" stroke="var(--brand)" strokeWidth="1.5" />
    </svg>
  );
}

export function trendLabel(points?: number[]) {
  if (!points || points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (last === first) return "Steady over 7 days";
  return last > first ? "Up over 7 days" : "Down over 7 days";
}

export function Stat({ label, value, help, series }: { label: string; value: string; help?: string; series?: number[] }) {
  const trend = trendLabel(series);
  return (
    <article className="flex h-full flex-col rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <Spark points={series} />
      </div>
      <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
      {trend ? <p className="mt-1 text-xs text-muted-foreground">{trend}</p> : null}
      {help ? <p className="mt-2 text-sm leading-5 text-muted-foreground">{help}</p> : null}
    </article>
  );
}

export function Meter({ label, usedLabel, limitLabel, used, limit, summary }: { label: string; usedLabel: string; limitLabel: string; used: number; limit: number; summary?: string }) {
  const pct = limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{summary ?? `${usedLabel} of ${limitLabel}`}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Field({ label, help, children, className }: { label: string; help?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`grid gap-2 text-sm ${className ?? ""}`}>
      <span>{label}</span>
      {children}
      {help ? <span className="text-sm leading-5 text-muted-foreground">{help}</span> : null}
    </label>
  );
}

export function ConfirmButton({ label, title, detail, confirmLabel, onConfirm, className, testid }: { label: string; title: string; detail: string; confirmLabel?: string; onConfirm: () => Promise<void> | void; className?: string; testid?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button type="button" data-testid={testid} className={className ?? quiet} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[var(--overlay)] px-4" role="presentation">
          <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="w-full max-w-md rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
            <h3 id="confirm-title" className="text-base font-medium">{title}</h3>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{detail}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={quiet} onClick={() => setOpen(false)}>Cancel</button>
              <button
                type="button"
                className={danger}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void Promise.resolve(onConfirm()).finally(() => {
                    setBusy(false);
                    setOpen(false);
                  });
                }}
              >
                {confirmLabel ?? label}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

type Column<T> = {
  id: string;
  header: string;
  align?: "right";
  sortValue?: (row: T) => string | number;
  cell: (row: T) => ReactNode;
};

type RowMenu<T> = { label: string; onSelect: (row: T) => void; hidden?: (row: T) => boolean; confirmTitle?: string; confirmDetail?: string };

export function DataTable<T>({
  rows,
  rowKey,
  columns,
  searchText,
  searchTestId,
  rowTestId,
  filters,
  menus,
  pageSize = 8,
  emptyTitle,
  emptyDetail,
  emptyTestId,
}: {
  rows: T[];
  rowKey: (row: T) => string;
  columns: Column<T>[];
  searchText: (row: T) => string;
  searchTestId?: string;
  rowTestId?: (row: T) => string;
  filters?: { id: string; label: string; value: (row: T) => string }[];
  menus?: RowMenu<T>[];
  pageSize?: number;
  emptyTitle: string;
  emptyDetail?: string;
  emptyTestId?: string;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ id: string; dir: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(0);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{ label: string; title: string; detail: string; run: () => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (needle && !searchText(row).toLowerCase().includes(needle)) return false;
      return (filters ?? []).every((filter) => {
        const pick = chosen[filter.id];
        return !pick || pick === "all" || filter.value(row) === pick;
      });
    });
  }, [rows, query, filters, chosen, searchText]);
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const column = columns.find((item) => item.id === sort.id);
    if (!column?.sortValue) return filtered;
    const copy = [...filtered];
    copy.sort((a, b) => {
      const left = column.sortValue!(a);
      const right = column.sortValue!(b);
      const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
      return sort.dir === "asc" ? order : -order;
    });
    return copy;
  }, [filtered, sort, columns]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const slice = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const options = (filter: { id: string; value: (row: T) => string }) => ["all", ...Array.from(new Set(rows.map(filter.value)))];

  return (
    <div className="rounded-[12px] border border-border bg-card shadow-(--shadow-card)">
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center">
        <input
          data-testid={searchTestId}
          className={`${control} sm:max-w-xs`}
          placeholder="Search"
          value={query}
          aria-label="Search"
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
        {(filters ?? []).map((filter) => (
          <label key={filter.id} className="grid gap-1 text-xs font-medium text-muted-foreground">
            {filter.label}
            <select
              className={control}
              aria-label={filter.label}
              value={chosen[filter.id] ?? "all"}
              onChange={(event) => {
                setChosen({ ...chosen, [filter.id]: event.target.value });
                setPage(0);
              }}
            >
              {options(filter).map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "All" : option}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {slice.length === 0 ? (
        <div className="p-4">
          <Empty testid={emptyTestId} title={emptyTitle} detail={emptyDetail} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr className="border-b border-border">
                {columns.map((column) => (
                  <th key={column.id} scope="col" className={`px-4 py-3 font-medium ${column.align === "right" ? "text-right" : "text-left"}`}>
                    {column.sortValue ? (
                      <button
                        type="button"
                        className="inline-flex min-h-11 items-center gap-1"
                        onClick={() => setSort({ id: column.id, dir: sort?.id === column.id && sort.dir === "asc" ? "desc" : "asc" })}
                      >
                        {column.header}
                        <span aria-hidden>{sort?.id === column.id ? (sort.dir === "asc" ? "↑" : "↓") : ""}</span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                ))}
                {menus ? <th scope="col" className="px-4 py-3 text-right font-medium">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {slice.map((row) => (
                <tr key={rowKey(row)} data-testid={rowTestId?.(row)} className="border-b border-border last:border-0">
                  {columns.map((column) => (
                    <td key={column.id} className={`px-4 py-3 ${column.align === "right" ? "text-right" : "text-left"}`}>
                      {column.cell(row)}
                    </td>
                  ))}
                  {menus ? (
                    <td className="px-4 py-3 text-right">
                      <details className="relative inline-block text-left">
                        <summary className={`${quiet} cursor-pointer list-none`}>Menu</summary>
                        <div className="absolute right-0 z-10 mt-1 min-w-36 rounded-[8px] border border-border bg-card p-1 shadow-(--shadow-card)">
                          {menus.filter((item) => !item.hidden?.(row)).map((item) => (
                            <button
                              key={`${item.label}-${item.confirmTitle ?? "now"}`}
                              type="button"
                              className="flex min-h-11 w-full items-center rounded-[8px] px-3 text-left text-sm hover:bg-accent"
                              onClick={() => {
                                if (item.confirmTitle) {
                                  setPending({ label: item.label, title: item.confirmTitle, detail: item.confirmDetail || item.confirmTitle, run: () => item.onSelect(row) });
                                  return;
                                }
                                item.onSelect(row);
                              }}
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                      </details>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm text-muted-foreground">
        <p className="tabular-nums">{sorted.length === 0 ? "0" : `${safePage * pageSize + 1}–${Math.min(sorted.length, safePage * pageSize + pageSize)} of ${sorted.length}`}</p>
        <div className="flex gap-2">
          <button type="button" className={quiet} disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>Previous</button>
          <button type="button" className={quiet} disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>Next</button>
        </div>
      </div>
      {pending ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[var(--overlay)] px-4" role="presentation">
          <div role="dialog" aria-modal="true" aria-labelledby="row-confirm-title" className="w-full max-w-md rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
            <h3 id="row-confirm-title" className="text-base font-medium">{pending.title}</h3>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{pending.detail}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={quiet} onClick={() => setPending(null)}>Cancel</button>
              <button
                type="button"
                className={danger}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void Promise.resolve(pending.run()).finally(() => {
                    setBusy(false);
                    setPending(null);
                  });
                }}
              >
                {pending.label}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const control = "min-h-11 w-full rounded-[8px] border border-input bg-card px-3 text-sm";
export const primary = "inline-flex min-h-11 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground";
export const quiet = "inline-flex min-h-11 items-center rounded-full border border-border px-3 text-sm";
export const danger = "inline-flex min-h-11 items-center rounded-full bg-destructive px-4 text-sm font-medium text-destructive-foreground";

export function money(cents: number) {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export function cores(millis: number) {
  const value = millis / 1000;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text} ${value === 1 ? "core" : "cores"}`;
}

export function gigabytes(bytes: number) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function hostName(host?: string | null) {
  if (!host || host === "local") return "This server";
  return host;
}

export function onSubmit(run: () => Promise<void>) {
  return (event: FormEvent) => {
    event.preventDefault();
    void run();
  };
}
