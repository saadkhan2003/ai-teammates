"use client";

import { Settings, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Approvals } from "@/components/approvals";
import { PluginsPane } from "@/components/plugins-pane";
import { ArtifactsPane } from "@/components/artifacts-pane";
import { ChatPane } from "@/components/chat-pane";
import { CodingPanel, JobDetailDialog } from "@/components/coding-jobs";
import { LoginCard } from "@/components/login-card";
import { FilesPane } from "@/components/files-pane";
import { MemoryPane } from "@/components/memory-pane";
import { RoutinesPane } from "@/components/routines-pane";
import { SkillsPane } from "@/components/skills-pane";
import { StateMessage } from "@/components/state-message";
import { TasksPane } from "@/components/tasks-pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { applyCodingJob, normalizeCodingJob, readableAccent, type CodingJob } from "@/lib/chat-ui";
import { mergeAgentEvent, parseAgentEvent, subscribeEvents, type AgentEvent } from "@/lib/events";
import { StatusBadge } from "@/lib/status";
import type { Artifact, FileEntry, LoginRequest, MemoryItem, Routine, SecretRequest, Skill, Workspace as WorkspaceData } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { BotAvatar } from "@/components/bot-avatar";
import { BotAvatarPicker } from "@/components/bot-avatar-picker";
import { defaultBotAvatar } from "@/lib/avatars";

const ComputerPane = dynamic(() => import("@/components/computer-pane").then((mod) => mod.ComputerPane), {
  ssr: false,
  loading: () => (
    <div data-testid="computer-tab" data-vnc-state="disconnected" className="rounded-lg border border-border bg-card p-3 text-sm">
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
  ["overview", "Overview"],
  ["computer", "Computer"],
  ["routines", "Routines"],
  ["files", "Files/Media"],
  ["skills", "Skills"],
  ["memory", "Memory"],
  ["tasks", "Tasks"],
  ["plugins", "Plugins"],
] as const;

export function Workspace({ botId }: { botId: string }) {
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [pane, setPane] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [desktopFull, setDesktopFull] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [files, setFiles] = useState<ListState<FileEntry>>(emptyList);
  const [memories, setMemories] = useState<ListState<MemoryItem>>(emptyList);
  const [skills, setSkills] = useState<ListState<Skill>>(emptyList);
  const [routines, setRoutines] = useState<ListState<Routine>>(emptyList);
  const [artifacts, setArtifacts] = useState<ListState<Artifact>>(emptyList);
  const [detailTab, setDetailTab] = useState("overview");
  const [openJob, setOpenJob] = useState<CodingJob | null>(null);
  const [finishedLogins, setFinishedLogins] = useState<LoginRequest[]>([]);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [llmConnected, setLlmConnected] = useState<boolean | null>(null);
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
    setPane(window.matchMedia("(min-width: 768px)").matches);
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
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (document.querySelector("[role='dialog']")) return;
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
    if (!pane) return;
    if (detailTab === "files") void loadAux(["files", "artifacts"]);
    if (detailTab === "memory") void loadAux(["memories"]);
    if (detailTab === "skills") void loadAux(["skills"]);
    if (detailTab === "routines") void loadAux(["routines"]);
  }, [pane, detailTab, loadAux]);

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

  const provider = workspace.llmProvider || "";
  const bot = workspace.bot;
  const requests = (workspace.secretRequests ?? []) as SecretRequest[];
  const computerExpanded = desktopFull || detailTab === "computer";

  return (
    <div className="flex h-full min-h-0">
      <section className="relative flex min-w-0 flex-1 flex-col">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 bg-gradient-to-b from-background to-transparent" />
        <header className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
          <button
            type="button"
            data-testid="bot-name-button"
            className="pointer-events-auto inline-flex max-w-[70%] items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-card-foreground shadow-sm transition-shadow hover:shadow-md"
            onClick={() => setPane((value) => !value)}
          >
            <BotAvatar botId={bot?.id} shape={bot?.avatarShape} color={bot?.avatarColor} size={20} />
            <span className="truncate">{bot?.name || "Teammate"}</span>
          </button>
        </header>
        {workspaceError ? (
          <p role="alert" className="px-4 pt-3 text-sm text-destructive">
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
          accent={readableAccent(bot?.avatarColor || defaultBotAvatar(botId).color)}
          avatarShape={bot?.avatarShape || defaultBotAvatar(botId).shape}
          avatarColor={bot?.avatarColor || defaultBotAvatar(botId).color}
          codingJobs={(workspace.codingJobs ?? []).map((job, index) => normalizeCodingJob(job, index)).filter((job): job is CodingJob => job !== null)}
          onOpenJob={setOpenJob}
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
        <JobDetailDialog job={openJob} accent={readableAccent(bot?.avatarColor || defaultBotAvatar(botId).color)} onClose={() => setOpenJob(null)} />
      </section>
      {pane ? (
        <aside
          data-testid="info-pane"
          data-view="details"
          className="fixed inset-0 z-30 flex w-full min-w-0 flex-col border-border bg-background pt-[env(safe-area-inset-top)] md:static md:z-0 md:w-[380px] md:max-w-[42vw] md:border-l md:pt-0"
        >
          <div className="flex h-11 items-center gap-1 border-b border-border px-2">
            <p className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{bot?.name}</p>
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
              onClose={() => setSettingsOpen(false)}
              onSaved={() => void loadWorkspace()}
            />
          ) : (
            <div className={cn("min-h-0 flex-1 overflow-y-auto", desktopFull && "overflow-visible")}>
              <div className={cn("border-b border-border", !computerExpanded && "p-3", computerExpanded && "flex min-h-[max(480px,70dvh)] flex-col")}>
                <ComputerPane
                  botId={botId}
                  tasks={workspace.tasks ?? []}
                  pages={workspace.pages ?? []}
                  holder={workspace.holder}
                  compact={!computerExpanded}
                  caption={bot?.name || "Teammate"}
                  fullscreen={desktopFull}
                  onExpand={() => setDesktopFull(true)}
                  onExitFullscreen={() => setDesktopFull(false)}
                  onChanged={() => void loadWorkspace()}
                />
              </div>
              <CodingPanel
                jobs={(workspace.codingJobs ?? []).map((job, index) => normalizeCodingJob(job, index)).filter((job): job is CodingJob => job !== null)}
                routines={routines.items}
                accent={readableAccent(bot?.avatarColor || defaultBotAvatar(botId).color)}
                botId={botId}
                avatarShape={bot?.avatarShape}
                avatarColor={bot?.avatarColor}
                onOpenJob={setOpenJob}
                onToggleRoutine={(routine, enabled) => {
                  setRoutines((current) => ({ ...current, items: current.items.map((item) => (item.id === routine.id ? { ...item, enabled } : item)) }));
                  void api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }).catch((caught) => {
                    setRoutines((current) => ({ ...current, items: current.items.map((item) => (item.id === routine.id ? { ...item, enabled: !enabled } : item)) }));
                    setWorkspaceError(errorMessage(caught, "Could not update that routine."));
                  });
                }}
              />
              <Collapsible data-testid="connect-apps" className="border-b border-border">
                <CollapsibleTrigger className="flex min-h-11 w-full items-center px-3 text-left text-sm font-medium">Connect apps</CollapsibleTrigger>
                <CollapsibleContent className="px-3 pb-3">
                  <PluginsPane mode="catalog" />
                </CollapsibleContent>
              </Collapsible>
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
                    <p className="text-sm text-muted-foreground">The live desktop is above. Take control when you need the pointer.</p>
                  </TabsContent>
                  <TabsContent value="routines">
                    <RoutinesPane botId={botId} routines={routines.items} error={routines.error} loaded={routines.loaded} onChanged={() => void loadAux(["routines"])} />
                  </TabsContent>
                  <TabsContent value="files">
                    <div className="flex flex-col gap-6">
                      <FilesPane botId={botId} files={files.items} error={files.error} loaded={files.loaded} onChanged={() => void loadAux(["files"])} />
                      <ArtifactsPane artifacts={artifacts.items} error={artifacts.error} loaded={artifacts.loaded} onRetry={() => void loadAux(["artifacts"])} />
                    </div>
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
                </div>
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
      <Input id="settings-model" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="Provider default" />
      <div className="flex items-center justify-between gap-3 text-sm">
        <Label htmlFor="settings-notifications">Notifications</Label>
        <Switch
          id="settings-notifications"
          checked={draft.notifications}
          onCheckedChange={(checked) => setDraft({ ...draft, notifications: checked })}
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" size="sm">
        Save
      </Button>
    </form>
  );
}
