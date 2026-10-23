"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { errorMessage, formatWhen } from "@/lib/utils";

type Device = { id: string; name: string; os: string; version: string; lastSeen: string; online: boolean; execution: string; routeTraffic: boolean; allowFiles: boolean; allowBrowser: boolean };
type Version = { latest: string; minCompatible: string };
export default function ComputerSettingsPage() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [version, setVersion] = useState<Version | null>(null);
  const [selected, setSelected] = useState("");
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoke, setRevoke] = useState("");
  const load = useCallback(async () => {
    try {
      const [items, release] = await Promise.all([api<Device[]>("/api/devices"), api<Version>("/api/devices/version")]);
      setDevices(items); setVersion(release); setError(null);
      setSelected(current => items.some(item => item.id === current) ? current : items[0]?.id ?? "");
    } catch (caught) { setError(errorMessage(caught, "Could not load devices. Owner access is required.")); }
  }, []);
  useEffect(() => { void load(); const timer = setInterval(() => { setNow(Date.now()); void load(); }, 30_000); return () => clearInterval(timer); }, [load]);
  async function update(device: Device, changes: Partial<Device>) {
    setBusy(true); setError(null);
    try { await api(`/api/devices/${device.id}`, { method: "PATCH", body: JSON.stringify(changes) }); await load(); }
    catch (caught) { setError(errorMessage(caught, "Could not update device permissions.")); }
    finally { setBusy(false); }
  }
  async function pair() {
    setBusy(true); setError(null);
    try { setPairing(await api("/api/devices/pair", { method: "POST" })); setNow(Date.now()); }
    catch (caught) { setError(errorMessage(caught, "Could not create a pairing code.")); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (revoke !== id) { setRevoke(id); return; }
    setBusy(true);
    try { await api(`/api/devices/${id}`, { method: "DELETE" }); setRevoke(""); await load(); }
    catch (caught) { setError(errorMessage(caught, "Could not revoke device.")); }
    finally { setBusy(false); }
  }
  const current = devices?.find(device => device.id === selected);
  function execution(device: Device, prefix: string) {
    return <div className="space-y-2"><Label htmlFor={`${prefix}-execution`}>Execution on this computer</Label><Select value={device.execution} disabled={busy} onValueChange={value => void update(device, { execution: value })}><SelectTrigger id={`${prefix}-execution`} data-testid={`${prefix}-execution`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ask">Ask every time</SelectItem><SelectItem value="always">Always allow</SelectItem><SelectItem value="off">Off</SelectItem></SelectContent></Select><p className="text-xs text-muted-foreground">Ask requires approval. Off refuses execution on this device.</p></div>;
  }
  function toggle(device: Device, key: "routeTraffic" | "allowFiles" | "allowBrowser", label: string, prefix: string) {
    const id = `${prefix}-${key}`;
    return <div className="flex items-center justify-between gap-3"><Label htmlFor={id}>{label}</Label><Switch id={id} data-testid={id} checked={device[key]} disabled={busy} onCheckedChange={checked => void update(device, { [key]: checked })} /></div>;
  }
  return <div data-testid="settings-computer" className="space-y-4">
    <div><h2 className="text-lg font-medium">Computer</h2><p className="text-sm text-muted-foreground">Choose what your teammates can do on each paired computer.</p></div>
    {error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p><Button variant="outline" onClick={() => void load()}>Retry</Button></div>}
    {!devices && !error && <Skeleton className="h-48 w-full" />}
    {version && <Card data-testid="device-version"><CardContent className="space-y-2 p-4"><p className="text-sm">{current && current.version.replace(/^v/, "") !== version.latest.replace(/^v/, "") ? `Update available: v${current.version.replace(/^v/, "")} → v${version.latest.replace(/^v/, "")}` : "You're up to date"}</p><p className="text-xs text-muted-foreground">Latest companion: v{version.latest} · Minimum compatible: v{version.minCompatible}</p><a href="/docs/COMPANION.md" className="text-sm underline">Companion setup and update docs</a></CardContent></Card>}
    {current && <Card><CardContent className="space-y-4 p-4"><Label htmlFor="current-device">This computer</Label><Select value={selected} onValueChange={setSelected}><SelectTrigger id="current-device"><SelectValue /></SelectTrigger><SelectContent>{devices?.map(device => <SelectItem key={device.id} value={device.id}>{device.name}</SelectItem>)}</SelectContent></Select>{execution(current, "current")}{toggle(current, "routeTraffic", "Route traffic through this computer", "current")}<p className="text-xs text-muted-foreground">Applies only to the selected paired device.</p></CardContent></Card>}
    <Card><CardHeader><CardTitle className="text-sm">Manage devices</CardTitle></CardHeader><CardContent className="space-y-4">
      {devices?.length === 0 && <p data-testid="devices-empty" className="text-sm text-muted-foreground">No devices paired. Add a device to connect your companion app.</p>}
      {devices?.map(device => <div key={device.id} data-testid="device-row" className="space-y-4 rounded-md border border-border p-3"><div className="flex items-start justify-between gap-2"><div><p className="font-medium">{device.name}</p><p className="text-xs text-muted-foreground">{device.os} · v{device.version} · Last seen {formatWhen(device.lastSeen)}</p></div><Badge variant="secondary">{device.online && now - Date.parse(device.lastSeen) < 90_000 ? "Online" : "Offline"}</Badge></div>{execution(device, device.id)}{toggle(device, "routeTraffic", "Route traffic through this computer", device.id)}{toggle(device, "allowFiles", "Allow files", device.id)}{toggle(device, "allowBrowser", "Allow browser", device.id)}<Button variant="destructive" size="sm" data-testid="revoke-device" disabled={busy} onClick={() => void remove(device.id)}>{revoke === device.id ? "Confirm revoke" : "Remove / revoke"}</Button></div>)}
      <Button data-testid="add-device" disabled={busy} onClick={() => void pair()}>Add a device</Button>
      {pairing && <div data-testid="pairing-code" className="space-y-2 rounded-md border border-border p-3" role="status"><p className="text-sm">Enter this single-use code in the companion app or CLI.</p><p className="font-mono text-xl tracking-widest">{Date.parse(pairing.expiresAt) > now ? pairing.code : "Code expired"}</p><p className="text-xs text-muted-foreground">Expires {formatWhen(pairing.expiresAt)} (10 minutes). A new device starts with Ask every time and all optional permissions off.</p><Button variant="ghost" size="sm" onClick={() => setPairing(null)}>Dismiss code</Button></div>}
    </CardContent></Card>
  </div>;
}
