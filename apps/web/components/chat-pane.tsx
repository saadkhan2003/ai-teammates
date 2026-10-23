"use client";

import { FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/markdown";
import type { AgentEvent } from "@/lib/events";
import { Notebook } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api } from "@/lib/api";
import { messageBlocks, type FormField, type QuestionOption } from "@/lib/message-blocks";
import type { ChatMessage } from "@/lib/types";
import { errorMessage, formatWhen } from "@/lib/utils";

const QUICK_REACTIONS = ["👍", "❤️", "🎉", "😂", "✅"];

export function ChatPane({
  conversationId,
  messages,
  botName,
  onSent,
  extras,
  working = false,
  events = [],
  onStop,
}: {
  conversationId?: string;
  messages: ChatMessage[];
  botName: string;
  onSent: () => void;
  extras?: ReactNode;
  working?: boolean;
  events?: AgentEvent[];
  onStop?: () => Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dlp, setDlp] = useState(false);
  const [customEmoji, setCustomEmoji] = useState("");
  const [userName, setUserName] = useState("You");

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
    if (stickRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, events, working]);
  useEffect(() => {
    const node = composerRef.current;
    if (node) { node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, 180)}px`; }
  }, [content]);
  async function stop() {
    setStopping(true);
    try { await onStop?.(); } catch (caught) { setError(errorMessage(caught, "Could not stop this run.")); }
    finally { setStopping(false); }
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

  async function send(asTask: boolean, text = content.trim()) {
    if (sending) return;
    if (!text) {
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
        body: JSON.stringify({ content: text, asTask }),
      });
      if (text === content.trim()) setContent("");
      onSent();
    } catch (caught) {
      const message = errorMessage(caught, asTask ? "Could not assign that work." : "Could not send that message.");
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
    void send(false);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} data-testid="chat-scroll" className="min-h-0 flex-1 overflow-y-auto" onScroll={() => {
        const node = scrollRef.current;
        if (!node) return;
        stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        setScrolledUp(!stickRef.current);
      }}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-4">
          {extras}
          {messages.length === 0 ? <div data-testid="chat-empty" className="py-12 text-center"><p className="font-medium">Start a conversation with {botName}</p><p className="mt-2 text-sm text-muted-foreground">Ask a question, share an idea, or assign some work.</p></div> : null}
          {messages.map((message) => {
            const blocks = messageBlocks(message.content);
            const only = blocks.length === 1 ? blocks[0] : null;
            if (only?.kind === "memory") {
              return (
                <article key={message.id} data-testid="message-item" data-role={message.role} className="group mr-auto w-full max-w-md">
                  <MemoryNotice action={only.action} text={only.text} />
                  <time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time>
                </article>
              );
            }
            if (only?.kind === "question") {
              return (
                <article key={message.id} data-testid="message-item" data-role={message.role} className="group mr-auto w-full max-w-md">
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
            return (
              <article
                key={message.id}
                data-testid="message-item"
                data-role={message.role}
                className={mine ? "group ml-auto min-w-0 max-w-[85%] sm:max-w-[75%]" : "group mr-auto min-w-0 max-w-[85%] sm:max-w-[75%]"}
              >
                {!mine ? <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground"><img src="/favicon.svg" alt="" className="h-5 w-5 rounded-sm" />{botName}</div> : null}
                <div
                  className={
                    mine
                      ? "space-y-2 rounded-bubble bg-user-bubble px-3.5 py-2 text-sm text-user-bubble-foreground"
                      : "space-y-2 rounded-bubble bg-assistant-bubble px-3.5 py-2 text-sm text-assistant-bubble-foreground"
                  }
                >
                  {blocks.map((block, index) => (
                    <MessageBlockView key={`${message.id}-${index}`} block={block} />
                  ))}
                </div>
                {(message.reactions ?? []).length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {message.reactions?.map((reaction) => (
                      <Button
                        variant="outline"
                        size="sm"
                        key={reaction.id ?? `${reaction.actorType}-${reaction.emoji}`}
                        type="button"
                        data-testid="reaction-pill"
                        data-emoji={reaction.emoji}
                        data-actor={reaction.actorType}
                        title={reaction.actorType === "bot" ? botName : "You"}
                        className="rounded-md border border-border bg-card px-2 py-0.5 text-sm"
                        onClick={() => {
                          if (reaction.actorType === "user") void react(message.id, reaction.emoji);
                        }}
                      >
                        {reaction.emoji}
                      </Button>
                    ))}
                  </div>
                ) : null}
                {message.role === "assistant" ? (
                  <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="reaction-picker">
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
                      className="w-16 rounded-md border border-border bg-card px-2 py-0.5 text-xs"
                      aria-label="Custom emoji"
                    />
                  </div>
                ) : null}
                <time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time>
              </article>
            );
          })}
          {events.filter(event => !["delta", "message.delta", "text_delta"].includes(event.type)).map((event, i) => <EventCard key={`${conversationId}-${i}`} event={event} />)}
          {working && events.some(event => ["delta", "message.delta", "text_delta"].includes(event.type)) ? <div data-testid="streaming-text" className="rounded-md bg-assistant-bubble p-3 text-sm"><Markdown text={events.filter(event => ["delta", "message.delta", "text_delta"].includes(event.type)).map(event => String(event.delta ?? event.text ?? "")).join("")} /><span aria-hidden className="inline-block h-4 w-1 animate-pulse bg-foreground" /></div> : null}
          {working ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <img src="/favicon.svg" alt="" className="h-4 w-4 rounded-sm" />
              {botName} is working
            </p>
          ) : null}
        </div>
      </div>
      {scrolledUp ? <Button data-testid="jump-to-latest" variant="secondary" className="mx-auto my-2" onClick={() => { stickRef.current = true; setScrolledUp(false); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }}>Jump to latest ↓</Button> : null}
      <form
        data-testid="composer-bar"
        className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        onSubmit={onSubmit}
      >
        <div className="rounded-md border border-border bg-card px-3 py-2 shadow-sm">
          <Textarea
            ref={composerRef}
            aria-label={`Message ${botName}`}
            data-testid="composer"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={`Message ${botName}`}
            className="min-h-10 resize-none border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0"
            onKeyDown={(event) => {
              if (event.key === "Escape") { setError(null); composerRef.current?.blur(); }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send(false);
              }
            }}
          />
          <div className="flex items-center justify-end gap-2">
            {working && onStop ? <Button type="button" data-testid="stop-run" variant="destructive" disabled={stopping} onClick={() => void stop()}>{stopping ? "Stopping…" : "Stop"}</Button> : null}
            <Button data-testid="send-chat" type="submit" variant="secondary" className="min-h-11 rounded-md" disabled={sending || !conversationId}>
              Send
            </Button>
            <Button data-testid="assign-task" className="min-h-11 rounded-md" disabled={sending || !conversationId} onClick={() => void send(true)}>
              Assign work
            </Button>
          </div>
        </div>
        {error ? (
          <p role="alert" data-testid={dlp ? "dlp-block" : undefined} className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </form>
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
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-destructive text-[11px] font-medium text-white" aria-hidden>
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
      <CollapsibleTrigger
        data-testid="memory-notice"
        data-action={action}
        className="inline-flex min-h-11 items-center gap-2 rounded-md px-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <Notebook className="h-3.5 w-3.5" aria-hidden />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent data-testid="memory-fact" className="px-6 pb-1 text-sm text-muted-foreground">
        {text}
      </CollapsibleContent>
    </Collapsible>
  );
}

function MessageBlockView({ block }: { block: ReturnType<typeof messageBlocks>[number] }) {
  if (block.kind === "text") return <Markdown text={block.text} />;
  if (block.kind === "question" || block.kind === "memory") return null;
  if (block.kind === "form") return <SecureFormCard title={block.title} fields={block.fields} />;
  if (block.kind === "image") {
    return (
      <figure data-testid="attachment-card" className="overflow-hidden rounded-lg border border-border bg-card">
        <img src={block.url} alt={block.name} className="max-h-64 w-full object-contain" />
        <figcaption className="px-2 py-1 text-xs text-muted-foreground">{block.name}</figcaption>
      </figure>
    );
  }
  return (
    <a data-testid="attachment-card" href={block.url || "#"} className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-card-foreground">
      <span className="truncate font-medium">{block.name}</span>
      {block.mime ? <span className="text-xs text-muted-foreground">{block.mime}</span> : null}
    </a>
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
    return <p data-testid="grounding-notice" role="status" className="text-xs text-muted-foreground">Verified {verified} links, removed {removed}</p>;
  }
  if (event.type === "memory") return <MemoryNotice action={event.action === "forgot" ? "forgot" : "saved"} text={String(event.content ?? "")} />;
  const tool = String(event.tool ?? event.name ?? "Tool");
  const args = typeof event.args === "object" && event.args ? JSON.stringify(event.args) : String(event.args ?? "");
  return <Collapsible data-testid="tool-call-card" className="rounded-md border border-border text-xs"><CollapsibleTrigger className="flex min-h-10 w-full items-center gap-2 px-3 text-left"><span aria-hidden>⌘</span><span className="font-medium">{tool}</span><span className="min-w-0 flex-1 truncate text-muted-foreground">{args.slice(0, 90)}</span><span>{String(event.status ?? (event.type === "tool_result" ? "Done" : "Running"))}</span></CollapsibleTrigger><CollapsibleContent><pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border p-3">{JSON.stringify({ args: event.args, result: event.result }, null, 2)}</pre></CollapsibleContent></Collapsible>;
}
