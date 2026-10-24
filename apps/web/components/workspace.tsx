"use client";

import { Settings, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Approvals } from "@/components/approvals";
import { PluginsPane } from "@/components/plugins-pane";
import { ArtifactsPane } from "@/components/artifacts-pane";
import { ChatPane } from "@/components/chat-pane";
import { LoginCard } from "@/components/login-card";
import { FilesPane } from "@/components/files-pane";
import { MemoryPane } from "@/components/memory-pane";
import { CodingSection } from "@/components/coding-section";
import { RoutinesSection } from "@/components/routines-section";
import { SkillsPane } from "@/components/skills-pane";
import { StateMessage } from "@/components/state-message";
import { TasksPane } from "@/components/tasks-pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChatSkeleton, ListSkeleton, Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  normalizeArtifacts,
  normalizeFiles,
  normalizeMemories,
  normalizeRoutines,
  normalizeSkills,
} from "@/lib/api";
import { mergeAgentEvent, parseAgentEvent, subscribeEvents, type AgentEvent } from "@/lib/events";
import { StatusBadge } from "@/lib/status";
import { REFRESH_EVENT, useConnection } from "@/lib/connection";
import type { Artifact, FileEntry, LoginRequest, MemoryItem, Routine, SecretRequest, Skill, Workspace as WorkspaceData } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { BotAvatar } from "@/components/bot-avatar";
import { BotAvatarPicker } from "@/components/bot-avatar-picker";
import { defaultBotAvatar } from "@/lib/avatars";
import { HISTORY_PAGE, mergeHistory } from "@/lib/history";
import { clampWorkBudget, WORK_BUDGET_LIMITS } from "@/lib/work-budget";
import type { ChatMessage } from "@/lib/types";
import { RefreshNotice } from "@/components/refresh-notice";
import { LibraryPane } from "@/components/library-pane";
import { ShareMenu } from "@/components/share-menu";
import { RecordingBanner, useTeachTask } from "@/components/teach-task";

const ComputerPane = dynamic(() => import("@/components/computer-pane").then((mod) => mod.ComputerPane), {
  ssr: false,
  loading: () => (
    <div data-testid="computer-tab" data-vnc-state="disconnected" role="status" aria-busy="true" className="p-3">
      <span className="sr-only">Loading the desktop</span>
      <Skeleton className="aspect-[16/10] w-full rounded-xl" />
    </div>
  ),
});

type ListState<T> = { items: T[]; error: string | null; loaded: boolean };

const emptyList = { items: [], error: null, loaded: false };

function normalizeWorkspace(data: WorkspaceData): WorkspaceData {
  return {
    ...data,
    tasks: data.tasks ?? [],
    messages: data.messages ?? [],
    approvals: data.approvals ?? [],
    secretRequests: data.secretRequests ?? [],
    loginRequests: data.loginRequests ?? [],
    pages: data.pages ?? [],
    holder: data.holder === "human" ? "human" : "agent",
    llmProvider: data.llmProvider ?? "",
    openrouterConnected: data.openrouterConnected,
  };
}

async function loadList<T>(path: string, normalize: (data: unknown) => T[]): Promise<ListState<T>> {
  try {
    const data = await api<unknown>(path);
    return { items: normalize(data), error: null, loaded: true };
  } catch (caught) {
    return { items: [], error: errorMessage(caught, "The list could not be loaded."), loaded: true };
  }
}

const INFO_TABS = [
  ["overview", "Overview"],
  ["computer", "Computer"],
  ["library", "Library"],
  ["files", "Files/Media"],
  ["skills", "Skills"],
  ["memory", "Memory"],
  ["tasks", "Tasks"],
  ["plugins", "Plugins"],
] as const;

export function Workspace({ botId }: { botId: string }) {
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [older, setOlder] = useState<{ botId: string; items: ChatMessage[]; hasMore: boolean | null }>({ botId, items: [], hasMore: null });
  const olderRef = useRef(older);
  olderRef.current = older;
  const workspaceRef = useRef<WorkspaceData | null>(null);
  workspaceRef.current = workspace;
  /** Loads one page of older messages in front of the chat. Resolves to whether still older history exists. */
  const loadOlder = useCallback(async (): Promise<boolean> => {
    const current = olderRef.current.botId === botId ? olderRef.current : { botId, items: [] as ChatMessage[], hasMore: null };
    const merged = mergeHistory(current.items, workspaceRef.current?.messages ?? []);
    const first = merged[0]?.id;
    if (!first) return false;
    const page = await api<{ messages: ChatMessage[]; hasMore: boolean }>(`/api/bots/${botId}/messages?before=${first}&limit=${HISTORY_PAGE}`);
    setOlder({ botId, items: mergeHistory(page.messages ?? [], current.items), hasMore: !!page.hasMore });
    return !!page.hasMore;
  }, [botId]);
  const [pane, setPaneRaw] = useState(false);
  const [paneMounted, setPaneMounted] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const setPane = useCallback((next: boolean | ((value: boolean) => boolean)) => {
    setPaneRaw(current => {
      const value = typeof next === "function" ? next(current) : next;
      if (value !== current && typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches) {
        try { window.localStorage.setItem("teammates-pane", value ? "open" : "closed"); } catch { /* storage unavailable */ }
      }
      return value;
    });
  }, []);
  const togglePane = () => setPane(value => !value);
  useEffect(() => {
    if (pane) { setPaneMounted(true); return; }
    const timer = window.setTimeout(() => setPaneMounted(false), 220);
    return () => window.clearTimeout(timer);
  }, [pane]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [desktopFull, setDesktopFull] = useState(false);
  const [autoControlKey, setAutoControlKey] = useState(0);
  const [handBackKey, setHandBackKey] = useState(0);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [files, setFiles] = useState<ListState<FileEntry>>(emptyList);
  const [memories, setMemories] = useState<ListState<MemoryItem>>(emptyList);
  const [skills, setSkills] = useState<ListState<Skill>>(emptyList);
  const [routines, setRoutines] = useState<ListState<Routine>>(emptyList);
  const [routineEditRequest, setRoutineEditRequest] = useState<{ key: number; text: string } | undefined>();
  const [artifacts, setArtifacts] = useState<ListState<Artifact>>(emptyList);
  const [detailTab, setDetailTab] = useState("overview");
  const [memoryFocusId, setMemoryFocusId] = useState<string | undefined>();
  const [finishedLogins, setFinishedLogins] = useState<LoginRequest[]>([]);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [llmConnected, setLlmConnected] = useState<boolean | null>(null);
  const connection = useConnection();
  const taskIds = useRef(new Set<string>());
  const seq = useRef(0);
  const auxSeq = useRef(0);
  const tabRef = useRef(detailTab);
  tabRef.current = detailTab;

  const loadWorkspace = useCallback(async () => {
    const ticket = ++seq.current;
    try {
      const data = normalizeWorkspace(await api<WorkspaceData>(`/api/bots/${botId}/workspace`));
      if (ticket !== seq.current) return;
      taskIds.current = new Set(data.tasks.map(task => task.id));
      setWorkspace(data);
      setWorkspaceError(null);
    } catch (caught) {
      if (ticket !== seq.current) return;
      setWorkspaceError(errorMessage(caught, "Could not load this workspace."));
    } finally {
      if (ticket === seq.current) setReady(true);
    }
  }, [botId]);

  const loadAux = useCallback(
    async (kinds: Array<"files" | "memories" | "skills" | "routines" | "artifacts">) => {
      const ticket = auxSeq.current;
      const apply = async <T,>(
        kind: (typeof kinds)[number],
        path: string,
        normalize: (data: unknown) => T[],
        set: (value: ListState<T>) => void,
      ) => {
        if (!kinds.includes(kind)) return;
        const next = await loadList(path, normalize);
        if (ticket !== auxSeq.current) return;
        set(next);
      };
      await Promise.all([
        apply("files", `/api/bots/${botId}/files`, normalizeFiles, setFiles),
        apply("memories", `/api/bots/${botId}/memories`, normalizeMemories, setMemories),
        apply("skills", `/api/bots/${botId}/skills`, normalizeSkills, setSkills),
        apply("routines", `/api/bots/${botId}/routines`, normalizeRoutines, setRoutines),
        apply("artifacts", `/api/bots/${botId}/artifacts`, normalizeArtifacts, setArtifacts),
      ]);
    },
    [botId],
  );

  useEffect(() => {
    setReady(false);
    setAgentEvents([]);
    taskIds.current = new Set();
    setLlmConnected(null);
    api<Record<string, unknown>>("/api/system/llm-status").then(status => {
      const connected = status.openrouterConnected ?? status.connected ?? status.configured ?? status.hasKey;
      if (typeof connected === "boolean") setLlmConnected(connected);
    }).catch(() => api<unknown>("/api/secrets").then(data => {
      const items = Array.isArray(data) ? data : (data as { secrets?: unknown[] })?.secrets;
      if (Array.isArray(items)) setLlmConnected(items.some(item => { const entry = item as Record<string, unknown>; return entry.provider === "openrouter" || entry.namespace === "openrouter"; }));
    }).catch(() => undefined));
    setWorkspace(null);
    setWorkspaceError(null);
    const desktop = window.matchMedia("(min-width: 768px)").matches;
    let stored: string | null = null;
    try { stored = window.localStorage.getItem("teammates-pane"); } catch { /* storage unavailable */ }
    setPaneRaw(desktop && stored !== "closed");
    void loadWorkspace();
    void loadAux(["artifacts", "routines"]);
    const preload = window.setTimeout(() => {
      void import("@novnc/novnc/lib/rfb.js");
    }, 1500);
    let debounce = 0;
    const schedule = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void loadWorkspace(), 200);
    };
    const stopEvents = subscribeEvents((data) => {
      const event = parseAgentEvent(data);
      const type = event?.type ?? "";
      if (event && ["grounding", "tool", "tool_call", "tool_result", "delta", "message.delta", "text_delta", "memory"].includes(type)) {
        // Events without bot/task attribution cannot safely be shown in this workspace.
        if (event.botId === botId || (typeof event.taskId === "string" && taskIds.current.has(event.taskId))) {
          const detail = event.detail && typeof event.detail === "object" ? event.detail as Record<string, unknown> : {};
          setAgentEvents(current => mergeAgentEvent(current, { ...event, ...detail, type: event.type }));
        }
      }
      if (type === "memory" && (event?.botId === botId || (typeof event?.taskId === "string" && taskIds.current.has(event.taskId)))) void loadAux(["memories"]);
      schedule();
      if (type !== "task" && type !== "artifact") return;
      const extra: Array<"files" | "memories" | "skills" | "routines" | "artifacts"> = ["artifacts", "routines"];
      const tab = tabRef.current;
      if (tab === "files") extra.push("files");
      if (tab === "memory") extra.push("memories");
      if (tab === "skills") extra.push("skills");
      void loadAux(extra);
    });
    const slow = window.setInterval(() => {
      void loadWorkspace();
      void loadAux(["artifacts", "routines"]);
    }, 15_000);
    return () => {
      window.clearTimeout(debounce);
      window.clearTimeout(preload);
      window.clearInterval(slow);
      stopEvents();
      seq.current += 1;
      auxSeq.current += 1;
    };
  }, [loadWorkspace, loadAux]);

  useEffect(() => {
    const refresh = () => { void loadWorkspace(); void loadAux([tabRef.current === "files" ? "files" : "artifacts", "routines"]); };
    window.addEventListener(REFRESH_EVENT, refresh);
    return () => window.removeEventListener(REFRESH_EVENT, refresh);
  }, [loadWorkspace, loadAux]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const target = event.target as HTMLElement | null;
        const inPane = !!target?.closest?.("[data-testid='info-pane']");
        const onPill = !!target?.closest?.("[data-testid='bot-name-button']");
        const neutral = !target || target === document.body;
        setDesktopFull(false); setSettingsOpen(false);
        if (inPane || onPill || neutral) { setPaneRaw(open => { if (open) { try { if (window.matchMedia("(min-width: 768px)").matches) window.localStorage.setItem("teammates-pane", "closed"); } catch { /* storage unavailable */ } window.setTimeout(() => document.querySelector<HTMLElement>("[data-testid='bot-name-button']")?.focus(), 0); } return false; }); }
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        setPane((value) => !value);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!pane) return;
    if (detailTab === "files") void loadAux(["files", "artifacts"]);
    if (detailTab === "memory") void loadAux(["memories"]);
    if (detailTab === "skills") void loadAux(["skills"]);
  }, [pane, detailTab, loadAux]);

  const teach = useTeachTask({
    botId,
    conversationId: workspace?.conversationId,
    onBegin: () => { setDesktopFull(true); setAutoControlKey(value => value + 1); },
    onEnd: () => setHandBackKey(value => value + 1),
    onSent: () => void loadWorkspace(),
  });

  if (!ready) {
    return (
      <ChatSkeleton />
    );
  }

  if (!workspace) {
    return (
      <StateMessage
        tone="error"
        title="Could not load this workspace."
        detail={workspaceError ?? "The server did not return this teammate."}
        action={
          <Button variant="outline" onClick={() => void loadWorkspace()}>
            Retry
          </Button>
        }
      />
    );
  }

  const provider = workspace.llmProvider || "";
  const bot = workspace.bot;
  const requests = (workspace.secretRequests ?? []) as SecretRequest[];
  const computerExpanded = desktopFull;

  return (
    <div className="flex h-full min-h-0">
      {teach.startedAt ? <RecordingBanner botName={bot?.name || "Teammate"} shape={bot?.avatarShape} color={bot?.avatarColor} startedAt={teach.startedAt} onCancel={() => void teach.cancel()} /> : null}
      <section className="motion-fade relative flex min-w-0 flex-1 flex-col">
        <div aria-hidden data-testid="chat-top-fade" className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 bg-gradient-to-b from-background/85 via-background/50 to-transparent" />
        <header data-testid="chat-pill-bar" className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-12 items-center justify-center px-3 pt-2">
          <button
            type="button"
            data-testid="bot-name-button"
            aria-expanded={pane}
            aria-controls="info-pane"
            aria-label={`${bot?.name || "Teammate"} details`}
            className="pointer-events-auto inline-flex max-w-[70%] items-center gap-2 rounded-full border border-white/5 bg-black/75 px-3.5 py-1.5 text-sm font-medium shadow-md backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => togglePane()}
          >
            <BotAvatar animated botId={bot?.id} shape={bot?.avatarShape} color={bot?.avatarColor} size={20} primary={bot?.isPrimary} />
            <span className="truncate">{bot?.name || "Teammate"}</span>
          </button>
          {bot?.status ? (
            <span className="pointer-events-auto absolute right-3 top-3">
              <StatusBadge status={bot.status} />
            </span>
          ) : null}
        </header>
        {workspaceError && !connection.failed ? (
          <p role="alert" className="relative z-30 mt-12 px-4 pt-1 text-sm text-destructive">
            Could not refresh the workspace. {workspaceError}
          </p>
        ) : null}
        <ChatPane
          onEditMemory={(id) => { setMemoryFocusId(id); setDetailTab("memory"); setPaneRaw(true); }}
          onMemoryChanged={() => void loadAux(["memories"])}
          editRequest={routineEditRequest}
          conversationId={workspace.conversationId}
          messages={mergeHistory(older.botId === botId ? older.items : [], workspace.messages ?? [])}
          hasOlder={older.botId === botId && older.hasMore !== null ? older.hasMore : !!workspace.messagesHasMore}
          onLoadOlder={loadOlder}
          events={agentEvents.filter(event => !["delta", "message.delta", "text_delta"].includes(event.type) || workspace.tasks.some(task => task.id === event.taskId && ["running", "planning", "queued"].includes(task.status)))}
          onStop={async () => {
            await Promise.all(workspace.tasks.filter(task => ["running", "planning", "queued"].includes(task.status)).map(task => api(`/api/tasks/${task.id}/cancel`, { method: "POST" })));
            await loadWorkspace();
          }}
          botName={bot?.name || "Teammate"}
          botId={botId}
          avatar={{ shape: bot?.avatarShape || defaultBotAvatar(bot?.id || botId).shape, color: bot?.avatarColor || defaultBotAvatar(bot?.id || botId).color, primary: bot?.isPrimary }}
          botThreads={workspace.botThreads ?? []}
          taskTitle={(workspace.tasks ?? []).find(task => ["running", "planning"].includes((task.status ?? "").toLowerCase()))?.title}
          activeTaskId={(workspace.tasks ?? []).find(task => ["running", "planning", "waiting_human"].includes((task.status ?? "").toLowerCase()))?.id}
          evidenceTaskId={(workspace.tasks ?? []).find(task => ["running", "planning", "waiting_human"].includes((task.status ?? "").toLowerCase()))?.id ?? (workspace.tasks ?? [])[0]?.id}
          onSent={() => void loadWorkspace()}
          working={(workspace.tasks ?? []).some((task) => ["running", "planning", "queued"].includes((task.status ?? "").toLowerCase()))}
          extras={
            <>
              {provider.toLowerCase() === "mock" ? <p className="text-sm text-muted-foreground">Provider is mock. This teammate is not calling OpenRouter.</p> : null}
              {(llmConnected ?? workspace.openrouterConnected) === false ? (
                <p data-testid="llm-key-banner" className="rounded-md border border-border bg-card px-3 py-2 text-sm">
                  <Link href="/settings/secrets" className="font-medium text-brand">
                    Connect OpenRouter in Settings → Vault
                  </Link>
                  <span className="text-muted-foreground"> — model tasks wait until a key is saved.</span>
                </p>
              ) : null}
              <Approvals approvals={workspace.approvals ?? []} onChanged={() => void loadWorkspace()} />
              {(workspace.loginRequests ?? [])
                .filter((request) => !finishedLogins.some((done) => done.id === request.id))
                .map((request) => (
                  <LoginCard
                    key={request.id}
                    request={request}
                    onDone={() => {
                      setFinishedLogins((current) => (current.some((done) => done.id === request.id) ? current : [...current, request]));
                      void loadWorkspace();
                    }}
                  />
                ))}
              {finishedLogins.map((request) => (
                <article key={`done-${request.id}`} data-testid="login-card" data-state="done" className="min-w-0 max-w-full rounded-lg border border-border bg-card p-4 text-card-foreground">
                  <p className="text-sm font-medium">Done ✓</p>
                  <p className="mt-1 break-words text-sm text-muted-foreground">{request.domain}</p>
                </article>
              ))}
              {requests.map((request) => (
                <article key={request.id} data-testid="secret-request-card" className="min-w-0 max-w-full break-words rounded-lg border border-border bg-card px-3 py-2 text-sm">
                  <p className="font-medium">Secret request</p>
                  <p className="text-muted-foreground">{request.suggestedRef || request.type}</p>
                  {request.reason ? <p className="mt-1">{request.reason}</p> : null}
                  <Link href="/settings/secrets" className="mt-2 inline-block text-brand">
                    Open vault
                  </Link>
                </article>
              ))}
              {(workspace.tasks ?? []).slice(0, 3).map((task) => (
                <article key={task.id} data-testid="task-card" className="min-w-0 max-w-full rounded-lg border border-border bg-card px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate font-medium">{task.title || task.instruction}</p>
                    <StatusBadge status={task.status} />
                  </div>
                  {task.status === "failed" && task.error ? <p role="alert" data-testid="task-error" className="mt-2 whitespace-pre-wrap text-destructive">{task.error}</p> : null}
                </article>
              ))}
              {(artifacts.items ?? []).slice(0, 2).map((artifact) => (
                <article key={artifact.id} data-testid="artifact-card" className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
                  <p className="font-medium">{artifact.name}</p>
                  <a className="text-brand" href={`/api/artifacts/${artifact.id}/download`}>
                    Download
                  </a>
                </article>
              ))}
            </>
          }
        />
      </section>
      <div className={cn("contents md:block md:shrink-0 md:overflow-hidden md:transition-[width] md:duration-200 motion-reduce:md:transition-none", pane ? "md:w-[min(380px,42vw)]" : "md:w-0")}>
      {paneMounted ? (
        <aside
          id="info-pane"
          data-testid="info-pane"
          data-view="details"
          data-state={pane ? "open" : "closed"}
          aria-hidden={pane ? undefined : true}
          className={cn("fixed inset-0 z-30 flex w-full min-w-0 flex-col border-border bg-background pt-[env(safe-area-inset-top)] transition-opacity duration-200 motion-reduce:transition-none md:static md:z-0 md:w-[min(380px,42vw)] md:border-l md:pt-0", !pane && "pointer-events-none opacity-0 max-md:hidden")}
        >
          <RefreshNotice variant="panel" />
          <div className="flex h-11 items-center gap-1 border-b border-border px-2">
            <p className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{bot?.name}</p>
            <ShareMenu botId={botId} onCreated={() => window.dispatchEvent(new Event("teammates-bots-changed"))} />
            <Button
              type="button"
              data-testid="bot-settings-gear"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label="Teammate settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings />
            </Button>
            <Button
              type="button"
              data-testid="info-pane-close"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label="Close"
              onClick={() => {
                setPane(false);
                setSettingsOpen(false);
                setDesktopFull(false);
              }}
            >
              <X />
            </Button>
          </div>
          {settingsOpen ? (
            <BotSettings
              botId={botId}
              name={bot?.name || ""}
              role={bot?.role || ""}
              instructions={bot?.instructions || ""}
              model={(bot as { model?: string } | undefined)?.model || ""}
              avatar={(bot as { avatar?: string } | undefined)?.avatar || ""}
              avatarShape={bot?.avatarShape || defaultBotAvatar(bot?.id || botId).shape}
              avatarColor={bot?.avatarColor || defaultBotAvatar(bot?.id || botId).color}
              notifications={(bot as { notificationsEnabled?: boolean } | undefined)?.notificationsEnabled !== false}
              peerMessaging={bot?.peerMessaging !== false}
              onClose={() => setSettingsOpen(false)}
              onSaved={() => void loadWorkspace()}
            />
          ) : (
            <div className={cn("min-h-0 flex-1 overflow-y-auto", desktopFull && "overflow-visible")}>
              <div className="flex flex-col items-center gap-1 border-b border-border px-3 py-3" data-testid="panel-identity">
                <BotAvatar animated botId={bot?.id} shape={bot?.avatarShape} color={bot?.avatarColor} size={72} primary={bot?.isPrimary} />
                <BioField botId={botId} bio={bot?.bio ?? ""} onSaved={() => void loadWorkspace()} />
              </div>
              <div className={cn("border-b border-border", !computerExpanded && "p-3", computerExpanded && "flex min-h-[max(480px,70dvh)] flex-col")}>
                <ComputerPane
                  botId={botId}
                  tasks={workspace.tasks ?? []}
                  pages={workspace.pages ?? []}
                  holder={workspace.holder}
                  compact={!computerExpanded}
                  caption={bot?.name || "Teammate"}
                  avatar={<BotAvatar animated botId={bot?.id} shape={bot?.avatarShape} color={bot?.avatarColor} size={36} primary={bot?.isPrimary} />}
                  fullscreen={desktopFull}
                  recording={teach.recording}
                  autoControlKey={autoControlKey}
                  handBackKey={handBackKey}
                  onHandedBack={() => void teach.finish()}
                  onExpand={() => setDesktopFull(true)}
                  onExitFullscreen={() => setDesktopFull(false)}
                  onChanged={() => void loadWorkspace()}
                />
              </div>
              <RoutinesSection
                routines={routines.items}
                loaded={routines.loaded}
                error={routines.error}
                onRetry={() => void loadAux(["routines"])}
                onChanged={() => void loadAux(["routines"])}
                onEdit={(text) => setRoutineEditRequest((current) => ({ key: (current?.key ?? 0) + 1, text }))}
              />
              <CodingSection botId={botId} />
              <section data-testid="channels" className="border-b border-border px-3 py-3">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Channels</h2>
                <p className="mt-2 text-sm text-muted-foreground">No channels. Group chats will list them here.</p>
              </section>
              <section data-testid="members" className="border-b border-border px-3 py-3">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Members</h2>
                <p className="mt-2 text-sm text-muted-foreground">Just you and {bot?.name || "this teammate"}.</p>
              </section>
              <Tabs value={detailTab} onValueChange={setDetailTab} className="flex flex-col">
                <TabsList aria-label="Bot details" className="mx-1 h-auto w-auto justify-start gap-0 overflow-x-auto rounded-none bg-transparent p-0">
                  {INFO_TABS.map(([value, label]) => (
                    <TabsTrigger
                      key={value}
                      value={value}
                      className="min-h-11 shrink-0 rounded-none border-b border-transparent px-2.5 shadow-none data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                    >
                      {label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <div className="px-3 pb-6">
                  <TabsContent value="overview">
                    <div className="flex flex-col gap-2 text-sm">
                      <p>{bot?.role || "No title yet."}</p>
                      <p className="text-muted-foreground">{bot?.instructions || "No description yet."}</p>
                      <p className="text-muted-foreground">Provider: {provider || "unknown"}</p>
                      {provider.toLowerCase() === "mock" ? <p>Provider is mock. This teammate is not calling OpenRouter.</p> : null}
                    </div>
                  </TabsContent>
                  <TabsContent value="computer">
                    <p className="text-sm text-muted-foreground">The live desktop is above. Click it to open the full view, where you can take control.</p>
                    <div className="mt-3 rounded-lg border border-border p-3">
                      <p className="text-sm font-medium">Teach a task</p>
                      <p className="mt-1 text-xs text-muted-foreground">Show {bot?.name || "your teammate"} how it is done on the desktop. It records the screen, then learns the steps as a reusable skill and deletes the video.</p>
                      <Button type="button" data-testid="teach-start" size="sm" className="mt-2" disabled={teach.busy || teach.recording} onClick={() => void teach.start()}>Teach a task</Button>
                    </div>
                  </TabsContent>
                  <TabsContent value="library">
                    <LibraryPane botId={botId} botName={bot?.name || "Teammate"} botShape={bot?.avatarShape} botColor={bot?.avatarColor} />
                    <div className="mt-5 border-t border-border pt-4">
                      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Manage files</h3>
                      <FilesPane botId={botId} files={files.items} error={files.error} loaded={files.loaded} onChanged={() => void loadAux(["files"])} />
                      <ArtifactsPane artifacts={artifacts.items} error={artifacts.error} loaded={artifacts.loaded} onRetry={() => void loadAux(["artifacts"])} />
                    </div>
                  </TabsContent>
                  <TabsContent value="files">
                    <div className="flex flex-col gap-6">
                      <FilesPane botId={botId} files={files.items} error={files.error} loaded={files.loaded} onChanged={() => void loadAux(["files"])} />
                      <ArtifactsPane artifacts={artifacts.items} error={artifacts.error} loaded={artifacts.loaded} onRetry={() => void loadAux(["artifacts"])} />
                    </div>
                  </TabsContent>
                  <TabsContent value="skills">
                    <SkillsPane botId={botId} skills={skills.items} error={skills.error} loaded={skills.loaded} onChanged={() => void loadAux(["skills"])} />
                  </TabsContent>
                  <TabsContent value="memory">
                    <MemoryPane botId={botId} memories={memories.items} error={memories.error} loaded={memories.loaded} onChanged={() => void loadAux(["memories"])} focusMemoryId={memoryFocusId} onFocused={() => setMemoryFocusId(undefined)} />
                  </TabsContent>
                  <TabsContent value="tasks">
                    <TasksPane botId={botId} tasks={workspace.tasks ?? []} openrouterConnected={workspace.openrouterConnected !== false} onChanged={() => void loadWorkspace()} />
                  </TabsContent>
                  <TabsContent value="plugins">
                    <PluginsPane />
                  </TabsContent>
                </div>
              </Tabs>
            </div>
          )}
        </aside>
      ) : null}
      </div>
    </div>
  );
}

function BotSettings({
  botId,
  name,
  role,
  instructions,
  model,
  avatar,
  avatarShape,
  avatarColor,
  notifications,
  peerMessaging,
  onClose,
  onSaved,
}: {
  botId: string;
  name: string;
  role: string;
  instructions: string;
  model: string;
  avatar: string;
  avatarShape: string;
  avatarColor: string;
  notifications: boolean;
  peerMessaging: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState({ name, role, instructions, model, avatar, avatarShape, avatarColor, notifications, peerMessaging });
  const [budgetSteps, setBudgetSteps] = useState(200);
  const [budgetMinutes, setBudgetMinutes] = useState(60);
  const [pauseOnBudget, setPauseOnBudget] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [budgetSaved, setBudgetSaved] = useState(false);

  useEffect(() => {
    let active = true;
    api<{ maxSteps: number; maxSeconds: number; pauseOnBudget: boolean }>(`/api/bots/${botId}/work-settings`)
      .then(settings => {
        if (!active) return;
        setBudgetSteps(settings.maxSteps);
        setBudgetMinutes(Math.max(1, Math.ceil(settings.maxSeconds / 60)));
        setPauseOnBudget(settings.pauseOnBudget);
      })
      .catch(caught => {
        if (active) setBudgetError(errorMessage(caught, "Could not load work settings."));
      });
    return () => { active = false; };
  }, [botId]);

  async function saveBudget() {
    setBudgetError(null);
    setBudgetSaved(false);
    const values = clampWorkBudget(Number(budgetSteps), Number(budgetMinutes));
    setBudgetSteps(values.maxSteps);
    setBudgetMinutes(values.maxMinutes);
    try {
      await api(`/api/bots/${botId}/work-settings`, {
        method: "PATCH",
        body: JSON.stringify({ maxSteps: values.maxSteps, maxSeconds: values.maxMinutes * 60, pauseOnBudget }),
      });
      setBudgetSaved(true);
    } catch (caught) {
      setBudgetError(errorMessage(caught, "Could not save work budget."));
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api(`/api/bots/${botId}`, { method: "PATCH", body: JSON.stringify(draft) });
      onSaved();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught, "Could not save teammate settings."));
    }
  }

  return (
    <form data-testid="bot-settings" className="grid gap-3 overflow-y-auto px-4 py-3" onSubmit={save}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Teammate settings</p>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Back
        </Button>
      </div>
      <p className="text-sm font-medium">Avatar</p>
      <BotAvatarPicker botId={botId} shape={draft.avatarShape} color={draft.avatarColor} onChange={(shape, color) => setDraft({ ...draft, avatarShape: shape, avatarColor: color })} />
      <Label htmlFor="settings-name">Name</Label>
      <Input id="settings-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required />
      <Label htmlFor="settings-title">Title</Label>
      <Input id="settings-title" value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} />
      <Label htmlFor="settings-description">Description</Label>
      <Textarea id="settings-description" value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} />
      <Label htmlFor="settings-model">Model</Label>
      <Input id="settings-model" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="anthropic/claude-haiku-5.5" />
      <div className="flex items-center justify-between gap-3 text-sm">
        <Label htmlFor="settings-notifications">Notifications</Label>
        <Switch
          id="settings-notifications"
          checked={draft.notifications}
          onCheckedChange={(checked) => setDraft({ ...draft, notifications: checked })}
        />
      </div>
      <div className="flex items-center justify-between gap-3 text-sm">
        <Label htmlFor="settings-peer-messaging" className="min-w-0">Message other teammates<span className="block text-xs font-normal text-muted-foreground">You still approve each new conversation.</span></Label>
        <Switch
          id="settings-peer-messaging"
          data-testid="settings-peer-messaging"
          checked={draft.peerMessaging}
          onCheckedChange={(checked) => setDraft({ ...draft, peerMessaging: checked })}
        />
      </div>
      <section className="grid gap-3 border-t border-border pt-3" aria-labelledby="work-budget-heading">
        <div>
          <h3 id="work-budget-heading" className="text-sm font-medium">Long-running work</h3>
          <p className="text-xs text-muted-foreground">Limits apply to each task. Steps: 4–1,000 · Minutes: 1–360.</p>
        </div>
        <Label htmlFor="work-budget-steps">Max steps</Label>
        <Input id="work-budget-steps" data-testid="work-budget-steps" type="number" min={WORK_BUDGET_LIMITS.steps.min} max={WORK_BUDGET_LIMITS.steps.max} step={1} value={budgetSteps} onChange={event => setBudgetSteps(Number(event.target.value))} />
        <Label htmlFor="work-budget-minutes">Max minutes</Label>
        <Input id="work-budget-minutes" data-testid="work-budget-minutes" type="number" min={WORK_BUDGET_LIMITS.minutes.min} max={WORK_BUDGET_LIMITS.minutes.max} step={1} value={budgetMinutes} onChange={event => setBudgetMinutes(Number(event.target.value))} />
        <div className="flex items-center justify-between gap-3 text-sm">
          <Label htmlFor="work-budget-pause">Pause when the budget is reached</Label>
          <Switch id="work-budget-pause" data-testid="work-budget-pause" checked={pauseOnBudget} onCheckedChange={setPauseOnBudget} />
        </div>
        <p className="text-xs text-muted-foreground">Current budget: {clampWorkBudget(Number(budgetSteps), Number(budgetMinutes)).maxSteps} steps · {clampWorkBudget(Number(budgetSteps), Number(budgetMinutes)).maxMinutes} min</p>
        {budgetError ? <p role="alert" className="text-sm text-destructive">{budgetError}</p> : null}
        {budgetSaved ? <p role="status" className="text-sm text-muted-foreground">Work budget saved.</p> : null}
        <Button type="button" data-testid="work-budget-save" size="sm" onClick={() => void saveBudget()}>Save work budget</Button>
      </section>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" size="sm">
        Save
      </Button>
    </form>
  );
}

function BioField({ botId, bio, onSaved }: { botId: string; bio: string; onSaved: () => void }) {
  const [value, setValue] = useState(bio);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setValue(bio), [bio]);
  async function save() {
    const next = value.replace(/\s+/g, " ").trim();
    if (next === bio) { setError(null); return; }
    try {
      await api(`/api/bots/${botId}`, { method: "PATCH", body: JSON.stringify({ bio: next }) });
      setError(null);
      onSaved();
      window.dispatchEvent(new Event("teammates-bots-changed"));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save."); setValue(bio); }
  }
  return <div className="w-full text-center">
    <input data-testid="bot-bio" aria-label="Bot title" maxLength={60} value={value} placeholder="Add a title"
      onChange={event => setValue(event.target.value)} onBlur={() => void save()}
      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); (event.target as HTMLInputElement).blur(); } if (event.key === "Escape") { event.stopPropagation(); setValue(bio); (event.target as HTMLInputElement).blur(); } }}
      className="w-full truncate rounded-md bg-transparent px-2 py-1 text-center text-sm text-muted-foreground placeholder:text-muted-foreground/60 hover:bg-bot-soft focus:bg-bot-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
  </div>;
}
