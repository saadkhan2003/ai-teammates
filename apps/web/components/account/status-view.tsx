"use client";

import { useCallback, useEffect, useState } from "react";
import { cardClass, PageError, PageHeader, PageSkeleton, pillClass, SectionTitle } from "@/components/account/chrome";
import { UptimeBoard, type UptimePayload } from "@/components/account/uptime-board";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

type LiveComponent = { name: string; status: string; available?: number };
type PublishedIncident = { id: string; title: string; status: string; details: string; created_at: string };

export function StatusView() {
  const [status, setStatus] = useState<(UptimePayload & { components?: LiveComponent[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [incidents, setIncidents] = useState<PublishedIncident[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [board, published] = await Promise.all([
        api<UptimePayload & { components?: LiveComponent[] }>("/api/status"),
        api<PublishedIncident[]>("/api/status/incidents").catch(() => []),
      ]);
      setStatus(board);
      setIncidents(published);
      setError(null);
    } catch (caught) {
      setStatus(null);
      setError(errorMessage(caught, "Could not load status."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div data-testid="status-page" className="flex flex-col gap-[var(--space-section)]">
      <PageHeader
        title="Status"
        subtitle="Uptime for each part of the platform."
        action={
          <Button type="button" variant="outline" className={pillClass} onClick={() => void load()}>
            Refresh
          </Button>
        }
      />
      {loading ? <PageSkeleton /> : null}
      {error ? <PageError title="Could not load status." detail={error} onRetry={() => void load()} /> : null}
      {status?.components?.length ? <section className={cardClass} aria-label="Live service checks">
        <div className="p-4"><SectionTitle>Live service checks</SectionTitle></div>
        <dl className="divide-y divide-border">{status.components.map(component => <div key={component.name} className="flex items-center justify-between gap-4 px-4 py-3 text-body-sm"><div><dt className="font-medium">{component.name}</dt>{component.available !== undefined ? <dd className="text-meta text-muted-foreground">{component.available} configured</dd> : null}</div><dd className="capitalize text-muted-foreground">{component.status.replaceAll("_", " ")}</dd></div>)}</dl>
      </section> : null}
      {status ? <UptimeBoard status={status} /> : null}
      {incidents.length ? <section aria-label="Published incidents" className="flex flex-col gap-4"><SectionTitle>Published incidents</SectionTitle>{incidents.map(incident => <article key={incident.id} className={`${cardClass} p-4`}><div className="flex justify-between gap-3"><h3 className="text-body-sm font-medium">{incident.title}</h3><span className="text-meta text-muted-foreground">{incident.status}</span></div><p className="mt-2 whitespace-pre-wrap text-body-sm text-muted-foreground">{incident.details}</p><time className="mt-2 block text-meta text-muted-foreground">{new Date(incident.created_at).toLocaleString()}</time></article>)}</section> : null}
    </div>
  );
}
