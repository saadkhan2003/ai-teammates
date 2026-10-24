"use client";

import { useCallback, useEffect, useState } from "react";
import { cardClass, pillClass, SectionTitle } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type Version = { latest: string; minCompatible?: string };

export default function UpdatesPage() {
  const [version, setVersion] = useState<Version | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setVersion(await api<Version>("/api/devices/version"));
      setChecked(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = process.env.NEXT_PUBLIC_APP_VERSION || "0.4.0";
  const available = version?.latest && version.latest.replace(/^v/, "") !== current.replace(/^v/, "");

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Updates</h2>
          <p className="mt-1 text-sm text-muted-foreground">Self-hosted updates are installed by rebuilding the application image.</p>
        </div>
        <Button data-testid="check-updates" variant="outline" className={pillClass} disabled={busy} onClick={() => void load()}>
          {busy ? "Checking…" : "Check for Updates"}
        </Button>
      </header>
      <section data-testid="updates-card" className={`${cardClass} p-4`}>
        <SectionTitle>This install</SectionTitle>
        <p className="mt-3 text-3xl font-semibold tabular-nums tracking-tight">{current}</p>
        <p className="text-sm text-muted-foreground">AI Teammates</p>
        <p data-testid="update-status" className="mt-3 text-sm text-muted-foreground">
          {!checked ? "Checking…" : available ? `v${version?.latest} available` : "You're up to date"}
        </p>
      </section>
    </div>
  );
}
