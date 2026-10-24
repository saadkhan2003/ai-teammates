"use client";

import { Bell, ChevronRight, CircleHelp, Info, Menu, MoreHorizontal, PanelLeft, PanelLeftClose, Plus, Search, Settings, Upload, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { BotAvatarPicker } from "@/components/bot-avatar-picker";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { PluginsPane } from "@/components/plugins-pane";
import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, asList } from "@/lib/api";
import { subscribeEvents } from "@/lib/events";
import { saveTheme, type ThemeMode } from "@/lib/theme";
import { cn, errorMessage } from "@/lib/utils";
import { matchShortcut } from "@/lib/shortcuts";
import { defaultBotAvatar } from "@/lib/avatars";

type RosterBot = {
  id: string;
  name: string;
  role: string;
  section: string;
  status: string;
  avatar: string;
  avatarShape: string;
  avatarColor: string;
  attention: boolean;
};

type ConnectedApp = { id: string; name: string };

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
        attention: record.attention === true,
      };
    })
    .filter((bot) => bot.id);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "T";
}

function readApps(data: unknown): ConnectedApp[] {
  return asList(data, ["plugins", "items"])
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return { id: String(record.id ?? ""), name: String(record.name ?? "App") };
    })
    .filter((app) => app.id)
    .slice(0, 3);
}

function statusDotClass(status: string, attention: boolean) {
  const value = status.toLowerCase();
  if (["failed", "error", "offline"].includes(value)) return "bg-destructive";
  if (attention || ["running", "working", "planning", "queued", "busy"].includes(value)) return "bg-brand";
  return "bg-success";
}

function appHue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 33 + char.charCodeAt(0)) % 360;
  return hash;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [bots, setBots] = useState<RosterBot[]>([]);
  const [username, setUsername] = useState("Account");
  const [displayName, setDisplayName] = useState("Account");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const rosterScrollTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [palette, setPalette] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [streamState, setStreamState] = useState("reconnecting");
  const [streamId, setStreamId] = useState("");
  const [pendingDelete, setPendingDelete] = useState<RosterBot | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [pluginTab, setPluginTab] = useState<"marketplace" | "yours">("yours");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [quickSwitch, setQuickSwitch] = useState(false);

  const load = useCallback(async () => {
    try {
      const [botData, me, noteData, pluginData] = await Promise.all([
        api<unknown>("/api/bots"),
        api<{ username?: string; displayName?: string; avatarUrl?: string }>("/api/auth/me").catch(() => ({ username: "Account", displayName: "Account", avatarUrl: "" })),
        api<unknown>("/api/notifications").catch(() => []),
        api<unknown>("/api/plugins").catch(() => []),
      ]);
      setBots(readBots(botData));
      const name = me.displayName || me.username || "Account";
      setUsername(me.username || name);
      setDisplayName(name);
      setAvatarUrl(typeof me.avatarUrl === "string" ? me.avatarUrl : "");
      setApps(readApps(pluginData));
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
      setBots([]);
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
    if (pathname === "/login" || pathname === "/invite") return;
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    const refresh = () => void load();
    const openCreate = () => setCreateOpen(true);
    window.addEventListener("teammates-bots-changed", refresh);
    window.addEventListener("teammates-open-create", openCreate);
    let debounce = 0;
    const stopEvents = subscribeEvents(
      () => {
        window.clearTimeout(debounce);
        debounce = window.setTimeout(() => void load(), 300);
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
      window.clearTimeout(debounce);
      stopEvents();
      window.removeEventListener("teammates-bots-changed", refresh);
      window.removeEventListener("teammates-open-create", openCreate);
    };
  }, [load, pathname]);

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
      if (action === "connect") { setPluginTab("marketplace"); setPluginsOpen(true); }
      if (action === "focus-chat") document.querySelector<HTMLElement>("[data-testid='composer']")?.focus();
      if (action === "selection") { const selected = window.getSelection()?.toString().trim(); if (selected) { const composer = document.querySelector<HTMLTextAreaElement>("[data-testid='composer']"); if (composer) { composer.value += `\n> ${selected.replace(/\n/g, "\n> ")}`; composer.dispatchEvent(new Event("input", { bubbles: true })); composer.focus(); } } }
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

  if (pathname === "/login" || pathname === "/invite") return <>{children}</>;

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
  const activeBot = bots.find((bot) => pathname === `/bots/${bot.id}`);
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
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
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
      {compact || !activeBot ? null : (
        <div data-testid="selected-bot-tile" className="flex flex-col items-center px-3 pb-3 text-center">
          <span className="relative grid h-[60px] w-[60px] place-items-center rounded-[8px] bg-accent">
            <BotAvatar botId={activeBot.id} shape={activeBot.avatarShape} color={activeBot.avatarColor} size={44} />
            <span className={cn("absolute bottom-1 right-1 size-2.5 rounded-full border-2 border-sidebar", statusDotClass(activeBot.status, activeBot.attention))} />
          </span>
          <span className="mt-2 max-w-full truncate text-xs font-semibold uppercase tracking-wide">{activeBot.name}</span>
          <span className="max-w-full truncate text-xs text-muted-foreground">{activeBot.role || activeBot.status}</span>
        </div>
      )}
      <nav className="sidebar-scroll min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5 pb-3" onScroll={onRosterScroll}>
        {groups.length === 0 ? <p className={cn("px-2 py-3 text-xs text-muted-foreground", compact && "sr-only")}>No teammates yet</p> : null}
        {groups.map(([section, items]) => (
          <Collapsible key={section} defaultOpen>
            {compact ? null : (
              <CollapsibleTrigger className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-sidebar-accent [&[data-state=open]>svg]:rotate-90">
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
                            onClick={() => setOpen(false)}
                            aria-current={active ? "page" : undefined}
                            title={bot.name}
                            className={cn(
                              "flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-accent",
                              active && "bg-accent",
                              compact ? "justify-center px-1" : "pr-8",
                            )}
                          >
                            <span className="relative shrink-0">
                              <BotAvatar botId={bot.id} shape={bot.avatarShape} color={bot.avatarColor} size={32} />
                              <span
                                data-testid="bot-status-dot"
                                data-status={bot.attention ? "attention" : bot.status}
                                className={cn("absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-sidebar", statusDotClass(bot.status, bot.attention))}
                              />
                            </span>
                            <span className={cn("min-w-0 flex-1", compact && "sr-only")}>
                              <span className="block truncate font-medium">{bot.name}</span>
                              {bot.role ? <span className="block truncate text-xs text-muted-foreground">{bot.role}</span> : null}
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
                              className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-background focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
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
      <div data-testid="sidebar-footer" className={cn("group/footer grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 overflow-hidden bg-sidebar p-2", compact && "flex flex-col", !compact && "group-hover/footer:grid-cols-[auto_minmax(0,1fr)]")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="account-button"
              title={accountName}
              className={cn(
                "flex h-11 w-full min-w-0 items-center gap-2 overflow-hidden rounded-full border border-border bg-card px-1.5 text-card-foreground shadow-sm transition-all duration-200 hover:shadow-md",
                compact ? "w-11 justify-center px-0" : "group-hover/footer:w-11 group-hover/footer:justify-center",
              )}
            >
              <Avatar className="h-8 w-8 shrink-0">
                {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
                <AvatarFallback className="text-[11px]">{initials(accountName)}</AvatarFallback>
              </Avatar>
              <span className={cn("min-w-0 flex-1 truncate text-left text-sm font-medium", compact ? "sr-only" : "group-hover/footer:sr-only")}>{accountName}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64" data-testid="account-menu">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="notifications">
                <Bell /> Notifications
                {unread > 0 ? <span className="ml-auto text-xs text-muted-foreground">{unread}</span> : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                <div className="flex items-center justify-between px-2 py-1.5">
                  <p className="text-xs font-medium">Notifications</p>
                  <button type="button" className="text-xs text-muted-foreground" onClick={() => void markRead()}>
                    Mark read
                  </button>
                </div>
                {notes.length === 0 ? <p className="px-2 py-2 text-xs text-muted-foreground">Nothing waiting.</p> : null}
                {notes.map((note) => (
                  <DropdownMenuItem key={note.id} className="flex flex-col items-start gap-0.5">
                    <span className="text-sm">{note.title}</span>
                    {note.body ? <span className="text-xs text-muted-foreground">{note.body}</span> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Weekly usage <span className="ml-auto text-xs text-muted-foreground">7% used</span></DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">
                <div className="px-2 py-2"><p className="text-sm font-medium">Weekly usage</p><p className="text-xs text-muted-foreground">Resets in 7 days</p><p className="mt-2 text-2xl font-medium">7% <span className="text-xs text-muted-foreground">used</span></p></div>
                <DropdownMenuItem onSelect={() => go("/settings/usage")}>Manage usage</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onSelect={() => go("/settings/computer")}><Upload /> Get app</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><CircleHelp /> Support</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={() => window.open("/docs/COMPANION.md", "_blank")}><CircleHelp /> Help Center</DropdownMenuItem>
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
            "flex h-11 min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-1.5 text-card-foreground shadow-sm transition-all duration-200 hover:shadow-md",
            compact ? "w-11 justify-center px-0" : "group-hover/footer:min-w-0 group-hover/footer:flex-1",
          )}
          onClick={() => {
            setPluginTab("yours");
            setPluginsOpen(true);
            setOpen(false);
          }}
        >
          <span className="flex shrink-0 items-center -space-x-2">
            {(apps.length ? apps : [{ id: "connect", name: "+" }]).map((app) => (
              <span
                key={app.id}
                className="grid size-7 place-items-center rounded-full border-2 border-card text-[10px] font-medium text-white"
                style={{ backgroundColor: `hsl(${appHue(app.name)} 55% 42%)` }}
              >
                {app.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
          </span>
          {compact ? null : (
            <span className="max-w-0 overflow-hidden whitespace-nowrap text-sm font-medium opacity-0 transition-all group-hover/footer:max-w-[8rem] group-hover/footer:opacity-100">Connect apps</span>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <TooltipProvider delayDuration={300}>
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
            className={cn("hidden shrink-0 overflow-x-hidden md:flex", compact ? "w-16" : "w-[232px]")}
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
        <Dialog open={pluginsOpen} onOpenChange={setPluginsOpen}>
          <DialogContent data-testid="plugins-modal" className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Connect apps</DialogTitle>
              <DialogDescription>Apps connected to your account. Install more from the marketplace.</DialogDescription>
            </DialogHeader>
            <div className="flex gap-1">
              {(["marketplace", "yours"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  data-testid="plugins-tab"
                  data-active={pluginTab === tab}
                  className={cn(
                    "rounded-md px-3 py-1 text-sm",
                    pluginTab === tab ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground",
                  )}
                  onClick={() => setPluginTab(tab)}
                >
                  {tab === "marketplace" ? "Marketplace" : "Yours"}
                </button>
              ))}
            </div>
            {pluginTab === "marketplace" ? <PluginsPane mode="catalog" /> : <PluginsPane mode="installed" />}
          </DialogContent>
        </Dialog>
        <Dialog open={palette} onOpenChange={setPalette}>
          <DialogContent data-testid="command-palette" className="overflow-hidden p-0 sm:max-w-lg">
            <DialogTitle className="sr-only">Command palette</DialogTitle>
            <Command>
              <CommandInput placeholder="Jump to a teammate or run a command" />
              <CommandList>
                <CommandEmpty>No matches.</CommandEmpty>
                <CommandGroup heading="Teammates">
                  {bots.map((bot) => (
                    <CommandItem key={bot.id} value={`${bot.name} ${bot.role}`} onSelect={() => go(`/bots/${bot.id}`)}>
                      <BotAvatar botId={bot.id} shape={bot.avatarShape} color={bot.avatarColor} size={24} />{bot.name}
                      <span className="ml-2 truncate text-xs text-muted-foreground">{bot.role}</span>
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
            <DialogHeader><div className="mx-auto grid h-16 w-16 place-items-center rounded-xl bg-brand text-3xl font-bold text-background">✦</div><DialogTitle className="text-2xl">AI Teammates</DialogTitle><DialogDescription>Version {process.env.NEXT_PUBLIC_APP_VERSION || "0.4.0"}<br />Built {process.env.NEXT_PUBLIC_BUILD_DATE || "2026"}<br />Copyright © 2026 AI Teammates</DialogDescription></DialogHeader>
            <Button variant="outline" data-testid="copy-version-info" onClick={() => { void navigator.clipboard?.writeText("AI Teammates 0.4.0"); toast.success("Version info copied."); }}>Copy version info</Button>
          </DialogContent>
        </Dialog>
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
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
            <p id="bot-name-help" className="text-xs text-muted-foreground">Required. What should we call your teammate?</p>
          </div>
          <Collapsible>
          <CollapsibleTrigger type="button" data-testid="bot-advanced-toggle" className="text-sm text-muted-foreground underline">Advanced (optional)</CollapsibleTrigger>
          <CollapsibleContent className="mt-3 grid gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-role" className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-[11px] text-primary-foreground">B</span>
              Title
            </Label>
            <Input id="bot-role" data-testid="bot-role" value={role} onChange={(event) => setRole(event.target.value)} aria-describedby="bot-role-help" />
            <p id="bot-role-help" className="text-xs text-muted-foreground">Optional. Defaults to Teammate.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-instructions" className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-[11px] text-primary-foreground">C</span>
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
          <p id="bot-instructions-help" className="text-xs text-muted-foreground">Optional. Describe their work, preferences, or goals.</p>
          </CollapsibleContent>
          </Collapsible>
          {formError ? (
            <p id="bot-form-error" role="alert" className="text-sm text-destructive">
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl" data-testid="shortcuts-dialog">
        <DialogHeader><DialogTitle>Keyboard shortcuts</DialogTitle></DialogHeader>
        <div className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
          {shortcutGroups.map(([title, entries]) => <section key={title}><h3 className="mb-2 text-sm font-medium">{title}</h3><div className="divide-y divide-border">{entries.map(([label, keys]) => <div key={label} className="flex min-h-10 items-center justify-between gap-3 text-sm"><span>{label}</span><span className="text-xs text-muted-foreground">{keys.split(" ").map((key, index) => <kbd key={`${key}-${index}`} className="ml-1 rounded border border-border bg-muted px-1.5 py-0.5 font-mono">{key}</kbd>)}</span></div>)}</div></section>)}
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
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent data-testid="feedback-dialog"><DialogHeader><DialogTitle>Send feedback</DialogTitle><DialogDescription>Share a note with the AI Teammates team.</DialogDescription></DialogHeader><form onSubmit={(event) => void submit(event)} className="space-y-3"><Textarea data-testid="feedback-message" value={message} onChange={event => setMessage(event.target.value)} maxLength={5000} required placeholder="What should we know?" /><Button data-testid="feedback-submit" type="submit" disabled={busy || !message.trim()}>{busy ? "Sending…" : "Send feedback"}</Button></form></DialogContent></Dialog>;
}
