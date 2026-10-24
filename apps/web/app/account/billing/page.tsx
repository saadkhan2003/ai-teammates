"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Download } from "lucide-react";
import { toast } from "sonner";
import { cardClass, DevBadge, PageEmpty, PageError, PageHeader, PageSkeleton, pillClass, SectionTitle } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { type BillingSnapshot, type Invoice, formatDay, money, planFeaturesFor } from "@/lib/account";
import { cn, errorMessage, formatWhen } from "@/lib/utils";

export default function BillingPage() {
  const [billing, setBilling] = useState<BillingSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBilling(await api<BillingSnapshot>("/api/billing"));
      setError(null);
    } catch (caught) {
      setBilling(null);
      setError(errorMessage(caught, "Could not load billing."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = billing?.plans.find((plan) => plan.id === billing.planId);
  const upgrade = billing?.planId === "free" ? "pro" : billing?.planId === "pro" ? "team" : null;

  async function checkout(planId: string) {
    setPending(planId);
    try {
      const result = await api<{ invoiceNumber?: string | null; chargesCard?: boolean }>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ planId }),
      });
      if (result.chargesCard) {
        toast.error("The plan change was refused.");
        return;
      }
      const name = planName(billing, planId);
      toast.success(`You're on the ${name} plan.`);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not change the plan."));
    } finally {
      setPending(null);
    }
  }

  return (
    <div data-testid="billing-page" className="flex flex-col gap-8">
      <PageHeader
        title="Billing"
        subtitle="Your plan, monthly credits, and invoices."
        action={
          <>
            <DevBadge show={Boolean(billing?.mockMode)} />
            <Button data-testid="upgrade-button" className={pillClass} disabled={!upgrade || pending != null} onClick={() => upgrade && void checkout(upgrade)}>
              {upgrade ? "Upgrade" : "Team plan"}
            </Button>
          </>
        }
      />
      {loading ? <PageSkeleton /> : null}
      {error ? <PageError title="Could not load billing." detail={error} onRetry={() => void load()} /> : null}
      {billing ? (
        <>
          <section data-testid="plan-summary" className={`${cardClass} flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between`}>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Current plan</p>
                <span className="inline-flex h-6 items-center rounded-full bg-foreground px-2 text-xs font-medium text-background">{current?.name ?? "Plan"}</span>
              </div>
              <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{money(current?.priceCents ?? 0)}<span className="text-sm font-normal text-muted-foreground"> / month</span></p>
              <p className="mt-1 text-sm text-muted-foreground">Renews {formatDay(billing.renewsAt)}</p>
            </div>
            <Button type="button" variant="outline" className={pillClass} onClick={() => document.getElementById("plans")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              Manage
            </Button>
          </section>

          <section data-testid="usage-card" className={`${cardClass} p-4`}>
            <div className="flex items-baseline justify-between gap-3">
              <SectionTitle>Usage</SectionTitle>
              <p className="text-sm text-muted-foreground">Resets {formatDay(billing.renewsAt)}</p>
            </div>
            <p className="mt-3 text-3xl font-semibold tabular-nums tracking-tight" data-testid="credit-balance">
              {billing.creditBalance.toLocaleString()} <span className="text-sm font-normal text-muted-foreground">credits left</span>
            </p>
            <div data-testid="usage-meter" className="mt-4">
              <div className="mb-2 flex justify-between text-sm tabular-nums">
                <span>{billing.usedCredits.toLocaleString()} used</span>
                <span className="text-muted-foreground">{billing.usedPercent}% of {billing.creditAllowance.toLocaleString()}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-brand" style={{ width: `${billing.usedPercent}%` }} />
              </div>
            </div>
          </section>

          <section id="plans" className="flex flex-col gap-4">
            <SectionTitle>Plans</SectionTitle>
            <div className="grid auto-rows-fr gap-4 md:grid-cols-3">
              {billing.plans.map((plan) => {
                const active = plan.id === billing.planId;
                const popular = plan.id === "pro";
                return (
                  <article key={plan.id} data-testid={`plan-card-${plan.id}`} className={cn(cardClass, "flex h-full flex-col p-4", popular && "ring-1 ring-brand")}>
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-base font-medium">{plan.name}</h4>
                      {popular ? <span className="inline-flex h-6 items-center rounded-full bg-accent px-2 text-[11px] font-medium text-foreground">Most popular</span> : null}
                    </div>
                    <p className="mt-1 min-h-10 text-sm text-muted-foreground">{plan.detail}</p>
                    <p className="mt-3 text-2xl font-semibold tabular-nums">{money(plan.priceCents)}</p>
                    <p className="text-xs text-muted-foreground">{plan.monthlyCredits.toLocaleString()} credits / month</p>
                    <ul className="mt-4 flex flex-1 flex-col gap-2">
                      {planFeaturesFor(plan).map((feature) => (
                        <li key={feature} className="flex items-start gap-2 text-sm">
                          <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                    <Button type="button" variant={active ? "secondary" : "default"} className={cn(pillClass, "mt-4 w-full")} disabled={active || pending != null} onClick={() => void checkout(plan.id)}>
                      {active ? "Current" : pending === plan.id ? "Updating" : "Choose"}
                    </Button>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <SectionTitle>Invoices</SectionTitle>
            {billing.invoices.length === 0 ? (
              <PageEmpty title="No invoices yet" detail="A paid plan adds an invoice here after you choose it." />
            ) : (
              <div data-testid="invoice-list" className={`${cardClass} overflow-x-auto`}>
                <table className="w-full min-w-[36rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="px-4 py-3 font-medium">Invoice</th>
                      <th scope="col" className="px-4 py-3 font-medium">Date</th>
                      <th scope="col" className="px-4 py-3 font-medium">Status</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">Amount</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium"><span className="sr-only">Download</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {billing.invoices.map((invoice) => (
                      <tr key={invoice.id} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-3 font-medium">{invoice.number}</td>
                        <td className="px-4 py-3 text-muted-foreground">{formatWhen(invoice.issuedAt)}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-xs font-medium capitalize">{invoice.status}</span>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{money(invoice.amountCents)}</td>
                        <td className="px-4 py-3 text-right">
                          <button type="button" data-testid={`invoice-download-${invoice.number}`} className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Download ${invoice.number}`} onClick={() => downloadInvoice(invoice, current?.name ?? invoice.planId)}>
                            <Download className="size-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function planName(billing: BillingSnapshot | null, planId: string) {
  return billing?.plans.find((plan) => plan.id === planId)?.name ?? "the new plan";
}

function downloadInvoice(invoice: Invoice, planNameText: string) {
  const body = [`Invoice ${invoice.number}`, `Plan ${planNameText}`, `Amount ${money(invoice.amountCents)}`, `Status ${invoice.status}`, `Issued ${formatWhen(invoice.issuedAt)}`, ""].join("\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${invoice.number}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}
