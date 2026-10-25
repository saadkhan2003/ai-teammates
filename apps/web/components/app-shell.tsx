"use client";

import { Bell, ChevronRight, CircleHelp, CreditCard, Info, Menu, MoreHorizontal, PanelLeft, PanelLeftClose, Plus, Search, Settings, Upload, User, Users, X } from "lucide-react";
import { initPerf } from "@/lib/perf";
import { ListSkeleton } from "@/components/ui/skeleton";
import { Plug } from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AvatarClock } from "@/components/avatar-motion/avatar-clock";
import { HeroAvatar } from "@/components/avatar-motion/hero-avatar";
import { MotionAvatar } from "@/components/avatar-motion/motion-avatar";
import { BotAvatar } from "@/components/bot-avatar";
import { BotAvatarPicker } from "@/components/bot-avatar-picker";
import { RefreshNotice } from "@/components/refresh-notice";
import { REFRESH_EVENT, wireConnectionEvents } from "@/lib/connection";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AppLogo } from "@/components/app-logo";
import { ConnectAppsDialog } from "@/components/connect-apps-modal";
import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, asList } from "@/lib/api";
import { appHue, catalogOrFallback, readCatalogApps, recommendedApps } from "@/lib/connect-apps";
import { subscribeEvents } from "@/lib/events";
import { saveTheme, type ThemeMode } from "@/lib/theme";
import { cn, errorMessage } from "@/lib/utils";
import { matchShortcut } from "@/lib/shortcuts";
import { defaultBotAvatar } from "@/lib/avatars";
import { useBotAppearance } from "@/lib/bot-appearance";
import type { AppLink } from "@/lib/app-links";



import { patchRoster } from "@/lib/event-patches";
import { parseAgentEvent, streamIsOpen } from "@/lib/events";



import { applyAccent } from "@/lib/accent";
import { get as getPrefetch, put as putPrefetch } from "@/lib/prefetch-cache.mjs";

const AppCommandPalette = dynamic(() => import("@/components/app-command-palette").then(module => module.AppCommandPalette), { ssr: false });
const PluginsPane = dynamic(() => import("@/components/plugins-pane").then((module) => module.PluginsPane));

function useOpened(open: boolean) {
  const [opened, setOpened] = useState(open);
  useEffect(() => { if (open) setOpened(true); }, [open]);
  return open || opened;
}

type RosterBot = {
  id: string;
  name: string;
  role: string;
  section: string;
  status: string;
  avatar: string;
  avatarShape: string;
  avatarColor: string;
  isPrimary: boolean;
  bio: string;
  attention: boolean;
};

type ConnectedApp = { id: string; name: string; iconUrl: string };

type Note = { id: string; title: string; body: string; readAt?: string | null };

function readBots(data: unknown): RosterBot[] {
  return asList(data, ["bots", "items"])
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        id: String(record.id ?? ""),
        name: String(record.name ?? "Bot"),
        role: String(record.role ?? ""),
        section: String(record.section ?? "Teammates"),
        status: String(record.status ?? "idle"),
        avatar: String(record.avatar ?? ""),
        avatarShape: String(record.avatarShape ?? ""),
        avatarColor: String(record.avatarColor ?? ""),
        isPrimary: record.isPrimary === true,
        bio: String(record.bio ?? ""),
        attention: record.attention === true,
      };
    })
    .filter((bot) => bot.id);
}

function AccountAvatar({ name, url }: { name: string; url: string }) {
  const [failed, setFailed] = useState(false);
  const letter = name.trim().charAt(0).toUpperCase() || "A";
  if (url && !failed) {
    return <img src={url} alt="" width={32} height={32} data-testid="account-avatar" className="size-8 shrink-0 rounded-full object-cover" onError={() => setFailed(true)} />;
  }
  return (
    <span
      data-testid="account-avatar"
      className="grid size-8 shrink-0 place-items-center rounded-full text-meta font-medium text-white"
      style={{ background: `linear-gradient(145deg, hsl(${appHue(name)} 42% 46%), hsl(${(appHue(name) + 24) % 360} 36% 32%))` }}
    >
      {letter}
    </span>
  );
}

function readApps(data: unknown): ConnectedApp[] {
  return asList(data, ["plugins", "items"])
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const icon = record.iconUrl ?? record.icon_url ?? record.icon ?? "";
      return { id: String(record.id ?? ""), name: String(record.name ?? "App"), iconUrl: typeof icon === "string" ? icon : "" };
    })
    .filter((app) => app.id);
}

function RosterLook({ bot, size, hero = false }: { bot: RosterBot; size: number; hero?: boolean }) {
  const look = useBotAppearance(bot.id, bot.avatarShape, bot.avatarColor);
  if (hero) return <HeroAvatar botId={bot.id} name={bot.name} shape={look.shape} color={look.color} size={size} />;
  return <MotionAvatar slot={bot.id} variant="row" botId={bot.id} shape={look.shape} color={look.color} size={size} label={bot.name} />;
}

function statusDotClass(status: string, attention: boolean) {
  const value = status.toLowerCase();
  if (["failed", "error", "offline"].includes(value)) return "bg-destructive";
  if (attention || ["running", "working", "planning", "queued", "busy"].includes(value)) return "bg-brand";
  return "bg-success";
}

export function AppShell({ children }: { children: ReactNode }) {
  useEffect(() => { initPerf(); }, []);
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    const match = pathname.match(/^\/bots\/([^/]+)/);
    if (!match) return;
    try { window.localStorage.setItem("teammates-last-bot", match[1]); } catch { /* storage unavailable */ }
  }, [pathname]);
  const authPage = pathname === "/login" || pathname === "/invite";
  const [bots, setBots] = useState<RosterBot[]>([]);
  const [botsLoaded, setBotsLoaded] = useState(false);
  const [username, setUsername] = useState("Account");
  const [displayName, setDisplayName] = useState("Account");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [suggested, setSuggested] = useState(() => recommendedApps(catalogOrFallback([])).slice(0, 3));
  const rosterScrollTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [palette, setPalette] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const createMounted = useOpened(createOpen);
  const [notes, setNotes] = useState<Note[]>([]);
  const [streamState, setStreamState] = useState("reconnecting");
  const [streamId, setStreamId] = useState("");
  const [pendingDelete, setPendingDelete] = useState<RosterBot | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutsMounted = useOpened(shortcutsOpen);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const feedbackMounted = useOpened(feedbackOpen);
  const [quickSwitch, setQuickSwitch] = useState(false);

  const load = useCallback(async () => {
    try {
      const [botData, me, noteData, pluginData, catalogData] = await Promise.all([
        api<unknown>("/api/bots"),
        api<{ username?: string; displayName?: string; avatarUrl?: string }>("/api/auth/me").catch(() => ({ username: "Account", displayName: "Account", avatarUrl: "" })),
        api<unknown>("/api/notifications").catch(() => []),
        api<unknown>("/api/plugins").catch(() => []),
        api<unknown>("/api/plugins/catalog").catch(() => ({ items: [] })),
      ]);
      setBots(readBots(botData));
      const name = me.displayName || me.username || "Account";
      setUsername(me.username || name);
      setDisplayName(name);
      setAvatarUrl(typeof me.avatarUrl === "string" ? me.avatarUrl : "");
      setApps(readApps(pluginData));
      setSuggested(recommendedApps(catalogOrFallback(readCatalogApps(catalogData).items)).slice(0, 3));
      setBotsLoaded(true);
      setUsername(me.username || "Account");
      setNotes(
        asList(noteData, ["items", "notifications"]).map((entry) => {
          const record = (entry ?? {}) as Record<string, unknown>;
          return {
            id: String(record.id ?? ""),
            title: String(record.title ?? ""),
            body: String(record.body ?? ""),
            readAt: typeof record.readAt === "string" ? record.readAt : null,
          };
        }),
      );
    } catch {
      // Keep the last good roster; the "Couldn't refresh" notice offers a retry.
      setBotsLoaded(true);
    }
  }, []);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem("teammates-rail") === "icons");
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const apply = () => setMobile(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (authPage) return;
    wireConnectionEvents();
    void load();
    const timer = window.setInterval(() => { if (!streamIsOpen()) void load(); }, 15_000);
    const refresh = () => void load();
    const openCreate = () => setCreateOpen(true);
    window.addEventListener("teammates-bots-changed", refresh);
    window.addEventListener("teammates-profile-changed", refresh);
    window.addEventListener(REFRESH_EVENT, refresh);
    window.addEventListener("teammates-open-create", openCreate);
    const stopEvents = subscribeEvents(
      data => {
        const event = parseAgentEvent(data);
        if (!event) return;
        if (event.type === "notification.created" && event.notification) { setNotes(current => [event.notification as Note, ...current.filter(note => note.id !== (event.notification as Note).id)]); return; }
        if (["stream.gap", "invalidate", "bots"].includes(event.type) || (!event.bot && !event.taskId && !event.botId)) { void load(); return; }
        setBots(current => patchRoster(current, event) ?? current);
      },
      (status) => {
        setStreamState(status.state);
        setStreamId(status.lastId);
      },
    );
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
    return () => {
      window.clearInterval(timer);
      stopEvents();
      window.removeEventListener("teammates-bots-changed", refresh);
      window.removeEventListener("teammates-profile-changed", refresh);
      window.removeEventListener(REFRESH_EVENT, refresh);
      window.removeEventListener("teammates-open-create", openCreate);
    };
  }, [load, authPage]);

  useEffect(() => {
    const onLink = (event: Event) => {
      const detail = (event as CustomEvent<AppLink>).detail;
      if (!detail || detail.kind !== "settings") return;
      router.push(`${detail.href}?id=${encodeURIComponent(detail.id)}`);
    };
    window.addEventListener("teammates-app-link", onLink);
    return () => window.removeEventListener("teammates-app-link", onLink);
  }, [router]);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const viewport = window.visualViewport;
      if (!viewport) {
        root.style.setProperty("--app-height", "100dvh");
        root.style.setProperty("--app-top", "0px");
        return;
      }
      root.style.setProperty("--app-height", `${viewport.height}px`);
      root.style.setProperty("--app-top", `${viewport.offsetTop}px`);
    };
    apply();
    window.visualViewport?.addEventListener("resize", apply);
    window.visualViewport?.addEventListener("scroll", apply);
    return () => {
      window.visualViewport?.removeEventListener("resize", apply);
      window.visualViewport?.removeEventListener("scroll", apply);
    };
  }, []);

  useEffect(() => {
    const section = new URLSearchParams(window.location.search).get("settings");
    if (section) {
      const route = ({ general: "/settings", computer: "/settings/computer", vault: "/settings/secrets", usage: "/settings/usage", updates: "/settings/updates" } as Record<string, string>)[section];
      if (route) router.replace(route);
    }
  }, [router]);

  useEffect(() => {
    const open = () => setPluginsOpen(true);
    window.addEventListener("teammates-open-connect-apps", open);
    return () => window.removeEventListener("teammates-open-connect-apps", open);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && !event.ctrlKey && !event.metaKey && !event.altKey) return;
      const action = matchShortcut(event);
      if (!action) return;
      event.preventDefault();
      if (action === "search") setPalette(true);
      if (action === "new-bot") setCreateOpen(true);
      if (action === "go-bot") { const index = Number(event.key) - 1; if (bots[index]) router.push(`/bots/${bots[index].id}`); }
      if (action === "compact") toggleRail();
      if (action === "settings") router.push("/settings");
      if (action === "shortcuts") setShortcutsOpen(true);
      if (action === "switch-bots") setQuickSwitch(true);
      if (action === "back") router.back(); if (action === "forward") router.forward();
      if (action === "connect") setPluginsOpen(true);
      if (action === "focus-chat") document.querySelector<HTMLElement>("[data-testid='composer']")?.focus();
      if (action === "selection") { event.preventDefault(); window.dispatchEvent(new Event("teammates-add-selection")); }
      if (action === "previous-bot" || action === "next-bot") { const index = bots.findIndex(bot => bot.id === activeBot?.id); const next = (index + (action === "next-bot" ? 1 : -1) + bots.length) % bots.length; if (bots[next]) router.push(`/bots/${bots[next].id}`); }
      if (action === "zoom-in" || action === "zoom-out" || action === "zoom-reset") { const value = action === "zoom-reset" ? 1 : Math.max(.75, Math.min(1.5, Number(localStorage.getItem("teammates-zoom") || 1) + (action === "zoom-in" ? .1 : -.1))); localStorage.setItem("teammates-zoom", String(value)); document.documentElement.style.zoom = String(value); }
      if (action === "fullscreen") { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); }
      if (action === "dictate") { const Speech = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition; if (!Speech) toast.error("Speech recognition is not supported in this browser."); else { const recognition = new Speech(); recognition.onresult = (result: any) => { const composer = document.querySelector<HTMLTextAreaElement>("[data-testid='composer']"); if (composer) { composer.value += result.results[0][0].transcript; composer.dispatchEvent(new Event("input", { bubbles: true })); } }; recognition.start(); } }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, bots, pathname]);

  const groups = useMemo(() => {
    const map = new Map<string, RosterBot[]>();
    for (const bot of bots) {
      const section = bot.section || "Teammates";
      map.set(section, [...(map.get(section) ?? []), bot]);
    }
    return [...map.entries()];
  }, [bots]);

  const unread = notes.filter((note) => !note.readAt).length;
  const warmingWorkspaces = useRef(new Set<string>());


  const warmBotWorkspace = useCallback((botId: string) => {
    const key = `/api/bots/${botId}/workspace`;
    if (getPrefetch(key) !== undefined || warmingWorkspaces.current.has(key)) return;
    warmingWorkspaces.current.add(key);
    void api<unknown>(key)
      .then((value) => putPrefetch(key, value))
      .catch(() => {})
      .finally(() => warmingWorkspaces.current.delete(key));
  }, []);
  const activeBot = bots.find((bot) => pathname === `/bots/${bot.id}`);
  const accentColor = activeBot ? (activeBot.avatarColor || defaultBotAvatar(activeBot.id).color) : null;
  useEffect(() => {
    const apply = () => applyAccent(accentColor, document.documentElement.classList.contains("light") ? "light" : "dark");
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [accentColor]);

  if (pathname === "/login" || pathname === "/invite" || pathname === "/login/reset" || pathname === "/offline" || pathname === "/status") return <>{children}</>;

  function go(href: string) {
    setPalette(false);
    setOpen(false);
    router.push(href);
  }

  async function markRead() {
    try {
      await api("/api/notifications/read", { method: "POST" });
      setNotes((current) => current.map((note) => ({ ...note, readAt: note.readAt ?? new Date().toISOString() })));
    } catch {
      toast.error("Could not mark notifications read.");
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api(`/api/bots/${pendingDelete.id}`, { method: "DELETE" });
      toast.success(`Deleted ${pendingDelete.name}.`);
      if (pathname === `/bots/${pendingDelete.id}`) router.push("/");
      setPendingDelete(null);
      window.dispatchEvent(new Event("teammates-bots-changed"));
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not delete that teammate."));
    } finally {
      setDeleting(false);
    }
  }

  const compact = collapsed && !mobile;

  const accountName = displayName || username;

  function onRosterScroll(event: UIEvent<HTMLElement>) {
    const node = event.currentTarget;
    node.dataset.scrolling = "true";
    if (rosterScrollTimer.current) window.clearTimeout(rosterScrollTimer.current);
    rosterScrollTimer.current = window.setTimeout(() => {
      delete node.dataset.scrolling;
    }, 700);
  }

  function toggleRail() {
    setCollapsed((value) => {
      const next = !value;
      window.localStorage.setItem("teammates-rail", next ? "icons" : "list");
      return next;
    });
  }

  const roster = (
    <div data-radius-allow="pane" className="flex h-full w-full min-w-0 max-w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className={cn("flex gap-1.5 px-2 pb-2 pt-3", compact ? "flex-col items-center" : "items-center")}>
        <Button variant="outline" size="icon" className="h-9 w-9 rounded-full border-border bg-card text-card-foreground shadow-sm" aria-label="Search" onClick={() => setPalette(true)}>
          <Search />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button data-testid="new-bot" variant="outline" size="icon" className="h-9 w-9 rounded-full border-border bg-card text-card-foreground shadow-sm" aria-label="New">
              <Plus />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent data-testid="plus-menu" align="start">
            <DropdownMenuItem
              onSelect={() => {
                setOpen(false);
                setCreateOpen(true);
              }}
            >
              New teammate
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                setOpen(false);
                router.push("/settings");
              }}
            >
              Open settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" data-testid="notifications" aria-label="Notifications" className="relative h-9 w-9 rounded-full border-border bg-card text-card-foreground shadow-sm">
              <Bell />
              {unread > 0 ? <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-brand" /> : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <div className="flex items-center justify-between px-2 py-1.5">
              <p className="text-meta font-medium">Notifications</p>
              <button type="button" className="text-meta text-muted-foreground" onClick={() => void markRead()}>
                Mark read
              </button>
            </div>
            {notes.length === 0 ? <p className="px-2 py-2 text-meta text-muted-foreground">Nothing waiting.</p> : null}
            {notes.map((note) => (
              <DropdownMenuItem key={note.id} className="flex flex-col items-start gap-0.5">
                <span className="text-body-sm">{note.title}</span>
                {note.body ? <span className="text-meta text-muted-foreground">{note.body}</span> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {mobile ? null : (
          <Button
            data-testid="rail-toggle"
            variant="outline"
            size="icon"
            className="h-9 w-9 rounded-full border-border bg-card text-card-foreground shadow-sm"
            aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleRail}
          >
            {compact ? <PanelLeft /> : <PanelLeftClose />}
          </Button>
        )}
      </div>
      {compact ? null : <RefreshNotice variant="sidebar" />}
      {compact || !activeBot ? null : (
        <div data-testid="selected-bot-tile" className="flex flex-col items-center px-3 pb-3 text-center">
          <span className="relative grid h-[60px] w-[60px] place-items-center rounded-avatar bg-accent">
            <RosterLook bot={activeBot} size={48} hero />
            <span className={cn("absolute bottom-1 right-1 size-2.5 rounded-full border border-sidebar", statusDotClass(activeBot.status, activeBot.attention))} />
          </span>
          {activeBot.bio ? <p data-testid="sidebar-bio">{activeBot.bio}</p> : null}
          <span className="mt-2 max-w-full truncate text-meta font-medium uppercase tracking-wide">{activeBot.name}</span>
          <span className="max-w-full truncate text-meta text-muted-foreground">{activeBot.role || activeBot.status}</span>
        </div>
      )}
      <nav className="sidebar-scroll min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5 pb-3" onScroll={onRosterScroll}>
        {groups.length === 0 ? (
          compact ? (
            <button type="button" className="mx-auto grid size-11 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="No teammates yet. Create one." onClick={() => window.dispatchEvent(new Event("teammates-open-create"))}>
              <Users className="size-4" />
            </button>
          ) : (
            <div data-testid="roster-empty" className="mx-2 mt-3 rounded-card border border-sidebar-border bg-card px-3 py-4 text-center text-card-foreground shadow-[var(--shadow-card)]">
              <span className="mx-auto grid size-10 place-items-center rounded-full bg-accent text-muted-foreground">
                <Users className="size-4" aria-hidden="true" />
              </span>
              <p className="mt-2 text-body-sm font-medium">No teammates yet</p>
              <p className="mt-1 text-meta leading-4 text-muted-foreground">Create one to start a conversation.</p>
              <Button type="button" className="mt-3 h-11 rounded-full px-4" onClick={() => window.dispatchEvent(new Event("teammates-open-create"))}>
                New teammate
              </Button>
            </div>
          )
        ) : null}
        {groups.map(([section, items]) => (
          <Collapsible key={section} defaultOpen className="motion-fade">
            {compact ? null : (
              <CollapsibleTrigger className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-micro font-medium uppercase tracking-wide text-muted-foreground hover:bg-sidebar-accent [&[data-state=open]>svg]:rotate-90">
                <ChevronRight className="h-3 w-3 transition-transform" />
                {section}
              </CollapsibleTrigger>
            )}
            <CollapsibleContent>
              <ul className="space-y-0.5">
                {items.map((bot) => {
                  const active = pathname === `/bots/${bot.id}`;
                  return (
                    <li key={bot.id} className="group relative">
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <Link
                            href={`/bots/${bot.id}`}
                            prefetch
                            onMouseEnter={() => warmBotWorkspace(bot.id)}
                            onFocus={() => warmBotWorkspace(bot.id)}
                            onClick={() => setOpen(false)}
                            aria-current={active ? "page" : undefined}
                            title={bot.name}
                            className={cn(
                              "avatar-motion-row flex items-center gap-2 rounded-control px-2 py-2 text-body-sm hover:bg-accent",
                              active && "bg-accent",
                              compact ? "justify-center px-1" : "pr-8",
                            )}
                          >
                            <span className="relative shrink-0">
                              <RosterLook bot={bot} size={32} />
                              <span
                                data-testid="bot-status-dot"
                                data-status={bot.attention ? "attention" : bot.status}
                                className={cn("absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border border-sidebar", statusDotClass(bot.status, bot.attention))}
                              />
                            </span>
                            <span className={cn("min-w-0 flex-1", compact && "sr-only")}>
                              <span className="block truncate font-medium">{bot.name}</span>
                              {bot.role ? <span className="block truncate text-meta text-muted-foreground">{bot.role}</span> : null}
                            </span>
                            {bot.attention && !compact ? (
                              <Badge aria-label="Unread" className="h-5 min-w-5 justify-center px-1">
                                1
                              </Badge>
                            ) : null}
                          </Link>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            onSelect={() => {
                              setOpen(false);
                              router.push(`/bots/${bot.id}`);
                            }}
                          >
                            Open
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => setPendingDelete(bot)}>Delete</ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                      {compact ? null : (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              data-testid="bot-row-menu"
                              aria-label={`More actions for ${bot.name}`}
                              className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground opacity-0 hover:bg-background focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="right" align="start">
                            <DropdownMenuItem
                              onSelect={() => {
                                setOpen(false);
                                router.push(`/bots/${bot.id}`);
                              }}
                            >
                              Open
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setPendingDelete(bot)}>Delete</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </li>
                  );
                })}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </nav>
      <div data-testid="sidebar-footer" className={cn("group/footer flex w-full min-w-0 items-center gap-2 overflow-visible bg-sidebar px-2.5 py-2", compact && "flex-col")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="account-button"
              title={accountName}
              className={cn(
                "flex h-11 min-w-0 items-center gap-2 overflow-hidden rounded-full border border-border bg-card text-card-foreground shadow-[var(--shadow-pill)] transition-[box-shadow] duration-200 hover:shadow-[var(--shadow-pill-hover)]",
                compact ? "size-11 shrink-0 justify-center px-0" : "basis-0 flex-1 pl-1 pr-2.5",
              )}
            >
              <AccountAvatar name={accountName} url={avatarUrl} />
              <span data-testid="account-name" className={cn("min-w-0 truncate text-left text-body", compact && "sr-only")}>{accountName}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64" data-testid="account-menu">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Weekly usage <span className="ml-auto text-meta text-muted-foreground">7% used</span></DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">
                <div className="px-2 py-2"><p className="text-body-sm font-medium">Weekly usage</p><p className="text-meta text-muted-foreground">Resets in 7 days</p><p className="mt-2 text-h1">7% <span className="text-meta text-muted-foreground">used</span></p></div>
                <DropdownMenuItem onSelect={() => go("/settings/usage")}>Manage usage</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem data-testid="menu-account" onSelect={() => go("/account")}><User /> Account</DropdownMenuItem>
            <DropdownMenuItem data-testid="menu-billing" onSelect={() => go("/account/billing")}><CreditCard /> Billing</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => go("/settings/computer")}><Upload /> Get app</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><CircleHelp /> Support</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={() => go("/account/help")}><CircleHelp /> Help Center</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setShortcutsOpen(true)}>⌨ Keyboard shortcuts</DropdownMenuItem>
                <DropdownMenuItem data-testid="send-feedback" onSelect={() => setFeedbackOpen(true)}>✉ Send Feedback</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setAboutOpen(true)}><Info /> About</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onSelect={() => go("/settings")}><Settings /> Settings</DropdownMenuItem>
            <DropdownMenuItem disabled title="Single-owner build">＋ Add account</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void api("/api/auth/logout", { method: "POST" }).then(() => router.push("/login"))}>Log out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          data-testid="open-plugins"
          aria-label="Connect apps"
          title={apps.length ? apps.map((app) => app.name).join(", ") : "Connect apps"}
          className={cn(
            "flex h-11 shrink-0 items-center overflow-visible rounded-full border border-border bg-card text-card-foreground shadow-[var(--shadow-pill)] transition-[box-shadow] duration-200 hover:shadow-[var(--shadow-pill-hover)]",
            compact ? "size-11 justify-center px-0" : "px-3",
          )}
          onClick={() => {
            setPluginsOpen(true);
            setOpen(false);
          }}
        >
          {apps.length === 0 ? (
            <span data-testid="apps-pill-empty" className="flex items-center overflow-visible">
              {suggested.slice(0, 3).map((app, index) => (
                <AppLogo key={app.id} name={app.name} iconUrl={app.iconUrl} size={20} shape="circle" className={cn("ring-2 ring-card", index > 0 && "-ml-0.5")} />
              ))}
              <span data-testid="apps-pill-plus" className="relative -ml-0.5 grid size-5 place-items-center overflow-visible rounded-full bg-muted text-micro font-medium text-foreground ring-2 ring-card">+</span>
            </span>
          ) : (
            <span data-testid="apps-pill-connected" className="flex items-center overflow-visible">
              {apps.slice(0, 3).map((app, index) => (
                <AppLogo key={app.id} name={app.name} iconUrl={app.iconUrl} size={20} shape="circle" className={cn("ring-2 ring-card", index > 0 && "-ml-0.5")} />
              ))}
              {apps.length > 3 ? (
                <span data-testid="apps-pill-count" className="relative -ml-0.5 grid size-5 place-items-center overflow-visible rounded-full bg-muted text-micro font-medium text-foreground ring-2 ring-card">+{apps.length - 3}</span>
              ) : null}
            </span>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <AvatarClock />
      <div
        data-testid="app-shell"
        className="flex min-h-0 bg-background pt-[env(safe-area-inset-top)] text-foreground"
        style={{ height: "var(--app-height, 100dvh)", marginTop: "var(--app-top, 0px)" }}
      >
        {mobile ? (
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent side="left" data-testid="sidebar" className="w-[280px] p-0 sm:max-w-[280px] [&>button]:hidden">
              <SheetTitle className="sr-only">Teammates</SheetTitle>
              {roster}
            </SheetContent>
          </Sheet>
        ) : (
          <aside
            data-testid="sidebar"
            data-rail={compact ? "icons" : "list"}
            data-divider="sidebar"
            className={cn("hidden shrink-0 overflow-x-hidden border-r border-border md:flex", compact ? "w-16" : "w-[280px] min-w-0")}
          >
            {roster}
          </aside>
        )}
        <span data-testid="event-stream" data-state={streamState} data-last-id={streamId} className="sr-only" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 items-center border-b border-border px-1 md:hidden">
            <Button
              data-testid="sidebar-toggle"
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11"
              aria-label="Open teammates"
              onClick={() => setOpen(true)}
            >
              <Menu />
            </Button>
          </div>
          <div className="min-h-0 flex-1">{children}</div>
        </div>
        <ConnectAppsDialog open={pluginsOpen} onOpenChange={setPluginsOpen} />
        <Dialog open={palette} onOpenChange={setPalette}>
          <DialogContent data-testid="command-palette" className="overflow-hidden rounded-[16px] p-0 shadow-[var(--shadow-card)] sm:max-w-lg">
            <DialogTitle className="sr-only">Command palette</DialogTitle>
            <Command>
              <CommandInput placeholder="Jump to a teammate or run a command" />
              <CommandList>
                <CommandEmpty>No matches.</CommandEmpty>
                <CommandGroup heading="Teammates">
                  {bots.map((bot) => (
                    <CommandItem key={bot.id} value={`${bot.name} ${bot.role}`} onSelect={() => go(`/bots/${bot.id}`)}>
                      <BotAvatar botId={bot.id} shape={bot.avatarShape} color={bot.avatarColor} size={24} />{bot.name}
                      <span className="ml-2 truncate text-meta text-muted-foreground">{bot.role}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandGroup heading="Actions">
                  <CommandItem onSelect={() => go("/settings")}>Open settings</CommandItem>
                  <CommandItem
                    onSelect={() => {
                      setPalette(false);
                      setCreateOpen(true);
                    }}
                  >
                    New teammate
                  </CommandItem>
                  {(["dark", "light", "system"] as ThemeMode[]).map((mode) => (
                    <CommandItem
                      key={mode}
                      onSelect={() => {
                        void saveTheme(mode).catch(() => undefined);
                        setPalette(false);
                        toast.success(`Theme set to ${mode}.`);
                      }}
                    >
                      Theme {mode}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </DialogContent>
        </Dialog>
        <CreateTeammateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={() => {
            void load();
          }}
        />
        <Dialog open={pendingDelete != null} onOpenChange={(next) => !next && setPendingDelete(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {pendingDelete?.name}?</DialogTitle>
              <DialogDescription>This removes the teammate and their conversation. The shared computer stays.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
          <DialogContent className="sm:max-w-sm text-center" data-testid="about-dialog">
            <DialogHeader><div className="mx-auto grid h-16 w-16 place-items-center rounded-xl bg-brand text-display text-background">✦</div><DialogTitle className="text-h1">AI Teammates</DialogTitle><DialogDescription>Version {process.env.NEXT_PUBLIC_APP_VERSION || "0.4.0"}<br />Built {process.env.NEXT_PUBLIC_BUILD_DATE || "2026"}<br />Copyright © 2026 AI Teammates</DialogDescription></DialogHeader>
            <Button variant="outline" data-testid="copy-version-info" onClick={() => { void navigator.clipboard?.writeText("AI Teammates 0.4.0"); toast.success("Version info copied."); }}>Copy version info</Button>
          </DialogContent>
        </Dialog>
        {shortcutsMounted ? <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} /> : null}
        {feedbackMounted ? <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} /> : null}
        <Dialog open={quickSwitch} onOpenChange={setQuickSwitch}><DialogContent data-testid="quick-switcher"><DialogHeader><DialogTitle>Switch teammate</DialogTitle></DialogHeader><div className="grid gap-1">{bots.map(bot => <Button key={bot.id} variant="ghost" className="justify-start" onClick={() => { router.push(`/bots/${bot.id}`); setQuickSwitch(false); }}><BotAvatar botId={bot.id} shape={bot.avatarShape} color={bot.avatarColor} size={26} />{bot.name}</Button>)}</div></DialogContent></Dialog>
      </div>
    </TooltipProvider>
  );
}

function CreateTeammateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [avatarShape, setAvatarShape] = useState("blob3");
  const [avatarColor, setAvatarColor] = useState("#ff3045");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function createBot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setFormError("Give your teammate a name");
      document.getElementById("bot-name")?.focus();
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      await api("/api/bots", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), role: role.trim(), instructions: instructions.trim(), avatarShape, avatarColor }),
      });
      setName("");
      setRole("");
      setInstructions("");
      setAvatarShape("blob3");
      setAvatarColor("#ff3045");
      onOpenChange(false);
      toast.success(`Created ${name}.`);
      window.dispatchEvent(new Event("teammates-bots-changed"));
      onCreated();
    } catch (caught) {
      setFormError(errorMessage(caught, "Could not create that teammate."));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle data-testid="create-bot-title">Create New Bot</DialogTitle>
          <DialogDescription className="sr-only">Choose an avatar and name your bot. Role and instructions are optional.</DialogDescription>
        </DialogHeader>
        <form data-testid="create-bot-form" className="flex max-h-[80vh] flex-col gap-3 overflow-y-auto" onSubmit={createBot} noValidate>
          <BotAvatarPicker shape={avatarShape} color={avatarColor} onChange={(shape, color) => { setAvatarShape(shape); setAvatarColor(color); }} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-name">Name your Bot</Label>
            <Input id="bot-name" data-testid="bot-name" placeholder="Name your Bot" value={name} onChange={(event) => { setName(event.target.value); setFormError(null); }} aria-invalid={!!formError && !name.trim()} aria-describedby="bot-name-help bot-form-error" />
            <p id="bot-name-help" className="text-meta text-muted-foreground">Required. What should we call your teammate?</p>
          </div>
          <Collapsible>
          <CollapsibleTrigger type="button" data-testid="bot-advanced-toggle" className="text-body-sm text-muted-foreground underline">Advanced (optional)</CollapsibleTrigger>
          <CollapsibleContent className="mt-3 grid gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-role" className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-micro text-primary-foreground">B</span>
              Title
            </Label>
            <Input id="bot-role" data-testid="bot-role" value={role} onChange={(event) => setRole(event.target.value)} aria-describedby="bot-role-help" />
            <p id="bot-role-help" className="text-meta text-muted-foreground">Optional. Defaults to Teammate.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-instructions" className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-micro text-primary-foreground">C</span>
              Instructions
            </Label>
            <Textarea
              id="bot-instructions"
              data-testid="bot-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              aria-describedby="bot-instructions-help"
            />
          </div>
          <p id="bot-instructions-help" className="text-meta text-muted-foreground">Optional. Describe their work, preferences, or goals.</p>
          </CollapsibleContent>
          </Collapsible>
          {formError ? (
            <p id="bot-form-error" role="alert" className="text-body-sm text-destructive">
              {formError}
            </p>
          ) : null}
          <DialogFooter><Button type="button" variant="outline" data-testid="bot-cancel" onClick={() => onOpenChange(false)}>Cancel</Button><Button data-testid="bot-create" type="submit" disabled={creating || !name.trim()}>
            {creating ? "Creating…" : "Create"}
          </Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const shortcutGroups = [
  ["Essentials", [["Search", "Ctrl K  or  Ctrl Shift F"], ["New Bot", "Ctrl N"], ["Send", "Enter"], ["Go to Bot", "Ctrl 1–9"], ["Compact sidebar", "Ctrl B"], ["Settings", "Ctrl ,"], ["Keyboard shortcuts", "Ctrl /"]]],
  ["Chat", [["Focus chat", "Ctrl I"], ["Find in chat", "Ctrl F"], ["Dictate", "Ctrl D"], ["Add selection to chat", "Ctrl L"]]],
  ["Navigation", [["Previous / next Bot", "Alt ↑ / Alt ↓"], ["Back / forward", "Ctrl [ / Ctrl ]"], ["Switch Bots", "Hold Ctrl  Tab"]]],
  ["Panels", [["Details", "Ctrl Alt B"], ["Skills", "Ctrl Shift W"], ["Connect apps", "Ctrl Shift M"]]],
  ["Window", [["Zoom", "Ctrl + / Ctrl − / Ctrl 0"], ["Full screen", "F11"]]],
] as const;

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-[16px] shadow-[var(--shadow-card)] sm:max-w-3xl" data-testid="shortcuts-dialog">
        <DialogHeader><DialogTitle>Keyboard shortcuts</DialogTitle></DialogHeader>
        <div className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
          {shortcutGroups.map(([title, entries]) => <section key={title}><h3 className="mb-2 text-body-sm font-medium">{title}</h3><div className="divide-y divide-border">{entries.map(([label, keys]) => <div key={label} className="flex min-h-10 items-center justify-between gap-3 text-body-sm"><span>{label}</span><span className="text-meta text-muted-foreground">{keys.split(" ").map((key, index) => <kbd key={`${key}-${index}`} className="ml-1 rounded-chip border border-border bg-muted px-1.5 py-0.5 font-mono">{key}</kbd>)}</span></div>)}</div></section>)}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FeedbackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { await api("/api/feedback", { method: "POST", body: JSON.stringify({ message, category: "general" }) }); toast.success("Feedback sent."); setMessage(""); onOpenChange(false); }
    catch (error) { toast.error(errorMessage(error, "Could not send feedback.")); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent data-testid="feedback-dialog" className="rounded-[16px] shadow-[var(--shadow-card)]"><DialogHeader><DialogTitle>Send feedback</DialogTitle><DialogDescription>Share a note with the AI Teammates team.</DialogDescription></DialogHeader><form onSubmit={(event) => void submit(event)} className="space-y-4"><Textarea data-testid="feedback-message" className="min-h-28 rounded-control" value={message} onChange={event => setMessage(event.target.value)} maxLength={5000} required placeholder="What should we know?" /><DialogFooter><Button data-testid="feedback-submit" className="rounded-full" type="submit" disabled={busy || !message.trim()}>{busy ? "Sending…" : "Send feedback"}</Button></DialogFooter></form></DialogContent></Dialog>;
}
