"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ListSkeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";

type Billing = {
  plan: string | null;
  creditBalance: number | null;
  periodStart: string;
  periodEnd: string;
  usage: { modelCalls: number; costUsd: number; latencyMs: number };
  breakdown: { category: string; calls: number; cost_usd: number }[];
  invoices: { id: string; date?: string; amount?: number; status?: string }[];
};

const money = (amount: number) => `$${amount.toFixed(4)}`;

export default function BillingPage() {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void api<Billing>("/api/billing").then(setBilling).catch(() => setError("Billing details could not be loaded. Please try again.")); }, []);

  return <main className="flex flex-col gap-5" data-testid="billing-page">
    <header><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Account</p><h2 className="mt-1 text-xl font-semibold">Billing overview</h2><p className="mt-1 text-sm text-muted-foreground">Review this month’s activity, plan and receipts.</p></header>
    {error ? <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm">{error}</p> : null}
    {!billing && !error ? <ListSkeleton label="Loading billing" rows={3} /> : null}
    {billing ? <>
      <section className="grid gap-3 sm:grid-cols-3">
        <article className="rounded-lg border border-line bg-paper p-4"><p className="text-sm text-muted-foreground">Current plan</p><p className="mt-2 text-lg font-semibold">{billing.plan ?? "No plan assigned"}</p><Link href="/pricing" className="mt-2 inline-block text-sm underline underline-offset-4">Compare plans</Link></article>
        <article className="rounded-lg border border-line bg-paper p-4"><p className="text-sm text-muted-foreground">Credit balance</p><p className="mt-2 text-lg font-semibold">{billing.creditBalance == null ? "Not configured" : money(billing.creditBalance)}</p><p className="mt-2 text-xs text-muted-foreground">A balance will appear when account credits are enabled.</p></article>
        <article className="rounded-lg border border-line bg-paper p-4"><p className="text-sm text-muted-foreground">Activity this period</p><p className="mt-2 text-lg font-semibold">{billing.usage.modelCalls.toLocaleString()} calls</p><p className="mt-2 text-xs text-muted-foreground">{new Date(billing.periodStart).toLocaleDateString()} – {new Date(billing.periodEnd).toLocaleDateString()}</p></article>
      </section>
      <section className="rounded-lg border border-line bg-paper p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">Usage this period</h3><p className="mt-1 text-sm text-muted-foreground">Recorded activity to date. This is not a payment charge.</p></div><p className="text-right"><span className="block text-lg font-semibold">{money(billing.usage.costUsd)}</span><span className="text-xs text-muted-foreground">recorded service cost</span></p></div>
        <div className="mt-5 h-2 overflow-hidden rounded-sm bg-muted"><div className="h-full w-full bg-foreground/70" /></div>
        <div className="mt-4 divide-y divide-line">{billing.breakdown.length ? billing.breakdown.map(row => <div key={row.category} className="flex justify-between gap-3 py-3 text-sm"><span className="capitalize">{row.category} <span className="text-muted-foreground">· {row.calls} calls</span></span><span>{money(Number(row.cost_usd))}</span></div>) : <p className="py-4 text-sm text-muted-foreground">No usage recorded in this period.</p>}</div>
      </section>
      <section className="rounded-lg border border-line bg-paper p-5"><div className="flex items-center justify-between"><div><h3 className="font-semibold">Invoices & receipts</h3><p className="mt-1 text-sm text-muted-foreground">Receipts will appear here if billing is enabled.</p></div></div>{billing.invoices.length ? <ul className="mt-4 divide-y divide-line">{billing.invoices.map(invoice => <li key={invoice.id} className="flex justify-between py-3 text-sm">{invoice.date ?? invoice.id}<span>{invoice.amount == null ? "—" : money(invoice.amount)} · {invoice.status ?? "available"}</span></li>)}</ul> : <p className="mt-4 rounded-md border border-dashed border-line p-5 text-center text-sm text-muted-foreground">No invoices yet</p>}</section>
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-4"><div><p className="font-medium">Change your plan</p><p className="text-sm text-muted-foreground">Plan changes are reviewed by support. No payment is taken here.</p></div><Button asChild variant="outline"><Link href="/settings/contact">Contact support</Link></Button></section>
    </> : null}
  </main>;
}
