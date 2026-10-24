"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { cardClass, PageError, PageHeader, PageSkeleton } from "@/components/account/chrome";
import { api } from "@/lib/api";
import { type LegalPayload } from "@/lib/account";
import { errorMessage } from "@/lib/utils";

export default function LegalPage() {
  const params = useParams<{ doc: string }>();
  const doc = params.doc === "privacy" ? "privacy" : "terms";
  const [legal, setLegal] = useState<LegalPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLegal(await api<LegalPayload>(`/api/legal/${doc}`));
      setError(null);
    } catch (caught) {
      setLegal(null);
      setError(errorMessage(caught, "Could not load this page."));
    } finally {
      setLoading(false);
    }
  }, [doc]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div data-testid={`${doc}-page`} className="flex flex-col gap-[var(--space-section)]">
      <PageHeader title={legal?.title ?? (doc === "privacy" ? "Privacy" : "Terms")} subtitle="Placeholder copy until counsel reviews it." />
      {loading ? <PageSkeleton /> : null}
      {error ? <PageError title="Could not load this page." detail={error} onRetry={() => void load()} /> : null}
      {legal ? (
        <>
          {legal.placeholder ? (
            <div data-testid="legal-placeholder" className="rounded-card border border-border bg-muted px-[var(--space-inset)] py-3 text-body-sm">
              <p className="font-medium">Placeholder</p>
              <p className="mt-1 text-muted-foreground">{legal.banner}</p>
            </div>
          ) : null}
          <article className={`${cardClass} whitespace-pre-wrap p-[var(--space-inset)] text-body-sm leading-6`}>{legal.body}</article>
        </>
      ) : null}
    </div>
  );
}
