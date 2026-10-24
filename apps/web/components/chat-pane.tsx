"use client";

import { FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/markdown";
import type { AgentEvent } from "@/lib/events";
import { ArrowDown, ArrowUp, AudioLines, MessageSquareQuote, Mic, MoreHorizontal, Notebook, Plus, Reply, Smile } from "lucide-react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerPresence } from "@/components/avatar-motion/composer-presence";
import { CodingJobsCard, JobMention, JobResultCard, LiveJobStep } from "@/components/coding-jobs";
import { lastMessagePreview } from "@/lib/avatar-motion";
import { publishAvatarPreview } from "@/lib/avatar-preview";
import { ApiError, api, apiFetch } from "@/lib/api";
import { EXTRA_EMOJIS, liveJob, newMessagesLabel, optionLetter, pickerSide, QUICK_REACTIONS, QUOTE_HIGHLIGHT_MS, quotePlacement, reactionTooltip, readableAccent, replySnippet, showsJobResult, splitJobMentions, visibleReactions, type CodingJob } from "@/lib/chat-ui";
import { messageBlocks, type FormField, type MessageBlock, type QuestionOption } from "@/lib/message-blocks";
import type { ChatMessage } from "@/lib/types";
import { cn, errorMessage, formatWhen } from "@/lib/utils";

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
  const [picker, setPicker] = useState<{ id: string; side: "above" | "below"; full: boolean } | null>(null);

  useEffect(() => {
    if (!picker) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setPicker(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker]);
  const paint = readableAccent(accent || avatarColor);
  const active = liveJob(codingJobs);
  const byId = new Map(messages.map((message) => [message.id, message]));

  useEffect(() => {
    if (!botId) return undefined;
    let text = "";
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const content = messages[index]?.content?.trim();
      if (content) {
        text = lastMessagePreview(content);
        break;
      }
    }
    publishAvatarPreview(botId, text);
    return undefined;
  }, [botId, messages]);

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

  function togglePicker(messageId: string, anchor: HTMLButtonElement) {
    const rect = anchor.getBoundingClientRect();
    const bounds = scrollRef.current?.getBoundingClientRect();
    const side = pickerSide((bounds?.bottom ?? window.innerHeight) - rect.bottom);
    setPicker((current) => (current?.id === messageId ? null : { id: messageId, side, full: false }));
  }

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
    window.setTimeout(() => node.removeAttribute("data-highlight"), QUOTE_HIGHLIGHT_MS);
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
      setPicker(null);
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
  const [composerLines, setComposerLines] = useState(1);

  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    node.style.height = "auto";
    const line = 20;
    const next = Math.min(Math.max(node.scrollHeight, line), line * 6);
    node.style.height = `${next}px`;
    const fromBreaks = content.split("\n").length;
    setComposerLines(Math.max(fromBreaks, Math.round(next / line)));
  }, [content]);
  let showedJobs = false;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" style={{ ["--bot-accent" as string]: paint }}>
      <div
        ref={scrollRef}
        data-testid="chat-scroll"
        className="relative z-0 min-h-0 flex-1 overflow-y-auto pt-12"
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
        <div className="mx-auto flex w-full max-w-[var(--content-width)] flex-col gap-2 px-4 py-4">
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
                <article key={message.id} id={`message-${message.id}`} data-testid="message-item" data-role={message.role} className="group relative mr-auto w-full max-w-md">
                  <QuestionCard
                    prompt={only.prompt}
                    options={only.options}
                    multiple={only.multiple}
                    allowCustom={only.allowCustom}
                    answer={only.answer}
                    onAnswer={(choices, custom) => answer(message.id, choices, custom)}
                  />
                  <MessageToolbar
                    messageId={message.id}
                    content={message.content}
                    mine={false}
                    picker={picker?.id === message.id ? picker : null}
                    customEmoji={customEmoji}
                    onCustomEmoji={setCustomEmoji}
                    onToggle={(anchor) => togglePicker(message.id, anchor)}
                    onExpand={() => setPicker((current) => (current ? { ...current, full: true } : current))}
                    onReact={(emoji) => void react(message.id, emoji)}
                    onReply={() => setReply(message)}
                  />
                  <time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time>
                </article>
              );
            }
            const mine = message.role === "user";
            const reactions = visibleReactions(message.role, message.reactions);
            const quoted = message.replyToId ? byId.get(message.replyToId) : undefined;
            const placement = quotePlacement(message.role);
            const media = blocks.filter((block) => block.kind === "image" || block.kind === "video" || block.kind === "file");
            const body = blocks.filter((block) => block.kind !== "image" && block.kind !== "video" && block.kind !== "file");
            const singleLine = mine && media.length === 0 && body.length === 1 && body[0].kind === "text" && !body[0].text.includes("\n") && body[0].text.trim().length < 80;
            const showBubble = body.length > 0 || (Boolean(message.replyToId) && placement === "inside");
            return (
              <article
                key={message.id}
                id={`message-${message.id}`}
                data-testid="message-item"
                data-role={message.role}
                className={cn("group relative flex w-fit min-w-0 max-w-[85%] flex-col sm:max-w-[70%]", mine ? "ml-auto items-end" : "mr-auto items-start")}
              >
                {message.replyToId && placement === "above" ? (
                  <button
                    type="button"
                    data-testid="reply-quote"
                    className="mb-1 max-w-full truncate rounded-full bg-muted px-3 py-1 text-left text-xs text-muted-foreground"
                    onClick={() => focusMessage(message.replyToId!)}
                  >
                    {replySnippet(quoted?.content ?? "")}
                  </button>
                ) : null}
                {showBubble ? (
                  <div
                    data-testid="message-bubble"
                    className={cn(
                      "relative space-y-2 px-3.5 py-2 text-sm",
                      mine ? "bg-[var(--bot-accent)] text-on-accent" : "bg-assistant-bubble text-assistant-bubble-foreground",
                      singleLine ? "rounded-full" : mine ? "rounded-2xl" : "rounded-xl",
                      reactions.length ? "mb-3" : "",
                    )}
                  >
                    {message.replyToId && placement === "inside" ? (
                      <button
                        type="button"
                        data-testid="reply-quote"
                        className="flex w-full min-w-0 items-center gap-1.5 text-left text-xs text-muted-foreground"
                        onClick={() => focusMessage(message.replyToId!)}
                      >
                        <MessageSquareQuote className="size-3.5 shrink-0" aria-hidden />
                        <span className="truncate">{replySnippet(quoted?.content ?? "")}</span>
                      </button>
                    ) : null}
                    {body.map((block, index) => (
                      <MessageBlockView
                        key={`${message.id}-body-${index}`}
                        block={block}
                        jobs={codingJobs}
                        accent={paint}
                        mine={mine}
                        botId={botId}
                        onOpenJob={onOpenJob}
                        onReply={() => setReply(message)}
                      />
                    ))}
                    <ReactionCluster reactions={reactions} botName={botName} userName={userName} onToggle={(emoji) => void react(message.id, emoji)} />
                  </div>
                ) : null}
                {media.length > 0 ? (
                  <div className={cn("relative flex w-full flex-col gap-1", showBubble ? "mt-1" : "", !showBubble && reactions.length ? "mb-3" : "")} data-testid={showBubble ? undefined : "message-bubble"}>
                    {media.map((block, index) => (
                      <MessageBlockView
                        key={`${message.id}-media-${index}`}
                        block={block}
                        jobs={codingJobs}
                        accent={paint}
                        mine={mine}
                        botId={botId}
                        onOpenJob={onOpenJob}
                        onReply={() => setReply(message)}
                      />
                    ))}
                    {showBubble ? null : <ReactionCluster reactions={reactions} botName={botName} userName={userName} onToggle={(emoji) => void react(message.id, emoji)} />}
                  </div>
                ) : null}
                <MessageToolbar
                  messageId={message.id}
                  content={message.content}
                  mine={mine}
                  picker={picker?.id === message.id ? picker : null}
                  customEmoji={customEmoji}
                  onCustomEmoji={setCustomEmoji}
                  onToggle={(anchor) => togglePicker(message.id, anchor)}
                  onExpand={() => setPicker((current) => (current ? { ...current, full: true } : current))}
                  onReact={(emoji) => void react(message.id, emoji)}
                  onReply={() => setReply(message)}
                />
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
        </div>
      </div>
      {scrolledUp ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-30 flex justify-center">
          {fresh > 0 && !dismissedFresh ? (
            <div data-testid="new-messages" className="pointer-events-auto flex items-center gap-1 rounded-full bg-[var(--bot-accent)] px-3 py-1 text-sm text-on-accent shadow-sm">
              <button type="button" onClick={jump}>
                {newMessagesLabel(fresh)}
              </button>
              <button type="button" aria-label="Dismiss new messages" className="px-1" onClick={() => setDismissedFresh(true)}>
                ×
              </button>
            </div>
          ) : (
            <button type="button" data-testid="jump-to-latest" aria-label="Jump to latest" className="pointer-events-auto grid size-10 place-items-center rounded-full border border-border bg-card text-card-foreground shadow-md" onClick={jump}>
              <ArrowDown className="h-5 w-5" />
            </button>
          )}
        </div>
      ) : null}
      {working ? (
        <div className="mx-auto w-full max-w-[var(--content-width)] px-4 pb-2">
          <ComposerPresence botId={botId} name={botName} shape={avatarShape} color={avatarColor || accent} status="Typing…" />
        </div>
      ) : null}
      <form data-testid="composer-bar" className="mx-auto flex w-full max-w-[var(--content-width)] flex-col px-4 pb-4" onSubmit={onSubmit}>
        <div data-testid="composer-stack" className="flex flex-col">
        {reply ? (
          <div data-testid="reply-chip" className="mb-2 flex w-fit max-w-full items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{replySnippet(reply.content)}</span>
            <button type="button" aria-label="Cancel reply" onClick={() => setReply(null)}>
              ×
            </button>
          </div>
        ) : null}
        <div
          data-testid="composer-pill"
          data-multiline={composerLines > 1 ? "true" : "false"}
          className="border border-[var(--composer-border)] bg-[var(--composer)] text-card-foreground shadow-[var(--composer-shadow)] transition-colors focus-within:border-[var(--composer-border-focus)]"
          style={{ borderRadius: composerLines > 1 || uploads.length > 0 ? 20 : 9999 }}
        >
          {uploads.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
              {uploads.map((item) => (
                <UploadCard key={item.id} item={item} />
              ))}
            </div>
          ) : null}
          <div className={cn("flex gap-1 px-1.5", composerLines > 1 ? "items-end py-1.5" : "h-11 items-center")}>
            <input ref={fileRef} type="file" multiple className="sr-only" aria-hidden tabIndex={-1} onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" data-testid="composer-add" aria-label="Add" disabled={sending} className="grid size-7 shrink-0 place-items-center rounded-full text-[var(--composer-placeholder)] hover:bg-[var(--composer-hover)] disabled:opacity-50">
                  <Plus className="size-4" strokeWidth={1.5} />
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
            <textarea
              ref={composerRef}
              aria-label={`Message ${botName}`}
              data-testid="composer"
              value={content}
              disabled={sending}
              onChange={(event) => setContent(event.target.value)}
              placeholder={`Message ${botName}`}
              rows={1}
              className="max-h-[120px] min-h-5 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-0 text-[13px] leading-5 text-foreground shadow-none outline-none placeholder:text-[var(--composer-placeholder)] focus-visible:outline-none focus-visible:ring-0 disabled:opacity-50"
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
            <button type="button" data-testid="composer-mic" aria-label="Microphone" disabled={sending} className="grid size-7 shrink-0 place-items-center text-[var(--composer-placeholder)] disabled:opacity-50">
              <Mic className="size-4" strokeWidth={1.5} />
            </button>
            <button
              type={typing ? "submit" : "button"}
              data-testid={typing ? "send-chat" : "composer-voice"}
              aria-label={typing ? "Send" : "Voice"}
              disabled={sending || !conversationId || (typing && uploads.some((item) => item.status === "uploading"))}
              className="relative grid size-[30px] shrink-0 place-items-center rounded-full text-on-accent disabled:opacity-50"
              style={{ backgroundColor: paint }}
            >
              <AudioLines className={cn("absolute size-4 transition-opacity duration-200", typing ? "opacity-0" : "opacity-100")} strokeWidth={1.75} />
              <ArrowUp className={cn("absolute size-4 transition-opacity duration-200", typing ? "opacity-100" : "opacity-0")} strokeWidth={2.25} />
            </button>
          </div>
        </div>
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
    <div data-testid="upload-card" data-status={item.status} className="flex max-w-full items-center gap-2 rounded-full border border-border bg-muted px-2 py-1 text-xs text-foreground">
      {media ? (
        <span className="relative size-5 overflow-hidden rounded-full">
          {!ready ? <span data-testid="media-skeleton" className="media-shimmer absolute inset-0" /> : null}
          {item.mime.startsWith("video/") ? (
            <video src={item.preview} className={cn("size-5 object-cover transition-opacity", ready ? "opacity-100" : "opacity-0")} muted onLoadedData={() => setReady(true)} />
          ) : (
            <img src={item.preview} alt="" className={cn("size-5 object-cover transition-opacity", ready ? "opacity-100" : "opacity-0")} onLoad={() => setReady(true)} />
          )}
        </span>
      ) : null}
      <span className="max-w-[12rem] truncate">{item.name}</span>
      {item.status === "uploading" ? (
        <span data-testid="upload-bar" className="upload-bar w-10 rounded-full">
          <span />
        </span>
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
  onAnswer,
}: {
  prompt: string;
  options: QuestionOption[];
  multiple: boolean;
  allowCustom: boolean;
  answer: string[] | null;
  onAnswer: (choices: string[], custom?: string) => Promise<boolean>;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [localAnswer, setLocalAnswer] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const answered = !!((answer?.length ?? 0) || localAnswer?.length);
  const chosen = answer?.length ? answer : localAnswer ?? [];
  const chooseRef = useRef<(label: string) => void>(() => undefined);

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

  chooseRef.current = (label: string) => {
    void choose(label);
  };

  useEffect(() => {
    if (answered) return;
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.key.length !== 1) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const index = event.key.toUpperCase().charCodeAt(0) - 65;
      if (index < 0 || index >= options.length) return;
      event.preventDefault();
      chooseRef.current(options[index].label);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answered, options]);

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
      <div data-testid="question-card" data-answered="true" className="rounded-2xl border border-border bg-card px-4 py-3 text-card-foreground shadow-sm">
        <div data-testid="question-answered">
          <p className="text-sm text-muted-foreground">{prompt}</p>
          <div className="mt-2 flex flex-col gap-1">
            {chosen.map((label) => {
              const index = options.findIndex((option) => option.label === label);
              const letter = index >= 0 ? optionLetter(index) : "";
              return (
                <div key={label} className="flex items-center gap-2 py-1">
                  {letter ? (
                    <span data-testid="option-letter" className="grid size-5 shrink-0 place-items-center rounded-md bg-[var(--bot-accent)] text-[11px] font-medium text-on-accent" aria-hidden>
                      {letter}
                    </span>
                  ) : null}
                  <span className="min-w-0 text-sm text-foreground">{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="question-card" data-answered="false" className="rounded-2xl border border-border bg-card px-4 py-3 text-card-foreground shadow-sm">
      <p className="text-sm font-semibold">{prompt}</p>
      {multiple ? <p className="mt-0.5 text-xs text-muted-foreground">Choose all that apply</p> : null}
      <div className="mt-2 flex flex-col">
        {options.map((option, index) => {
          const letter = optionLetter(index);
          const selected = picked.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              aria-pressed={multiple ? selected : undefined}
              data-style={option.style}
              data-letter={letter}
              disabled={pending}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-60"
              onClick={() => void choose(option.label)}
            >
              <span
                aria-hidden
                data-testid="option-letter"
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-md text-[11px] font-medium",
                  selected ? "bg-[var(--bot-accent)] text-on-accent" : "bg-muted text-muted-foreground",
                )}
              >
                {letter}
              </span>
              <span className="min-w-0">{option.label}</span>
            </button>
          );
        })}
        {allowCustom ? (
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Input
              data-testid="question-custom"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              placeholder="Type your own answer"
              className="min-h-11"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitCustom();
                }
              }}
            />
            <Button type="button" variant="secondary" className="min-h-11" data-testid="question-custom-send" disabled={pending} onClick={() => void submitCustom()}>
              Send
            </Button>
          </div>
        ) : null}
        {multiple ? (
          <Button type="button" className="ml-auto mt-2 h-9 rounded-full px-4" data-testid="question-confirm" disabled={pending || (picked.length === 0 && !custom.trim())} onClick={() => void submitCustom()}>
            Done
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ReactionCluster({
  reactions,
  botName,
  userName,
  onToggle,
}: {
  reactions: { id?: string; actorType: string; emoji: string }[];
  botName: string;
  userName: string;
  onToggle: (emoji: string) => void;
}) {
  if (reactions.length === 0) return null;
  return (
    <div data-testid="reaction-cluster" className="absolute bottom-0 right-2 z-10 flex translate-y-1/2 gap-1">
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
                  if (reaction.actorType === "user") onToggle(reaction.emoji);
                }}
              >
                {reaction.emoji}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="rounded-full bg-popover text-popover-foreground shadow-md">
              {reactionTooltip(reaction.actorType, who, reaction.emoji)}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function MessageToolbar({
  messageId,
  content,
  mine,
  picker,
  customEmoji,
  onCustomEmoji,
  onToggle,
  onExpand,
  onReact,
  onReply,
}: {
  messageId: string;
  content: string;
  mine: boolean;
  picker: { id: string; side: "above" | "below"; full: boolean } | null;
  customEmoji: string;
  onCustomEmoji: (value: string) => void;
  onToggle: (anchor: HTMLButtonElement) => void;
  onExpand: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
}) {
  const side = picker?.side ?? "below";
  const place = cn("absolute z-30", mine ? "right-0" : "left-0", side === "above" ? "bottom-full mb-1" : "top-full mt-1");
  return (
    <div className={cn("absolute top-0 z-20", mine ? "right-full mr-1.5" : "left-full ml-1.5")}>
      <div
        data-testid="message-toolbar"
        className={cn(
          "flex items-center gap-0.5 rounded-full border border-border bg-card p-0.5 text-card-foreground shadow-sm transition-opacity",
          picker ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        <button type="button" data-testid="message-react" aria-label="React" aria-expanded={picker?.id === messageId} className="grid size-7 place-items-center rounded-full hover:bg-accent" onClick={(event) => onToggle(event.currentTarget)}>
          <Smile className="size-4" />
        </button>
        <button type="button" data-testid="message-reply" aria-label="Reply" className="grid size-7 place-items-center rounded-full hover:bg-accent" onClick={onReply}>
          <Reply className="size-4" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" data-testid="message-more" aria-label="More message actions" className="grid size-7 place-items-center rounded-full hover:bg-accent">
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={mine ? "end" : "start"}>
            <DropdownMenuItem
              onSelect={() => {
                void navigator.clipboard?.writeText(content).then(
                  () => toast.success("Copied the message."),
                  () => toast.error("Could not copy that message."),
                );
              }}
            >
              Copy text
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {picker?.full ? (
        <div data-testid="emoji-picker" data-side={side} className={cn(place, "w-52 rounded-2xl border border-border bg-popover p-2 text-popover-foreground shadow-md")}>
          <div className="grid grid-cols-6 gap-0.5">
            {[...QUICK_REACTIONS, ...EXTRA_EMOJIS].map((emoji) => (
              <button key={emoji} type="button" className="grid size-8 place-items-center rounded-md text-base hover:bg-accent" onClick={() => onReact(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
          <input
            data-testid="reaction-custom"
            value={customEmoji}
            onChange={(event) => onCustomEmoji(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onReact(customEmoji);
              }
            }}
            placeholder="Emoji"
            aria-label="Custom emoji"
            className="mt-1 w-full rounded-full border border-border bg-card px-2 py-1 text-xs text-foreground"
          />
        </div>
      ) : picker ? (
        <div data-testid="reaction-picker" data-side={side} className={cn(place, "flex max-w-[13.5rem] items-center gap-0.5 rounded-full border border-border bg-popover px-1 py-0.5 text-popover-foreground shadow-md")}>
          {QUICK_REACTIONS.map((emoji) => (
            <button key={emoji} type="button" className="grid size-7 place-items-center rounded-full text-base hover:bg-accent" onClick={() => onReact(emoji)}>
              {emoji}
            </button>
          ))}
          <button type="button" data-testid="reaction-add" aria-label="Add emoji" className="grid size-7 place-items-center rounded-full hover:bg-accent" onClick={onExpand}>
            <Plus className="size-3.5" />
          </button>
        </div>
      ) : null}
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
  botId,
  mine,
  onOpenJob,
  onReply,
}: {
  block: MessageBlock;
  jobs: CodingJob[];
  accent: string;
  botId?: string;
  mine: boolean;
  onOpenJob?: (job: CodingJob) => void;
  onReply: () => void;
}) {
  const side = mine ? "start" : "end";
  if (block.kind === "text") return <RichText text={block.text} jobs={jobs} accent={accent} botId={botId} onOpenJob={onOpenJob} />;
  if (block.kind === "question" || block.kind === "memory" || block.kind === "coding-jobs") return null;
  if (block.kind === "form") return <SecureFormCard title={block.title} fields={block.fields} />;
  if (block.kind === "image" || block.kind === "video") {
    return <MediaAttachment name={block.name} url={block.url} video={block.kind === "video"} side={side} onReply={onReply} />;
  }
  return (
    <div data-testid="attachment-card" className="group/file relative w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-card-foreground">
      <a href={block.url || "#"} className="flex min-h-11 items-center gap-2">
        <span className="truncate font-medium">{block.name}</span>
        {block.mime ? <span className="text-xs text-muted-foreground">{block.mime}</span> : null}
      </a>
      <AttachmentActions name={block.name} url={block.url} side={side} onReply={onReply} />
    </div>
  );
}

function RichText({ text, jobs, accent, botId, onOpenJob }: { text: string; jobs: CodingJob[]; accent: string; botId?: string; onOpenJob?: (job: CodingJob) => void }) {
  const parts = splitJobMentions(text);
  if (!parts.some((part) => part.kind === "job")) return <Markdown text={text} jobs={jobs} />;
  return (
    <div className="whitespace-pre-wrap">
      {parts.map((part, index) => {
        if (part.kind === "text") return <Markdown key={index} text={part.text} jobs={jobs} />;
        const job = jobs.find((item) => item.id === part.id) ?? { id: part.id, title: "Coding job", status: "running" as const, step: "", prNumber: null, prUrl: "", branch: "", filesChanged: 0, additions: 0, deletions: 0 };
        return <JobMention key={part.id} job={job} accent={accent} botId={botId} onOpen={() => onOpenJob?.(job)} />;
      })}
    </div>
  );
}

function MediaAttachment({ name, url, video, side, onReply }: { name: string; url: string; video: boolean; side: "start" | "end"; onReply: () => void }) {
  const [ready, setReady] = useState(false);
  return (
    <figure data-testid="attachment-card" className="group/file relative overflow-visible rounded-xl border border-border bg-card">
      <div className="relative min-h-24 overflow-hidden rounded-xl">
        {!ready ? <div data-testid="media-skeleton" className="media-shimmer absolute inset-0 min-h-24" /> : null}
        {video ? (
          <video src={url} controls className={cn("max-h-64 w-full transition-opacity", ready ? "opacity-100" : "opacity-0")} onLoadedData={() => setReady(true)} />
        ) : (
          <img src={url} alt={name} className={cn("max-h-64 w-full object-contain transition-opacity", ready ? "opacity-100" : "opacity-0")} onLoad={() => setReady(true)} />
        )}
      </div>
      <figcaption className="px-2 py-1 text-xs text-muted-foreground">{name}</figcaption>
      <AttachmentActions name={name} url={url} side={side} onReply={onReply} />
    </figure>
  );
}

function AttachmentActions({ name, url, side, onReply }: { name: string; url?: string; side: "start" | "end"; onReply: () => void }) {
  return (
    <div
      className={cn(
        "absolute top-1 z-30 flex items-center gap-0.5 rounded-full border border-border bg-card p-0.5 text-card-foreground opacity-0 shadow-sm transition-opacity group-hover/file:opacity-100 group-focus-within/file:opacity-100",
        side === "end" ? "left-full ml-1" : "right-full mr-1",
      )}
    >
      <button type="button" data-testid="attachment-reply" aria-label="Reply" className="grid size-7 place-items-center rounded-full hover:bg-accent" onClick={onReply}>
        <Reply className="size-3.5" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" data-testid="attachment-more" aria-label="More attachment actions" className="grid size-7 place-items-center rounded-full hover:bg-accent">
            <MoreHorizontal className="size-3.5" />
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
