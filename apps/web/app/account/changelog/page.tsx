"use client";

import { useCallback, useEffect, useState } from "react";
import { cardClass, PageEmpty, PageError, PageHeader, PageSkeleton } from "@/components/account/chrome";
import { api } from "@/lib/api";
import { type ChangelogPayload } from "@/lib/account";
import { errorMessage } from "@/lib/utils";

export default function ChangelogPage() {
  const [log, setLog] = useState<ChangelogPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLog(await api<ChangelogPayload>("/api/changelog"));
      setError(null);
    } catch (caught) {
      setLog(null);
      setError(errorMessage(caught, "Could not load the changelog."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div data-testid="changelog-page" className="flex flex-col gap-[var(--space-section)]">
      <PageHeader title="Changelog" subtitle="What shipped in the product." />
      {loading ? <PageSkeleton /> : null}
      {error ? <PageError title="Could not load the changelog." detail={error} onRetry={() => void load()} /> : null}
      {log && log.entries.length === 0 ? <PageEmpty title="No entries yet" detail="Releases will show up here." /> : null}
      {log && log.entries.length > 0 ? (
        <div data-testid="changelog-list" className="flex flex-col gap-[var(--space-card)]">
          {log.entries.map((entry) => (
            <article key={entry.id} className={`${cardClass} p-4 transition-shadow hover:shadow-[var(--shadow-card)]`}>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{entry.date}</p>
              <h3 className="mt-2 text-base font-medium">{entry.title}</h3>
              <p className="mt-2 text-sm leading-5 text-muted-foreground">{entry.body}</p>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
