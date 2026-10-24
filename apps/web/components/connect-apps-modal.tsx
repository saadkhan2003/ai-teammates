"use client";

import { ChevronLeft, ChevronRight, ExternalLink, Plus, Search } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppLogo } from "@/components/app-logo";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, asList } from "@/lib/api";
import {
  CONNECT_CATEGORIES,
  actionLabel,
  connectSections,
  connectorLine,
  extraCategories,
  isConnected,
  matchingSkills,
  catalogOrFallback,
  readCatalogApps,
  readInstalledApps,
  readPrivateSkills,
  type CatalogApp,
  type InstalledApp,
  type PrivateSkill,
} from "@/lib/connect-apps";
import { cn, errorMessage } from "@/lib/utils";

type View = "browse" | "manage" | "templates";

type TemplateBot = { id: string; name: string; role: string; avatarShape: string; avatarColor: string; instructions: string };

function CategoryRow({ active, extras, onSelect }: { active: string; extras: string[]; onSelect: (name: string) => void }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const candidates = useMemo(() => ["All", ...CONNECT_CATEGORIES], []);
  const [fit, setFit] = useState(candidates.length);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const probe = probeRef.current;
    if (!row || !probe) return;
    const measure = () => {
      const chips = [...probe.querySelectorAll<HTMLElement>("[data-chip]")];
      const more = row.querySelector<HTMLElement>("[data-more]");
      const available = row.clientWidth - (more?.offsetWidth ?? 72) - 4;
      let used = 0;
      let count = 0;
      for (const chip of chips) {
        const width = chip.offsetWidth + 4;
        if (count > 0 && used + width > available) break;
        used += width;
        count += 1;
      }
      setFit(Math.max(1, count));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [candidates, extras]);

  const shown = candidates.slice(0, fit);
  const overflow = [...candidates.slice(fit), ...extras.filter((name) => !candidates.includes(name))];
  const moreActive = overflow.includes(active);

  return (
    <div className="relative px-4 py-2">
      <div ref={rowRef} data-testid="connect-categories" className="flex h-7 flex-nowrap items-center gap-1 overflow-hidden">
        {shown.map((name) => (
          <Chip key={name} testId="connect-category" active={active === name} onClick={() => onSelect(name)}>{name}</Chip>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" data-more="" data-testid="connect-more" data-active={moreActive} className="connect-chip shrink-0 rounded-full px-2.5 py-1 text-meta font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
              More ▾
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {overflow.length === 0 ? <DropdownMenuItem disabled>No other categories</DropdownMenuItem> : null}
            {overflow.map((name) => (
              <DropdownMenuItem key={name} data-testid="connect-more-item" onSelect={() => onSelect(name)}>{name}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div ref={probeRef} className="pointer-events-none invisible absolute inset-x-0 top-0 flex flex-nowrap gap-1" aria-hidden>
        {candidates.map((name) => (
          <Chip key={name} measure>{name}</Chip>
        ))}
      </div>
    </div>
  );
}

function Chip({ active, children, onClick, testId, measure = false }: { active?: boolean; children: ReactNode; onClick?: () => void; testId?: string; measure?: boolean }) {
  return (
    <button type="button" data-chip="" data-testid={measure ? undefined : testId} data-active={active} className="connect-chip shrink-0 rounded-full px-2.5 py-1 text-meta font-medium text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground" onClick={onClick}>
      {children}
    </button>
  );
}

export function ConnectAppsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [view, setView] = useState<View>("browse");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState("All");
  const [apps, setApps] = useState<CatalogApp[]>([]);
  const [apiCategories, setApiCategories] = useState<string[]>([]);
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [skills, setSkills] = useState<PrivateSkill[]>([]);
  const [templates, setTemplates] = useState<TemplateBot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAllInstalled, setShowAllInstalled] = useState(false);
  const [keyFor, setKeyFor] = useState<{ installId: string; catalogId: string } | null>(null);
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setView("browse");
      setQuery("");
      setDebounced("");
      setCategory("All");
      setKeyFor(null);
      setShowAllInstalled(false);
    }
  }, [open]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debounced) params.set("q", debounced);
      if (category !== "All" && category !== "recommended") params.set("category", category);
      const [catalogBody, pluginBody, botBody] = await Promise.all([
        api<unknown>(`/api/plugins/catalog?${params.toString()}`),
        api<unknown>("/api/plugins"),
        api<unknown>("/api/bots"),
      ]);
      const catalog = readCatalogApps(catalogBody);
      const installs = readInstalledApps(pluginBody);
      const installedIds = new Set(installs.map((row) => row.catalogId).filter(Boolean));
      const source = debounced ? catalog.items : catalogOrFallback(catalog.items);
      setApps(source.filter((item) => !installedIds.has(item.id)));
      setApiCategories(catalog.categories);
      setInstalled(installs);
      const bots = asList(botBody, ["bots", "items"]).map((entry) => {
        const row = (entry ?? {}) as Record<string, unknown>;
        return {
          id: String(row.id ?? ""),
          name: String(row.name ?? "Teammate"),
          role: String(row.role ?? ""),
          avatarShape: String(row.avatarShape ?? row.avatar_shape ?? ""),
          avatarColor: String(row.avatarColor ?? row.avatar_color ?? ""),
          instructions: String(row.instructions ?? ""),
        };
      }).filter((bot) => bot.id);
      setTemplates(bots);
      const skillLists = await Promise.all(
        bots.map(async (bot) => {
          try {
            return readPrivateSkills(bot.name, await api<unknown>(`/api/bots/${bot.id}/skills`));
          } catch {
            return null;
          }
        }),
      );
      setSkills(skillLists.flatMap((list) => list ?? []));
      setSkillsError(skillLists.some((list) => list === null) ? "Could not load private skills." : null);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load apps."));
    } finally {
      setLoading(false);
    }
  }, [category, debounced]);

  useEffect(() => {
    if (!open) return;
    void load().catch(() => setSkillsError("Could not load private skills."));
  }, [open, load]);

  const sections = useMemo(() => connectSections(apps, category), [apps, category]);
  const more = useMemo(() => extraCategories(apiCategories, apps), [apiCategories, apps]);
  const skillHits = useMemo(() => (category === "All" || category === "recommended" ? matchingSkills(skills, debounced) : []), [skills, debounced, category]);
  const visibleInstalled = showAllInstalled ? installed : installed.slice(0, 6);
  const connectedCount = installed.length;

  async function install(item: CatalogApp) {
    setBusy(item.id);
    try {
      const created = await api<{ id?: string }>("/api/plugins/install", { method: "POST", body: JSON.stringify({ catalogId: item.id }) });
      const installId = created?.id ?? "";
      if (item.authType === "oauth" && installId) {
        const body = await api<{ url?: string }>(`/api/plugins/${installId}/oauth/start`, { method: "POST", body: "{}" });
        if (body.url) {
          window.location.assign(body.url);
          return;
        }
        toast.error("OAuth is not configured for this plugin.");
      } else if (item.authType === "api_key" && installId) {
        setKeyFor({ installId, catalogId: item.id });
        setApiKey("");
      } else {
        toast.success("Installed.");
      }
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not install that app."));
    } finally {
      setBusy(null);
    }
  }

  async function connectInstalled(row: InstalledApp) {
    setBusy(row.id);
    try {
      if (row.authType === "oauth") {
        const body = await api<{ url?: string }>(`/api/plugins/${row.id}/oauth/start`, { method: "POST", body: "{}" });
        if (!body.url) throw new Error("OAuth is not configured for this plugin.");
        window.location.assign(body.url);
        return;
      }
      setKeyFor({ installId: row.id, catalogId: row.catalogId });
      setApiKey("");
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not start the connection."));
    } finally {
      setBusy(null);
    }
  }

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    if (!keyFor) return;
    const value = apiKey.trim();
    if (!value) return;
    setBusy(keyFor.installId);
    try {
      await api(`/api/plugins/${keyFor.installId}/connect`, { method: "POST", body: JSON.stringify({ apiKey: value }) });
      toast.success("Credential stored in the vault.");
      setKeyFor(null);
      setApiKey("");
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not store that credential."));
    } finally {
      setBusy(null);
    }
  }

  async function addTemplate(bot: TemplateBot) {
    setBusy(bot.id);
    try {
      await api("/api/bots", {
        method: "POST",
        body: JSON.stringify({
          name: `${bot.name} copy`,
          role: bot.role,
          instructions: bot.instructions,
          avatarShape: bot.avatarShape,
          avatarColor: bot.avatarColor,
        }),
      });
      toast.success("Teammate created from that template.");
      window.dispatchEvent(new Event("teammates-bots-changed"));
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not create that teammate."));
    } finally {
      setBusy(null);
    }
  }

  const title = view === "manage" ? "Manage plugins and skills" : view === "templates" ? "Bot templates" : "Connect Apps";
  const empty = !loading && !error && sections.length === 0 && skillHits.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="plugins-modal" className="flex h-[75vh] max-h-[75vh] w-[min(520px,calc(100vw-2rem))] max-w-[520px] flex-col gap-0 overflow-hidden bg-background p-0 sm:max-w-[520px]">
        <div data-testid="connect-apps-scroll" className="min-h-0 flex-1 overflow-y-auto">
          {view === "browse" ? (
            <>
              <div className="flex items-center gap-3 px-4 pb-2 pr-12 pt-4">
                <DialogTitle>{title}</DialogTitle>
                <button
                  type="button"
                  data-testid="connect-manage"
                  className="ml-auto flex h-8 items-center gap-1.5 rounded-full border border-border bg-card px-2 text-meta font-medium shadow-[var(--shadow-pill)] transition-shadow duration-200 hover:shadow-[var(--shadow-pill-hover)]"
                  onClick={() => setView("manage")}
                >
                  <span className="flex items-center px-0.5">
                    {(installed.length ? installed : apps).slice(0, 3).map((app, index) => (
                      <AppLogo key={app.id} name={app.name} iconUrl={"iconUrl" in app ? app.iconUrl : ""} size={16} shape="circle" className={cn("ring-2 ring-card", index > 0 && "-ml-1.5")} />
                    ))}
                  </span>
                  <span className="tabular">{connectedCount} connected</span>
                  <ChevronRight className="size-3.5 text-muted-foreground" />
                </button>
              </div>
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-background px-4 py-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search across apps and skills"
                    aria-label="Search across apps and skills"
                    className="h-9 rounded-full border-border bg-muted pl-9"
                  />
                </div>
                <button
                  type="button"
                  data-testid="connect-templates"
                  className="flex h-9 shrink-0 items-center gap-1 rounded-full border border-border bg-card px-3 text-meta font-medium shadow-[var(--shadow-pill)]"
                  onClick={() => setView("templates")}
                >
                  Bot templates
                  <ExternalLink className="size-3.5" />
                </button>
              </div>
              <CategoryRow active={category} extras={more} onSelect={setCategory} />
            </>
          ) : (
            <div className="px-4 pb-2 pr-12 pt-4">
              <button type="button" data-testid="connect-back" className="mb-3 flex items-center gap-1 text-body-sm text-muted-foreground hover:text-foreground" onClick={() => setView("browse")}>
                <ChevronLeft className="size-4" /> Connect Apps
              </button>
              <DialogTitle>{title}</DialogTitle>
            </div>
          )}

          {loading ? (
            <div data-testid="connect-apps-loading" className="grid grid-cols-2 gap-2 px-3 py-2" aria-busy="true">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-14 rounded-lg" />
              ))}
            </div>
          ) : null}

          {error ? (
            <div data-testid="connect-apps-error" role="alert" className="mx-4 my-6 rounded-xl border border-border px-4 py-6 text-center">
              <p className="text-body-sm font-medium">Could not load apps</p>
              <p className="mt-1 text-body-sm text-muted-foreground">{error}</p>
              <button type="button" className="mt-3 rounded-full border border-border px-3 py-1 text-body-sm" onClick={() => void load()}>Retry</button>
            </div>
          ) : null}

          {!loading && !error && view === "browse" ? (
            <div className="flex flex-col gap-4 px-2 pb-4">
              {sections.map((section) => (
                <section key={section.title}>
                  <div className="flex items-center justify-between px-2 pb-1">
                    <h3 className="text-body-sm font-medium">{section.title}</h3>
                    <button
                      type="button"
                      data-testid="connect-view-all"
                      data-section={section.title}
                      className="text-meta text-muted-foreground hover:text-foreground"
                      onClick={() => setCategory(section.title === "Recommended for you" ? "recommended" : section.title)}
                    >
                      View all
                    </button>
                  </div>
                  <div className="grid w-full gap-x-1" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
                    {section.items.map((item) => (
                      <AppRow key={`${section.title}-${item.id}`} item={item} busy={busy === item.id} onAction={() => void install(item)} />
                    ))}
                  </div>
                </section>
              ))}
              {skillHits.length > 0 ? (
                <section>
                  <h3 className="px-2 pb-1 text-body-sm font-medium">Skills</h3>
                  <SkillList skills={skillHits} />
                </section>
              ) : null}
              {empty ? (
                <div data-testid="connect-apps-empty" className="px-4 py-10 text-center">
                  <p className="text-body-sm font-medium">{debounced ? "No matching apps or skills" : "Nothing in this category"}</p>
                  <p className="mt-1 text-body-sm text-muted-foreground">
                    {debounced ? `Nothing matches “${debounced}”.` : "The catalog has no apps in this category yet."}
                  </p>
                </div>
              ) : null}
              {keyFor ? <KeyForm value={apiKey} busy={busy === keyFor.installId} onChange={setApiKey} onSubmit={(event) => void saveKey(event)} /> : null}
            </div>
          ) : null}

          {!loading && !error && view === "manage" ? (
            <div className="flex flex-col gap-4 px-3 pb-6">
              <section>
                <h3 className="px-1 pb-1 text-body-sm font-medium">Installed</h3>
                {installed.length === 0 ? (
                  <p className="px-1 text-body-sm text-muted-foreground">No plugins installed yet.</p>
                ) : (
                  <div className="grid w-full gap-x-1" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
                    {visibleInstalled.map((row) => (
                      <div key={row.id} data-testid="connect-installed" className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent">
                        <AppLogo name={row.name} iconUrl={row.iconUrl} size={36} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body-sm font-medium">{row.name}</span>
                          <span className="block truncate text-meta text-muted-foreground">{connectorLine(row.toolCount)}</span>
                        </span>
                        {isConnected(row) ? (
                          <span className="shrink-0 text-meta font-medium text-success">Connected</span>
                        ) : (
                          <button type="button" className="shrink-0 rounded-full bg-secondary px-2.5 py-1 text-meta font-medium" disabled={busy === row.id} onClick={() => void connectInstalled(row)}>
                            Connect
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {installed.length > 6 && !showAllInstalled ? (
                  <button type="button" data-testid="connect-show-all" className="mt-1 px-1 text-meta text-muted-foreground hover:text-foreground" onClick={() => setShowAllInstalled(true)}>
                    Show all {installed.length} plugins
                  </button>
                ) : null}
              </section>
              <section>
                <h3 className="px-1 pb-1 text-body-sm font-medium">Private skills</h3>
                {skillsError ? <p className="px-1 text-body-sm text-destructive">{skillsError}</p> : null}
                {skills.length === 0 && !skillsError ? <p className="px-1 text-body-sm text-muted-foreground">No private skills yet.</p> : null}
                <SkillList skills={skills} />
              </section>
              {keyFor ? <KeyForm value={apiKey} busy={busy === keyFor.installId} onChange={setApiKey} onSubmit={(event) => void saveKey(event)} /> : null}
            </div>
          ) : null}

          {!loading && !error && view === "templates" ? (
            <div className="grid w-full gap-x-1 px-2 pb-6" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
              {templates.length === 0 ? <p className="col-span-2 px-2 text-body-sm text-muted-foreground">No teammates to use as templates yet.</p> : null}
              {templates.map((bot) => (
                <div key={bot.id} data-testid="connect-template" className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent">
                  <AppLogo name={bot.name} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-sm font-medium">{bot.name}</span>
                    <span className="block truncate text-meta text-muted-foreground">{bot.role || "Teammate template"}</span>
                  </span>
                  <button type="button" className="shrink-0 rounded-full bg-secondary px-3 py-1 text-meta font-medium" disabled={busy === bot.id} onClick={() => void addTemplate(bot)}>
                    Add
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AppRow({ item, busy, onAction }: { item: CatalogApp; busy: boolean; onAction: () => void }) {
  const label = actionLabel(item.authType);
  return (
    <div data-testid="connect-app" data-category={item.category} className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 transition-colors duration-200 hover:bg-accent">
      <AppLogo name={item.name} iconUrl={item.iconUrl} size={36} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm font-medium">{item.name}</span>
        <span className="block truncate text-meta text-muted-foreground">{item.description || item.kind || "App"}</span>
      </span>
      <button
        type="button"
        data-testid="connect-action"
        className="ml-auto shrink-0 rounded-full bg-secondary px-3 py-1 text-meta font-medium disabled:opacity-60"
        disabled={busy || item.blocked}
        onClick={onAction}
      >
        {item.blocked ? "Blocked" : busy ? "…" : label}
      </button>
    </div>
  );
}

function SkillList({ skills }: { skills: PrivateSkill[] }) {
  return (
    <ul className="flex flex-col">
      {skills.map((skill) => (
        <li key={skill.id} data-testid="connect-skill" className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent">
          <span className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Plus className="size-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-body-sm font-medium">{skill.name}</span>
            <span className="block truncate text-meta text-muted-foreground">Created locally{skill.description ? ` · ${skill.description}` : ""}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function KeyForm({ value, busy, onChange, onSubmit }: { value: string; busy: boolean; onChange: (value: string) => void; onSubmit: (event: FormEvent) => void }) {
  return (
    <form className="mx-2 flex gap-2" onSubmit={onSubmit}>
      <Input value={value} onChange={(event) => onChange(event.target.value)} type="password" autoComplete="off" aria-label="API key" placeholder="API key" className="h-9" />
      <button type="submit" className="rounded-full bg-secondary px-3 text-meta font-medium" disabled={busy || !value.trim()}>Save</button>
    </form>
  );
}
