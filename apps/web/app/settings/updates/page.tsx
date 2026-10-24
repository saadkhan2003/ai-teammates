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
  return <div id="updates" className="space-y-4"><h2 className="text-lg font-medium">Updates</h2><Card data-testid="updates-card"><CardContent className="flex flex-wrap items-center justify-between gap-4 p-4"><div className="space-y-1 text-sm"><p className="font-medium">AI Teammates Updates · Version {current}</p><p className="text-muted-foreground">Self-hosted updates are installed by rebuilding the application image.</p><p data-testid="update-status" className="text-muted-foreground">{!checked ? "Checking…" : available ? `v${version?.latest} available` : "You're up to date"}</p></div><Button data-testid="check-updates" variant="outline" disabled={busy} onClick={() => void load()}>{busy ? "Checking…" : "Check for Updates"}</Button></CardContent></Card></div>;
}
