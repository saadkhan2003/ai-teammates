"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ListSkeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { SettingsBillingTabs } from "@/components/settings-billing-tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Billing = {
  plan: string | null;
  creditBalance: number | null;
  periodStart: string;
  periodEnd: string;
  usage: { modelCalls: number; costUsd: number; latencyMs: number };
  breakdown: { category: string; calls: number; cost_usd: number }[];
  invoices: { id: string; date?: string; amount?: number; status?: string }[];
};

const money = (amount: number) => amount === 0 ? "$0.00" : Math.abs(amount) < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`;

export default function BillingPage() {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [error, setError] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [rate, setRate] = useState("");
  const [plansJson, setPlansJson] = useState("[]");
  const [configMessage, setConfigMessage] = useState("");
  useEffect(() => {
    void api<Billing>("/api/billing").then(setBilling).catch(() => setError("Billing details could not be loaded. Please try again."));
    void api<{ role?: string }>("/api/auth/me").then(me => setIsAdmin(me.role === "admin" || me.role === "owner")).catch(() => {});
    void api<{ currencyRatePkrPerUsd: number | null; plans: unknown[] }>("/api/admin/billing/config").then(config => {
      setRate(config.currencyRatePkrPerUsd == null ? "" : String(config.currencyRatePkrPerUsd));
      setPlansJson(JSON.stringify(config.plans, null, 2));
    }).catch(() => {});
  }, []);
  async function savePricing() {
    try {
      const plans = JSON.parse(plansJson) as unknown;
      if (!Array.isArray(plans)) throw new Error("Plans must be a JSON array.");
      await api("/api/admin/billing/config", { method: "PUT", body: JSON.stringify({ currencyRatePkrPerUsd: rate.trim() ? Number(rate) : null, plans }) });
      setConfigMessage("Pricing configuration saved.");
    } catch {
      setConfigMessage("Could not save. Check the exchange rate and plan JSON.");
    }
  }

  return <main id="billing" className="flex flex-col gap-5" data-testid="billing-page">
    <header><h2 className="text-title">Billing</h2><p className="mt-1 text-body-sm text-muted-foreground">Review this month’s activity, plan and receipts.</p></header>
    <SettingsBillingTabs />
    {error ? <p role="alert" className="rounded-md border border-destructive/30 p-3 text-body-sm">{error}</p> : null}
    {!billing && !error ? <ListSkeleton label="Loading billing" rows={3} /> : null}
    {billing ? <>
      <section className="grid gap-3 sm:grid-cols-3">
        <article className="rounded-card border border-border bg-card p-4"><p className="text-body-sm text-muted-foreground">Current plan</p><p className="mt-2 text-lead font-medium">{billing.plan ?? "No plan assigned"}</p><Link href="/pricing" className="mt-2 inline-block text-body-sm underline underline-offset-4">Compare plans</Link></article>
        <article className="rounded-card border border-border bg-card p-4"><p className="text-body-sm text-muted-foreground">Credit balance</p><p className="mt-2 text-lead font-medium">{billing.creditBalance == null ? "Not configured" : money(billing.creditBalance)}</p><p className="mt-2 text-meta text-muted-foreground">A balance will appear when account credits are enabled.</p></article>
        <article className="rounded-card border border-border bg-card p-4"><p className="text-body-sm text-muted-foreground">Activity this period</p><p className="mt-2 text-lead font-medium tabular-nums">{billing.usage.modelCalls.toLocaleString()} calls</p><p className="mt-2 text-meta text-muted-foreground">{new Date(billing.periodStart).toLocaleDateString()} to {new Date(billing.periodEnd).toLocaleDateString()}</p></article>
      </section>
      <section className="rounded-card border border-border bg-card p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">Usage this period</h3><p className="mt-1 text-body-sm text-muted-foreground">Recorded activity to date. This is not a payment charge.</p></div><p className="text-right"><span className="block text-lead font-medium">{money(billing.usage.costUsd)}</span><span className="text-meta text-muted-foreground">recorded service cost</span></p></div>
        <div role="meter" aria-label="Recorded usage by category" className="mt-5 flex h-2 overflow-hidden rounded-sm bg-muted">{billing.breakdown.map((row, index) => <div key={row.category} className={index % 2 ? "h-full bg-foreground/45" : "h-full bg-foreground/75"} style={{ width: `${billing.usage.costUsd > 0 ? Math.max(0, Number(row.cost_usd) / billing.usage.costUsd * 100) : 0}%` }} />)}</div>
        <div className="mt-4 divide-y divide-border">{billing.breakdown.length ? billing.breakdown.map(row => <div key={row.category} className="flex justify-between gap-3 py-3 text-body-sm"><span><span className="capitalize">{row.category}</span>, <span className="text-muted-foreground">{row.calls} calls</span></span><span className="tabular-nums">{money(Number(row.cost_usd))}</span></div>) : <p className="py-4 text-body-sm text-muted-foreground">No usage recorded in this period.</p>}</div>
      </section>
      <section className="rounded-card border border-border bg-card p-5"><div className="flex items-center justify-between"><div><h3 className="font-semibold">Invoices & receipts</h3><p className="mt-1 text-body-sm text-muted-foreground">Receipts will appear here if billing is enabled.</p></div></div>{billing.invoices.length ? <ul className="mt-4 divide-y divide-border">{billing.invoices.map(invoice => <li key={invoice.id} className="flex justify-between py-3 text-body-sm">{invoice.date ?? invoice.id}<span>{invoice.amount == null ? "—" : money(invoice.amount)} · {invoice.status ?? "available"}</span></li>)}</ul> : <p className="mt-4 py-4 text-body-sm text-muted-foreground">No invoices yet</p>}</section>
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border p-4"><div><p className="font-medium">Change your plan</p><p className="text-body-sm text-muted-foreground">Plan changes are reviewed by support. No payment is taken here.</p></div><Button asChild variant="outline"><Link href="/settings/contact">Contact support</Link></Button></section>
      {isAdmin ? <section className="rounded-card border border-border bg-card p-5"><h3 className="font-semibold">Published plan prices</h3><p className="mt-1 text-body-sm text-muted-foreground">Set the approximate PKR exchange rate and plan table shown on the public pricing page. Leave the rate blank to keep pricing unpublished.</p><div className="mt-4 grid gap-3"><label className="grid gap-1 text-body-sm">PKR per USD<Input aria-label="PKR per USD" type="number" min="0.0001" max="100000" step="0.0001" value={rate} onChange={event => setRate(event.target.value)} placeholder="Not configured" /></label><label className="grid gap-1 text-body-sm">Plans JSON<Textarea aria-label="Plans JSON" value={plansJson} onChange={event => setPlansJson(event.target.value)} rows={9} /></label><div className="flex items-center gap-3"><Button variant="outline" onClick={() => void savePricing()}>Save pricing configuration</Button>{configMessage ? <span role="status" className="text-body-sm text-muted-foreground">{configMessage}</span> : null}</div></div></section> : null}
    </> : null}
  </main>;
}
