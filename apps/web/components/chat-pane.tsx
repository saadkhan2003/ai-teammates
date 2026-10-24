"use client";

import { FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/markdown";
import type { AgentEvent } from "@/lib/events";
import { ArrowDown, ArrowUp, AudioLines, Mic, Notebook, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CodingJobsCard, JobMention, JobResultCard, LiveJobStep } from "@/components/coding-jobs";
import { ApiError, api, apiFetch } from "@/lib/api";
import { liveJob, reactionTooltip, readableAccent, replySnippet, showsJobResult, splitJobMentions, visibleReactions, type CodingJob } from "@/lib/chat-ui";
import { messageBlocks, type FormField, type MessageBlock, type QuestionOption } from "@/lib/message-blocks";
import type { ChatMessage } from "@/lib/types";
import { cn, errorMessage, formatWhen } from "@/lib/utils";

const QUICK_REACTIONS = ["👍", "❤️", "🎉", "😂", "✅"];

type PendingUpload = {
  id: string;
  name: string;
  mime: string;
  path: string;
  preview: string;
  status: "uploading" | "done" | "error";
};

export function ChatPane({
  conversationId,
  messages,
  botName,
  onSent,
  extras,
  working = false,
  events = [],
  onStop,
  botId,
  accent,
  avatarShape,
  avatarColor,
  codingJobs = [],
  onOpenJob,
}: {
  conversationId?: string;
  messages: ChatMessage[];
  botName: string;
  onSent: () => void;
  extras?: ReactNode;
  working?: boolean;
  events?: AgentEvent[];
  onStop?: () => Promise<void>;
  botId?: string;
  accent?: string;
  avatarShape?: string;
  avatarColor?: string;
  codingJobs?: CodingJob[];
  onOpenJob?: (job: CodingJob) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stickRef = useRef(true);
  const seenRef = useRef<Set<string> | null>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [fresh, setFresh] = useState(0);
  const [dismissedFresh, setDismissedFresh] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dlp, setDlp] = useState(false);
  const [customEmoji, setCustomEmoji] = useState("");
  const [userName, setUserName] = useState("You");
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const paint = readableAccent(accent || avatarColor);
  const active = liveJob(codingJobs);
  const byId = new Map(messages.map((message) => [message.id, message]));

  useEffect(() => {
    let live = true;
    api<{ username?: string }>("/api/auth/me")
      .then((me) => {
        if (live && me.username) setUserName(me.username);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const ids = messages.map((message) => message.id);
    if (seenRef.current === null) {
      seenRef.current = new Set(ids);
      return;
    }
    if (stickRef.current) {
      seenRef.current = new Set(ids);
      setFresh(0);
      return;
    }
    const count = ids.filter((id) => !seenRef.current?.has(id)).length;
    if (count > 0) {
      setFresh(count);
      setDismissedFresh(false);
    }
  }, [messages]);

  useEffect(() => {
    if (stickRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, events, working, codingJobs]);

  useEffect(() => {
    const node = composerRef.current;
    if (node) {
      node.style.height = "auto";
      node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
    }
  }, [content]);

  function jump() {
    stickRef.current = true;
    setScrolledUp(false);
    setFresh(0);
    seenRef.current = new Set(messages.map((message) => message.id));
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }

  function focusMessage(id: string) {
    const node = document.getElementById(`message-${id}`);
    if (!node) return;
    node.setAttribute("data-highlight", "true");
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => node.removeAttribute("data-highlight"), 3000);
  }

  async function stop() {
    setStopping(true);
    try {
      await onStop?.();
    } catch (caught) {
      setError(errorMessage(caught, "Could not stop this run."));
    } finally {
      setStopping(false);
    }
  }

  const initial = userName.trim().charAt(0).toUpperCase() || "Y";

  async function react(messageId: string, emoji: string) {
    const glyph = emoji.trim();
    if (!glyph) return;
    setError(null);
    try {
      await api(`/api/messages/${messageId}/reactions`, {
        method: "POST",
        body: JSON.stringify({ emoji: glyph }),
      });
      setCustomEmoji("");
      onSent();
    } catch (caught) {
      setError(errorMessage(caught, "Could not update that reaction."));
    }
  }

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;
    if (!botId) {
      setError("This teammate cannot take files yet.");
      return;
    }
    const files = [...list];
    for (const file of files) {
      const id = `${Date.now()}-${file.name}`;
      const path = `uploads/${Date.now()}-${file.name.replace(/[^\w.\-]+/g, "_")}`;
      const preview = URL.createObjectURL(file);
      setUploads((current) => [...current, { id, name: file.name, mime: file.type, path, preview, status: "uploading" }]);
      try {
        const response = await apiFetch(`/api/bots/${botId}/files`, {
          method: "PUT",
          headers: { "x-path": path, "Content-Type": "application/octet-stream" },
          body: file,
        });
        if (!response.ok) throw new ApiError(response.status, `Upload failed (${response.status}).`);
        setUploads((current) => current.map((item) => (item.id === id ? { ...item, status: "done" } : item)));
      } catch (caught) {
        setUploads((current) => current.map((item) => (item.id === id ? { ...item, status: "error" } : item)));
        setError(errorMessage(caught, "Could not upload that file."));
      }
    }
  }

  function attachmentMarkdown(item: PendingUpload) {
    const url = `/api/bots/${botId}/files/raw?path=${encodeURIComponent(item.path)}`;
    if (item.mime.startsWith("image/")) return `![${item.name}](${url})`;
    return `[${item.name}](${url})`;
  }

  async function send(text = content.trim()) {
    const ready = uploads.filter((item) => item.status === "done");
    const pending = uploads.some((item) => item.status === "uploading");
    const attached = ready.map(attachmentMarkdown).join("\n");
    const bodyText = [text, attached].filter(Boolean).join("\n\n");
    if (sending || pending) return;
    if (!bodyText) {
      setError("Write a message first.");
      return;
    }
    if (!conversationId) {
      setError("This teammate does not have a conversation yet.");
      return;
    }
    setSending(true);
    setError(null);
    setDlp(false);
    try {
      await api(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: bodyText, asTask: false, ...(reply ? { replyTo: reply.id } : {}) }),
      });
      if (text === content.trim()) setContent("");
      setReply(null);
      setUploads((current) => {
        current.forEach((item) => URL.revokeObjectURL(item.preview));
        return [];
      });
      onSent();
    } catch (caught) {
      const message = errorMessage(caught, "Could not send that message.");
      const blocked = (caught instanceof ApiError && caught.status === 422) || message.toLowerCase().includes("data policy");
      setDlp(blocked);
      setError(message);
    } finally {
      setSending(false);
    }
  }

  async function answer(messageId: string, choices: string[], custom = "") {
    setError(null);
    try {
      await api(`/api/messages/${messageId}/answer`, {
        method: "POST",
        body: JSON.stringify({ choices, custom }),
      });
      onSent();
      return true;
    } catch (caught) {
      setError(errorMessage(caught, "Could not send that answer."));
      return false;
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send();
  }

  const typing = content.trim().length > 0;
  let showedJobs = false;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" style={{ ["--bot-accent" as string]: paint }}>
      <div
        ref={scrollRef}
        data-testid="chat-scroll"
        className="min-h-0 flex-1 overflow-y-auto pt-12"
        onScroll={() => {
          const node = scrollRef.current;
          if (!node) return;
          stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          setScrolledUp(!stickRef.current);
          if (stickRef.current) {
            seenRef.current = new Set(messages.map((message) => message.id));
            setFresh(0);
          }
        }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-4">
          {extras}
          {messages.length === 0 ? (
            <div data-testid="chat-empty" className="py-12 text-center">
              <p className="font-medium">Start a conversation with {botName}</p>
              <p className="mt-2 text-sm text-muted-foreground">Ask a question, share an idea, or assign some work.</p>
            </div>
          ) : null}
          {messages.map((message) => {
            const blocks = messageBlocks(message.content);
            const jobBlock = blocks.some((block) => block.kind === "coding-jobs");
            if (jobBlock && !showedJobs) {
              showedJobs = true;
              return (
                <div key={message.id} className="flex w-full max-w-md flex-col gap-2">
                  <CodingJobsCard jobs={codingJobs} accent={paint} botId={botId} onOpenJob={onOpenJob} />
                  <JobResults jobs={codingJobs} accent={paint} onOpenJob={onOpenJob} />
                </div>
              );
            }
            if (jobBlock) return null;
            const only = blocks.length === 1 ? blocks[0] : null;
            if (only?.kind === "memory") {
              return (
                <article key={message.id} id={`message-${message.id}`} data-testid="message-item" data-role={message.role} className="group mr-auto w-full max-w-md">
                  <MemoryNotice action={only.action} text={only.text} />
                  <time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time>
                </article>
              );
            }
            if (only?.kind === "question") {
              return (
                <article key={message.id} id={`message-${message.id}`} data-testid="message-item" data-role={message.role} className="group mr-auto w-full max-w-md">
                  <QuestionCard
                    prompt={only.prompt}
                    options={only.options}
                    multiple={only.multiple}
                    allowCustom={only.allowCustom}
                    answer={only.answer}
                    initial={initial}
                    onAnswer={(choices, custom) => answer(message.id, choices, custom)}
                  />
                  <time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time>
                </article>
              );
            }
            const mine = message.role === "user";
            const reactions = visibleReactions(message.role, message.reactions);
            const quoted = message.replyToId ? byId.get(message.replyToId) : undefined;
            return (
              <article
                key={message.id}
                id={`message-${message.id}`}
                data-testid="message-item"
                data-role={message.role}
                className={mine ? "group ml-auto min-w-0 max-w-[85%] rounded-bubble sm:max-w-[75%]" : "group mr-auto min-w-0 max-w-[85%] rounded-bubble sm:max-w-[75%]"}
              >
                {!mine ? (
                  <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <img src="/favicon.svg" alt="" className="h-5 w-5 rounded-sm" />
                    {botName}
                  </div>
                ) : null}
                <div
                  data-testid="message-bubble"
                  className={
                    mine
                      ? `relative space-y-2 rounded-bubble bg-user-bubble px-3.5 py-2 text-sm text-user-bubble-foreground${reactions.length ? " mb-3" : ""}`
                      : `relative space-y-2 rounded-bubble bg-assistant-bubble px-3.5 py-2 text-sm text-assistant-bubble-foreground${reactions.length ? " mb-3" : ""}`
                  }
                >
                  {message.replyToId ? (
                    <button
                      type="button"
                      data-testid="reply-quote"
                      className="block w-full rounded-md border-l-2 border-border bg-muted px-2 py-1 text-left text-xs text-muted-foreground"
                      onClick={() => focusMessage(message.replyToId!)}
                    >
                      {replySnippet(quoted?.content ?? "")}
                    </button>
                  ) : null}
                  {blocks.map((block, index) => (
                    <MessageBlockView
                      key={`${message.id}-${index}`}
                      block={block}
                      jobs={codingJobs}
                      accent={paint}
                      onOpenJob={onOpenJob}
                      onReply={() => setReply(message)}
                    />
                  ))}
                  {reactions.length > 0 ? (
                    <div data-testid="reaction-cluster" className={cn("absolute bottom-0 z-10 flex translate-y-1/2 gap-1", mine ? "right-2" : "left-2")}>
                      {reactions.map((reaction) => {
                        const who = reaction.actorType === "bot" ? botName : userName;
                        return (
                          <Tooltip key={reaction.id ?? `${reaction.actorType}-${reaction.emoji}`}>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                data-testid="reaction-pill"
                                data-emoji={reaction.emoji}
                                data-actor={reaction.actorType}
                                aria-label={reactionTooltip(reaction.actorType, who, reaction.emoji)}
                                className="rounded-full border border-border bg-card px-1.5 py-0 text-sm leading-5 text-card-foreground shadow-sm"
                                onClick={() => {
                                  if (reaction.actorType === "user") void react(message.id, reaction.emoji);
                                }}
                              >
                                {reaction.emoji}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top">{reactionTooltip(reaction.actorType, who, reaction.emoji)}</TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <button type="button" data-testid="message-reply" aria-label="Reply" className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100 group-focus-within:opacity-100" onClick={() => setReply(message)}>
                    Reply
                  </button>
                  {message.role === "assistant" ? (
                    <div className="flex flex-wrap items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" data-testid="reaction-picker">
                      {QUICK_REACTIONS.map((emoji) => (
                        <Button key={emoji} variant="ghost" size="sm" type="button" className="rounded-md px-1.5 py-0.5 text-sm hover:bg-accent" onClick={() => void react(message.id, emoji)}>
                          {emoji}
                        </Button>
                      ))}
                      <input
                        data-testid="reaction-custom"
                        value={customEmoji}
                        onChange={(event) => setCustomEmoji(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void react(message.id, customEmoji);
                          }
                        }}
                        placeholder="Emoji"
                        className="w-16 rounded-md border border-border bg-card px-2 py-0.5 text-xs text-foreground"
                        aria-label="Custom emoji"
                      />
                    </div>
                  ) : null}
                </div>
                <time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time>
              </article>
            );
          })}
          {!showedJobs && codingJobs.length > 0 ? (
            <div className="flex w-full max-w-md flex-col gap-2">
              <CodingJobsCard jobs={codingJobs} accent={paint} botId={botId} onOpenJob={onOpenJob} />
              <JobResults jobs={codingJobs} accent={paint} onOpenJob={onOpenJob} />
            </div>
          ) : null}
          {events.filter((event) => !["delta", "message.delta", "text_delta"].includes(event.type)).map((event, i) => (
            <EventCard key={`${conversationId}-${i}`} event={event} />
          ))}
          {working && events.some((event) => ["delta", "message.delta", "text_delta"].includes(event.type)) ? (
            <div data-testid="streaming-text" className="rounded-md bg-assistant-bubble p-3 text-sm">
              <Markdown text={events.filter((event) => ["delta", "message.delta", "text_delta"].includes(event.type)).map((event) => String(event.delta ?? event.text ?? "")).join("")} />
              <span aria-hidden className="inline-block h-4 w-1 animate-pulse bg-foreground" />
            </div>
          ) : null}
          {active ? <LiveJobStep job={active} botId={botId} botName={botName} shape={avatarShape} color={avatarColor || accent} /> : null}
          {working ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <img src="/favicon.svg" alt="" className="h-4 w-4 rounded-sm" />
              {botName} is working
            </p>
          ) : null}
        </div>
      </div>
      {scrolledUp ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-10 flex flex-col items-center gap-2">
          {fresh > 0 && !dismissedFresh ? (
            <div data-testid="new-messages" className="pointer-events-auto flex items-center gap-1 rounded-full px-3 py-1 text-sm text-on-accent shadow-sm" style={{ backgroundColor: paint }}>
              <button type="button" onClick={jump}>
                {fresh === 1 ? "↓ 1 new message" : `↓ ${fresh} new messages`}
              </button>
              <button type="button" aria-label="Dismiss new messages" className="px-1" onClick={() => setDismissedFresh(true)}>
                ×
              </button>
            </div>
          ) : null}
          <button type="button" data-testid="jump-to-latest" aria-label="Jump to latest" className="pointer-events-auto grid size-11 place-items-center rounded-full border border-border bg-card text-card-foreground shadow-sm" onClick={jump}>
            <ArrowDown className="h-5 w-5" />
          </button>
        </div>
      ) : null}
      <form data-testid="composer-bar" className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]" onSubmit={onSubmit}>
        {reply ? (
          <div data-testid="reply-chip" className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-sm text-card-foreground">
            <span className="min-w-0 flex-1 truncate">{replySnippet(reply.content)}</span>
            <button type="button" aria-label="Cancel reply" onClick={() => setReply(null)}>
              ×
            </button>
          </div>
        ) : null}
        {uploads.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {uploads.map((item) => (
              <UploadCard key={item.id} item={item} />
            ))}
          </div>
        ) : null}
        <div data-testid="composer-pill" className="flex items-end gap-1 rounded-full border border-border bg-card px-2 py-1.5 text-card-foreground shadow-sm">
          <input ref={fileRef} type="file" multiple className="sr-only" aria-hidden tabIndex={-1} onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" data-testid="composer-add" aria-label="Add" className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground hover:bg-accent">
                <Plus className="h-5 w-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start">
              <DropdownMenuItem onSelect={() => fileRef.current?.click()}>Attach files</DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setContent((current) => (current.trim().length > 0 ? current : "Teach this task: "));
                  composerRef.current?.focus();
                }}
              >
                Teach a task
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Textarea
            ref={composerRef}
            aria-label={`Message ${botName}`}
            data-testid="composer"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={`Message ${botName}`}
            rows={1}
            className="max-h-44 min-h-10 flex-1 resize-none border-0 bg-transparent px-1 py-2 text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setError(null);
                composerRef.current?.blur();
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button type="button" aria-label="Microphone" className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent">
            <Mic className="h-5 w-5" />
          </button>
          {typing ? (
            <button type="submit" data-testid="send-chat" aria-label="Send" disabled={sending || !conversationId || uploads.some((item) => item.status === "uploading")} className="grid size-11 shrink-0 place-items-center rounded-full text-on-accent disabled:opacity-50" style={{ backgroundColor: paint }}>
              <ArrowUp className="h-5 w-5" />
            </button>
          ) : (
            <button type="button" data-testid="composer-voice" aria-label="Voice" className="grid size-11 shrink-0 place-items-center rounded-full text-on-accent" style={{ backgroundColor: paint }}>
              <AudioLines className="h-5 w-5" />
            </button>
          )}
        </div>
        {working && onStop ? (
          <div className="flex items-center justify-end">
            <Button type="button" data-testid="stop-run" variant="destructive" disabled={stopping} onClick={() => void stop()}>
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" data-testid={dlp ? "dlp-block" : undefined} className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}

function JobResults({ jobs, accent, onOpenJob }: { jobs: CodingJob[]; accent: string; onOpenJob?: (job: CodingJob) => void }) {
  return jobs.filter(showsJobResult).map((job) => <JobResultCard key={job.id} job={job} accent={accent} onOpen={() => onOpenJob?.(job)} />);
}

function UploadCard({ item }: { item: PendingUpload }) {
  const [ready, setReady] = useState(false);
  const media = item.mime.startsWith("image/") || item.mime.startsWith("video/");
  return (
    <div data-testid="upload-card" data-status={item.status} className="w-40 overflow-hidden rounded-xl border border-border bg-card text-card-foreground">
      {media ? (
        <div className="relative h-24">
          {!ready ? <div data-testid="media-skeleton" className="media-shimmer absolute inset-0" /> : null}
          {item.mime.startsWith("video/") ? (
            <video src={item.preview} className={cn("h-24 w-full object-cover transition-opacity", ready ? "opacity-100" : "opacity-0")} muted onLoadedData={() => setReady(true)} />
          ) : (
            <img src={item.preview} alt="" className={cn("h-24 w-full object-cover transition-opacity", ready ? "opacity-100" : "opacity-0")} onLoad={() => setReady(true)} />
          )}
        </div>
      ) : (
        <p className="truncate px-2 py-2 text-xs">{item.name}</p>
      )}
      {item.status === "uploading" ? (
        <div data-testid="upload-bar" className="upload-bar">
          <span />
        </div>
      ) : null}
    </div>
  );
}

function QuestionCard({
  prompt,
  options,
  multiple,
  allowCustom,
  answer,
  initial,
  onAnswer,
}: {
  prompt: string;
  options: QuestionOption[];
  multiple: boolean;
  allowCustom: boolean;
  answer: string[] | null;
  initial: string;
  onAnswer: (choices: string[], custom?: string) => Promise<boolean>;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [localAnswer, setLocalAnswer] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const answered = !!((answer?.length ?? 0) || localAnswer?.length);
  const shown = (answer?.length ? answer : localAnswer ?? []).join(", ");

  async function choose(label: string) {
    if (answered || pending) return;
    if (multiple) {
      setPicked((current) => (current.includes(label) ? current.filter((item) => item !== label) : [...current, label]));
      return;
    }
    setPicked([label]);
    setPending(true);
    if (await onAnswer([label])) setLocalAnswer([label]);
    setPending(false);
  }

  async function submitCustom() {
    if (answered || pending) return;
    const text = custom.trim();
    if (!text && picked.length === 0) return;
    setPending(true);
    if (await onAnswer(picked, text)) setLocalAnswer([...picked, text].filter(Boolean));
    setPending(false);
  }

  if (answered) {
    return (
      <div data-testid="question-card" data-answered="true" className="rounded-md border border-border bg-card px-4 py-3 shadow-sm">
        <div data-testid="question-answered">
          <p className="text-sm text-muted-foreground">{prompt}</p>
          <div className="mt-2 flex items-center gap-2">
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-destructive text-[11px] font-medium text-destructive-foreground" aria-hidden>
              {initial}
            </span>
            <span className="min-w-0 text-sm text-foreground">{shown}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="question-card" data-answered="false" className="rounded-md border border-border bg-card px-4 py-3 shadow-sm">
      <p className="text-sm font-medium">{prompt}</p>
      <div className="mt-3 flex flex-col gap-2">
        {options.map((option) => (
          <Button
            key={option.label}
            type="button"
            variant={option.style === "danger" ? "destructive" : multiple && picked.includes(option.label) ? "secondary" : "default"}
            aria-pressed={multiple ? picked.includes(option.label) : undefined}
            data-style={option.style}
            disabled={pending}
            className="min-h-11 w-full justify-start whitespace-normal text-left"
            onClick={() => choose(option.label)}
          >
            {option.label}
          </Button>
        ))}
        {allowCustom ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              data-testid="question-custom"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              placeholder="Your own answer"
              className="min-h-11"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitCustom();
                }
              }}
            />
            <Button type="button" variant="secondary" className="min-h-11" data-testid="question-custom-send" disabled={pending} onClick={submitCustom}>
              Send
            </Button>
          </div>
        ) : null}
        {multiple ? (
          <Button type="button" className="min-h-11" data-testid="question-confirm" disabled={pending || (picked.length === 0 && !custom.trim())} onClick={submitCustom}>
            Send choice
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function MemoryNotice({ action, text }: { action: "saved" | "forgot"; text: string }) {
  const label = action === "forgot" ? "Forgot a note" : "Saved to notes";
  return (
    <Collapsible>
      <CollapsibleTrigger data-testid="memory-notice" data-action={action} className="inline-flex min-h-11 items-center gap-2 rounded-md px-1 text-sm text-muted-foreground hover:text-foreground">
        <Notebook className="h-3.5 w-3.5" aria-hidden />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent data-testid="memory-fact" className="px-6 pb-1 text-sm text-muted-foreground">
        {text}
      </CollapsibleContent>
    </Collapsible>
  );
}

function MessageBlockView({
  block,
  jobs,
  accent,
  onOpenJob,
  onReply,
}: {
  block: MessageBlock;
  jobs: CodingJob[];
  accent: string;
  onOpenJob?: (job: CodingJob) => void;
  onReply: () => void;
}) {
  if (block.kind === "text") return <RichText text={block.text} jobs={jobs} accent={accent} onOpenJob={onOpenJob} />;
  if (block.kind === "question" || block.kind === "memory" || block.kind === "coding-jobs") return null;
  if (block.kind === "form") return <SecureFormCard title={block.title} fields={block.fields} />;
  if (block.kind === "image" || block.kind === "video") {
    return <MediaAttachment name={block.name} url={block.url} video={block.kind === "video"} onReply={onReply} />;
  }
  return (
    <div data-testid="attachment-card" className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-card-foreground">
      <a href={block.url || "#"} className="flex min-h-11 items-center gap-2">
        <span className="truncate font-medium">{block.name}</span>
        {block.mime ? <span className="text-xs text-muted-foreground">{block.mime}</span> : null}
      </a>
      <AttachmentActions name={block.name} url={block.url} onReply={onReply} />
    </div>
  );
}

function RichText({ text, jobs, accent, onOpenJob }: { text: string; jobs: CodingJob[]; accent: string; onOpenJob?: (job: CodingJob) => void }) {
  const parts = splitJobMentions(text);
  if (!parts.some((part) => part.kind === "job")) return <Markdown text={text} />;
  return (
    <div className="whitespace-pre-wrap">
      {parts.map((part, index) => {
        if (part.kind === "text") return <Markdown key={index} text={part.text} />;
        const job = jobs.find((item) => item.id === part.id) ?? { id: part.id, title: "Coding job", status: "running" as const, step: "", prNumber: null, prUrl: "", branch: "", filesChanged: 0, additions: 0, deletions: 0 };
        return <JobMention key={part.id} job={job} accent={accent} onOpen={() => onOpenJob?.(job)} />;
      })}
    </div>
  );
}

function MediaAttachment({ name, url, video, onReply }: { name: string; url: string; video: boolean; onReply: () => void }) {
  const [ready, setReady] = useState(false);
  return (
    <figure data-testid="attachment-card" className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative min-h-24">
        {!ready ? <div data-testid="media-skeleton" className="media-shimmer absolute inset-0 min-h-24" /> : null}
        {video ? (
          <video src={url} controls className={cn("max-h-64 w-full transition-opacity", ready ? "opacity-100" : "opacity-0")} onLoadedData={() => setReady(true)} />
        ) : (
          <img src={url} alt={name} className={cn("max-h-64 w-full object-contain transition-opacity", ready ? "opacity-100" : "opacity-0")} onLoad={() => setReady(true)} />
        )}
      </div>
      <figcaption className="px-2 py-1 text-xs text-muted-foreground">{name}</figcaption>
      <AttachmentActions name={name} url={url} onReply={onReply} />
    </figure>
  );
}

function AttachmentActions({ name, url, onReply }: { name: string; url?: string; onReply: () => void }) {
  return (
    <div className="flex items-center gap-1 px-2 pb-2">
      <button type="button" data-testid="attachment-reply" aria-label="Reply" className="rounded-md px-2 py-1 text-xs hover:bg-accent" onClick={onReply}>
        Reply
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" data-testid="attachment-more" aria-label="More attachment actions" className="rounded-md px-2 py-1 text-xs hover:bg-accent">
            ⋯
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onSelect={() => {
              if (url) void navigator.clipboard?.writeText(url);
              toast.success(`Copied the link for ${name}.`);
            }}
          >
            Copy link
          </DropdownMenuItem>
          <DropdownMenuItem asChild disabled={!url}>
            <a href={url || "#"} download>
              Download
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SecureFormCard({ title, fields }: { title: string; fields: FormField[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      for (const field of fields) {
        const value = values[field.name] ?? "";
        if (!value) continue;
        if (field.secret) {
          await api("/api/secrets", {
            method: "POST",
            body: JSON.stringify({
              name: field.name,
              namespace: "chat",
              type: "GENERIC",
              value,
              allowedDomains: [],
              allowedTools: [],
            }),
          });
        }
      }
      toast.success("Saved in the vault. The values stayed out of the transcript.");
      setValues({});
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not save that form."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form data-testid="secure-form-card" className="rounded-lg border border-border bg-card p-3 text-card-foreground" onSubmit={onSubmit}>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">Secret fields are stored in the vault and are not sent to the model.</p>
      <div className="mt-2 flex flex-col gap-2">
        {fields.map((field) => (
          <label key={field.name} className="flex flex-col gap-1 text-xs">
            {field.label}
            <Input
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              value={values[field.name] ?? ""}
              onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
            />
          </label>
        ))}
      </div>
      <Button type="submit" className="mt-3 min-h-11" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

function EventCard({ event }: { event: AgentEvent }) {
  if (event.type === "grounding") {
    const verified = Number(event.verified ?? event.verifiedLinks);
    const removed = Number(event.removed ?? event.removedLinks);
    if (!Number.isFinite(verified) || !Number.isFinite(removed)) return null;
    return (
      <p data-testid="grounding-notice" role="status" className="text-xs text-muted-foreground">
        Verified {verified} links, removed {removed}
      </p>
    );
  }
  if (event.type === "memory") return <MemoryNotice action={event.action === "forgot" ? "forgot" : "saved"} text={String(event.content ?? "")} />;
  const tool = String(event.tool ?? event.name ?? "Tool");
  const args = typeof event.args === "object" && event.args ? JSON.stringify(event.args) : String(event.args ?? "");
  return (
    <Collapsible data-testid="tool-call-card" className="rounded-md border border-border text-xs">
      <CollapsibleTrigger className="flex min-h-10 w-full items-center gap-2 px-3 text-left">
        <span aria-hidden>⌘</span>
        <span className="font-medium">{tool}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{args.slice(0, 90)}</span>
        <span>{String(event.status ?? (event.type === "tool_result" ? "Done" : "Running"))}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border p-3">{JSON.stringify({ args: event.args, result: event.result }, null, 2)}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
