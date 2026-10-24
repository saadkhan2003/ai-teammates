"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StateMessage } from "@/components/state-message";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

type Config = { visionModel: string; transcriptionModel: string; transcriptionProvider: string; allowFallbacks?: false };

export default function VideoAdminConfigPage() {
  const [role, setRole] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([api<{ role?: string }>("/api/auth/me"), api<Config>("/api/admin/config/video")])
      .then(([me, loaded]) => { setRole(me.role ?? "member"); setConfig(loaded); })
      .catch((caught) => setError(errorMessage(caught, "Could not load video configuration.")))
      .finally(() => setLoading(false));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!config) return;
    setSaving(true); setError(null);
    try {
      setConfig(await api<Config>("/api/admin/config/video", { method: "PUT", body: JSON.stringify(config) }));
      toast.success("Video configuration saved.");
    } catch (caught) { setError(errorMessage(caught, "Could not save video configuration.")); }
    finally { setSaving(false); }
  }

  const staff = role === "owner" || role === "admin";
  return <>
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="text-sm">Video processing</CardTitle>
        <CardDescription>Choose the services used when teammates analyze videos. Transcription stays pinned to one provider without fallback.</CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {loading ? <StateMessage title="Loading video configuration" detail="Reading current admin settings." /> : null}
        {!loading && !staff ? <StateMessage title="Admin access required" detail="Only owners and admins can change video processing settings." /> : null}
        {error ? <p role="alert" className="mb-3 text-sm text-destructive">{error}</p> : null}
        {!loading && staff && config ? <form className="grid gap-4" onSubmit={(event) => void save(event)}>
          <div className="grid gap-2"><Label htmlFor="video-vision-model">Video vision model</Label><Input id="video-vision-model" value={config.visionModel} onChange={(event) => setConfig({ ...config, visionModel: event.target.value })} required /></div>
          <div className="grid gap-2"><Label htmlFor="video-transcription-model">Transcription model</Label><Input id="video-transcription-model" value={config.transcriptionModel} onChange={(event) => setConfig({ ...config, transcriptionModel: event.target.value })} required /></div>
          <div className="grid gap-2"><Label htmlFor="video-transcription-provider">Transcription provider pin</Label><Input id="video-transcription-provider" value={config.transcriptionProvider} onChange={(event) => setConfig({ ...config, transcriptionProvider: event.target.value })} required /><p className="text-xs text-muted-foreground">Fallbacks are disabled.</p></div>
          <div><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save settings"}</Button></div>
        </form> : null}
      </CardContent>
    </Card>
  </>;
}
