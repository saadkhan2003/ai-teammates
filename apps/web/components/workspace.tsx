"use client";

import { Hash, Info, Plug, Settings, Share, Users, X } from "lucide-react";
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
import { RoutinesPane } from "@/components/routines-pane";
import { SkillsPane } from "@/components/skills-pane";
import { StateMessage } from "@/components/state-message";
import { TasksPane } from "@/components/tasks-pane";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
import { applyCodingJob, copyBotName, normalizeCodingJob, readableAccent, templateShareUrl, type CodingJob } from "@/lib/chat-ui";
import { mergeAgentEvent, parseAgentEvent, subscribeEvents, type AgentEvent } from "@/lib/events";
import { StatusBadge } from "@/lib/status";
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

function isFileArtifact(artifact: Artifact) {
  return Boolean(artifact.mime) || /\.[a-z0-9]{2,8}$/i.test(artifact.name);
}

const ComputerPane = dynamic(() => import("@/components/computer-pane").then((mod) => mod.ComputerPane), {
  ssr: false,
  loading: () => (
    <div data-testid="computer-tab" data-vnc-state="disconnected" className="rounded-lg border border-border bg-card p-3 text-body-sm">
      Loading the desktop…
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

export function Workspace({ botId }: { botId: string }) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [pane, setPane] = useState(false);
  const [connectedApps, setConnectedApps] = useState<InstalledApp[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [desktopFull, setDesktopFull] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [files, setFiles] = useState<ListState<FileEntry>>(emptyList);
  const [memories, setMemories] = useState<ListState<MemoryItem>>(emptyList);
  const [skills, setSkills] = useState<ListState<Skill>>(emptyList);
  const [routines, setRoutines] = useState<ListState<Routine>>(emptyList);
  const [artifacts, setArtifacts] = useState<ListState<Artifact>>(emptyList);
  const [detailTab, setDetailTab] = useState("details");
  const [librarySection, setLibrarySection] = useState("files");
  const [openJob, setOpenJob] = useState<CodingJob | null>(null);
  const [finishedLogins, setFinishedLogins] = useState<LoginRequest[]>([]);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [llmConnected, setLlmConnected] = useState<boolean | null>(null);
  const taskIds = useRef(new Set<string>());
  const seq = useRef(0);
  const auxSeq = useRef(0);
  const tabRef = useRef(detailTab);
  const libraryRef = useRef(librarySection);
  tabRef.current = detailTab;
  libraryRef.current = librarySection;

  useEffect(() => {
    const onLink = (event: Event) => {
      const detail = (event as CustomEvent<AppLink>).detail;
      if (!detail || detail.kind !== "panel") return;
      setPane(true);
      setSettingsOpen(false);
      setDesktopFull(false);
      setDetailTab(detail.tab);
      if (detail.section) setLibrarySection(detail.section);
    };
    window.addEventListener("teammates-app-link", onLink);
    return () => window.removeEventListener("teammates-app-link", onLink);
  }, []);

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
    void loadWorkspace();
    void api<unknown>("/api/plugins")
      .then((data) => setConnectedApps(readInstalledApps(data).filter(isConnected)))
      .catch(() => setConnectedApps([]));
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
      if (event && ["grounding", "tool", "tool_call", "tool_result", "delta", "message.delta", "text_delta", "memory"].includes(type)) {
        // Events without bot/task attribution cannot safely be shown in this workspace.
        if (event.botId === botId || (typeof event.taskId === "string" && taskIds.current.has(event.taskId))) {
          const detail = event.detail && typeof event.detail === "object" ? event.detail as Record<string, unknown> : {};
          setAgentEvents(current => mergeAgentEvent(current, { ...event, ...detail, type: event.type }));
        }
      }
      schedule();
      if (type !== "task" && type !== "artifact") return;
      const extra: Array<"files" | "memories" | "skills" | "routines" | "artifacts"> = ["artifacts", "routines"];
      const tab = tabRef.current;
      const section = libraryRef.current;
      if (tab === "library" && section === "files") extra.push("files");
      if (tab === "library" && section === "memory") extra.push("memories");
      if (tab === "library" && section === "skills") extra.push("skills");
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
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (document.querySelector("[role='dialog'], [role='menu']")) return;
        setDesktopFull(false);
        setSettingsOpen(false);
        setPane(false);
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
    if (detailTab === "details" || (detailTab === "library" && librarySection === "routines")) void loadAux(["routines"]);
    if (detailTab === "library" && librarySection === "files") void loadAux(["files", "artifacts"]);
    if (detailTab === "library" && librarySection === "memory") void loadAux(["memories"]);
    if (detailTab === "library" && librarySection === "skills") void loadAux(["skills"]);
  }, [pane, detailTab, librarySection, loadAux]);

  if (!ready) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
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
    <div className="flex h-full min-h-0">
      <section className="relative flex min-w-0 flex-1 flex-col">
        <div data-radius-allow="fade" className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 bg-gradient-to-b from-background to-transparent" />
        <header className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
          <button
            type="button"
            data-testid="bot-name-button"
            className="pointer-events-auto inline-flex h-9 max-w-[70%] items-center gap-2 rounded-full border border-border bg-card pl-1.5 pr-3 text-ui font-medium text-card-foreground shadow-[var(--shadow-pill)] transition-[box-shadow] duration-200 hover:shadow-[var(--shadow-pill-hover)]"
            onClick={() => setPane((value) => !value)}
          >
            <BotAvatar botId={bot?.id || botId} shape={avatarShape} color={avatarColor} size={24} />
            <span className="truncate">{bot?.name || "Teammate"}</span>
          </button>
        </header>
        {workspaceError ? (
          <p role="alert" className="px-4 pt-3 text-body-sm text-destructive">
            Could not refresh the workspace. {workspaceError}
          </p>
        ) : null}
        <ChatPane
          conversationId={workspace.conversationId}
          messages={workspace.messages ?? []}
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
          onSent={() => void loadWorkspace()}
          working={(workspace.tasks ?? []).some((task) => ["running", "planning", "queued"].includes((task.status ?? "").toLowerCase()))}
          extras={
            <>
              {(llmConnected ?? workspace.openrouterConnected) === false ? (
                <p data-testid="llm-key-banner" className="rounded-md border border-border bg-card px-3 py-2 text-body-sm">
                  <Link href="/settings/secrets" className="font-medium text-brand">
                    Add a platform key in Settings → Vault
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
      {pane ? (
        <aside
          data-testid="info-pane"
          data-view={detailTab}
          data-radius-allow="pane"
          data-divider="panel"
          className="fixed inset-0 z-30 flex w-full min-w-0 flex-col border-l border-border bg-sidebar pt-[env(safe-area-inset-top)] text-sidebar-foreground md:static md:z-0 md:w-[320px] md:max-w-[42vw] md:pt-0"
          style={{ ["--bot-accent" as string]: accent }}
        >
          <div className="flex h-11 items-center justify-end gap-1 px-2">
            <Button type="button" data-testid="bot-settings-gear" variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Teammate settings" onClick={() => setSettingsOpen(true)}>
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
              model={(bot as { model?: string } | undefined)?.model || ""}
              avatar={(bot as { avatar?: string } | undefined)?.avatar || ""}
              avatarShape={avatarShape}
              avatarColor={avatarColor}
              notifications={(bot as { notificationsEnabled?: boolean } | undefined)?.notificationsEnabled !== false}
              onClose={() => setSettingsOpen(false)}
              onSaved={() => void loadWorkspace()}
            />
          ) : (
            <div className={cn("min-h-0 w-full min-w-0 flex-1 overflow-y-auto", desktopFull && "overflow-visible")}>
              <div data-testid="info-identity" className="flex flex-col items-center px-3 pb-3 text-center">
                <BotAvatar botId={bot?.id || botId} shape={avatarShape} color={avatarColor} size={64} />
                <p data-testid="info-bot-name" className="type-title mt-2">{bot?.name || "Teammate"}</p>
                <p data-testid="info-bot-title" className="type-caption max-w-full truncate px-2">{bot?.role || "No title yet."}</p>
              </div>
              <Tabs
                value={detailTab}
                onValueChange={(value) => {
                  setDetailTab(value);
                  if (value !== "computer") setDesktopFull(false);
                }}
                className="flex w-full min-w-0 flex-col"
              >
                <TabsList aria-label="Bot details" className="mx-4 grid h-[34px] w-[calc(100%-2rem)] grid-cols-3 items-center gap-0.5 self-center rounded-full bg-[var(--track)] p-[3px]">
                  {INFO_TABS.map(([value, label]) => (
                    <TabsTrigger key={value} value={value} className="info-tab h-7 min-h-0 w-full min-w-0 justify-center overflow-hidden rounded-full border border-transparent px-3 text-ui font-medium leading-none text-muted-foreground shadow-none transition-[background-color,box-shadow,color] duration-200 data-[state=active]:border-border data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-[0_1px_2px_rgba(0,0,0,0.16)]">
                      {label}
                    </TabsTrigger>
                  ))}
                </TabsList>
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
                      <RoutinesPane botId={botId} routines={routines.items} error={routines.error} loaded={routines.loaded} onChanged={() => void loadAux(["routines"])} />
                    </TabsContent>
                    <TabsContent value="skills">
                      <SkillsPane skills={skills.items} error={skills.error} loaded={skills.loaded} onChanged={() => void loadAux(["skills"])} />
                    </TabsContent>
                    <TabsContent value="memory">
                      <MemoryPane botId={botId} memories={memories.items} error={memories.error} loaded={memories.loaded} onChanged={() => void loadAux(["memories"])} />
                    </TabsContent>
                    <TabsContent value="tasks">
                      <TasksPane botId={botId} tasks={workspace.tasks ?? []} openrouterConnected={workspace.openrouterConnected !== false} onChanged={() => void loadWorkspace()} />
                    </TabsContent>
                    <TabsContent value="plugins">
                      <PluginsPane />
                    </TabsContent>
                  </Tabs>
                </TabsContent>
                <TabsContent value="computer" forceMount className="px-4 pb-6 data-[state=inactive]:hidden">
                  <ComputerPane
                    botId={botId}
                    tasks={workspace.tasks ?? []}
                    pages={workspace.pages ?? []}
                    holder={workspace.holder}
                    compact={!desktopFull}
                    caption={bot?.name || "Teammate"}
                    avatarShape={avatarShape}
                    avatarColor={avatarColor}
                    fullscreen={desktopFull}
                    onExpand={() => setDesktopFull(true)}
                    onExitFullscreen={() => setDesktopFull(false)}
                    onChanged={() => void loadWorkspace()}
                  />
                </TabsContent>
              </Tabs>
            </div>
          )}
        </aside>
      ) : null}
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
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState({ name, role, instructions, model, avatar, avatarShape, avatarColor, notifications });
  const [error, setError] = useState<string | null>(null);

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
      <input id="settings-model" type="hidden" value={draft.model} readOnly />
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
      {error ? <p className="text-body-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end">
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}
