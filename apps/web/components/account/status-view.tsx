"use client";

import { useCallback, useEffect, useState } from "react";
import { PageError, PageHeader, PageSkeleton, pillClass } from "@/components/account/chrome";
import { UptimeBoard, type UptimePayload } from "@/components/account/uptime-board";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

export function StatusView() {
  const [status, setStatus] = useState<UptimePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api<UptimePayload>("/api/status"));
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
    <div data-testid="status-page" className="flex flex-col gap-8">
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
      {status ? <UptimeBoard status={status} /> : null}
    </div>
  );
}
