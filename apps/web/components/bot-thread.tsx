"use client";

import { useCallback, useEffect, useState } from "react";
import { MessagesSquare, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { actionRowText, threadRowText, threadStatusLabel, type BotRow, type BotThreadView } from "@/lib/bot-thread";
import { errorMessage, formatWhen } from "@/lib/utils";

type ThreadMessage = { id: string; seq: number; fromBotId?: string | null; kind: string; content: string; createdAt?: string };
type ThreadDetail = {
  thread: BotThreadView & { initiatorName?: string; peerName?: string };
  messages: ThreadMessage[];
  approvals: Array<{ id: string; action?: string; summary?: string; botName?: string }>;
};

/** One inline row in a chat: "Messaged Scout <title>" with a live status chip. Click it for the whole conversation. */
export function BotThreadRow({ row, thread, createdAt, onChanged }: { row: Extract<BotRow, { type: "bot_thread" }>; thread?: BotThreadView; createdAt?: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const text = threadRowText(row);
  const status = thread?.status ?? "waiting";
  return (
    <article data-testid="message-item" data-role="assistant" data-kind="bot_thread" className="group motion-rise mr-auto w-full max-w-md">
      <button
        type="button"
        data-testid="bot-thread-row"
        data-thread-id={row.threadId}
        data-status={status}
        onClick={() => setOpen(true)}
        className="flex min-h-11 w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <MessagesSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate"><span className="font-medium">{text.lead}</span> <span className="text-muted-foreground">{text.title}</span></span>
        <span data-testid="bot-thread-status" className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${status === "approval" || status === "paused" || status === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>{threadStatusLabel(status)}</span>
      </button>
      <time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(createdAt)}</time>
      {open ? <BotThreadDialog threadId={row.threadId} status={status} onClose={() => setOpen(false)} onChanged={onChanged} /> : null}
    </article>
  );
}

export function BotActionRow({ row, createdAt }: { row: Extract<BotRow, { type: "bot_action" }>; createdAt?: string }) {
  return (
    <article data-testid="message-item" data-role="assistant" data-kind="bot_action" className="group motion-rise mr-auto w-full max-w-md">
      <p data-testid="bot-action-row" className="flex min-h-11 items-center gap-2 px-1 text-sm text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">{actionRowText(row)}</span>
      </p>
      <time className="block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(createdAt)}</time>
    </article>
  );
}

function BotThreadDialog({ threadId, status, onClose, onChanged }: { threadId: string; status: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setDetail(await api<ThreadDetail>(`/api/bot-threads/${threadId}`)); setError(null); }
    catch (caught) { setError(errorMessage(caught, "Could not load this conversation.")); }
  }, [threadId]);
  useEffect(() => { void load(); }, [load, status]);

  async function act(kind: "resume" | "close") {
    setBusy(true);
    try { await api(`/api/bot-threads/${threadId}/${kind}`, { method: "POST" }); toast.success(kind === "resume" ? "Conversation resumed." : "Conversation closed."); await load(); onChanged(); }
    catch (caught) { toast.error(errorMessage(caught, "Could not do that.")); }
    finally { setBusy(false); }
  }

  const live = detail?.thread.status ?? status;
  const mine = detail?.thread.initiatorBotId;
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent data-testid="bot-thread-dialog" className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words">{detail?.thread.title ?? "Conversation"}</DialogTitle>
          <DialogDescription>
            {detail ? `${detail.thread.initiatorName} and ${detail.thread.peerName} · ${threadStatusLabel(live)}` : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <ol className="flex flex-col gap-2">
          {(detail?.messages ?? []).map((message) => (
            <li key={message.id} data-testid="thread-message" data-kind={message.kind} className={`rounded-md px-3 py-2 text-sm ${message.kind === "system" ? "text-muted-foreground" : message.fromBotId === mine ? "bg-muted" : "border border-border"}`}>
              {message.kind === "system" ? null : <span className="mb-0.5 block text-[11px] text-muted-foreground">{message.fromBotId === mine ? detail?.thread.initiatorName : detail?.thread.peerName} · {message.kind}</span>}
              <span className="whitespace-pre-wrap break-words">{message.content}</span>
            </li>
          ))}
        </ol>
        {(detail?.approvals ?? []).length > 0 ? <p data-testid="thread-approvals" className="text-sm text-muted-foreground">Waiting for your approval in the chat: {detail?.approvals.map((a) => a.summary || a.action).join("; ")}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          {live === "paused" ? <Button data-testid="thread-resume" size="sm" disabled={busy} onClick={() => void act("resume")}>Resume</Button> : null}
          {live !== "closed" ? <Button data-testid="thread-close" size="sm" variant="outline" disabled={busy} onClick={() => void act("close")}>Close conversation</Button> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
