"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";

type Version = { latest: string; minCompatible?: string };
export default function UpdatesPage() {
  const [version, setVersion] = useState<Version | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const load = useCallback(async () => { setBusy(true); try { setVersion(await api<Version>("/api/devices/version")); setChecked(true); } finally { setBusy(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const current = process.env.NEXT_PUBLIC_APP_VERSION || "0.4.0";
  const available = version?.latest && version.latest.replace(/^v/, "") !== current.replace(/^v/, "");
  return <div className="flex flex-col gap-[var(--space-section)]"><header className="flex items-start justify-between gap-4"><div><h2 className="text-sm font-medium">Updates</h2><p className="mt-1 text-sm text-muted-foreground">Self-hosted updates are installed by rebuilding the application image.</p></div><Button data-testid="check-updates" variant="outline" disabled={busy} onClick={() => void load()}>{busy ? "Checking…" : "Check for Updates"}</Button></header><Card data-testid="updates-card"><CardContent className="space-y-1 p-4 text-sm"><p className="font-medium">AI Teammates · Version {current}</p><p data-testid="update-status" className="text-muted-foreground">{!checked ? "Checking…" : available ? `v${version?.latest} available` : "You're up to date"}</p></CardContent></Card></div>;
}
