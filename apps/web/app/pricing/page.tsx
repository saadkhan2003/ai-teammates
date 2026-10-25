"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type Plan = { name: string; priceUsd: number | null; interval?: string; description?: string; features?: string[] };
type Pricing = { currencyRatePkrPerUsd: number | null; plans: Plan[] };

export default function PricingPage() {
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [usd, setUsd] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { void api<Pricing>("/api/pricing").then(setPricing).catch(() => setError(true)); }, []);
  const configured = !!pricing?.plans.some(plan => plan.priceUsd != null) && pricing?.currencyRatePkrPerUsd != null;

  return <main id="pricing" className="mx-auto min-h-dvh max-w-6xl px-5 py-12" data-testid="pricing-page">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-3xl font-semibold">Simple, transparent pricing</h1><p className="mt-2 max-w-2xl text-body-sm text-muted-foreground">Plan prices appear once configured by an account administrator. USD shows the configured source price; PKR uses the approximate exchange rate shown below.</p></div>{configured ? <Button variant="outline" aria-pressed={usd} onClick={() => setUsd(value => !value)}>{usd ? "Show PKR" : "Show USD"}</Button> : null}</div>
    {error ? <section role="alert" className="mt-8 rounded-card border border-border bg-card p-8 text-center"><h2 className="text-lead font-medium">Pricing is temporarily unavailable</h2><p className="mt-2 text-body-sm text-muted-foreground">Please try again later.</p></section> : null}
    {!error && !pricing ? <div className="mt-8 animate-pulse rounded-card border border-border bg-card p-10 text-body-sm text-muted-foreground">Loading plan details…</div> : null}
    {pricing ? pricing.plans.length && configured ? <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{pricing.plans.map((plan) => <article key={plan.name} className="flex flex-col rounded-card border border-border bg-card p-5"><h2 className="text-lead font-medium">{plan.name}</h2><p className="mt-2 min-h-10 text-body-sm text-muted-foreground">{plan.description || "Plan details provided by your administrator."}</p><p className="my-5 text-title">{usd ? (plan.priceUsd == null ? "—" : `$${plan.priceUsd.toLocaleString()}`) : (plan.priceUsd == null ? "Price unavailable" : `PKR ${Math.round(plan.priceUsd * pricing.currencyRatePkrPerUsd!).toLocaleString()}`)}{plan.priceUsd != null ? <span className="text-body-sm font-normal text-muted-foreground"> / {plan.interval || "month"}</span> : null}</p><ul className="mb-6 grid flex-1 content-start gap-3 text-body-sm">{(plan.features || []).map(feature => <li key={feature} className="border-t border-border pt-3">{feature}</li>)}</ul><Button asChild className="bg-foreground text-background hover:bg-foreground/90"><Link href="/settings/contact">Ask about this plan</Link></Button></article>)}</div> : <section className="mt-8 rounded-card border border-border bg-card p-8 sm:p-10"><div className="mx-auto max-w-xl text-center"><div className="mx-auto grid size-11 place-items-center rounded-md bg-muted text-lg" aria-hidden>₨</div><h2 className="mt-4 text-title">Pricing has not been set yet</h2><p className="mt-2 text-body-sm leading-6 text-muted-foreground">An administrator has not published plan prices. Contact support if you need help choosing a plan.</p><Button asChild className="mt-5"><Link href="/settings/contact">Contact support</Link></Button></div></section> : null}
    {pricing?.currencyRatePkrPerUsd ? <p className="mt-4 text-meta text-muted-foreground">Approximate conversion at PKR {pricing.currencyRatePkrPerUsd} per USD. Your final price is confirmed by support.</p> : null}
  </main>;
}
