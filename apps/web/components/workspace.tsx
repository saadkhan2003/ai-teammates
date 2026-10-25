"use client";

import { Hash, Info, Plug, Settings, Share, Users, X } from "lucide-react";
import { frameBatch, mergeRows, patchWorkspace } from "@/lib/event-patches";
import { streamIsOpen } from "@/lib/events";
import { Lru } from "@/lib/chat-speed";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Approvals } from "@/components/approvals";
import { PluginsPane } from "@/components/plugins-pane";
import { ChatPane } from "@/components/chat-pane";
import { CodingPanel, JobDetailDialog } from "@/components/coding-jobs";
import { LoginCard } from "@/components/login-card";
import { FilesPane } from "@/components/files-pane";
import { LibraryList } from "@/components/library-list";
import { MemoryPane } from "@/components/memory-pane";
import { LearnedSection } from "@/components/learned-section";
import { CodingSection } from "@/components/coding-section";
import { RoutinesSection } from "@/components/routines-section";
import { SkillsPane } from "@/components/skills-pane";
import { StateMessage } from "@/components/state-message";
import { TasksPane } from "@/components/tasks-pane";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChatSkeleton, ListSkeleton, Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, normalizeArtifacts, normalizeFiles, normalizeMemories, normalizeRoutines, normalizeSkills } from "@/lib/api";
import { applyCodingJob, copyBotName, normalizeCodingJob, readableAccent, templateShareUrl, type CodingJob } from "@/lib/chat-ui";
import { mergeAgentEvent, parseAgentEvent, subscribeEvents, type AgentEvent } from "@/lib/events";
import { StatusBadge } from "@/lib/status";
import { REFRESH_EVENT, useConnection } from "@/lib/connection";
import type { Artifact, FileEntry, LoginRequest, MemoryItem, Routine, SecretRequest, Skill, Workspace as WorkspaceData } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { toast } from "sonner";
import { PanelCard, PanelEmpty, PanelSection } from "@/components/panel-section";
import { AppLogo } from "@/components/app-logo";
import { BotAvatar } from "@/components/bot-avatar";
import { BotAvatarPicker } from "@/components/bot-avatar-picker";
import { FileCard } from "@/components/file-card";
import { publishBotAppearance, resolveBotAppearance } from "@/lib/bot-appearance";
import { isConnected, readInstalledApps, type InstalledApp } from "@/lib/connect-apps";
import type { AppLink } from "@/lib/app-links";
import type { LibraryFilter } from "@/lib/library";

function isFileArtifact(artifact: Artifact) {
  return Boolean(artifact.mime) || /\.[a-z0-9]{2,8}$/i.test(artifact.name);
}
import { defaultBotAvatar } from "@/lib/avatars";
import { HISTORY_PAGE, mergeHistory } from "@/lib/history";
import { clampWorkBudget, WORK_BUDGET_LIMITS } from "@/lib/work-budget";
import type { ChatMessage } from "@/lib/types";
import { RefreshNotice } from "@/components/refresh-notice";
import { PageCanvasHost } from "@/components/page-canvas";
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

function normalizeWorkspace(data: WorkspaceData & { openrouterConnected?: boolean }): WorkspaceData {
  return {
    ...data,
    tasks: data.tasks ?? [],
    messages: data.messages ?? [],
    approvals: data.approvals ?? [],
    secretRequests: data.secretRequests ?? [],
    loginRequests: data.loginRequests ?? [],
    pages: data.pages ?? [],
    holder: data.holder === "human" ? "human" : "agent",
    aiConnected: data.aiConnected ?? data.openrouterConnected,
    codingJobs: (data.codingJobs ?? []).map((job, index) => normalizeCodingJob(job, index)).filter((job): job is CodingJob => job !== null),
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
  ["details", "Details"],
  ["library", "Library"],
  ["computer", "Computer"],
] as const;

const LIBRARY_TABS = [
  ["files", "Files"],
  ["routines", "Routines"],
  ["skills", "Skills"],
  ["memory", "Memory"],
  ["tasks", "Tasks"],
  ["plugins", "Plugins"],
] as const;

const workspaceCache = new Lru<string, WorkspaceData>(10);
if (typeof window !== "undefined") window.addEventListener("teammates-session-reset", () => workspaceCache.clear());

export function Workspace({ botId }: { botId: string }) {
  const router = useRouter();
  const [connectedApps, setConnectedApps] = useState<InstalledApp[]>([]);
  const [workspaceState, setWorkspace] = useState<WorkspaceData | null>(() => workspaceCache.get(botId) ?? null);
  const workspace = workspaceState?.bot.id === botId ? workspaceState : workspaceCache.get(botId) ?? null;
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
  const [readyForBot, setReadyForBot] = useState<string | null>(() => workspaceCache.get(botId) ? botId : null);
  const ready = readyForBot === botId;
  const [files, setFiles] = useState<ListState<FileEntry>>(emptyList);
  const [memories, setMemories] = useState<ListState<MemoryItem>>(emptyList);
  const [skills, setSkills] = useState<ListState<Skill>>(emptyList);
  const [routines, setRoutines] = useState<ListState<Routine>>(emptyList);
  const [routineEditRequest, setRoutineEditRequest] = useState<{ key: number; text: string } | undefined>();
  const [artifacts, setArtifacts] = useState<ListState<Artifact>>(emptyList);
  const [detailTab, setDetailTab] = useState("details");
  const [librarySection, setLibrarySection] = useState("files");
  const [libraryType, setLibraryType] = useState<LibraryFilter>("All");
  const [openJob, setOpenJob] = useState<CodingJob | null>(null);
  const [memoryFocusId, setMemoryFocusId] = useState<string | undefined>();
  const [finishedLogins, setFinishedLogins] = useState<LoginRequest[]>([]);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [llmConnected, setLlmConnected] = useState<boolean | null>(null);
  const connection = useConnection();
  const taskIds = useRef(new Set<string>());
  const seq = useRef(0);
  const patchSeq = useRef(0);
  const auxSeq = useRef(0);
  const tabRef = useRef(detailTab);
  const libraryRef = useRef(librarySection);
  tabRef.current = detailTab;
  libraryRef.current = librarySection;

  useEffect(() => {
    const onLink = (event: Event) => {
      const detail = (event as CustomEvent<AppLink>).detail;
      if (!detail || detail.kind !== "panel") return;
      setLibraryType(detail.id === "pages" ? "Pages" : "All");
      setPane(true);
      setSettingsOpen(false);
      setDesktopFull(false);
      const libraryTabs = ["files", "memory", "skills", "tasks", "plugins", "routines"];
      if (libraryTabs.includes(detail.tab)) {
        setDetailTab("library");
        setLibrarySection(detail.tab);
      } else setDetailTab(detail.tab === "overview" ? "details" : detail.tab);
      if (detail.section) setLibrarySection(detail.section);
    };
    window.addEventListener("teammates-app-link", onLink);
    return () => window.removeEventListener("teammates-app-link", onLink);
  }, []);

  const loadWorkspace = useCallback(async () => {
    const ticket = ++seq.current;
    const patchesBefore = patchSeq.current;
    try {
      let data = normalizeWorkspace(await api<WorkspaceData>(`/api/bots/${botId}/workspace`));
      if (ticket !== seq.current) return;
      // A live patch that landed while this snapshot was in flight is newer than it:
      // keep rows the snapshot does not have yet instead of dropping them.
      const live = workspaceRef.current;
      if (patchSeq.current !== patchesBefore && live && live.bot.id === data.bot.id) {
        const messageIds = new Set(data.messages.map(row => row.id));
        const taskIds = new Set(data.tasks.map(row => row.id));
        data = { ...data,
          messages: mergeRows(data.messages, live.messages.filter(row => !messageIds.has(row.id))),
          tasks: mergeRows(data.tasks, live.tasks.filter(row => !taskIds.has(row.id))) };
      }
      taskIds.current = new Set(data.tasks.map(task => task.id));
      workspaceCache.set(botId, data);
      setWorkspace(data);
      const activeTasks = new Set(data.tasks.filter(task => ["running", "planning", "queued"].includes((task.status ?? "").toLowerCase())).map(task => task.id));
      setAgentEvents(current => current.filter(event => event.type !== "video_progress" || (typeof event.taskId === "string" && activeTasks.has(event.taskId))));
      setWorkspaceError(null);
    } catch (caught) {
      if (ticket !== seq.current) return;
      setWorkspaceError(errorMessage(caught, "Could not load this workspace."));
    } finally {
      if (ticket === seq.current) setReadyForBot(botId);
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
    setReadyForBot(workspaceCache.get(botId) ? botId : null);
    setAgentEvents([]);
    taskIds.current = new Set();
    setLlmConnected(null);
    api<Record<string, unknown>>("/api/system/llm-status").then(status => {
      const connected = status.aiConnected ?? status.connected ?? status.configured ?? status.hasKey ?? status.openrouterConnected;
      if (typeof connected === "boolean") setLlmConnected(connected);
    }).catch(() => undefined);
    setWorkspace(workspaceCache.get(botId) ?? null);
    setWorkspaceError(null);
    const desktop = window.matchMedia("(min-width: 768px)").matches;
    let stored: string | null = null;
    try { stored = window.localStorage.getItem("teammates-pane"); } catch { /* storage unavailable */ }
    setPaneRaw(desktop && stored !== "closed");
    void loadWorkspace();
    void api<unknown>("/api/plugins")
      .then((data) => setConnectedApps(readInstalledApps(data).filter(isConnected)))
      .catch(() => setConnectedApps([]));
    void loadAux(["artifacts", "routines"]);
    const preload = window.setTimeout(() => {
      void import("@novnc/novnc/lib/rfb.js");
    }, 1500);
    const batch = frameBatch<AgentEvent>(events => {
      setAgentEvents(current => events.reduce((list, event) => mergeAgentEvent(list, event), current));
    }, requestAnimationFrame, cancelAnimationFrame);
    let peerTimer: number | undefined;
    const peerRefresh = () => {
      if (peerTimer !== undefined) return;
      peerTimer = window.setTimeout(() => { peerTimer = undefined; void loadWorkspace(); }, 250);
    };
    const stopEvents = subscribeEvents((data) => {
      const event = parseAgentEvent(data);
      const type = event?.type ?? "";
      if (type === "coding.job" && event?.botId === botId) {
        const job = normalizeCodingJob(event.job);
        if (job) {
          setWorkspace((current) => {
            if (!current) return current;
            const existing = (current.codingJobs ?? []).map((item, index) => normalizeCodingJob(item, index)).filter((item): item is CodingJob => item !== null);
            return { ...current, codingJobs: applyCodingJob(existing, job) };
          });
        }
      }
      if (!event || event.type === "notification.created") return;
      if (["message.delta", "tool.delta", "model.started", "model.finished", "model.error"].includes(event.type)) return;
      const belongs = event.botId === botId || (typeof event.taskId === "string" && taskIds.current.has(event.taskId));
      if (event.botId && !belongs) {
        // A peer's approval (or its resolution) can surface here as a relayed card; re-read only then.
        const relays = (workspaceRef.current?.botThreads?.length ?? 0) > 0 || (workspaceRef.current?.approvals ?? []).some(a => a.relayed);
        if (relays && ["approval", "task", "bot_thread"].includes(event.type)) peerRefresh();
        return;
      }
      if (belongs && ["grounding", "tool", "tool_call", "tool_result", "tool.delta", "delta", "message.delta", "text_delta", "memory", "model.started", "model.finished", "model.error", "task.started", "video_progress"].includes(event.type)) {
        const detail = event.detail && typeof event.detail === "object" ? event.detail as Record<string, unknown> : {};
        batch.push({ ...event, ...detail, type: event.type });
      }
      if (belongs && event.type === "task" && ["completed", "failed", "cancelled"].includes(String(event.status ?? "").toLowerCase())) {
        setAgentEvents(current => current.filter(item => !(item.type === "video_progress" && item.taskId === event.taskId)));
      }
      const current = workspaceRef.current;
      const patched = current ? patchWorkspace(current, event) : null;
      if (patched) {
        if (patched !== current) {
          taskIds.current = new Set(patched.tasks.map(task => task.id));
          workspaceRef.current = patched;
          patchSeq.current++;
          workspaceCache.set(botId, patched);
          setWorkspace(patched);
        }
      } else if (!["message.delta", "tool.delta", "model.started", "model.finished", "model.error"].includes(event.type)) void loadWorkspace();
      if (event.type === "memory" && belongs) void loadAux(["memories"]);
      if (["artifact", "task"].includes(event.type) && belongs) {
        const extra: Array<"files" | "memories" | "skills" | "routines" | "artifacts"> = ["artifacts", "routines"];
        const tab = tabRef.current;
        if (tab === "files") extra.push("files");
        if (tab === "memory") extra.push("memories");
        if (tab === "skills") extra.push("skills");
        const section = libraryRef.current;
        if (tab === "library" && section === "files") extra.push("files");
        if (tab === "library" && section === "memory") extra.push("memories");
        if (tab === "library" && section === "skills") extra.push("skills");
        void loadAux(extra);
      }
    });
    const slow = window.setInterval(() => {
      if (streamIsOpen()) return;
      void loadWorkspace();
      void loadAux(["artifacts", "routines"]);
    }, 15_000);
    return () => {
      batch.stop();
      window.clearTimeout(preload);
      if (peerTimer !== undefined) window.clearTimeout(peerTimer);
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
        // A dialog, popover or menu already handled this Escape (Radix calls preventDefault when it dismisses);
        // closing that layer must not also close the info pane behind it.
        if (event.defaultPrevented || document.querySelector("[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open'], [role='menu']")) return;
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
    const current = workspace?.bot;
    publishBotAppearance(current?.id || botId, current?.avatarShape, current?.avatarColor);
  }, [workspace?.bot, botId]);

  useEffect(() => {
    if (!pane) return;
    if (detailTab === "files") void loadAux(["files", "artifacts"]);
    if (detailTab === "memory") void loadAux(["memories"]);
    if (detailTab === "skills") void loadAux(["skills"]);
    if (detailTab === "details" || (detailTab === "library" && librarySection === "routines")) void loadAux(["routines"]);
    if (detailTab === "library" && librarySection === "files") void loadAux(["files", "artifacts"]);
    if (detailTab === "library" && librarySection === "memory") void loadAux(["memories"]);
    if (detailTab === "library" && librarySection === "skills") void loadAux(["skills"]);
  }, [pane, detailTab, librarySection, loadAux]);

  const teach = useTeachTask({
    botId,
    conversationId: workspace?.conversationId,
    onBegin: () => { setPane(true); setDetailTab("computer"); setDesktopFull(true); setAutoControlKey(value => value + 1); },
    onEnd: () => setHandBackKey(value => value + 1),
    onSent: () => void loadWorkspace(),
  });

  useEffect(() => {
    const startTeaching = () => {
      if (teach.busy || teach.recording) return;
      void teach.start();
    };
    window.addEventListener("teammates-teach-task", startTeaching);
    return () => window.removeEventListener("teammates-teach-task", startTeaching);
  }, [teach.busy, teach.recording, teach.start]);

  if (!ready && !workspace) {
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

  const bot = workspace.bot;
  const requests = (workspace.secretRequests ?? []) as SecretRequest[];
  const look = resolveBotAppearance(bot?.id || botId, bot?.avatarShape, bot?.avatarColor);
  const accent = readableAccent(look.color);
  const avatarShape = look.shape;
  const avatarColor = look.color;
  const jobs = (workspace.codingJobs ?? []).map((job, index) => normalizeCodingJob(job, index)).filter((job): job is CodingJob => job !== null);

  async function createCopy() {
    try {
      const created = await api<{ id?: string }>("/api/bots", {
        method: "POST",
        body: JSON.stringify({
          name: copyBotName(bot?.name || "Teammate"),
          role: bot?.role || "",
          instructions: bot?.instructions || "",
          avatarShape,
          avatarColor,
        }),
      });
      toast.success("Copy created.");
      window.dispatchEvent(new Event("teammates-bots-changed"));
      if (created?.id) router.push(`/bots/${created.id}`);
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not create a copy."));
    }
  }

  async function shareTemplate() {
    const url = templateShareUrl(window.location.origin, botId);
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Template link copied.");
    } catch {
      toast.error("Could not copy the template link.");
    }
  }

  function toggleRoutine(routine: (typeof routines.items)[number], enabled: boolean) {
    setRoutines((current) => ({ ...current, items: current.items.map((item) => (item.id === routine.id ? { ...item, enabled } : item)) }));
    void api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }).catch((caught) => {
      setRoutines((current) => ({ ...current, items: current.items.map((item) => (item.id === routine.id ? { ...item, enabled: !enabled } : item)) }));
      setWorkspaceError(errorMessage(caught, "Could not update that routine."));
    });
  }


  return (
    <div className="flex h-full min-h-0 [&_button]:rounded-control">
      {teach.startedAt ? <RecordingBanner botName={bot?.name || "Teammate"} shape={bot?.avatarShape} color={bot?.avatarColor} startedAt={teach.startedAt} onCancel={() => void teach.cancel()} /> : null}
      <section className="relative flex min-w-0 flex-1 flex-col">
        <div aria-hidden data-testid="chat-top-fade" data-radius-allow="fade" className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 bg-gradient-to-b from-background to-transparent" />
        <header data-testid="chat-pill-bar" className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
          <button
            type="button"
            data-testid="bot-name-button"
            aria-expanded={pane}
            aria-controls="info-pane"
            aria-label={`${bot?.name || "Teammate"} details`}
            className="pointer-events-auto inline-flex h-9 max-w-[70%] items-center gap-2 rounded-full border border-border bg-card pl-1.5 pr-3 text-ui font-medium text-card-foreground shadow-[var(--shadow-pill)] transition-[box-shadow] duration-200 hover:shadow-[var(--shadow-pill-hover)]"
            onClick={() => togglePane()}
          >
            <BotAvatar animated botId={bot?.id || botId} shape={avatarShape} color={avatarColor} size={24} primary={bot?.isPrimary} />
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
          onOpenTask={() => { setDetailTab("library"); setLibrarySection("tasks"); setPaneRaw(true); }}
          onEditMemory={(id) => { setMemoryFocusId(id); setDetailTab("library"); setLibrarySection("memory"); setPaneRaw(true); }}
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
          accent={accent}
          avatarShape={avatarShape}
          avatarColor={avatarColor}
          codingJobs={(workspace.codingJobs ?? []).map((job, index) => normalizeCodingJob(job, index)).filter((job): job is CodingJob => job !== null)}
          onOpenJob={setOpenJob}
          avatar={{ shape: bot?.avatarShape || defaultBotAvatar(bot?.id || botId).shape, color: bot?.avatarColor || defaultBotAvatar(bot?.id || botId).color, primary: bot?.isPrimary }}
          botThreads={workspace.botThreads ?? []}
          taskTitle={(workspace.tasks ?? []).find(task => ["running", "planning"].includes((task.status ?? "").toLowerCase()))?.title}
          activeTaskId={(workspace.tasks ?? []).find(task => ["running", "planning", "waiting_human"].includes((task.status ?? "").toLowerCase()))?.id}
          evidenceTaskId={(workspace.tasks ?? []).find(task => ["running", "planning", "waiting_human"].includes((task.status ?? "").toLowerCase()))?.id ?? (workspace.tasks ?? [])[0]?.id}
          onSent={() => void loadWorkspace()}
          working={(workspace.tasks ?? []).some((task) => ["running", "planning", "queued"].includes((task.status ?? "").toLowerCase()))}
          extras={
            <>
              {(llmConnected ?? workspace.aiConnected) === false ? (
                <p data-testid="llm-key-banner" className="rounded-md border border-border bg-card px-3 py-2 text-body-sm">
                  <Link href="/settings/secrets" className="font-medium text-brand">
                    Contact your administrator to connect AI
                  </Link>
                  <span className="text-muted-foreground"> — tasks wait until a key is saved.</span>
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
                  <p className="text-body-sm font-medium">Done ✓</p>
                  <p className="mt-1 break-words text-body-sm text-muted-foreground">{request.domain}</p>
                </article>
              ))}
              {requests.map((request) => (
                <article key={request.id} data-testid="secret-request-card" className="min-w-0 max-w-full break-words rounded-lg border border-border bg-card px-3 py-2 text-body-sm">
                  <p className="font-medium">Secret request</p>
                  <p className="text-muted-foreground">{request.suggestedRef || request.type}</p>
                  {request.reason ? <p className="mt-1">{request.reason}</p> : null}
                  <Link href="/settings/secrets" className="mt-2 inline-block text-brand">
                    Open vault
                  </Link>
                </article>
              ))}
              {(workspace.tasks ?? []).slice(0, 3).map((task) => (
                <article key={task.id} data-testid="task-card" className="min-w-0 max-w-full rounded-lg border border-border bg-card px-3 py-2 text-body-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate font-medium">{task.title || task.instruction}</p>
                    <StatusBadge status={task.status} />
                  </div>
                  {task.status === "failed" && task.error ? <p role="alert" data-testid="task-error" className="mt-2 whitespace-pre-wrap text-destructive">{task.error}</p> : null}
                </article>
              ))}
              {(artifacts.items ?? []).filter(isFileArtifact).slice(0, 2).map((artifact) => (
                <FileCard
                  key={artifact.id}
                  testId="artifact-card"
                  name={artifact.name}
                  url={`/api/artifacts/${artifact.id}/download`}
                  mime={artifact.mime}
                  size={artifact.size}
                />
              ))}
            </>
          }
        />
        <JobDetailDialog job={openJob} accent={accent} onClose={() => setOpenJob(null)} />
      </section>
      <PageCanvasHost botId={botId} onOpen={() => { setPaneRaw(false); setSettingsOpen(false); }} />
      <div className={cn("contents md:block md:shrink-0 md:overflow-hidden", pane ? "md:w-[320px] md:max-w-[42vw]" : "md:w-0")}>
      {paneMounted ? (
        <aside
          id="info-pane"
          data-testid="info-pane"
          data-view={detailTab}
          data-radius-allow="pane"
          data-divider="panel"
          style={{ ["--bot-accent" as string]: accent }}
          data-state={pane ? "open" : "closed"}
          aria-hidden={pane ? undefined : true}
          className={cn("fixed inset-0 z-30 flex w-full min-w-0 flex-col border-border bg-sidebar text-sidebar-foreground pt-[env(safe-area-inset-top)] transition-opacity duration-200 motion-reduce:transition-none md:static md:z-0 md:w-[320px] md:max-w-[42vw] md:border-l md:pt-0", !pane && "pointer-events-none opacity-0 max-md:hidden")}
        >
          <RefreshNotice variant="panel" />
          <div className="flex h-11 items-center justify-end gap-1 px-2">
            <ShareMenu botId={botId} onCreated={() => window.dispatchEvent(new Event("teammates-bots-changed"))} />
            <Button
              type="button"
              data-testid="bot-settings-gear"
              variant="ghost"
              size="icon"
              className="size-8 rounded-md"
              aria-label="Teammate settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" data-testid="info-share" variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Share">
                  <Share />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent data-testid="info-share-menu" align="end">
                <DropdownMenuItem data-testid="share-create-copy" onSelect={() => void createCopy()}>
                  Create a copy
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="share-template-link" onSelect={() => void shareTemplate()}>
                  Share a template link
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              data-testid="info-pane-close"
              variant="ghost"
              size="icon"
              className="size-8 rounded-full"
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
              avatar={(bot as { avatar?: string } | undefined)?.avatar || ""}
              avatarShape={avatarShape}
              avatarColor={avatarColor}
              notifications={(bot as { notificationsEnabled?: boolean } | undefined)?.notificationsEnabled !== false}
              peerMessaging={bot?.peerMessaging !== false}
              onClose={() => setSettingsOpen(false)}
              onSaved={() => void loadWorkspace()}
            />
          ) : (
            <div className={cn("min-h-0 w-full min-w-0 flex-1 overflow-y-auto", desktopFull && "overflow-visible")}>
              <div data-testid="panel-identity">
                <div data-testid="info-identity" className="flex flex-col items-center px-3 pb-3 text-center">
                  <BotAvatar animated botId={bot?.id || botId} shape={avatarShape} color={avatarColor} size={64} primary={bot?.isPrimary} />
                  <p data-testid="info-bot-name" className="type-title mt-2">{bot?.name || "Teammate"}</p>
                  <p data-testid="info-bot-title" className="type-caption max-w-full truncate px-2">{bot?.role || "No title yet."}</p>
                  <BioField botId={botId} bio={bot?.bio ?? ""} onSaved={() => void loadWorkspace()} />
                </div>
              </div>
              <Tabs
                value={detailTab}
                onValueChange={(value) => {
                  setDetailTab(value);
                  if (value !== "computer") setDesktopFull(false);
                }}
                className="flex w-full min-w-0 flex-col"
              >
                <TabsList aria-label="Bot details" className="mx-4 grid h-[34px] w-[calc(100%-2rem)] grid-cols-3 items-center gap-0.5 self-center rounded-md bg-[var(--track)] p-[3px]">
                  {INFO_TABS.map(([value, label]) => (
                    <TabsTrigger key={value} value={value} className="info-tab h-7 min-h-0 w-full min-w-0 justify-center overflow-hidden rounded-full border border-transparent px-3 text-ui font-medium leading-none text-muted-foreground shadow-none transition-[background-color,box-shadow,color] duration-200 data-[state=active]:border-border data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-[0_1px_2px_rgba(0,0,0,0.16)]">
                      {label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <TabsContent value="overview"><p>{bot?.role}</p><p>{bot?.instructions}</p></TabsContent>
                <TabsContent value="skills"><SkillsPane botId={botId} skills={skills.items} loaded={skills.loaded} error={skills.error} onChanged={() => void loadAux(["skills"])} /></TabsContent>
                <TabsContent value="memory"><MemoryPane botId={botId} memories={memories.items} loaded={memories.loaded} error={memories.error} onChanged={() => void loadAux(["memories"])} focusMemoryId={memoryFocusId} onFocused={() => setMemoryFocusId(undefined)} /></TabsContent>
                <TabsContent value="tasks"><TasksPane botId={botId} tasks={workspace.tasks} aiConnected={workspace.aiConnected !== false} onChanged={() => void loadWorkspace()} /></TabsContent>
                <TabsContent value="plugins"><PluginsPane /></TabsContent>
                <TabsContent value="details" className="mt-4 flex flex-col gap-6 px-4 pb-6">
                  <CodingPanel
                    jobs={jobs}
                    routines={routines.items}
                    accent={accent}
                    botId={botId}
                    avatarShape={avatarShape}
                    avatarColor={avatarColor}
                    onOpenJob={setOpenJob}
                    onToggleRoutine={toggleRoutine}
                  />
                  <PanelSection title="About">
                    {bot?.instructions ? (
                      <PanelCard className="px-3 py-3">
                        <p className="type-body text-card-foreground">{bot.instructions}</p>
                      </PanelCard>
                    ) : (
                      <PanelEmpty icon={Info} title="No description yet" detail="Add a short description in teammate settings." />
                    )}
                  </PanelSection>
                  <CodingSection botId={botId} />
                  <LearnedSection key={botId} botId={botId} onOpenMessage={() => { if (!window.matchMedia("(min-width: 768px)").matches) setPane(false); }} />
                  <PanelSection title="Connect apps" testId="connect-apps">
                    {connectedApps.length === 0 ? (
                      <PanelEmpty
                        icon={Plug}
                        title="No apps connected"
                        detail="Plugins and skills you add show up here."
                        action={
                          <Button type="button" size="sm" onClick={() => window.dispatchEvent(new Event("teammates-open-connect-apps"))}>
                            <Plug />
                            Connect apps
                          </Button>
                        }
                      />
                    ) : (
                      <PanelCard>
                        <ul>
                          {connectedApps.map((app) => (
                            <li key={app.id} data-testid="connected-app-row" className="flex min-h-11 items-center gap-2 px-3">
                              <AppLogo name={app.name} iconUrl={app.iconUrl} size={28} />
                              <span className="min-w-0 flex-1">
                                <span className="type-body block truncate font-medium">{app.name}</span>
                                <span className="type-caption block">Connected</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </PanelCard>
                    )}
                  </PanelSection>
                  <PanelSection title="Channels" testId="channels">
                    <PanelEmpty icon={Hash} title="No channels" detail="Group chats will list them here." />
                  </PanelSection>
                  <PanelSection title="Members" testId="members">
                    <PanelCard>
                      <ul>
                        <li className="flex min-h-11 items-center gap-2 px-3">
                          <span className="grid size-7 place-items-center rounded-full bg-muted text-micro font-medium text-muted-foreground">
                            <Users className="size-3.5" strokeWidth={1.5} aria-hidden />
                          </span>
                          <span className="type-body font-medium">You</span>
                        </li>
                        <li className="flex min-h-11 items-center gap-2 px-3">
                          <BotAvatar botId={bot?.id || botId} shape={avatarShape} color={avatarColor} size={28} />
                          <span className="min-w-0">
                            <span className="type-body block truncate font-medium">{bot?.name || "Teammate"}</span>
                            <span className="type-caption block">Teammate</span>
                          </span>
                        </li>
                      </ul>
                    </PanelCard>
                  </PanelSection>
                </TabsContent>
                <TabsContent value="library" className="min-w-0 px-4 pb-6">
                  <Tabs value={librarySection} onValueChange={setLibrarySection} className="min-w-0">
                    <TabsList aria-label="Library sections" className="library-subtabs -mx-4 h-8 w-[calc(100%+2rem)] min-w-0 justify-between gap-0 overflow-x-auto bg-transparent px-1.5">
                      {LIBRARY_TABS.map(([value, label]) => (
                        <TabsTrigger key={value} value={value} className="h-7 min-h-0 shrink-0 rounded-full px-1 text-ui font-medium">
                          {label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                    <TabsContent value="files">
                      <LibraryPane activeType={libraryType} onTypeChange={setLibraryType} botId={botId} botName={bot?.name || "Teammate"} botShape={avatarShape} botColor={avatarColor} />
                      <div className="flex flex-col gap-4">
                        <LibraryList
                          botId={botId}
                          botName={bot?.name || "Teammate"}
                          avatarShape={avatarShape}
                          avatarColor={avatarColor}
                          files={files.items}
                          artifacts={artifacts.items}
                          pages={workspace.pages ?? []}
                          error={files.error || artifacts.error}
                          loaded={files.loaded && artifacts.loaded}
                          onRetry={() => void loadAux(["files", "artifacts"])}
                        />
                        <FilesPane botId={botId} onChanged={() => void loadAux(["files"])} />
                      </div>
                    </TabsContent>
                    <TabsContent value="routines">
                      <RoutinesSection routines={routines.items} error={routines.error} loaded={routines.loaded} onRetry={() => void loadAux(["routines"])} onChanged={() => void loadAux(["routines"])} onEdit={(text) => setRoutineEditRequest(current => ({ key: (current?.key ?? 0) + 1, text }))} />
                    </TabsContent>
                    <TabsContent value="skills">
                      <SkillsPane botId={botId} skills={skills.items} error={skills.error} loaded={skills.loaded} onChanged={() => void loadAux(["skills"])} />
                    </TabsContent>
                    <TabsContent value="memory">
                      <MemoryPane botId={botId} memories={memories.items} error={memories.error} loaded={memories.loaded} onChanged={() => void loadAux(["memories"])} focusMemoryId={memoryFocusId} onFocused={() => setMemoryFocusId(undefined)} />
                    </TabsContent>
                    <TabsContent value="tasks">
                      <TasksPane botId={botId} tasks={workspace.tasks ?? []} aiConnected={workspace.aiConnected !== false} onChanged={() => void loadWorkspace()} />
                    </TabsContent>
                    <TabsContent value="plugins">
                      <PluginsPane />
                    </TabsContent>
                  </Tabs>
                </TabsContent>
                <TabsContent value="computer" forceMount className={cn("px-4 pb-6", !desktopFull && "data-[state=inactive]:hidden")}>
                  <Button data-testid="teach-start" className="mb-3" disabled={teach.busy || teach.recording} onClick={() => void teach.start()}>Teach a task</Button>
                <ComputerPane
                  botId={botId}
                  tasks={workspace.tasks ?? []}
                  events={agentEvents}
                  pages={workspace.pages ?? []}
                  holder={workspace.holder}
                  compact={!desktopFull}
                  caption={bot?.name || "Teammate"}
                  avatar={<BotAvatar animated botId={bot?.id} shape={bot?.avatarShape} color={bot?.avatarColor} size={36} primary={bot?.isPrimary} />}
                  avatarShape={avatarShape}
                  avatarColor={avatarColor}
                  displays={(workspace as WorkspaceData & { displays?: number }).displays ?? 1}
                  fullscreen={desktopFull}
                  recording={teach.recording}
                  autoControlKey={autoControlKey}
                  handBackKey={handBackKey}
                  onHandedBack={() => void teach.finish()}
                  onExpand={() => setDesktopFull(true)}
                  onExitFullscreen={() => setDesktopFull(false)}
                  onChanged={() => void loadWorkspace()}
                />
                </TabsContent>
                  <TabsContent value="files">
                    <div className="flex flex-col gap-6">
                      <FilesPane botId={botId} onChanged={() => void loadAux(["files"])} />
                      <div>{artifacts.items.map(item => <a data-testid="artifact-card" key={item.id} href={`/api/artifacts/${item.id}/download`}>{item.name}</a>)}</div>
                    </div>
                  </TabsContent>
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
  avatar: string;
  avatarShape: string;
  avatarColor: string;
  notifications: boolean;
  peerMessaging: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState({ name, role, instructions, avatar, avatarShape, avatarColor, notifications, peerMessaging });
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
    <form data-testid="bot-settings" className="flex flex-col gap-6 overflow-y-auto px-4 py-4" onSubmit={save}>
      <div className="flex items-center">
        <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={onClose}>
          Back
        </Button>
      </div>
      <div>
        <h2 className="text-body-sm font-medium">Teammate settings</h2>
        <p className="mt-1 text-meta text-muted-foreground">Avatar, name, and notifications for this teammate.</p>
      </div>
      <section className="flex flex-col gap-2">
        <p className="text-meta font-medium text-muted-foreground">Avatar</p>
        <BotAvatarPicker botId={botId} shape={draft.avatarShape} color={draft.avatarColor} onChange={(shape, color) => setDraft({ ...draft, avatarShape: shape, avatarColor: color })} />
      </section>
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="settings-name">Name</Label>
          <Input id="settings-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="settings-title">Title</Label>
          <Input id="settings-title" value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="settings-description">Description</Label>
          <Textarea id="settings-description" value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} />
        </div>
      </section>
      <div className="flex min-h-11 items-center justify-between gap-3 text-body-sm">
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
          <p className="text-xs text-muted-foreground">Limits apply to each task. Steps range from 4 to 1,000. Minutes range from 1 to 360.</p>
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
