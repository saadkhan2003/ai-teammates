"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { cardClass, PageError, PageSkeleton, pillClass, SectionTitle } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { type BillingSnapshot, formatDay } from "@/lib/account";
import { errorMessage } from "@/lib/utils";

export default function UsagePage() {
  const [billing, setBilling] = useState<BillingSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBilling(await api<BillingSnapshot>("/api/billing"));
      setError(null);
    } catch (caught) {
      setBilling(null);
      setError(errorMessage(caught, "Could not load usage."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Usage</h2>
          <p className="mt-1 text-sm text-muted-foreground">Credits left for this account.</p>
        </div>
        <Button variant="outline" className={pillClass} asChild>
          <Link href="/account/billing">Plans</Link>
        </Button>
      </header>
      {loading ? <PageSkeleton /> : null}
      {error ? <PageError title="Could not load usage." detail={error} onRetry={() => void load()} /> : null}
      {billing ? (
        <section data-testid="usage-report" className={`${cardClass} p-4`}>
          <div className="flex items-baseline justify-between gap-3">
            <SectionTitle>Credits</SectionTitle>
            <p className="text-sm text-muted-foreground">Resets {formatDay(billing.renewsAt)}</p>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {[
              ["Left", billing.creditBalance.toLocaleString()],
              ["Used", billing.usedCredits.toLocaleString()],
              ["Grant", billing.creditAllowance.toLocaleString()],
            ].map(([label, value]) => (
              <article key={label}>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
              </article>
            ))}
          </div>
          <div className="mt-4">
            <div className="mb-2 flex justify-between text-sm tabular-nums">
              <span>{billing.usedCredits.toLocaleString()} used</span>
              <span className="text-muted-foreground">{billing.usedPercent}% of {billing.creditAllowance.toLocaleString()}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-brand" style={{ width: `${billing.usedPercent}%` }} />
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
