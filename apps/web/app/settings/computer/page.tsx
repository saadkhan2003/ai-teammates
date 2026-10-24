"use client";

import { useCallback, useEffect, useState } from "react";
import { cardClass, controlClass, focusClass, PageError, PageSkeleton, pillClass, SectionTitle } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
      setDevices(items);
      setVersion(release);
      setError(null);
      setSelected((current) => (items.some((item) => item.id === current) ? current : items[0]?.id ?? ""));
    } catch (caught) {
      setError(errorMessage(caught, "Could not load devices. Owner access is required."));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  async function update(device: Device, changes: Partial<Device>) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/devices/${device.id}`, { method: "PATCH", body: JSON.stringify(changes) });
      await load();
    } catch (caught) {
      setError(errorMessage(caught, "Could not update device permissions."));
    } finally {
      setBusy(false);
    }
  }

  async function pair() {
    setBusy(true);
    setError(null);
    try {
      setPairing(await api("/api/devices/pair", { method: "POST" }));
      setNow(Date.now());
    } catch (caught) {
      setError(errorMessage(caught, "Could not create a pairing code."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (revoke !== id) {
      setRevoke(id);
      return;
    }
    setBusy(true);
    try {
      await api(`/api/devices/${id}`, { method: "DELETE" });
      setRevoke("");
      await load();
    } catch (caught) {
      setError(errorMessage(caught, "Could not revoke device."));
    } finally {
      setBusy(false);
    }
  }

  const current = devices?.find((device) => device.id === selected);

  function execution(device: Device, prefix: string) {
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${prefix}-execution`}>Execution on this computer</Label>
        <Select value={device.execution} disabled={busy} onValueChange={(value) => void update(device, { execution: value })}>
          <SelectTrigger id={`${prefix}-execution`} data-testid={`${prefix}-execution`} className={`${controlClass} min-h-11`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ask">Ask every time</SelectItem>
            <SelectItem value="always">Always allow</SelectItem>
            <SelectItem value="off">Off</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-meta text-muted-foreground">Ask requires approval. Off refuses execution on this device.</p>
      </div>
    );
  }

  function toggle(device: Device, key: "routeTraffic" | "allowFiles" | "allowBrowser", label: string, prefix: string) {
    const id = `${prefix}-${key}`;
    return (
      <div className="flex min-h-11 items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <Switch id={id} data-testid={id} checked={device[key]} disabled={busy} onCheckedChange={(checked) => void update(device, { [key]: checked })} />
      </div>
    );
  }

  const behind = current && version?.latest && current.version.replace(/^v/, "") !== version.latest.replace(/^v/, "");

  return (
    <div data-testid="settings-computer" className="flex flex-col gap-[var(--space-section)]">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-title">Computer</h2>
          <p className="mt-1 text-body-sm text-muted-foreground">Choose what your teammates can do on each paired computer.</p>
        </div>
        <Button data-testid="add-device" className={pillClass} disabled={busy} onClick={() => void pair()}>
          Add a device
        </Button>
      </header>
      {error ? <PageError title="Could not update devices." detail={error} onRetry={() => void load()} /> : null}
      {!devices && !error ? <PageSkeleton /> : null}
      {version?.latest ? (
        <section data-testid="device-version" className={`${cardClass} p-4`}>
          <SectionTitle>Companion</SectionTitle>
          <p className="mt-2 text-body-sm">{behind ? `Update available: v${current?.version.replace(/^v/, "")} → v${version.latest.replace(/^v/, "")}` : "You're up to date"}</p>
          <p className="mt-1 text-meta text-muted-foreground">Latest companion: v{version.latest} · Minimum compatible: v{version.minCompatible}</p>
          <a href="/docs/COMPANION.md" className={`${focusClass} mt-3 inline-flex text-body-sm underline`}>
            Companion setup and update docs
          </a>
        </section>
      ) : null}
      {current ? (
        <section className={`${cardClass} flex flex-col gap-4 p-4`}>
          <SectionTitle>This computer</SectionTitle>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger id="current-device" className={`${controlClass} min-h-11`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {devices?.map((device) => (
                <SelectItem key={device.id} value={device.id}>
                  {device.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {execution(current, "current")}
          {toggle(current, "routeTraffic", "Route traffic through this computer", "current")}
          <p className="text-meta text-muted-foreground">Applies only to the selected paired device.</p>
        </section>
      ) : null}
      <section className={`${cardClass} p-4`}>
        <SectionTitle>Manage devices</SectionTitle>
        {devices?.length === 0 ? (
          <p data-testid="devices-empty" className="mt-4 text-body-sm text-muted-foreground">
            No devices paired. Add a device to connect your companion app.
          </p>
        ) : null}
        <div className="mt-4 flex flex-col gap-4">
          {devices?.map((device) => {
            const online = device.online && now - Date.parse(device.lastSeen) < 90_000;
            return (
              <article key={device.id} data-testid="device-row" className={`${controlClass} flex flex-col gap-4 border border-border p-4`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{device.name}</p>
                    <p className="text-meta text-muted-foreground">
                      {device.os} · v{device.version} · Last seen {formatWhen(device.lastSeen)}
                    </p>
                  </div>
                  <span className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-meta">{online ? "Online" : "Offline"}</span>
                </div>
                {execution(device, device.id)}
                {toggle(device, "routeTraffic", "Route traffic through this computer", device.id)}
                {toggle(device, "allowFiles", "Allow files", device.id)}
                {toggle(device, "allowBrowser", "Allow browser", device.id)}
                <div className="rounded-card border border-destructive/40 p-3">
                  <p className="text-body-sm font-medium text-destructive">Remove this device</p>
                  <p className="mt-1 text-meta text-muted-foreground">Revoke access from the companion. Confirm once to finish.</p>
                  <div className="mt-3 flex justify-end">
                    <Button variant="destructive" size="sm" className={pillClass} data-testid="revoke-device" disabled={busy} onClick={() => void remove(device.id)}>
                      {revoke === device.id ? "Confirm revoke" : "Remove / revoke"}
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
        {pairing ? (
          <div data-testid="pairing-code" className={`${controlClass} mt-4 flex flex-col gap-2 border border-border p-4`} role="status">
            <p className="text-body-sm">Enter this single-use code in the companion app or CLI.</p>
            <p className="font-mono text-title tracking-widest tabular-nums">{Date.parse(pairing.expiresAt) > now ? pairing.code : "Code expired"}</p>
            <p className="text-meta text-muted-foreground">Expires {formatWhen(pairing.expiresAt)} (10 minutes). A new device starts with Ask every time and all optional permissions off.</p>
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" className={pillClass} onClick={() => setPairing(null)}>
                Dismiss code
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
