"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, asList } from "@/lib/api";
import { cn, errorMessage } from "@/lib/utils";

const LABEL_FILTERS = [
  { id: "", label: "Any label" },
  { id: "auto-checked", label: "Auto-checked" },
  { id: "needs-auth", label: "Needs auth" },
  { id: "verified", label: "Verified" },
  { id: "tested", label: "Tested" },
  { id: "community", label: "Community" },
  { id: "low", label: "Low risk" },
  { id: "medium", label: "Medium risk" },
  { id: "high", label: "High risk" },
] as const;

type CatalogItem = {
  id: string;
  name: string;
  publisher: string;
  version: string;
  kind: string;
  authType: string;
  category: string;
  risk: string;
  trust: string;
  label: string;
  checkStatus: string;
  healthStatus: string;
  blocked: boolean;
  labels: string[];
};

type InstallRow = {
  id: string;
  name: string;
  kind: string;
  authType: string;
  category: string;
  label: string;
  trust: string;
  risk: string;
  status: string;
  secretId: string;
  catalogId: string;
};

type BotRow = { id: string; name: string };
type EnableRow = { pluginId: string; botId: string; enabled: boolean };
type Stats = { imported: number; autoChecked: number; needsAuth: number; failed: number; countsTowardTarget: number };

const emptyStats: Stats = { imported: 0, autoChecked: 0, needsAuth: 0, failed: 0, countsTowardTarget: 0 };

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

function readCatalog(data: unknown): { items: CatalogItem[]; total: number; stats: Stats; categories: string[] } {
  const record = (data ?? {}) as Record<string, unknown>;
  const statsRecord = (record.stats ?? {}) as Record<string, unknown>;
  const items = asList(record.items ?? data, ["items"]).map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const labels = Array.isArray(row.labels) ? row.labels.map((item) => String(item)) : [];
    return {
      id: text(row.id),
      name: text(row.name, "Plugin"),
      publisher: text(row.publisher),
      version: text(row.version),
      kind: text(row.kind),
      authType: text(row.authType, "none"),
      category: text(row.category),
      risk: text(row.risk, "unknown"),
      trust: text(row.trust, "community"),
      label: text(row.label, "listed"),
      checkStatus: text(row.checkStatus),
      healthStatus: text(row.healthStatus),
      blocked: row.blocked === true,
      labels,
    };
  }).filter((row) => row.id);
  return {
    items,
    total: typeof record.total === "number" ? record.total : items.length,
    stats: {
      imported: Number(statsRecord.imported ?? 0),
      autoChecked: Number(statsRecord.autoChecked ?? 0),
      needsAuth: Number(statsRecord.needsAuth ?? 0),
      failed: Number(statsRecord.failed ?? 0),
      countsTowardTarget: Number(statsRecord.countsTowardTarget ?? 0),
    },
    categories: Array.isArray(record.categories) ? record.categories.map((item) => String(item)).filter(Boolean) : [],
  };
}

function readInstalls(data: unknown): InstallRow[] {
  return asList(data, ["plugins", "items"])
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      return {
        id: text(row.id),
        name: text(row.name, "Plugin"),
        kind: text(row.kind),
        authType: text(row.authType, "none"),
        category: text(row.category),
        label: text(row.label, "listed"),
        trust: text(row.trust),
        risk: text(row.risk),
        status: text(row.status),
        secretId: text(row.secretId),
        catalogId: text(row.catalogId),
      };
    })
    .filter((row) => row.id);
}

function authLabel(auth: string): string {
  if (auth === "api_key") return "API key";
  if (auth === "oauth") return "OAuth";
  return "No auth";
}

export function PluginsPane({ mode = "installed" }: { mode?: "both" | "catalog" | "installed" }) {
  const showCatalog = mode !== "installed";
  const showInstalled = mode !== "catalog";
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState("");
  const [label, setLabel] = useState("");
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [stats, setStats] = useState<Stats>(emptyStats);
  const [installs, setInstalls] = useState<InstallRow[]>([]);
  const [bots, setBots] = useState<BotRow[]>([]);
  const [enables, setEnables] = useState<EnableRow[]>([]);
  const [staff, setStaff] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("mcp");
  const [authType, setAuthType] = useState("none");
  const [manualCategory, setManualCategory] = useState("");
  const [apiKey, setApiKey] = useState<Record<string, string>>({});
  const [specUrl, setSpecUrl] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const loadInstalled = useCallback(async () => {
    const [pluginBody, botBody, enableBody, me] = await Promise.all([
      api<unknown>("/api/plugins"),
      api<unknown>("/api/bots"),
      api<unknown>("/api/plugins/enables"),
      api<{ role?: string }>("/api/auth/me"),
    ]);
    setInstalls(readInstalls(pluginBody));
    setBots(
      asList(botBody, ["bots", "items"])
        .map((entry) => {
          const row = (entry ?? {}) as Record<string, unknown>;
          return { id: text(row.id), name: text(row.name, "Teammate") };
        })
        .filter((row) => row.id),
    );
    setEnables(
      asList(enableBody, ["enables", "items"]).map((entry) => {
        const row = (entry ?? {}) as Record<string, unknown>;
        return { pluginId: text(row.pluginId), botId: text(row.botId), enabled: row.enabled !== false };
      }),
    );
    setStaff(me.role === "owner" || me.role === "admin");
  }, []);

  const loadCatalog = useCallback(async () => {
    const params = new URLSearchParams();
    if (debounced) params.set("q", debounced);
    if (category) params.set("category", category);
    if (label) params.set("label", label);
    const body = await api<unknown>(`/api/plugins/catalog?${params.toString()}`);
    const parsed = readCatalog(body);
    setCatalog(parsed.items);
    setCatalogTotal(parsed.total);
    setStats(parsed.stats);
    if (parsed.categories.length > 0) setCategories(parsed.categories);
  }, [debounced, category, label]);

  const load = useCallback(async () => {
    try {
      if (showInstalled) await loadInstalled();
      else {
        const me = await api<{ role?: string }>("/api/auth/me");
        setStaff(me.role === "owner" || me.role === "admin");
      }
      if (showCatalog) await loadCatalog();
      else {
        const body = await api<Stats>("/api/plugins/stats");
        setStats({
          imported: Number(body.imported ?? 0),
          autoChecked: Number(body.autoChecked ?? 0),
          needsAuth: Number(body.needsAuth ?? 0),
          failed: Number(body.failed ?? 0),
          countsTowardTarget: Number(body.countsTowardTarget ?? 0),
        });
      }
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load plugins."));
    } finally {
      setLoading(false);
    }
  }, [loadCatalog, loadInstalled, showCatalog, showInstalled]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleInstalls = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return installs.filter((row) => {
      if (category && !`${row.category} ${row.kind}`.toLowerCase().includes(category.toLowerCase())) return false;
      if (!needle) return true;
      return `${row.name} ${row.kind} ${row.category} ${row.authType} ${row.label}`.toLowerCase().includes(needle);
    });
  }, [installs, query, category]);

  async function install(catalogId: string) {
    setBusy(catalogId);
    try {
      await api("/api/plugins/install", { method: "POST", body: JSON.stringify({ catalogId }) });
      toast.success("Installed. Enable it on a teammate before it can be called.");
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not install that plugin."));
    } finally {
      setBusy(null);
    }
  }

  async function uninstall(id: string) {
    setBusy(id);
    try {
      await api(`/api/plugins/${id}`, { method: "DELETE" });
      toast.success("Plugin removed.");
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not remove that plugin."));
    } finally {
      setBusy(null);
    }
  }

  async function connectKey(id: string) {
    const value = (apiKey[id] ?? "").trim();
    if (!value) return;
    setBusy(id);
    try {
      await api(`/api/plugins/${id}/connect`, { method: "POST", body: JSON.stringify({ apiKey: value }) });
      setApiKey((current) => ({ ...current, [id]: "" }));
      toast.success("Credential stored in the vault.");
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not store that credential."));
    } finally {
      setBusy(null);
    }
  }

  async function startOauth(id: string) {
    setBusy(id);
    try {
      const body = await api<{ url?: string }>(`/api/plugins/${id}/oauth/start`, { method: "POST", body: "{}" });
      if (!body.url) throw new Error("OAuth is not configured for this plugin.");
      window.location.assign(body.url);
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not start OAuth."));
      setBusy(null);
    }
  }

  async function toggleBot(pluginId: string, botId: string, enabled: boolean) {
    setBusy(`${pluginId}:${botId}`);
    try {
      await api(`/api/plugins/${pluginId}/bots/${botId}`, { method: "PUT", body: JSON.stringify({ enabled }) });
      setEnables((current) => {
        const rest = current.filter((row) => !(row.pluginId === pluginId && row.botId === botId));
        return [...rest, { pluginId, botId, enabled }];
      });
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not update that teammate."));
    } finally {
      setBusy(null);
    }
  }

  async function block(id: string, blocked: boolean) {
    setBusy(id);
    try {
      await api(`/api/admin/plugins/${id}/block`, { method: "POST", body: JSON.stringify({ blocked, reason: blocked ? "blocked by an admin" : "" }) });
      toast.success(blocked ? "Plugin blocked." : "Plugin unblocked.");
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not update the block."));
    } finally {
      setBusy(null);
    }
  }

  async function queueImport() {
    setBusy("import");
    try {
      await api("/api/admin/plugins/jobs", { method: "POST", body: JSON.stringify({ kind: "import" }) });
      toast.success("Import queued. It does not start a plugin process.");
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not queue the import."));
    } finally {
      setBusy(null);
    }
  }

  async function addManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("manual");
    try {
      await api("/api/plugins", { method: "POST", body: JSON.stringify({ name, kind, authType, category: manualCategory }) });
      setName("");
      setManualCategory("");
      toast.success("Plugin saved. It is listed and not running.");
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not save that plugin."));
    } finally {
      setBusy(null);
    }
  }

  async function addSpec(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("spec");
    try {
      await api("/api/plugins/openapi", { method: "POST", body: JSON.stringify({ url: specUrl }) });
      setSpecUrl("");
      toast.success("Spec saved in the catalog. Install it to use it.");
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not read that spec."));
    } finally {
      setBusy(null);
    }
  }

  const catalogEmpty = !loading && showCatalog && catalog.length === 0;
  const installedEmpty = !loading && showInstalled && visibleInstalls.length === 0;

  return (
    <div data-testid="plugins-pane" className="flex flex-col gap-3">
      <p data-testid="plugin-stats" className="text-xs text-muted-foreground">
        Imported {stats.imported} · Auto-checked {stats.autoChecked} · Needs auth {stats.needsAuth} · Failed {stats.failed}
        {stats.countsTowardTarget !== stats.autoChecked ? ` · Toward target ${stats.countsTowardTarget}` : ""}
      </p>
      <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search plugins" aria-label="Search plugins" />
      <div className="flex flex-wrap gap-1.5">
        <FilterChip active={category === ""} onClick={() => setCategory("")}>
          All
        </FilterChip>
        {categories.map((item) => (
          <FilterChip key={item} active={category === item} onClick={() => setCategory(item)}>
            {item}
          </FilterChip>
        ))}
      </div>
      {showCatalog ? (
        <div className="flex flex-wrap gap-1.5">
          {LABEL_FILTERS.map((item) => (
            <FilterChip key={item.id || "any"} active={label === item.id} onClick={() => setLabel(item.id)}>
              {item.label}
            </FilterChip>
          ))}
        </div>
      ) : null}
      {loading ? (
        <div data-testid="plugins-loading" className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <p className="text-sm text-muted-foreground">Loading plugins…</p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {showCatalog && staff ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" disabled={busy === "import"} onClick={() => void queueImport()}>
            Queue catalog import
          </Button>
        </div>
      ) : null}
      {catalogEmpty ? (
        <div data-testid="plugins-empty" className="rounded-lg border border-border bg-card px-3 py-4">
          <p className="text-sm font-medium">No catalog plugins</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {query || category || label
              ? "Nothing in the catalog matches that filter."
              : "The catalog is empty. An import adds rows only. Nothing is installed until you install it."}
          </p>
        </div>
      ) : null}
      {showCatalog && catalog.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {catalog.map((row) => (
            <li key={row.id} data-testid="catalog-row" className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {row.publisher ? `${row.publisher} · ` : ""}
                    {row.kind} · {authLabel(row.authType)}
                    {row.category ? ` · ${row.category}` : ""}
                    {row.version ? ` · ${row.version}` : ""}
                  </p>
                </div>
                <Button type="button" data-testid="plugin-install" className="min-h-11" disabled={busy === row.id || row.blocked} onClick={() => void install(row.id)}>
                  {row.blocked ? "Blocked" : busy === row.id ? "Installing…" : "Install"}
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <Badge variant="secondary">{row.label}</Badge>
                <Badge variant="outline">{row.trust}</Badge>
                <Badge variant="outline">{row.risk}</Badge>
                {row.healthStatus && row.healthStatus !== "unknown" ? <Badge variant="outline">{row.healthStatus}</Badge> : null}
                {row.blocked ? <Badge variant="destructive">blocked</Badge> : null}
              </div>
              {staff ? (
                <button type="button" className="mt-2 text-xs text-muted-foreground underline" onClick={() => void block(row.id, !row.blocked)}>
                  {row.blocked ? "Unblock" : "Block"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {showCatalog && catalogTotal > catalog.length ? (
        <p className="text-xs text-muted-foreground">
          Showing {catalog.length} of {catalogTotal}. Search to narrow the catalog.
        </p>
      ) : null}
      {installedEmpty ? (
        <div data-testid={showCatalog ? "plugins-installed-empty" : "plugins-empty"} className="rounded-lg border border-border bg-card px-3 py-4">
          <p className="text-sm font-medium">No plugins installed</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {query || category ? "Nothing in this install matches that filter." : "Installed plugins list here. Installing one does not start a process."}
          </p>
        </div>
      ) : null}
      {showInstalled && visibleInstalls.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {visibleInstalls.map((row) => (
            <li key={row.id} data-testid="plugin-row" className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {row.kind} · {authLabel(row.authType)}
                    {row.category ? ` · ${row.category}` : ""}
                    {row.secretId ? " · credential stored" : ""}
                  </p>
                </div>
                <Button type="button" variant="secondary" data-testid="plugin-uninstall" className="min-h-11" disabled={busy === row.id} onClick={() => void uninstall(row.id)}>
                  Remove
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <Badge variant="secondary">{row.label || "listed"}</Badge>
                {row.trust ? <Badge variant="outline">{row.trust}</Badge> : null}
                {row.risk ? <Badge variant="outline">{row.risk}</Badge> : null}
              </div>
              {row.authType === "api_key" ? (
                <form
                  className="mt-2 flex flex-col gap-2 sm:flex-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void connectKey(row.id);
                  }}
                >
                  <Input
                    type="password"
                    autoComplete="off"
                    data-testid="plugin-api-key"
                    aria-label={`API key for ${row.name}`}
                    placeholder="API key"
                    value={apiKey[row.id] ?? ""}
                    onChange={(event) => setApiKey((current) => ({ ...current, [row.id]: event.target.value }))}
                  />
                  <Button type="submit" className="min-h-11" disabled={busy === row.id}>
                    Save in vault
                  </Button>
                </form>
              ) : null}
              {row.authType === "oauth" ? (
                <Button type="button" className="mt-2 min-h-11" data-testid="plugin-oauth" disabled={busy === row.id} onClick={() => void startOauth(row.id)}>
                  Connect with OAuth
                </Button>
              ) : null}
              {bots.length > 0 ? (
                <div className="mt-3 flex flex-col gap-2">
                  <p className="text-xs font-medium text-muted-foreground">Enabled for</p>
                  {bots.map((bot) => {
                    const enabled = enables.some((item) => item.pluginId === row.id && item.botId === bot.id && item.enabled);
                    return (
                      <label key={bot.id} className="flex min-h-11 items-center justify-between gap-3 text-sm">
                        <span className="truncate">{bot.name}</span>
                        <Switch
                          checked={enabled}
                          disabled={busy === `${row.id}:${bot.id}`}
                          aria-label={`Enable ${row.name} for ${bot.name}`}
                          onCheckedChange={(value) => void toggleBot(row.id, bot.id, value)}
                        />
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">Create a teammate to enable this plugin for them.</p>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {showCatalog ? (
        <form className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3" onSubmit={addSpec}>
          <p className="text-sm font-medium">Add an OpenAPI spec</p>
          <p className="text-xs text-muted-foreground">A public http(s) URL. Private addresses and file URLs are rejected. This does not install the plugin.</p>
          <Input value={specUrl} onChange={(event) => setSpecUrl(event.target.value)} placeholder="https://example.com/openapi.json" aria-label="OpenAPI spec URL" type="url" required />
          <Button type="submit" disabled={busy === "spec"}>
            {busy === "spec" ? "Reading…" : "Add spec to catalog"}
          </Button>
        </form>
      ) : null}
      {showInstalled ? (
        <form className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3" onSubmit={addManual}>
          <p className="text-sm font-medium">Add a plugin</p>
          <p className="text-xs text-muted-foreground">Saves a registry row only. It does not start a server.</p>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" aria-label="Plugin name" required />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <select aria-label="Plugin kind" value={kind} onChange={(event) => setKind(event.target.value)} className="h-10 rounded-md border border-input bg-card px-2 text-sm">
              <option value="mcp">MCP</option>
              <option value="openapi">OpenAPI</option>
              <option value="builtin">Built-in</option>
              <option value="oauth">OAuth app</option>
            </select>
            <select aria-label="Plugin auth" value={authType} onChange={(event) => setAuthType(event.target.value)} className="h-10 rounded-md border border-input bg-card px-2 text-sm">
              <option value="none">No auth</option>
              <option value="api_key">API key</option>
              <option value="oauth">OAuth</option>
            </select>
          </div>
          <Input value={manualCategory} onChange={(event) => setManualCategory(event.target.value)} placeholder="Category" aria-label="Plugin category" />
          <Button type="submit" disabled={busy === "manual"}>
            {busy === "manual" ? "Saving…" : "Save plugin"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      data-testid="plugin-filter"
      data-active={active}
      className={cn(
        "min-h-11 rounded-md border px-3 py-1 text-xs sm:min-h-0",
        active ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-card text-foreground",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
