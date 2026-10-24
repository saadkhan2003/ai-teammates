"use client";

import { useEffect, useState } from "react";
import { Check, Circle, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { formatThought } from "@/lib/brief-utils.mjs";
import type { ChatMessage } from "@/lib/types";

type BriefSteering = { id: string; text: string; createdAt?: string };
type TaskBrief = {
  taskId?: string;
  title?: string;
  priority?: string | number;
  markdown?: string;
  brief?: string;
  thoughtSeconds?: number;
  steering?: BriefSteering[];
};

export function BriefCard({ message, onOpenTask }: { message: ChatMessage; onOpenTask?: (taskId: string) => void }) {
  const children = message.childTasks ?? [];
  const briefTask = children.find(task => task.hasBrief);
  const [brief, setBrief] = useState<TaskBrief | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [steeringOpen, setSteeringOpen] = useState(false);
  const [steeringText, setSteeringText] = useState("");
  const [steering, setSteering] = useState<BriefSteering[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setBrief(null);
    setSteering([]);
    setExpanded(false);
    if (!briefTask?.taskId) return;
    let active = true;
    api<TaskBrief>(`/api/tasks/${briefTask.taskId}/brief`).then(value => {
      if (!active) return;
      setBrief(value && typeof value === "object" ? value : null);
      setSteering(Array.isArray(value?.steering) ? value.steering : []);
    }).catch(error => {
      if (!active) return;
      // Older API builds and tasks without a brief return 404.
      if (!(error instanceof ApiError && error.status === 404)) setBrief(null);
    });
    return () => { active = false; };
  }, [briefTask?.taskId]);

  async function sendSteering() {
    const text = steeringText.trim();
    if (!briefTask?.taskId || !text || sending) return;
    const optimistic: BriefSteering = { id: `pending-${Date.now()}`, text };
    setSending(true);
    setSteering(current => [...current, optimistic]);
    setSteeringText("");
    try {
      const result = await api<BriefSteering>(`/api/tasks/${briefTask.taskId}/brief/steer`, { method: "POST", body: JSON.stringify({ text }) });
      setSteering(current => current.map(item => item.id === optimistic.id ? result : item));
      setSteeringOpen(false);
    } catch {
      setSteering(current => current.filter(item => item.id !== optimistic.id));
      setSteeringText(text);
      toast.error("Could not send that guidance.");
    } finally {
      setSending(false);
    }
  }

  if (!children.length) return null;
  const markdown = brief?.markdown ?? brief?.brief ?? "";
  const priority = brief?.priority;
  const canExpand = markdown.length > 260 || markdown.split(/\r?\n/).length > 5;

  return <div className="mt-2 grid min-w-0 gap-2" data-testid="brief-stack">
    {briefTask && brief ? <section data-testid="brief-card" className="min-w-0 rounded-lg border border-border bg-card p-3 text-[13px] leading-5">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0 truncate text-xs text-muted-foreground" title={brief.title || briefTask.title}>
          {brief.title || briefTask.title}{priority != null ? <span> · {typeof priority === "number" ? `Priority ${priority}` : priority}</span> : null}
        </div>
        <Button type="button" variant="ghost" size="sm" data-testid="brief-steer" className="h-7 shrink-0 px-2 text-xs font-normal" onClick={() => setSteeringOpen(open => !open)} aria-expanded={steeringOpen}>Steer</Button>
      </div>
      <div className="relative min-w-0">
        <div className={expanded ? "max-h-64 overflow-y-auto pr-1" : "max-h-32 overflow-hidden pr-1"}>
          <div className="[&_code]:font-mono [&_code]:text-[12px] [&_pre]:font-mono [&_pre]:text-[12px] [&_strong]:font-medium [&_p]:font-normal [&_p]:text-[13px] [&_p]:leading-5">
            {markdown ? <Markdown text={markdown} /> : <p className="text-muted-foreground">No brief text available.</p>}
          </div>
        </div>
        {!expanded && canExpand ? <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent" /> : null}
      </div>
      {canExpand ? <button type="button" data-testid="brief-toggle" aria-expanded={expanded} className="mt-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Show more"}</button> : null}
      {steeringOpen ? <div className="mt-2 grid gap-2">
        <Textarea data-testid="brief-steer-input" aria-label="Guidance for this brief" className="min-h-16 resize-y rounded-md text-sm" value={steeringText} onChange={event => setSteeringText(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void sendSteering(); } }} placeholder="Add guidance for the agent" />
        <div className="flex justify-end"><Button type="button" size="sm" data-testid="brief-steer-send" className="h-8 rounded-md px-3" disabled={!steeringText.trim() || sending} onClick={() => void sendSteering()}>{sending ? "Sending…" : "Send guidance"}</Button></div>
      </div> : null}
      {steering.length ? <ul className="mt-2 grid gap-1 border-t border-border pt-2 text-xs text-muted-foreground">{steering.map((item, index) => <li key={item.id || index} data-testid="brief-steering-item" className="break-words"><span className="font-medium">You:</span> {item.text}</li>)}</ul> : null}
    </section> : null}
    {brief && formatThought(brief.thoughtSeconds) ? <p data-testid="brief-thought" className="-mt-1 px-1 text-xs font-normal text-muted-foreground">{formatThought(brief.thoughtSeconds)}</p> : null}
    {children.length ? <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-card" data-testid="brief-agents">
      <h3 className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">Coding agents <span className="ml-1">{children.length}</span></h3>
      <ul className="divide-y divide-border">{children.map(task => <li key={task.taskId}>
        <button type="button" className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => onOpenTask?.(task.taskId)}>
          <TaskStatus status={task.status} />
          <span className="min-w-0 flex-1 truncate text-[13px]">{task.title || "Coding task"}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{task.status.replaceAll("_", " ")}</span>
        </button>
      </li>)}</ul>
    </section> : null}
  </div>;
}

function TaskStatus({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  if (["running", "planning", "queued", "in_progress"].includes(normalized)) return <Loader2 aria-label="Running" className="h-4 w-4 shrink-0 animate-spin text-sky-500 motion-reduce:animate-none" />;
  if (["completed", "finished", "succeeded", "merged"].includes(normalized)) return <Check aria-label="Done" className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />;
  if (["failed", "cancelled", "canceled"].includes(normalized)) return <X aria-label="Failed" className="h-4 w-4 shrink-0 text-destructive" />;
  return <Circle aria-label={status} className="h-4 w-4 shrink-0 text-muted-foreground" />;
}
