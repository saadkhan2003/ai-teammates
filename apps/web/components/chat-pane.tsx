"use client";

import dynamic from "next/dynamic";
import { VideoProgress } from "@/components/video-progress";
import { FileCard } from "@/components/file-card";
import { ImageGrid } from "@/components/image-grid";
import type { GalleryImage } from "@/components/image-lightbox";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/chat-message-list";
import { anchoredScrollTop, appendedAssistantText, nearChatBottom, visibleChatAnchor, type ChatAnchor } from "@/lib/chat-scroll";
import { StreamDraft } from "@/components/stream-draft";
import { toolLabel } from "@/lib/tool-status";
import { mergeOptimistic } from "@/lib/chat-speed";
import { flushSync } from "react-dom";
import { useComputerPrewarm } from "@/lib/use-computer-prewarm";
import { beginSendPerf, endSendPerf, paintedPerf, chatPaintedPerf, initPerf } from "@/lib/perf";
import { FormEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/markdown";
import { RefreshNotice } from "@/components/refresh-notice";
import { ResumeCard, ResumeNotice } from "@/components/resume-card";
import type { AgentEvent } from "@/lib/events";
import { ArrowDown, ArrowUp, AudioLines, MessageCircle, MessageSquareQuote, Mic, MoreHorizontal, Notebook, Plus, Reply, Smile } from "lucide-react";
import { Loader2, Reply as ReplyIcon, X as XIcon, Quote } from "lucide-react";
import { Circle, CircleAlert, CircleCheck, CircleDot } from "lucide-react";
import { highlightPlan, loadUntil } from "@/lib/history";
import { BotAvatar } from "@/components/bot-avatar";
import { BotActionRow, BotThreadRow } from "@/components/bot-thread";
import { parseBotRow, type BotThreadView } from "@/lib/bot-thread";
import { MessageBody, MessageItem, plainTextOf } from "@/components/message-item";
import { workingStatus } from "@/components/shimmer-text";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type ComposerPart, parseAttachmentMarkers, flatten, addQuote, canSend, hasBlocks, hasFiles, initialParts, normalizeSelection, pillPosition, removePart, setReply as setReplyPart, toPayload } from "@/lib/chat-parts";
import { setAvatarMode } from "@/lib/avatar-motion";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerPresence } from "@/components/avatar-motion/composer-presence";
import { CodingJobsCard, JobMention, JobResultCard, LiveJobStep } from "@/components/coding-jobs";
import { lastMessagePreview } from "@/lib/avatar-motion";
import { publishAvatarPreview } from "@/lib/avatar-preview";
import { ApiError, api, apiFetch } from "@/lib/api";
import { EXTRA_EMOJIS, liveJob, newMessagesLabel, optionLetter, pickerSide, QUICK_REACTIONS, QUOTE_HIGHLIGHT_MS, quotePlacement, reactionTooltip, readableAccent, replySnippet, showsJobResult, splitJobMentions, visibleReactions, type CodingJob } from "@/lib/chat-ui";
import { messageBlocks, type FormField, type MessageBlock, type QuestionOption } from "@/lib/message-blocks";
import { Textarea } from "@/components/ui/textarea";


import { memoryReason, undoableMemoryAction } from "@/lib/memory-notes";
import type { ChatMessage } from "@/lib/types";
import { cn, errorMessage, formatWhen } from "@/lib/utils";
import type { Widget } from "@/lib/widgets/schema";

type PendingUpload = {
  id: string;
  name: string;
  mime: string;
  path: string;
  preview: string;
  status: "uploading" | "done" | "error";
};
const FlowDiagram = dynamic(() => import("@/components/widgets/flow-view").then(m => m.FlowDiagram), { ssr: false, loading: () => <div className="h-60 animate-pulse rounded-md bg-muted" /> });
type TaskPlan = { taskId: string; title: string; status: string; items: { title: string; status: string }[]; budget: { label: string }; tests: { required: boolean; passedAt?: string; override: boolean }; blocked: boolean; estimate?: { lowSeconds: number; highSeconds: number; n: number; label: string } | null };

export function ChatPane({
  conversationId,
  messages: storedMessages,
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
  onOpenTask,
}: {
  onEditMemory?: (id: string) => void;
  onMemoryChanged?: () => void;
  onOpenTask?: (taskId: string) => void;
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
  accent?: string;
  avatarShape?: string;
  avatarColor?: string;
  codingJobs?: CodingJob[];
  onOpenJob?: (job: CodingJob) => void;
}) {
  type Pending = ChatMessage & { conversation: string; payload: Record<string, unknown> };
  const [pending, setPending] = useState<Pending[]>([]);
  const visiblePending = pending.filter(m => m.conversation === conversationId);
  const messages = useMemo(() => mergeOptimistic(storedMessages, pending.filter(message => message.conversation === conversationId)), [storedMessages, pending, conversationId]);
  useEffect(() => {
    setPending(current => current.filter(m => m.conversation !== conversationId || !storedMessages.some(real => real.id === m.id || real.clientId === m.clientId)));
  }, [storedMessages, conversationId]);
  async function deliver(item: Pending) {
    setSending(true);
    setError(null);
    setDlp(false);
    setPending(current => current.map(m => m.id === item.id ? { ...m, sendState: "pending" } : m));
    try {
      const sent = await api<{ taskId?: string; messageId?: string }>(`/api/conversations/${item.conversation}/messages`, { method: "POST", body: JSON.stringify(item.payload) });
      if (perfTurn.current) { perfTurn.current.task = sent?.taskId; perfTurn.current.message = sent?.messageId; }
      onSent();
    } catch (caught) {
      setPending(current => current.map(m => m.id === item.id ? { ...m, sendState: "failed" } : m));
      const message = errorMessage(caught, "Could not send that message.");
      setDlp(caught instanceof ApiError && caught.status === 422);
      setError(message);
    } finally { setSending(false); }
  }
  const prewarmComputer = useComputerPrewarm(botId);
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
  const streamTextPainted = useCallback(() => { if (perfTurn.current) paintedPerf(`${perfTurn.current.id}:first_token_screen_ms`, "first_token_screen_ms"); }, []);
  const streamToolPainted = useCallback(() => { if (perfTurn.current) paintedPerf(`${perfTurn.current.id}:tool_chip_ms`, "tool_chip_ms"); }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  useEffect(() => { setAvatarMode(working ? "working" : "idle"); return () => setAvatarMode("idle"); }, [working]);
  const seenRef = useRef<Set<string> | null>(null);
  const seenConversation = useRef(conversationId);
  const historyStart = useRef(storedMessages[0]?.createdAt);
  const freshCount = useRef(0);
  useEffect(() => {
    const ids = messages.map((message) => message.id);
    if (seenConversation.current !== conversationId) seenRef.current = null;
    if (seenRef.current === null) {
      seenRef.current = new Set(ids);
      seenConversation.current = conversationId;
      historyStart.current = storedMessages[0]?.createdAt;
      freshCount.current = 0;
      setFresh(0);
      setDismissedFresh(false);
      return;
    }
    // Prepended history is already read; only arrivals after the initial history count as fresh.
    for (const message of storedMessages) {
      if (historyStart.current && message.createdAt && message.createdAt < historyStart.current) seenRef.current.add(message.id);
    }
    if (stickRef.current) {
      seenRef.current = new Set(ids);
      freshCount.current = 0;
      setDismissedFresh(false);
      setFresh(0);
      return;
    }
    const count = ids.filter((id) => !seenRef.current?.has(id)).length;
    setFresh(count);
    if (count > 0) {
      if (count > freshCount.current) setDismissedFresh(false);
    }
    freshCount.current = count;
  }, [messages, storedMessages, conversationId]);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [fresh, setFresh] = useState(0);
  const [dismissedFresh, setDismissedFresh] = useState(false);
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
  const [customEmoji, setCustomEmoji] = useState("");
  function togglePicker(messageId: string, anchor: HTMLButtonElement) {
    const rect = anchor.getBoundingClientRect();
    const bounds = scrollRef.current?.getBoundingClientRect();
    const side = pickerSide((bounds?.bottom ?? window.innerHeight) - rect.bottom);
    setPicker((current) => (current?.id === messageId ? null : { id: messageId, side, full: false }));
  }
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

  const messageListRef = useRef<ChatMessageListHandle>(null);
  const lastScrollTop = useRef(0);
  const prependAnchor = useRef<{ anchor: ChatAnchor; firstId?: string } | null>(null);
  const announced = useRef<{ conversation?: string; ids: string[] }>({ ids: [] });
  useEffect(() => {
    const previous = announced.current;
    const text = previous.conversation === conversationId ? appendedAssistantText(previous.ids, storedMessages) : "";
    announced.current = { conversation: conversationId, ids: storedMessages.map(message => message.id) };
    if (text) setLive(text);
  }, [storedMessages, conversationId]);
  useLayoutEffect(() => {
    stickRef.current = true; lastScrollTop.current = 0;
    prependAnchor.current = null;
    setScrolledUp(false);
  }, [conversationId]);
  // Observe the whole content, including the independently rendered streaming leaf.
  useLayoutEffect(() => {
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const node = scrollRef.current;
        if (node && stickRef.current) node.scrollTop = node.scrollHeight;
      });
    };
    const observer = new ResizeObserver(follow);
    if (listRef.current) observer.observe(listRef.current);
    follow();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [conversationId]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const pending = prependAnchor.current;
    if (scroll && pending && storedMessages[0]?.id !== pending.firstId) {
      let frame = 0;
      let attempts = 0;
      let stable = 0;
      const restore = () => {
        const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-chat-row]") ?? []).find(row => row.dataset.chatRow === pending.anchor.id);
        if (row) {
          // Rows above the anchor keep measuring for a few frames after a prepend;
          // re-align until the anchor holds still for two frames.
          const next = anchoredScrollTop(scroll.scrollTop, scroll.getBoundingClientRect().top, row.getBoundingClientRect().top, pending.anchor);
          const moved = Math.abs(next - scroll.scrollTop) >= 1;
          if (moved) scroll.scrollTop = next;
          stable = moved ? 0 : stable + 1;
          if (stable >= 2 || attempts++ >= 20) prependAnchor.current = null;
          else frame = requestAnimationFrame(restore);
        } else if (attempts++ < 8) {
          messageListRef.current?.reveal(pending.anchor.id);
          frame = requestAnimationFrame(restore);
        } else prependAnchor.current = null;
      };
      restore();
      return () => cancelAnimationFrame(frame);
    } else if (scroll && stickRef.current) scroll.scrollTop = scroll.scrollHeight;
  }, [storedMessages, messages.length, events, working]);
  const lastTextId = parts[parts.length - 1]?.id;
  useEffect(() => {
    for (const node of partRefs.current.values()) {
      if (node) {
        node.style.height = "auto";
        node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
      }
    }
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
    try {
      await onStop?.();
    } catch (caught) {
      setError(errorMessage(caught, "Could not stop this run."));
    } finally {
      setStopping(false);
    }
  }
  const initial = userName.trim().charAt(0).toUpperCase() || "Y";
  const byId = new Map(messages.map((message) => [message.id, message]));
  // Messages that arrive after the first paint of this conversation slide in; the history does not.
  const seen = useRef<{ key?: string; ids: Set<string> } | null>(null);
  if (!seen.current || seen.current.key !== botId) seen.current = { key: botId, ids: new Set(messages.map(m => m.id)) };
  const freshIds = new Set(messages.filter(m => !seen.current!.ids.has(m.id)).map(m => m.id));
  useEffect(() => { for (const m of messages) seen.current?.ids.add(m.id); });

  function announce(text: string) { setLive(""); window.setTimeout(() => setLive(text), 30); }
  async function sendWidgetAction(widget: Widget, action: string, payload: Record<string, unknown>) {
    if (!botId) return;
    await api(`/api/bots/${botId}/widget-actions`, { method: "POST", body: JSON.stringify({ widget_id: widget.id, action, payload }) });
    onSent();
  }
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
    const image = messageBlocks(message.content).find((block): block is Extract<MessageBlock, { kind: "image" }> => block.kind === "image");
    setParts(current => setReplyPart(current, { messageId: message.id, author: message.role === "user" ? "You" : botName, excerpt: text.slice(0, 200), ...(image ? { image: { src: image.url, alt: image.name } } : {}) }));
    announce("Reply added");
    focusComposer();
  }
  const replyPart = parts.find(part => part.type === "reply");
  const reply = replyPart?.type === "reply" ? byId.get(replyPart.messageId) ?? { id: replyPart.messageId, content: replyPart.excerpt } : null;
  function setReply(message: ChatMessage | null) {
    if (message) startReply(message);
    else setParts(current => current.filter(part => part.type !== "reply"));
  }
  function jump() {
    stickRef.current = true;
    freshCount.current = 0;
    setDismissedFresh(false);
    setFresh(0);
    setScrolledUp(false);
    seenRef.current = new Set(messages.map((message) => message.id));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" });
    else scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }
  function focusMessage(id: string) {
    void jumpTo(id);
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
    document.querySelectorAll("[data-highlight]").forEach(el => el.removeAttribute("data-highlight"));
    const cloudTarget = document.getElementById(node.id.replace(/^msg-/, "message-")) ?? node;
    cloudTarget.setAttribute("data-highlight", "true");
    highlightTimers.current.push(window.setTimeout(() => cloudTarget.removeAttribute("data-highlight"), QUOTE_HIGHLIGHT_MS));
    node.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    for (const step of highlightPlan(reduced)) {
      const apply = () => { if (step.phase === "off") node.removeAttribute("data-jump"); else node.setAttribute("data-jump", step.phase); };
      if (step.after === 0) apply(); else highlightTimers.current.push(window.setTimeout(apply, step.after));
    }
  }
  useEffect(() => () => highlightTimers.current.forEach(window.clearTimeout), []);
  async function loadEarlier() {
    if (!onLoadOlder || loadingOlder) return;
    const scroll = scrollRef.current;
    if (scroll) {
      stickRef.current = false;
      setScrolledUp(true);
      const anchor = visibleChatAnchor(Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-chat-row]") ?? []).map(row => {
        const rect = row.getBoundingClientRect();
        return { id: row.dataset.chatRow!, top: rect.top, bottom: rect.bottom };
      }), scroll.getBoundingClientRect().top);
      prependAnchor.current = anchor ? { anchor, firstId: storedMessages[0]?.id } : null;
    }
    setLoadingOlder(true);
    try { await onLoadOlder(); } catch (caught) { toast.error(errorMessage(caught, "Could not load earlier messages.")); } finally { setLoadingOlder(false); }
  }
  async function jumpTo(id: string) {
    stickRef.current = false;
    setScrolledUp(true);
    if (messagesRef.current.some(message => message.id === id)) {
      messageListRef.current?.reveal(id);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }
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
      messageListRef.current?.reveal(id);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
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
    const index = messages.findIndex(message => message.id === from.closest<HTMLElement>("[data-chat-row]")?.dataset.chatRow);
    const target = messages[index + delta];
    if (index < 0 || !target) return;
    stickRef.current = false;
    messageListRef.current?.reveal(target.id);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-chat-row]") ?? []).find(row => row.dataset.chatRow === target.id);
      (row?.querySelector<HTMLElement>("article[tabindex]") ?? row)?.focus();
    }));
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
      const id = crypto.randomUUID();
      const name = file.name.replace(/[^\w.\- ]+/g, "_");
      const video = file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(name);
      const path = `/workspace/uploads/${video ? name : `${Date.now()}-${name}`}`;
      const preview = URL.createObjectURL(file);
      setUploads((current) => [...current, { id, name: file.name, mime: file.type, path, preview, status: "uploading" }]);
      try {
        const response = await apiFetch(`/api/bots/${botId}/files`, {
          method: "PUT",
          headers: { "x-path": path, "Content-Type": "application/octet-stream" },
          body: file,
        });
        if (!response.ok) throw new ApiError(response.status, `Upload failed (${response.status}).`);
        setParts(current => current.map((p, i) => i === current.length - 1 && p.type === "text" ? { ...p, text: `${p.text}${p.text && !p.text.endsWith("\n") ? "\n" : ""}[attached: ${path}]` } : p));
        setUploads((current) => current.map((item) => (item.id === id ? { ...item, status: "done" } : item)));
        announce(`Attached ${file.name}`);
      } catch (caught) {
        setUploads((current) => current.map((item) => (item.id === id ? { ...item, status: "error" } : item)));
        setError(errorMessage(caught, "Could not upload that file."));
      }
    }
    if (fileRef.current) fileRef.current.value = "";
    focusComposer();
  }

  function attachmentMarkdown(item: PendingUpload) {
    const url = `/api/bots/${botId}/files/raw?path=${encodeURIComponent(item.path)}`;
    if (item.mime.startsWith("image/")) return `![${item.name}](${url})`;
    if (item.mime.startsWith("video/")) return `\`\`\`video\n${JSON.stringify({ name: item.name, url })}\n\`\`\``;
    return `[${item.name}](${url})`;
  }

  async function send(asTask = false) {
    const ready = uploads.filter((item) => item.status === "done");
    const pending = uploads.some((item) => item.status === "uploading");
    if (sending || pending) return;
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
    const attached = ready.map(attachmentMarkdown).join("\n");
    const bodyText = [text, attached].filter(Boolean).join("\n\n");
    const clientId = crypto.randomUUID();
    const payload = { ...(rich ? { parts: [...toPayload(parts), ...(attached ? [{ type: "text", text: attached }] : [])], asTask } : { content: bodyText, asTask }), client_id: clientId };
    const item: Pending = { id: clientId, clientId, conversation: conversationId, role: "user", content: [flatten(parts), attached].filter(Boolean).join("\n\n"), createdAt: new Date().toISOString(), sendState: "pending", payload };
    // Commit before awaiting IO, so the echo is present for this submit frame.
    flushSync(() => { setPending(current => [...current, item]); setParts(initialParts());
      setUploads((current) => {
        current.forEach((item) => URL.revokeObjectURL(item.preview));
        return [];
      }); });
    draftsRef.current.delete(conversationId);
    await deliver(item);
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

  const content = flatten(parts);
  const composerRef = { current: Array.from(partRefs.current.values()).pop() ?? null };
  const typing = canSend(parts);
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
  function renderComposerPart(part: ComposerPart, index: number) {
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
        onFocus={prewarmComputer}
        onInput={prewarmComputer}
        onChange={(event) => { const value = event.target.value; setParts(current => current.map(p => p.id === part.id ? { ...p, text: value } as ComposerPart : p)); }}
        placeholder={last && parts.length === 1 ? `Message ${botName}` : last ? "Add a comment" : ""}
        rows={1}
        className="max-h-[180px] min-h-5 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-0 text-ui text-foreground shadow-none outline-none placeholder:text-[var(--composer-placeholder)] focus-visible:outline-none focus-visible:ring-0"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setError(null);
            composerRef.current?.blur();
          }
          if (event.key === "Backspace" && part.text === "" && index > 0 && parts[index - 1].type !== "text") {
            event.preventDefault();
            const above = parts[index - 1];
            setParts(current => removePart(current, above.id));
            focusComposer();
          }
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && last) {
            event.preventDefault();
            void send();
          }
        }}
      />
    );
  }
  let showedJobs = false;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" style={{ ["--bot-accent" as string]: paint }}>
      <div
        ref={scrollRef}
        data-testid="chat-scroll"
        className="chat-scroll relative z-0 min-h-0 flex-1 overflow-y-auto pt-12"
        style={{ overflowAnchor: "none" }}
        tabIndex={0}
        aria-label="Conversation history"
        onScroll={() => {
          const node = scrollRef.current;
          if (!node) return;
          // Only an upward scroll away from the bottom unsticks. Row measurement in the
          // virtual list can move scrollTop while content grows; that must not drop follow.
          const near = nearChatBottom(node.scrollTop, node.scrollHeight, node.clientHeight);
          if (near) stickRef.current = true;
          else if (node.scrollTop < lastScrollTop.current - 1) stickRef.current = false;
          lastScrollTop.current = node.scrollTop;
          setScrolledUp(!stickRef.current);
          if (stickRef.current) {
            seenRef.current = new Set(messages.map((message) => message.id));
            freshCount.current = 0;
            setDismissedFresh(false);
            setFresh(0);
          }
      }}>
        <div ref={listRef} role="log" aria-label="Messages" aria-live="off" className="mx-auto flex w-full max-w-[var(--content-width)] flex-col gap-1.5 px-4 py-4">
          {visiblePending.filter(m => m.sendState === "failed").map(m => <div key={`retry-${m.id}`} role="status" className="text-sm text-destructive">Message failed. <Button size="sm" variant="outline" data-testid="retry-send" onClick={() => void deliver(m)}>Retry</Button></div>)}
          {events.some(event => event.type === "task.started" && !storedMessages.some(m => m.role === "assistant" && m.requestId === event.taskId)) ? <div data-testid="ack-chip" role="status" className="text-sm text-muted-foreground">On it</div> : null}
          {hasOlder ? <Button type="button" data-testid="load-older" variant="ghost" size="sm" className="mx-auto" disabled={loadingOlder} onClick={() => void loadEarlier()}>{loadingOlder ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}Load earlier messages</Button> : null}
          {extras}
          {messages.length === 0 ? (
            <div data-testid="chat-empty" className="mx-auto flex max-w-sm flex-col items-center px-4 py-16 text-center">
              <span className="grid size-10 place-items-center rounded-card bg-muted text-muted-foreground">
                <MessageCircle className="size-5" strokeWidth={1.5} aria-hidden />
              </span>
              <p className="type-title mt-3">Start a conversation with {botName}</p>
              <p className="type-caption mt-1">Ask a question, share an idea, or hand over some work.</p>
            </div>
          ) : null}
          <ChatMessageList key={conversationId} ref={messageListRef} messages={messages} scrollRef={scrollRef} renderMessage={(message) => {
            const display = parseAttachmentMarkers(message.content);
            const blocks = messageBlocks(display.text);
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
                  <MemoryNotice botId={botId} action={only.action} text={only.text} memoryId={only.memoryId} memoryKind={only.memoryKind} previous={only.previous} reason={only.reason} onEdit={onEditMemory} onChanged={onMemoryChanged} />
                  <time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time>
                </article>
              );
            }
            if (only?.kind === "resume" || only?.kind === "compacted") {
              return <article key={message.id} id={`message-${message.id}`} data-testid="message-item" data-role={message.role} className="group mr-auto w-full max-w-md"><ResumeNotice block={only} /><time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time></article>;
            }
            if (only?.kind === "resume_card") {
              return <article key={message.id} id={`message-${message.id}`} data-testid="message-item" data-role={message.role} className="group mr-auto w-full max-w-md"><ResumeCard block={only} onChanged={onSent} /><time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time></article>;
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
                  <time className="mt-1 block px-1 text-micro text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time>
                </article>
              );
            }
            const botRow = parseBotRow(message.kind, message.content);
            if (botRow?.type === "bot_thread") return <BotThreadRow key={message.id} row={botRow} thread={botThreads.find(item => item.id === botRow.threadId)} createdAt={message.createdAt} onChanged={onSent} />;
            if (botRow?.type === "bot_action") return <BotActionRow key={message.id} row={botRow} createdAt={message.createdAt} />;
            const mine = message.role === "user";
            const reactions = visibleReactions(message.role, message.reactions);
            const quoted = message.replyToId ? byId.get(message.replyToId) : undefined;
            const placement = quotePlacement(message.role);
            const media = blocks.filter((block) => block.kind === "image" || block.kind === "video" || block.kind === "file");
            const body = blocks.filter((block) => block.kind !== "image" && block.kind !== "video" && block.kind !== "file").filter((block) => block.kind !== "text" || block.text.trim().length > 0);
            const singleLine = mine && media.length === 0 && body.length === 1 && body[0].kind === "text" && !body[0].text.includes("\n") && body[0].text.trim().length < 80;
            const showBubble = body.length > 0 || (Boolean(message.replyToId) && placement === "inside" && Boolean(replySnippet(quoted?.content ?? "").trim()));
            if (!message.parts?.length && !message.deleted && !message.videoAnalysis && !message.attachments?.length && !display.attachments.length && !message.skill && !showBubble && media.length === 0 && reactions.length === 0) return null;
            return (
              <MessageItem
                key={message.id}
                message={message}
                presentation="cloud"
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
                onOpenTask={onOpenTask}
              >
                {message.replyToId && placement === "above" ? (
                  <button
                    type="button"
                    data-testid="reply-quote"
                    className="mb-1 max-w-full truncate rounded-md bg-muted px-3 py-1 text-left text-meta text-muted-foreground"
                    onClick={() => focusMessage(message.replyToId!)}
                  >
                    {replySnippet(quoted?.content ?? "")}
                  </button>
                ) : null}
                {showBubble || message.parts?.length || message.videoAnalysis || message.attachments?.length || display.attachments.length || message.skill ? (
                  <MessageBody
                    message={message}
                    displayAttachments={message.attachments?.length ? message.attachments : display.attachments}
                    mine={mine}
                    byId={byId}
                    onJump={jumpTo}
                    onWidgetAction={sendWidgetAction}
                    renderText={(text) => <MediaRow media={messageBlocks(text)} jobs={codingJobs} accent={paint} botId={botId} mine={mine} onOpenJob={onOpenJob} onReply={() => setReply(message)} />}
                    fallback={<>
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
                    ))}</>}
                    renderBubble={(contents) => (
                      <div id={`message-${message.id}`} data-testid={mine ? "user-bubble" : "assistant-bubble"}>
                        <div
                          data-testid="message-bubble"
                          className={cn(
                            "relative space-y-2 px-3.5 py-2 text-body",
                            mine ? "bg-[var(--bot-accent)] text-on-accent" : "bg-assistant-bubble text-assistant-bubble-foreground",
                            singleLine ? "rounded-control" : mine ? "rounded-2xl" : "rounded-xl",
                            reactions.length ? "mb-3" : "",
                          )}
                        >
                          {message.replyToId && !message.parts?.length && placement === "inside" ? (
                            <button
                              type="button"
                              data-testid="reply-quote"
                              className="flex w-full min-w-0 items-center gap-1.5 text-left text-meta text-muted-foreground"
                              onClick={() => focusMessage(message.replyToId!)}
                            >
                              <MessageSquareQuote className="size-3.5 shrink-0" aria-hidden />
                              <span className="truncate">{replySnippet(quoted?.content ?? "")}</span>
                            </button>
                          ) : null}
                          {contents}
                          <ReactionCluster reactions={reactions} botName={botName} userName={userName} onToggle={(emoji) => void react(message.id, emoji)} />
                        </div>
                      </div>
                    )}
                  />
                ) : null}
                {media.length > 0 && !message.parts?.length ? (
                  <div className={cn("relative", showBubble ? "mt-1 w-0 min-w-full" : "w-[360px] max-w-full", !showBubble && reactions.length ? "mb-3" : "")}>
                    <MediaRow
                      media={media}
                      jobs={codingJobs}
                      accent={paint}
                      mine={mine}
                      botId={botId}
                      onOpenJob={onOpenJob}
                      onReply={() => setReply(message)}
                    />
                    {showBubble ? null : <ReactionCluster reactions={reactions} botName={botName} userName={userName} onToggle={(emoji) => void react(message.id, emoji)} />}
                  </div>
                ) : null}
              </MessageItem>
            );
          }} />
          {!showedJobs && codingJobs.length > 0 ? (
            <div className="flex w-full max-w-md flex-col gap-2">
              <CodingJobsCard jobs={codingJobs} accent={paint} botId={botId} onOpenJob={onOpenJob} />
            </div>
          ) : null}
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
          {events.filter(event => !["delta", "message.delta", "text_delta", "task.started", "model.started", "model.finished", "model.error"].includes(event.type)).map((event, i) => <EventCard key={`${conversationId}-${i}`} event={event} botId={botId} onEditMemory={onEditMemory} onMemoryChanged={onMemoryChanged} />)}
          <StreamDraft botId={botId} completed={storedMessages.filter(m => m.role === "assistant" && m.requestId).map(m => m.requestId!)} onText={streamTextPainted} onTool={streamToolPainted} />
          {active ? <LiveJobStep job={active} botId={botId} botName={botName} shape={avatarShape} color={avatarColor || accent} /> : null}
          {plan && plan.items.length ? <section aria-label="Task plan" className="rounded-md border border-border bg-card p-3 text-sm">
            <h3 className="font-medium">Plan</h3>
            <FlowDiagram label="Task plan flow" nodes={plan.items.map((item, index) => ({ id: `plan-${index}`, position: { x: index * 180, y: 0 }, data: { label: item.title }, type: "input" }))} edges={plan.items.slice(1).map((_, index) => ({ id: `plan-edge-${index}`, source: `plan-${index}`, target: `plan-${index + 1}` }))} />
            <ul className="mt-2 space-y-1">{plan.items.map((item, index) => <li key={index} className="flex gap-2"><span aria-hidden>{item.status === "done" ? <CircleCheck className="h-4 w-4 text-emerald-500" /> : item.status === "blocked" ? <CircleAlert className="h-4 w-4 text-destructive" /> : item.status === "in_progress" ? <CircleDot className="h-4 w-4 text-primary" /> : <Circle className="h-4 w-4 text-muted-foreground" />}</span><span>{item.title}</span></li>)}</ul>
            <p className="mt-2 text-xs text-muted-foreground">Budget: {plan.budget.label}</p>
            {plan.estimate ? <p className="text-xs text-muted-foreground">Estimate: ~{Math.round(plan.estimate.lowSeconds / 60)}–{Math.round(plan.estimate.highSeconds / 60)} min (from {plan.estimate.n} similar runs)</p> : null}
            <p className="text-xs">Tests: {plan.tests.required ? plan.tests.passedAt || plan.tests.override ? "passed" : "required" : "optional"}</p>
            {plan.blocked ? <p className="mt-2 rounded-md border border-destructive/40 p-2">This task is blocked.</p> : null}
            {plan.tests.required && !plan.tests.passedAt && !plan.tests.override && plan.status === "waiting_human" ? <Button size="sm" className="mt-2" onClick={() => void api(`/api/tasks/${plan.taskId}/override-tests`, { method: "POST" }).then(() => onSent())}>Mark done without tests</Button> : null}
          </section> : null}
          <JobResults jobs={codingJobs} accent={paint} onOpenJob={onOpenJob} />
          <RefreshNotice variant="chat" />
        </div>
      </div>
      <div role="status" aria-live="polite" data-testid="chat-live" className="sr-only">{live}</div>
      {pill ? <button ref={pillRef} type="button" data-testid="add-to-chat" aria-label="Add selection to chat"
        style={{ position: "fixed", left: pill.x, top: pill.y }}
        onMouseDown={event => event.preventDefault()}
        onClick={() => addQuoteText(pill.text, pill.source)}
        className="z-50 inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-popover px-3 text-xs font-medium text-popover-foreground shadow-md hover:bg-bot-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"><Quote className="h-3.5 w-3.5" aria-hidden />Add to chat</button> : null}
      {scrolledUp ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-30 flex justify-center">
          {fresh > 0 && !dismissedFresh ? (
            <div data-testid="new-messages-pill" className="pointer-events-auto flex items-center gap-1 rounded-md bg-[var(--bot-accent)] px-3 py-1 text-body-sm text-on-accent shadow-sm">
              <button type="button" data-testid="new-messages" onClick={jump}>
                {newMessagesLabel(fresh)}
              </button>
              <button type="button" data-testid="dismiss-new-messages" aria-label="Dismiss new messages" className="px-1" onClick={() => setDismissedFresh(true)}>
                ×
              </button>
            </div>
          ) : (
            <button type="button" data-testid="jump-to-latest" aria-label="Jump to latest" className="pointer-events-auto grid size-10 place-items-center rounded-md border border-border bg-card text-card-foreground shadow-md" onClick={jump}>
              <ArrowDown className="h-5 w-5" />
            </button>
          )}
        </div>
      ) : null}
      {working ? (
        <div data-testid="working-row" role="status" className="mx-auto w-full max-w-[var(--content-width)] px-4 pb-2">
          <ComposerPresence botId={botId} name={botName} shape={avatarShape ?? avatar?.shape} color={avatarColor || avatar?.color || accent} status={workingStatus(events, events.some(event => ["delta", "message.delta", "text_delta"].includes(event.type)), taskTitle)} />
        </div>
      ) : null}
      <form
        data-testid="composer-bar"
        className="mx-auto flex w-full max-w-[var(--content-width)] flex-col gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        onSubmit={onSubmit}
        onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={event => { if (hasFiles(event.dataTransfer.files)) { event.preventDefault(); void addFiles(event.dataTransfer.files); } }}
        onPaste={event => { if (hasFiles(event.clipboardData.files)) { event.preventDefault(); void addFiles(event.clipboardData.files); } }}
      >
        <div data-testid="composer-stack" className="flex flex-col">
        {reply && replyPart?.type === "reply" ? (
          <div data-testid="composer-reply" data-message-id={replyPart.messageId} className="mb-2 flex w-fit max-w-full items-center gap-2 rounded-md bg-muted px-3 py-1 text-meta text-muted-foreground">
            <ReplyIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {replyPart.image ? <img data-testid="composer-reply-image" src={replyPart.image.src} alt={replyPart.image.alt} className="size-7 shrink-0 rounded-md object-cover" /> : null}
            <span className="sr-only">Replying to {replyPart.author}: </span>
            <span data-testid="composer-reply-text" className="min-w-0 flex-1 truncate"><span data-testid="reply-chip">{replySnippet(reply.content)}</span></span>
            <button type="button" data-testid="remove-quote" aria-label="Cancel reply" onClick={() => { setReply(null); focusComposer(); }}>
              ×
            </button>
          </div>
        ) : null}
        <div
          data-testid="composer-pill"
          data-multiline={composerLines > 1 ? "true" : "false"}
          className="border border-[var(--composer-border)] bg-[var(--composer)] text-card-foreground shadow-[var(--composer-shadow)] transition-colors focus-within:border-[var(--composer-border-focus)]"
          style={{ borderRadius: "var(--radius-control)" }}
        >
          {uploads.length > 0 ? (
            <div data-testid="composer-attachments" className="flex flex-wrap gap-1.5 px-3 pt-2">
              {uploads.map((item) => (
                <div key={item.id} data-testid="pending-attachment" className="flex items-center gap-1">
                  <UploadCard key={item.id} item={item} />
                  <button type="button" aria-label={`Remove ${item.name}`} className="grid size-7 place-items-center rounded-md hover:bg-accent" onClick={() => { URL.revokeObjectURL(item.preview); setUploads(current => current.filter(row => row.id !== item.id)); setParts(current => current.map(part => part.type === "text" ? { ...part, text: part.text.replace(`[attached: ${item.path}]`, "") } : part)); }}><XIcon className="size-3.5" aria-hidden /></button>
                </div>
              ))}
            </div>
          ) : null}
          {parts.slice(0, -1).map(renderComposerPart)}
          <div className={cn("flex gap-1 px-1.5", composerLines > 1 ? "items-end py-1.5" : "h-11 items-center")}>
            <input ref={fileRef} type="file" multiple data-testid="composer-file" className="sr-only" aria-hidden tabIndex={-1} onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" data-testid="composer-plus" aria-label="Add" disabled={sending} className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--composer-placeholder)] hover:bg-[var(--composer-hover)] disabled:opacity-50">
                  <span data-testid="composer-add"><Plus className="size-4" strokeWidth={1.5} /></span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" onCloseAutoFocus={event => { event.preventDefault(); focusComposer(); }}>
                <DropdownMenuItem data-testid="plus-attach" onSelect={() => fileRef.current?.click()}>Attach files</DropdownMenuItem>
                <DropdownMenuItem data-testid="plus-teach-task" onSelect={() => window.dispatchEvent(new Event("teammates-teach-task"))}>Teach a task</DropdownMenuItem>
                <DropdownMenuItem data-testid="plus-quote" onSelect={() => window.dispatchEvent(new Event("teammates-add-selection"))}><Quote className="size-4" />Add selection to chat</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {renderComposerPart(parts[parts.length - 1], parts.length - 1)}
            <button type="button" data-testid="composer-mic" aria-label="Microphone" disabled={sending} className="grid size-7 shrink-0 place-items-center text-[var(--composer-placeholder)] disabled:opacity-50" onClick={() => toast.info("Voice input is not available yet.")}>
              <Mic className="size-4" strokeWidth={1.5} />
            </button>
            <button
              type={typing ? "submit" : "button"}
              data-testid={typing ? "send-chat" : "composer-voice"}
              aria-label={typing ? "Send" : "Voice"}
              disabled={sending || !conversationId || (typing && uploads.some((item) => item.status === "uploading"))}
              className="relative grid size-[30px] shrink-0 place-items-center rounded-md text-on-accent disabled:opacity-50"
              style={{ backgroundColor: paint }}
              onClick={typing ? undefined : () => toast.info("Voice input is not available yet.")}
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
          <p role="alert" data-testid={dlp ? "dlp-block" : undefined} className="text-body-sm text-destructive">
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
    <div data-testid="upload-card" data-status={item.status} className="flex max-w-full items-center gap-2 rounded-full border border-border bg-muted px-2 py-1 text-meta text-foreground">
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
      <div data-testid="question-card" data-answered="true" className="overflow-hidden rounded-card border border-border bg-card px-4 py-3 text-card-foreground shadow-sm">
        <div data-testid="question-answered">
          <p className="text-body-sm text-muted-foreground">{prompt}</p>
          <div className="mt-2 flex flex-col gap-1">
            {chosen.map((label) => {
              const index = options.findIndex((option) => option.label === label);
              const letter = index >= 0 ? optionLetter(index) : "";
              return (
                <div key={label} className="flex items-center gap-2 py-1">
                  {letter ? (
                    <span data-testid="option-letter" className="grid size-5 shrink-0 place-items-center rounded-md bg-[var(--bot-accent)] text-micro font-medium text-on-accent" aria-hidden>
                      {letter}
                    </span>
                  ) : null}
                  <span className="min-w-0 text-body-sm text-foreground">{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="question-card" data-answered="false" className="overflow-hidden rounded-card border border-border bg-card px-4 py-3 text-card-foreground shadow-sm">
      <p className="text-body-sm font-semibold">{prompt}</p>
      {multiple ? <p className="mt-0.5 text-meta text-muted-foreground">Choose all that apply</p> : null}
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
              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-body-sm hover:bg-muted disabled:opacity-60"
              onClick={() => void choose(option.label)}
            >
              <span
                aria-hidden
                data-testid="option-letter"
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-md text-micro font-medium",
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
                className="rounded-full border border-border bg-card px-1.5 py-0 text-body-sm leading-5 text-card-foreground shadow-sm"
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
  align = "start",
}: {
  messageId: string;
  content: string;
  mine: boolean;
  align?: "start" | "center";
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
    <div className={cn("absolute z-20", align === "center" ? "top-1/2 -translate-y-1/2" : "top-0", mine ? "right-full mr-1.5" : "left-full ml-1.5")}>
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
        <div data-testid="emoji-picker" data-side={side} className={cn(place, "w-52 overflow-hidden rounded-menu border border-border bg-popover p-2 text-popover-foreground shadow-md")}>
          <div className="grid grid-cols-6 gap-0.5">
            {[...QUICK_REACTIONS, ...EXTRA_EMOJIS].map((emoji) => (
              <button key={emoji} type="button" className="grid size-8 place-items-center rounded-md text-lead hover:bg-accent" onClick={() => onReact(emoji)}>
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
            className="mt-1 w-full rounded-full border border-border bg-card px-2 py-1 text-meta text-foreground"
          />
        </div>
      ) : picker ? (
        <div data-testid="reaction-picker" data-side={side} className={cn(place, "flex max-w-[13.5rem] items-center gap-0.5 rounded-full border border-border bg-popover px-1 py-0.5 text-popover-foreground shadow-md")}>
          {QUICK_REACTIONS.map((emoji) => (
            <button key={emoji} type="button" className="grid size-7 place-items-center rounded-full text-lead hover:bg-accent" onClick={() => onReact(emoji)}>
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
      <CollapsibleTrigger data-testid="memory-notice" data-action={action} className="inline-flex min-h-11 items-center gap-2 rounded-md px-1 text-body-sm text-muted-foreground hover:text-foreground">
        <Notebook className="h-3.5 w-3.5" aria-hidden />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent data-testid="memory-fact" onFocusCapture={() => setFocused(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }} className="px-6 pb-1 text-body-sm text-muted-foreground">
        {memoryKind === "rule" ? <span className="mr-2 rounded-sm border border-line px-1.5 py-0.5 text-xs">Rule</span> : null}{text}
        {action === "blocked" ? null : <div className="mt-2 flex flex-wrap gap-2">{undoOpen && undoableMemoryAction(action) && memoryId ? <Button data-testid="memory-undo" className="min-h-11" size="sm" variant="outline" disabled={busy} onClick={() => void undo()}>Undo</Button> : null}{memoryId && onEdit ? <Button className="min-h-11" size="sm" variant="ghost" onClick={() => onEdit(memoryId)}>Edit</Button> : null}{action === "suggested" && memoryId && botId ? <><Button className="min-h-11" size="sm" onClick={() => void api(`/api/bots/${botId}/memories/${memoryId}/accept`, { method: "POST" }).then(onChanged).catch(() => toast.error("Could not save this suggestion."))}>Save</Button><Button className="min-h-11" size="sm" variant="outline" onClick={() => void api(`/api/bots/${botId}/memories/${memoryId}/dismiss`, { method: "POST" }).then(onChanged).catch(() => toast.error("Could not dismiss this suggestion."))}>Skip</Button></> : null}</div>}
      </CollapsibleContent>
    </Collapsible>
  );
}

function MessageBlockView({
  block,
  jobs = [],
  accent = "#555555",
  botId,
  mine = false,
  onOpenJob,
  onReply = () => undefined,
}: {
  block: MessageBlock;
  jobs?: CodingJob[];
  accent?: string;
  botId?: string;
  mine?: boolean;
  onOpenJob?: (job: CodingJob) => void;
  onReply?: () => void;
}) {
  const side = mine ? "start" : "end";
  if (block.kind === "text") return <RichText text={block.text} jobs={jobs} accent={accent} botId={botId} onOpenJob={onOpenJob} />;
  if (block.kind === "question" || block.kind === "memory" || block.kind === "coding-jobs" || block.kind === "resume" || block.kind === "compacted" || block.kind === "resume_card") return null;
  if (block.kind === "form") return <SecureFormCard title={block.title} fields={block.fields} />;
  if (block.kind === "image") return <ImageGrid images={[{ src: block.url, alt: block.name }]} />;
  if (block.kind === "video") {
    return <MediaAttachment name={block.name} url={block.url} video side={side} onReply={onReply} />;
  }
  return <FileCard name={block.name} url={block.url} mime={block.mime} size={block.size} onReply={onReply} />;
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

function MediaRow({
  media,
  jobs,
  accent,
  mine,
  botId,
  onOpenJob,
  onReply,
}: {
  media: MessageBlock[];
  jobs: CodingJob[];
  accent: string;
  mine: boolean;
  botId?: string;
  onOpenJob?: (job: CodingJob) => void;
  onReply: () => void;
}) {
  const nodes: ReactNode[] = [];
  let images: GalleryImage[] = [];
  const flush = () => {
    if (images.length === 0) return;
    const batch = images;
    nodes.push(<ImageGrid key={`images-${nodes.length}-${batch[0]?.src}`} images={batch} />);
    images = [];
  };
  media.forEach((block, index) => {
    if (block.kind === "image") {
      images.push({ src: block.url, alt: block.name });
      return;
    }
    flush();
    nodes.push(
      <MessageBlockView
        key={`media-${index}`}
        block={block}
        jobs={jobs}
        accent={accent}
        mine={mine}
        botId={botId}
        onOpenJob={onOpenJob}
        onReply={onReply}
      />,
    );
  });
  flush();
  return <div className="flex w-full flex-col gap-1">{nodes}</div>;
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
      <figcaption className="px-2 py-1 text-meta text-muted-foreground">{name}</figcaption>
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
      <p className="text-body-sm font-medium">{title}</p>
      <p className="mt-1 text-meta text-muted-foreground">Secret fields are stored in the vault and are not shown again.</p>
      <div className="mt-2 flex flex-col gap-2">
        {fields.map((field) => (
          <label key={field.name} className="flex flex-col gap-1 text-meta">
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

function EventCard({ event, botId, onEditMemory, onMemoryChanged }: { event: AgentEvent; botId?: string; onEditMemory?: (id: string) => void; onMemoryChanged?: () => void }) {
  if (event.type === "video_progress") return <VideoProgress progress={event} testId="video-chat-progress" />;
  if (event.type === "grounding") {
    const verified = Number(event.verified ?? event.verifiedLinks);
    const removed = Number(event.removed ?? event.removedLinks);
    if (!Number.isFinite(verified) || !Number.isFinite(removed)) return null;
    return (
      <p data-testid="grounding-notice" role="status" className="text-meta text-muted-foreground">
        Verified {verified} links, removed {removed}
      </p>
    );
  }
  if (event.type === "memory") return <MemoryNotice botId={botId} onEdit={onEditMemory} onChanged={onMemoryChanged} previous={typeof event.previous === "string" ? event.previous : undefined} action={(["saved", "updated", "forgot", "suggested", "blocked"].includes(String(event.action)) ? String(event.action) : "saved") as "saved" | "updated" | "forgot" | "suggested" | "blocked"} text={String(event.content ?? "")} memoryId={String(event.memoryId ?? event.memory_id ?? "") || undefined} memoryKind={String(event.kind ?? "") || undefined} reason={String(event.reason ?? "") || undefined} />;
  const tool = String(event.tool ?? event.name ?? "Tool");
  const args = typeof event.args === "object" && event.args ? JSON.stringify(event.args) : String(event.args ?? "");
  return (
    <Collapsible data-testid="tool-call-card" className="rounded-md border border-border text-meta">
      <CollapsibleTrigger className="flex min-h-10 w-full items-center gap-2 px-3 text-left">
        <span aria-hidden>⌘</span>
        <span className="font-medium">{toolLabel(tool, event.args)}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{args.slice(0, 90)}</span>
        <span>{String(event.status ?? (event.type === "tool_result" ? "Done" : "Running"))}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border p-3">{JSON.stringify({ args: event.args, result: event.result }, null, 2)}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
