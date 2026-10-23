"use client";

import { Bell, ChevronRight, Menu, PanelLeft, PanelLeftClose, Plug, Plus, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { applyTheme, type ThemeMode } from "@/lib/theme";
import { cn, errorMessage } from "@/lib/utils";

type RosterBot = {
  id: string;
  name: string;
  role: string;
  section: string;
  avatar: string;
  attention: boolean;
};

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
        avatar: String(record.avatar ?? ""),
        attention: record.attention === true,
      };
    })
    .filter((bot) => bot.id);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "T";
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [bots, setBots] = useState<RosterBot[]>([]);
  const [username, setUsername] = useState("Account");
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

  const load = useCallback(async () => {
    try {
      const [botData, me, noteData] = await Promise.all([
        api<unknown>("/api/bots"),
        api<{ username?: string }>("/api/auth/me").catch(() => ({ username: "Account" })),
        api<unknown>("/api/notifications").catch(() => []),
      ]);
      setBots(readBots(botData));
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
    function onKey(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        setPalette(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setPalette(false);
        router.push("/settings");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

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
        <Button variant="outline" size="icon" className="h-9 w-9 rounded-md bg-background" aria-label="Search" onClick={() => setPalette(true)}>
          <Search />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button data-testid="new-bot" variant="outline" size="icon" className="h-9 w-9 rounded-md bg-background" aria-label="New">
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
            className="h-9 w-9 rounded-md bg-background"
            aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleRail}
          >
            {compact ? <PanelLeft /> : <PanelLeftClose />}
          </Button>
        )}
      </div>
      {compact || !activeBot ? null : (
        <div className="flex flex-col items-center px-3 pb-3">
          <div className="grid h-16 w-16 place-items-center rounded-md border border-sidebar-border bg-background text-base font-medium">
            {activeBot.avatar || initials(activeBot.name)}
          </div>
          <p className="mt-2 max-w-full truncate text-sm font-medium">{activeBot.name}</p>
        </div>
      )}
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5 pb-3">
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
                    <li key={bot.id}>
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <Link
                            href={`/bots/${bot.id}`}
                            onClick={() => setOpen(false)}
                            aria-current={active ? "page" : undefined}
                            title={bot.name}
                            className={cn(
                              "flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-sidebar-accent",
                              active && "bg-sidebar-accent",
                              compact && "justify-center px-1",
                            )}
                          >
                            <Avatar className="h-8 w-8">
                              <AvatarFallback className="text-[11px]">{bot.avatar || initials(bot.name)}</AvatarFallback>
                            </Avatar>
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
                    </li>
                  );
                })}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </nav>
      <div className={cn("flex items-center gap-1 border-t border-sidebar-border p-2", compact && "flex-col")}>
        <Button
          type="button"
          data-testid="open-plugins"
          variant="ghost"
          className={cn("h-9 px-2", compact && "w-9 px-0")}
          onClick={() => {
            setPluginTab("yours");
            setPluginsOpen(true);
            setOpen(false);
          }}
        >
          <Plug />
          {compact ? <span className="sr-only">Plugins</span> : <span>Plugins</span>}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button data-testid="notifications" variant="ghost" size="icon" className="relative h-9 w-9 shrink-0" aria-label="Notifications">
              <Bell />
              {unread > 0 ? <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-md bg-brand" /> : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64">
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
          </DropdownMenuContent>
        </DropdownMenu>
        <Link
          href="/settings"
          data-testid="account-button"
          onClick={() => setOpen(false)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-sidebar-accent",
            compact && "flex-none justify-center px-0",
          )}
        >
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-[10px]">{initials(username)}</AvatarFallback>
          </Avatar>
          {compact ? <span className="sr-only">{username}</span> : <span className="min-w-0 truncate text-sm">{username}</span>}
        </Link>
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
            className={cn("hidden shrink-0 border-r border-sidebar-border md:flex", compact ? "w-16" : "w-[260px]")}
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
              <DialogTitle>Plugins</DialogTitle>
              <DialogDescription>One registry for MCP servers, OpenAPI APIs, built-ins, and OAuth apps.</DialogDescription>
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
                      {bot.name}
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
                        applyTheme(mode);
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
        body: JSON.stringify({ name: name.trim(), role: role.trim() || "Teammate", instructions: instructions.trim() }),
      });
      setName("");
      setRole("");
      setInstructions("");
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
          <DialogTitle>New teammate</DialogTitle>
          <DialogDescription>A name is enough to start. Add a title and instructions whenever you like.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={createBot} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-name" className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-[11px] text-primary-foreground">A</span>
              Name
            </Label>
            <Input id="bot-name" data-testid="bot-name" value={name} onChange={(event) => { setName(event.target.value); setFormError(null); }} aria-invalid={!!formError && !name.trim()} aria-describedby="bot-name-help bot-form-error" />
            <p id="bot-name-help" className="text-xs text-muted-foreground">Required. What should we call your teammate?</p>
          </div>
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
          {formError ? (
            <p id="bot-form-error" role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
          <Button data-testid="bot-create" type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
