"use client";

import { beginSendPerf, endSendPerf, paintedPerf, chatPaintedPerf, initPerf } from "@/lib/perf";
import { FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/markdown";
import { RefreshNotice } from "@/components/refresh-notice";
import { ResumeCard, ResumeNotice } from "@/components/resume-card";
import type { AgentEvent } from "@/lib/events";
import { ArrowUp, Loader2, Notebook, Plus, Reply as ReplyIcon, X as XIcon, Quote } from "lucide-react";
import { highlightPlan, loadUntil } from "@/lib/history";
import { BotAvatar } from "@/components/bot-avatar";
import { BotActionRow, BotThreadRow } from "@/components/bot-thread";
import { parseBotRow, type BotThreadView } from "@/lib/bot-thread";
import { MessageBody, MessageItem, plainTextOf } from "@/components/message-item";
import { ShimmerText, workingStatus } from "@/components/shimmer-text";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { type ComposerPart, addQuote, canSend, hasBlocks, initialParts, normalizeSelection, pillPosition, removePart, setReply, toPayload } from "@/lib/chat-parts";
import { setAvatarMode } from "@/lib/avatar-motion";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, apiFetch } from "@/lib/api";
import { messageBlocks, type FormField, type QuestionOption } from "@/lib/message-blocks";
import { memoryReason, undoableMemoryAction } from "@/lib/memory-notes";
import type { ChatMessage } from "@/lib/types";
import { errorMessage, formatWhen } from "@/lib/utils";

type TaskPlan = { taskId: string; title: string; status: string; items: { title: string; status: string }[]; budget: { label: string }; tests: { required: boolean; passedAt?: string; override: boolean }; blocked: boolean; estimate?: { lowSeconds: number; highSeconds: number; n: number; label: string } | null };

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
  avatar,
  taskTitle,
  activeTaskId,
  evidenceTaskId,
  botThreads = [],
  hasOlder = false,
  onLoadOlder,
  editRequest,
  onEditMemory,
  onMemoryChanged,
}: {
  onEditMemory?: (id: string) => void;
  onMemoryChanged?: () => void;
  editRequest?: { key: number; text: string };
  botId?: string;
  avatar?: { shape?: string; color?: string; primary?: boolean };
  taskTitle?: string;
  activeTaskId?: string;
  evidenceTaskId?: string;
  botThreads?: BotThreadView[];
  hasOlder?: boolean;
  onLoadOlder?: () => Promise<boolean>;
  conversationId?: string;
  messages: ChatMessage[];
  botName: string;
  onSent: () => void;
  extras?: ReactNode;
  working?: boolean;
  events?: AgentEvent[];
  onStop?: () => Promise<void>;
}) {
  const perfTurn = useRef<{ id: string; conversation: string; messages: Set<string>; events: Set<AgentEvent>; working: boolean; at: number; task?: string; message?: string } | null>(null);
  useEffect(() => { initPerf(); }, []);
  useEffect(() => {
    if (conversationId) chatPaintedPerf(botId);
    const turn = perfTurn.current;
    if (!turn) return;
    if (turn.conversation !== conversationId || performance.now() - turn.at > 600000) {
      endSendPerf(turn.id); perfTurn.current = null; return;
    }
    const fresh = messages.filter(m => !turn.messages.has(m.id));
    const user = fresh.find(m => m.role === "user" && (!turn.message || m.id === turn.message));
    const task = turn.task ?? user?.requestId;
    const activity = events.filter(e => !turn.events.has(e) && task && e.taskId === task);
    const reply = fresh.some(m => m.role === "assistant" && m.content.trim() && task && m.requestId === task);
    const measure = (name: string) => paintedPerf(`${turn.id}:${name}`, name);
    if (user) measure("echo_ms");
    if ((!turn.working && working && task && (activeTaskId === task || (!activeTaskId && user))) || activity.length || reply) measure("ack_ms");
    if (activity.some(e => ["tool", "tool_call", "tool_result"].includes(e.type))) measure("tool_chip_ms");
    if (reply || activity.some(e => ["delta", "message.delta", "text_delta"].includes(e.type) && String(e.delta ?? e.text ?? "").trim())) measure("first_token_screen_ms");
  }, [messages, events, working, conversationId, botId, activeTaskId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  useEffect(() => { setAvatarMode(working ? "working" : "idle"); return () => setAvatarMode("idle"); }, [working]);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [evidence, setEvidence] = useState<Array<{ id: string; name: string; mime: string; bytes: number }>>([]);
  useEffect(() => {
    if (!activeTaskId) { setPlan(null); return; }
    let live = true;
    const refresh = () => { void api<TaskPlan>(`/api/tasks/${activeTaskId}/plan`).then(value => { if (live) setPlan(value); }).catch(() => {}); };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [activeTaskId, events]);
  useEffect(() => {
    if (!evidenceTaskId) { setEvidence([]); return; }
    let live = true;
    api<Array<{ id: string; name: string; mime: string; bytes: number }>>(`/api/tasks/${evidenceTaskId}/evidence`)
      .then(value => { if (live) setEvidence(value); })
      .catch(() => { if (live) setEvidence([]); });
    return () => { live = false; };
  }, [evidenceTaskId, messages.length]);
  const [parts, setParts] = useState<ComposerPart[]>(initialParts);
  const partRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState("");
  const [pill, setPill] = useState<{ x: number; y: number; text: string; source?: string } | null>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const draftsRef = useRef(new Map<string, ComposerPart[]>());
  const fileRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dlp, setDlp] = useState(false);
  const [userName, setUserName] = useState("You");

  useEffect(() => {
    if (!editRequest) return;
    const part = initialParts().find((item) => item.type === "text");
    if (!part || part.type !== "text") return;
    part.text = editRequest.text;
    setParts([part]);
    window.setTimeout(() => partRefs.current.get(part.id)?.focus(), 0);
  }, [editRequest?.key]);

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
  const lastTextId = parts[parts.length - 1]?.id;
  useEffect(() => {
    for (const node of partRefs.current.values()) { node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, 180)}px`; }
  }, [parts]);

  // keep a draft per conversation in memory
  const prevConv = useRef(conversationId);
  useEffect(() => {
    if (prevConv.current !== conversationId) {
      if (prevConv.current) draftsRef.current.set(prevConv.current, parts);
      setParts(draftsRef.current.get(conversationId ?? "") ?? initialParts());
      prevConv.current = conversationId;
    }
  }, [conversationId, parts]);

  async function stop() {
    setStopping(true);
    try { await onStop?.(); } catch (caught) { setError(errorMessage(caught, "Could not stop this run.")); }
    finally { setStopping(false); }
  }
  const initial = userName.trim().charAt(0).toUpperCase() || "Y";
  const byId = new Map(messages.map(m => [m.id, m]));
  // Messages that arrive after the first paint of this conversation slide in; the history does not.
  const seen = useRef<{ key?: string; ids: Set<string> } | null>(null);
  if (!seen.current || seen.current.key !== botId) seen.current = { key: botId, ids: new Set(messages.map(m => m.id)) };
  const freshIds = new Set(messages.filter(m => !seen.current!.ids.has(m.id)).map(m => m.id));
  useEffect(() => { for (const m of messages) seen.current?.ids.add(m.id); });

  function announce(text: string) { setLive(""); window.setTimeout(() => setLive(text), 30); }
  function focusComposer() { window.setTimeout(() => { const node = lastTextId ? partRefs.current.get(lastTextId) : null; (node ?? Array.from(partRefs.current.values()).pop())?.focus(); }, 0); }

  const addQuoteText = useCallback((raw: string, source?: string) => {
    const { text, truncated } = normalizeSelection(raw);
    let outcome: ReturnType<typeof addQuote> | null = null;
    setParts(current => { outcome = addQuote(current, text, source); return outcome.parts; });
    window.setTimeout(() => {
      const result = outcome as ReturnType<typeof addQuote> | null;
      if (!result) return;
      if (result.added) { announce("Quote added"); if (truncated) toast.info("Quote cut to 4,000 characters."); window.getSelection()?.removeAllRanges(); setPill(null); const nodes = Array.from(partRefs.current.values()); nodes[nodes.length - 1]?.focus(); }
      else if (result.reason === "limit") toast.error("You can add up to 10 quotes (12,000 characters).");
      else if (result.reason === "duplicate") toast.info("That quote is already added.");
    }, 0);
  }, []);

  function startReply(message: ChatMessage) {
    const text = plainTextOf(message).replace(/\s+/g, " ").trim();
    setParts(current => setReply(current, { messageId: message.id, author: message.role === "user" ? "You" : botName, excerpt: text.slice(0, 200) }));
    announce("Reply added");
    focusComposer();
  }
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const hasOlderRef = useRef(hasOlder);
  hasOlderRef.current = hasOlder;
  const highlightTimers = useRef<number[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Scrolls to a message and highlights it: held 3 s, then fades out over 600 ms. Reduced motion: instant scroll, brief static highlight. */
  function flash(node: HTMLElement) {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    highlightTimers.current.forEach(window.clearTimeout);
    highlightTimers.current = [];
    document.querySelectorAll("[data-jump]").forEach(el => el.removeAttribute("data-jump"));
    node.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    for (const step of highlightPlan(reduced)) {
      const apply = () => { if (step.phase === "off") node.removeAttribute("data-jump"); else node.setAttribute("data-jump", step.phase); };
      if (step.after === 0) apply(); else highlightTimers.current.push(window.setTimeout(apply, step.after));
    }
  }
  useEffect(() => () => highlightTimers.current.forEach(window.clearTimeout), []);
  async function loadEarlier() {
    if (!onLoadOlder || loadingOlder) return;
    setLoadingOlder(true);
    try { await onLoadOlder(); } catch (caught) { toast.error(errorMessage(caught, "Could not load earlier messages.")); } finally { setLoadingOlder(false); }
  }
  async function jumpTo(id: string) {
    let node = document.getElementById(`msg-${id}`);
    if (!node && onLoadOlder && hasOlderRef.current) {
      stickRef.current = false;
      setLoadingOlder(true);
      try {
        const found = await loadUntil(id, key => messagesRef.current.some(m => m.id === key), async () => {
          const more = await onLoadOlder();
          await new Promise(resolve => window.setTimeout(resolve, 60));
          return more;
        });
        if (!found) { toast.info("That message is too far back to load."); return; }
        await new Promise(resolve => window.setTimeout(resolve, 60));
      } catch (caught) { toast.error(errorMessage(caught, "Could not load earlier messages.")); return; } finally { setLoadingOlder(false); }
      node = document.getElementById(`msg-${id}`);
    }
    if (!node) { toast.info("The original message is no longer available."); return; }
    flash(node);
  }
  useEffect(() => {
    const openMessage = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (id) void jumpTo(id);
    };
    document.addEventListener("library:open-message", openMessage);
    return () => document.removeEventListener("library:open-message", openMessage);
  }, [jumpTo]);
  function focusSibling(from: HTMLElement, delta: number) {
    const all = Array.from(listRef.current?.querySelectorAll<HTMLElement>("article[data-testid='message-item']") ?? []);
    all[all.indexOf(from) + delta]?.focus();
  }

  // Add to chat: floating pill on a text selection inside the message list
  useEffect(() => {
    let timer = 0;
    const touch = () => window.matchMedia?.("(pointer: coarse)").matches;
    function evaluate() {
      const sel = window.getSelection();
      const list = listRef.current;
      if (!sel || sel.isCollapsed || !list || !sel.anchorNode || !sel.focusNode) { setPill(null); return; }
      const inside = (n: Node) => list.contains(n.nodeType === 3 ? n.parentNode : n);
      const bad = (n: Node) => !!(n.nodeType === 3 ? n.parentElement : (n as Element))?.closest("button, input, textarea, [data-no-quote]");
      if (!inside(sel.anchorNode) || !inside(sel.focusNode) || bad(sel.anchorNode) || bad(sel.focusNode)) { setPill(null); return; }
      const text = sel.toString();
      if (!text.trim()) { setPill(null); return; }
      const range = sel.getRangeAt(0);
      const rects = range.getClientRects();
      const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      const host = (sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : (sel.anchorNode as Element))?.closest<HTMLElement>("[data-message-id]");
      const pos = pillPosition(rect, { w: 124, h: 32 }, window.innerWidth, window.innerHeight, !!touch());
      setPill({ ...pos, text, source: host?.dataset.messageId });
    }
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(evaluate, 100); };
    const hide = () => setPill(null);
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setPill(null); else schedule(); };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("mouseup", schedule);
    document.addEventListener("touchend", schedule);
    document.addEventListener("keyup", onKey);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    const scroller = scrollRef.current;
    scroller?.addEventListener("scroll", hide, { passive: true });
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", schedule); document.removeEventListener("mouseup", schedule);
      document.removeEventListener("touchend", schedule); document.removeEventListener("keyup", onKey);
      window.removeEventListener("resize", hide); window.removeEventListener("blur", hide);
      scroller?.removeEventListener("scroll", hide);
    };
  }, []);

  // Ctrl/Cmd L uses the same function (dispatched by the app shell)
  useEffect(() => {
    const onAdd = () => {
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      if (!text.trim()) return;
      const host = (sel?.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : (sel?.anchorNode as Element | null))?.closest<HTMLElement>("[data-message-id]");
      addQuoteText(text, host?.dataset.messageId);
    };
    window.addEventListener("teammates-add-selection", onAdd);
    return () => window.removeEventListener("teammates-add-selection", onAdd);
  }, [addQuoteText]);

  async function react(messageId: string, emoji: string) {
    const glyph = emoji.trim();
    if (!glyph) return;
    setError(null);
    try {
      await api(`/api/messages/${messageId}/reactions`, { method: "POST", body: JSON.stringify({ emoji: glyph }) });
      onSent();
    } catch (caught) {
      setError(errorMessage(caught, "Could not update that reaction."));
    }
  }

  async function attach(list: FileList | null) {
    if (!list || !botId) return;
    for (const file of Array.from(list)) {
      const target = `/workspace/uploads/${file.name.replace(/[^\w.\- ]+/g, "_")}`;
      try {
        const response = await apiFetch(`/api/bots/${botId}/files`, { method: "PUT", headers: { "x-path": target, "Content-Type": "application/octet-stream" }, body: file });
        if (!response.ok) throw new ApiError(response.status, `Upload failed (${response.status}).`);
        setParts(current => current.map((p, i) => i === current.length - 1 && p.type === "text" ? { ...p, text: `${p.text}${p.text && !p.text.endsWith("\n") ? "\n" : ""}[attached: ${target}]` } : p));
        announce(`Attached ${file.name}`);
      } catch (caught) { setError(errorMessage(caught, "Could not attach that file.")); }
    }
    if (fileRef.current) fileRef.current.value = "";
    focusComposer();
  }

  async function send(asTask: boolean) {
    if (sending) return;
    if (!canSend(parts)) {
      setError("Write a message first.");
      return;
    }
    if (!conversationId) {
      setError("This teammate does not have a conversation yet.");
      return;
    }
    if (perfTurn.current) endSendPerf(perfTurn.current.id);
    perfTurn.current = { id: beginSendPerf(), conversation: conversationId, messages: new Set(messages.map(m => m.id)), events: new Set(events), working, at: performance.now() };
    setSending(true);
    setError(null);
    setDlp(false);
    const rich = hasBlocks(parts);
    const text = parts.filter(p => p.type === "text").map(p => (p as { text: string }).text).join("\n").trim();
    try {
      const sent = await api<{ taskId?: string; messageId?: string }>(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify(rich ? { parts: toPayload(parts), asTask } : { content: text, asTask }),
      });
      if (perfTurn.current) { perfTurn.current.task = sent?.taskId; perfTurn.current.message = sent?.messageId; }
      setParts(initialParts());
      draftsRef.current.delete(conversationId);
      onSent();
    } catch (caught) {
      if (perfTurn.current) { endSendPerf(perfTurn.current.id); perfTurn.current = null; }
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
    void send(false);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} data-testid="chat-scroll" className="min-h-0 flex-1 overflow-y-auto pt-12" onScroll={() => {
        const node = scrollRef.current;
        if (!node) return;
        stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        setScrolledUp(!stickRef.current);
      }}>
        <div ref={listRef} className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-4">
          {hasOlder ? <Button type="button" data-testid="load-older" variant="ghost" size="sm" className="mx-auto" disabled={loadingOlder} onClick={() => void loadEarlier()}>{loadingOlder ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}Load earlier messages</Button> : null}
          {extras}
          {messages.length === 0 ? <div data-testid="chat-empty" className="py-12 text-center"><p className="font-medium">Start a conversation with {botName}</p><p className="mt-2 text-sm text-muted-foreground">Ask a question, share an idea, or assign some work.</p></div> : null}
          {messages.map((message) => {
            const blocks = messageBlocks(message.content);
            const only = blocks.length === 1 ? blocks[0] : null;
            if (only?.kind === "memory") {
              return (
                <article key={message.id} data-testid="message-item" data-role={message.role} className="group mr-auto w-full max-w-md">
                  <MemoryNotice botId={botId} action={only.action} text={only.text} memoryId={only.memoryId} memoryKind={only.memoryKind} previous={only.previous} reason={only.reason} onEdit={onEditMemory} onChanged={onMemoryChanged} />
                  <time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time>
                </article>
              );
            }
            if (only?.kind === "resume" || only?.kind === "compacted") {
              return <article key={message.id} data-testid="message-item" data-role={message.role} className="group mr-auto w-full max-w-md"><ResumeNotice block={only} /><time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time></article>;
            }
            if (only?.kind === "resume_card") {
              return <article key={message.id} data-testid="message-item" data-role={message.role} className="group mr-auto w-full max-w-md"><ResumeCard block={only} onChanged={onSent} /><time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time></article>;
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
            const botRow = parseBotRow(message.kind, message.content);
            if (botRow?.type === "bot_thread") return <BotThreadRow key={message.id} row={botRow} thread={botThreads.find(item => item.id === botRow.threadId)} createdAt={message.createdAt} onChanged={onSent} />;
            if (botRow?.type === "bot_action") return <BotActionRow key={message.id} row={botRow} createdAt={message.createdAt} />;
            const mine = message.role === "user";
            return (
              <MessageItem
                key={message.id}
                message={message}
                fresh={freshIds.has(message.id)}
                mine={mine}
                botName={botName}
                botId={botId}
                bot={{ id: botId, shape: avatar?.shape, color: avatar?.color, primary: avatar?.primary }}
                byId={byId}
                onReact={(id, emoji) => void react(id, emoji)}
                onReply={startReply}
                onQuote={() => window.dispatchEvent(new Event("teammates-add-selection"))}
                onChanged={onSent}
                announce={announce}
                focusSibling={focusSibling}
              >
                <MessageBody
                  message={message}
                  mine={mine}
                  byId={byId}
                  onJump={jumpTo}
                  fallback={blocks.map((block, index) => <MessageBlockView key={`${message.id}-${index}`} block={block} />)}
                />
              </MessageItem>
            );
          })}
          {evidence.length ? <section aria-label="Task evidence" className="rounded-md border border-border bg-card p-3">
            <h3 className="mb-2 text-sm font-medium">Evidence</h3>
            <div className="grid gap-3 sm:grid-cols-2">{evidence.map(item => {
              const url = `/api/artifacts/${item.id}/download`;
              return <figure key={item.id} className="min-w-0 overflow-hidden rounded-md border border-border">
                {item.mime?.startsWith("image/") ? <img src={url} alt={item.name} loading="lazy" className="max-h-96 w-full object-contain" /> : item.mime?.startsWith("video/") ? <video src={url} controls preload="none" className="w-full" /> : null}
                <figcaption className="truncate border-t border-border px-2 py-1.5 text-xs text-muted-foreground">{item.name} · {Math.max(1, Math.round(item.bytes / 1024))} KB</figcaption>
              </figure>;
            })}</div>
          </section> : null}
          {events.filter(event => !["delta", "message.delta", "text_delta"].includes(event.type)).map((event, i) => <EventCard key={`${conversationId}-${i}`} event={event} />)}
          {working && events.some(event => ["delta", "message.delta", "text_delta"].includes(event.type)) ? <div data-testid="streaming-text" className="rounded-md bg-assistant-bubble p-3 text-sm"><Markdown text={events.filter(event => ["delta", "message.delta", "text_delta"].includes(event.type)).map(event => String(event.delta ?? event.text ?? "")).join("")} /><span aria-hidden className="inline-block h-4 w-1 animate-pulse bg-foreground" /></div> : null}
          {working ? (
            <div data-testid="working-row" role="status" className="flex items-center gap-2 px-1 py-1 text-sm">
              <BotAvatar animated size={22} botId={botId} shape={avatar?.shape} color={avatar?.color} />
              <ShimmerText text={workingStatus(events, events.some(event => ["delta", "message.delta", "text_delta"].includes(event.type)), taskTitle)} />
            </div>
          ) : null}
          {plan && plan.items.length ? <section aria-label="Task plan" className="rounded-md border border-border bg-card p-3 text-sm">
            <h3 className="font-medium">Plan</h3>
            <ul className="mt-2 space-y-1">{plan.items.map((item, index) => <li key={index} className="flex gap-2"><span aria-hidden>{item.status === "done" ? "✓" : item.status === "blocked" ? "!" : item.status === "in_progress" ? "◉" : "○"}</span><span>{item.title}</span></li>)}</ul>
            <p className="mt-2 text-xs text-muted-foreground">Budget: {plan.budget.label}</p>
            {plan.estimate ? <p className="text-xs text-muted-foreground">Estimate: ~{Math.round(plan.estimate.lowSeconds / 60)}–{Math.round(plan.estimate.highSeconds / 60)} min (from {plan.estimate.n} similar runs)</p> : null}
            <p className="text-xs">Tests: {plan.tests.required ? plan.tests.passedAt || plan.tests.override ? "passed" : "required" : "optional"}</p>
            {plan.blocked ? <p className="mt-2 rounded-md border border-destructive/40 p-2">This task is blocked.</p> : null}
            {plan.tests.required && !plan.tests.passedAt && !plan.tests.override && plan.status === "waiting_human" ? <Button size="sm" className="mt-2" onClick={() => void api(`/api/tasks/${plan.taskId}/override-tests`, { method: "POST" }).then(() => onSent())}>Mark done without tests</Button> : null}
          </section> : null}
          <RefreshNotice variant="chat" />
        </div>
      </div>
      <div role="status" aria-live="polite" data-testid="chat-live" className="sr-only">{live}</div>
      {pill ? <button ref={pillRef} type="button" data-testid="add-to-chat" aria-label="Add selection to chat"
        style={{ position: "fixed", left: pill.x, top: pill.y }}
        onMouseDown={event => event.preventDefault()}
        onClick={() => addQuoteText(pill.text, pill.source)}
        className="z-50 inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-popover px-3 text-xs font-medium text-popover-foreground shadow-md hover:bg-bot-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"><Quote className="h-3.5 w-3.5" aria-hidden />Add to chat</button> : null}
      {scrolledUp ? <Button data-testid="jump-to-latest" variant="secondary" className="mx-auto my-2" onClick={() => { stickRef.current = true; setScrolledUp(false); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }}>Jump to latest ↓</Button> : null}
      <form
        data-testid="composer-bar"
        className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        onSubmit={onSubmit}
      >
        {parts.filter(part => part.type === "reply").map(part => part.type === "reply" ? (
          <div key={part.id} data-testid="composer-reply" data-message-id={part.messageId} className="flex min-h-9 items-center gap-2 rounded-full border border-border bg-muted/60 py-1 pl-3 pr-1 text-[13px] text-muted-foreground">
            <ReplyIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="sr-only">Replying to {part.author}: </span>
            <span data-testid="composer-reply-text" className="min-w-0 flex-1 truncate">{part.excerpt}</span>
            <button type="button" aria-label="Remove reply" data-testid="remove-quote" className="grid h-7 w-7 shrink-0 place-items-center rounded-full hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" onClick={() => { setParts(current => removePart(current, part.id)); focusComposer(); }}><XIcon className="h-3.5 w-3.5" aria-hidden /></button>
          </div>
        ) : null)}
        <div className="rounded-md border border-border bg-card px-3 py-2 shadow-sm">
          {parts.map((part, index) => {
            if (part.type === "reply") return null;
            if (part.type === "quote") {
              return (
                <blockquote key={part.id} data-testid="composer-quote" className="mb-1 flex items-start gap-2 border-l-2 border-bot-border bg-bot-soft px-2 py-1 text-[13px] text-muted-foreground">
                  <span className="sr-only">Quoted text</span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-4 whitespace-pre-wrap">{part.text}</span>
                  </span>
                  <button type="button" aria-label="Remove quote" data-testid="remove-quote" className="grid h-6 w-6 shrink-0 place-items-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" onClick={() => { setParts(current => removePart(current, part.id)); focusComposer(); }}><XIcon className="h-3.5 w-3.5" /></button>
                </blockquote>
              );
            }
            const last = index === parts.length - 1;
            return (
              <Textarea
                key={part.id}
                ref={node => { if (node) partRefs.current.set(part.id, node); else partRefs.current.delete(part.id); }}
                aria-label={last ? `Message ${botName}` : "Comment"}
                data-testid={last ? "composer" : "composer-segment"}
                value={part.text}
                onChange={(event) => { const value = event.target.value; setParts(current => current.map(p => p.id === part.id ? { ...p, text: value } as ComposerPart : p)); }}
                placeholder={last && parts.length === 1 ? `Message ${botName}` : last ? "Add a comment" : ""}
                rows={1}
                className="min-h-10 resize-none border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0"
                onKeyDown={(event) => {
                  if (event.key === "Escape") { setError(null); (event.currentTarget as HTMLTextAreaElement).blur(); }
                  if (event.key === "Backspace" && part.text === "" && index > 0 && parts[index - 1].type !== "text") {
                    event.preventDefault();
                    const above = parts[index - 1];
                    setParts(current => removePart(current, above.id));
                    focusComposer();
                  }
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && last) {
                    event.preventDefault();
                    void send(false);
                  }
                }}
              />
            );
          })}
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" data-testid="composer-plus" aria-label="More options" className="h-9 w-9 rounded-full border border-border [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"><Plus className="h-4 w-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" onCloseAutoFocus={event => { event.preventDefault(); focusComposer(); }}>
                <DropdownMenuItem data-testid="plus-attach" onSelect={() => fileRef.current?.click()}>Attach files</DropdownMenuItem>
                <DropdownMenuItem data-testid="plus-quote" onSelect={() => window.dispatchEvent(new Event("teammates-add-selection"))}><Quote className="h-4 w-4" />Add selection to chat</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <input ref={fileRef} type="file" multiple hidden data-testid="composer-file" onChange={event => void attach(event.target.files)} />
            <div className="ml-auto flex items-center gap-2">
            {working && onStop ? <Button type="button" data-testid="stop-run" variant="destructive" disabled={stopping} onClick={() => void stop()}>{stopping ? "Stopping…" : "Stop"}</Button> : null}
            <Button data-testid="send-chat" type="submit" size="icon" aria-label={sending ? "Sending" : "Send"} title="Send" className="h-9 w-9 shrink-0 rounded-full bg-bot text-bot-foreground hover:bg-bot/90 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" disabled={sending || !conversationId}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <ArrowUp className="h-4 w-4" aria-hidden />}
            </Button>
            </div>
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

function MemoryNotice({ botId, action, text, memoryId, memoryKind, previous, reason, onEdit, onChanged }: { botId?: string; action: "saved" | "updated" | "forgot" | "suggested" | "blocked"; text: string; memoryId?: string; memoryKind?: string; previous?: string; reason?: string; onEdit?: (id: string) => void; onChanged?: () => void }) {
  const [undoOpen, setUndoOpen] = useState(true);
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!undoableMemoryAction(action) || focused) return; const timer = window.setTimeout(() => setUndoOpen(false), 10_000); return () => window.clearTimeout(timer); }, [action, focused]);
  const label = action === "forgot" ? "Forgot a note" : action === "updated" ? "Updated a note" : action === "suggested" ? "Suggested a note" : action === "blocked" ? memoryReason(reason) : "Saved to notes";
  async function undo() {
    if (!botId || !memoryId) return; setBusy(true);
    try {
      if (action === "forgot") await api(`/api/bots/${botId}/memories/${memoryId}/restore`, { method: "POST" });
      else if (action === "saved") await api(`/api/bots/${botId}/memories/${memoryId}`, { method: "DELETE" });
      else if (action === "updated" && previous) await api(`/api/bots/${botId}/memories/${memoryId}`, { method: "PATCH", body: JSON.stringify({ content: previous }) });
      setUndoOpen(false);
      onChanged?.();
    } catch { toast.error("Could not undo that memory change."); }
    finally { setBusy(false); }
  }
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
      <CollapsibleContent data-testid="memory-fact" onFocusCapture={() => setFocused(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }} className="px-6 pb-1 text-sm text-muted-foreground">
        {memoryKind === "rule" ? <span className="mr-2 rounded-sm border border-line px-1.5 py-0.5 text-xs">Rule</span> : null}{text}
        {action === "blocked" ? null : <div className="mt-2 flex flex-wrap gap-2">{undoOpen && undoableMemoryAction(action) && memoryId ? <Button data-testid="memory-undo" className="min-h-11" size="sm" variant="outline" disabled={busy} onClick={() => void undo()}>Undo</Button> : null}{memoryId && onEdit ? <Button className="min-h-11" size="sm" variant="ghost" onClick={() => onEdit(memoryId)}>Edit</Button> : null}{action === "suggested" && memoryId && botId ? <><Button className="min-h-11" size="sm" onClick={() => void api(`/api/bots/${botId}/memories/${memoryId}/accept`, { method: "POST" }).then(onChanged).catch(() => toast.error("Could not save this suggestion."))}>Save</Button><Button className="min-h-11" size="sm" variant="outline" onClick={() => void api(`/api/bots/${botId}/memories/${memoryId}/dismiss`, { method: "POST" }).then(onChanged).catch(() => toast.error("Could not dismiss this suggestion."))}>Skip</Button></> : null}</div>}
      </CollapsibleContent>
    </Collapsible>
  );
}

function MessageBlockView({ block }: { block: ReturnType<typeof messageBlocks>[number] }) {
  if (block.kind === "text") return <Markdown text={block.text} />;
  if (block.kind === "question" || block.kind === "memory" || block.kind === "resume" || block.kind === "compacted" || block.kind === "resume_card") return null;
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
  if (event.type === "memory") return <MemoryNotice action={(["saved", "updated", "forgot", "suggested", "blocked"].includes(String(event.action)) ? String(event.action) : "saved") as "saved" | "updated" | "forgot" | "suggested" | "blocked"} text={String(event.content ?? "")} memoryId={String(event.memoryId ?? event.memory_id ?? "") || undefined} memoryKind={String(event.kind ?? "") || undefined} reason={String(event.reason ?? "") || undefined} />;
  const tool = String(event.tool ?? event.name ?? "Tool");
  const args = typeof event.args === "object" && event.args ? JSON.stringify(event.args) : String(event.args ?? "");
  return <Collapsible data-testid="tool-call-card" className="rounded-md border border-border text-xs"><CollapsibleTrigger className="flex min-h-10 w-full items-center gap-2 px-3 text-left"><span aria-hidden>⌘</span><span className="font-medium">{tool}</span><span className="min-w-0 flex-1 truncate text-muted-foreground">{args.slice(0, 90)}</span><span>{String(event.status ?? (event.type === "tool_result" ? "Done" : "Running"))}</span></CollapsibleTrigger><CollapsibleContent><pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border p-3">{JSON.stringify({ args: event.args, result: event.result }, null, 2)}</pre></CollapsibleContent></Collapsible>;
}
