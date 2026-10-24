"use client";

import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Copy, MoreHorizontal, Reply, SmilePlus, Sparkles, Video } from "lucide-react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PopoverLite } from "@/components/ui/popover-lite";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { CLAMP_MAX_PX, EXPANDED, LONG_PRESS_MS, cancelsLongPress, flatten, needsClamp } from "@/lib/chat-parts";
import { readVideoAnalysis } from "@/lib/video-analysis";
import { PageCard } from "@/components/page-canvas";
import { VideoAnalysisCard } from "@/components/video-analysis-card";
import { QUICK_REACTIONS, searchEmoji } from "@/lib/emoji";
import type { ChatMessage, MessagePartView } from "@/lib/types";
import { cn, errorMessage, formatWhen } from "@/lib/utils";

export type MessageItemProps = {
  message: ChatMessage;
  fresh?: boolean;
  mine: boolean;
  botName: string;
  botId?: string;
  bot?: { shape?: string; color?: string; id?: string; primary?: boolean };
  byId: Map<string, ChatMessage>;
  children: ReactNode;
  onReact: (messageId: string, emoji: string) => void;
  onReply: (message: ChatMessage) => void;
  onQuote: () => void;
  onChanged: () => void;
  announce: (text: string) => void;
  focusSibling: (from: HTMLElement, delta: number) => void;
};

export function plainTextOf(message: ChatMessage): string {
  if (message.parts?.length) return flatten(message.parts as Array<{ type: string; text?: string }>);
  return message.content;
}

const isCoarse = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
const selectionIn = (el: HTMLElement | null) => {
  const sel = typeof window === "undefined" ? null : window.getSelection();
  return !!(sel && !sel.isCollapsed && el && sel.anchorNode && el.contains(sel.anchorNode) && sel.toString().trim());
};

export function MessageItem(props: MessageItemProps) {
  const { message, fresh, mine, botName, botId, bot, byId, children, onReact, onReply, onQuote, onChanged, announce, focusSibling } = props;
  const ref = useRef<HTMLElement>(null);
  const reactRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(false);
  const [tapShown, setTapShown] = useState(false);
  const press = useRef<{ x: number; y: number; timer: number; scrolled: boolean } | null>(null);
  const deleted = !!message.deleted;
  const status = message.taskStatus ?? null;
  const running = status === "running" || status === "planning";
  const canRetry = status === "failed" || status === "cancelled";
  const isQuestion = message.kind === "question";
  const forced = emojiOpen || menuOpen || tapShown;

  useEffect(() => {
    const onSel = () => setSelected(selectionIn(ref.current));
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const copy = useCallback(async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); toast.success(`${what} copied`); announce(`${what} copied`); }
    catch { toast.error("Could not copy."); }
  }, [announce]);

  async function retry() {
    setBusy(true);
    try { await api(`/api/messages/${message.id}/retry`, { method: "POST" }); announce("Retrying"); onChanged(); }
    catch (caught) { toast.error(errorMessage(caught, "Could not retry that.")); }
    finally { setBusy(false); }
  }
  async function remember() {
    if (!botId) return;
    try { await api(`/api/bots/${botId}/memories`, { method: "POST", body: JSON.stringify({ content: plainTextOf(message).slice(0, 2000) }) }); toast.success("Saved to notes"); announce("Saved to notes"); onChanged(); }
    catch (caught) { toast.error(errorMessage(caught, "Could not save that.")); }
  }
  async function remove() {
    setBusy(true);
    try { await api(`/api/messages/${message.id}`, { method: "DELETE" }); announce("Message deleted"); setConfirmDelete(false); onChanged(); }
    catch (caught) { toast.error(errorMessage(caught, "Could not delete that message.")); setConfirmDelete(false); }
    finally { setBusy(false); }
  }

  const items = (close?: () => void): ReactNode => {
    const wrap = (fn: () => void) => () => { fn(); close?.(); };
    return <>
      <Item testId="msg-copy" onSelect={wrap(() => void copy(plainTextOf(message), "Message"))}>Copy</Item>
      <Item testId="msg-copy-request" disabled={!message.requestId} title={message.requestId ? undefined : "No run for this message"} onSelect={wrap(() => void copy(message.requestId ?? "", "Request ID"))}>Copy request ID</Item>
      {selected ? <Item testId="msg-quote" onSelect={wrap(onQuote)}>Quote selection</Item> : null}
      {canRetry ? <Item testId="msg-retry" onSelect={wrap(() => void retry())}>Retry</Item> : null}
      {message.role === "assistant" && plainTextOf(message).trim() ? <Item testId="msg-remember" onSelect={wrap(() => void remember())}>Remember this</Item> : null}
      {running || isQuestion ? null : <><Sep /><Item testId="msg-delete" destructive onSelect={wrap(() => setConfirmDelete(true))}>Delete</Item></>}
    </>;
  };

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget || deleted) {
      return;
    }
    const k = event.key;
    if (k === "ArrowDown") { event.preventDefault(); focusSibling(event.currentTarget, 1); }
    else if (k === "ArrowUp") { event.preventDefault(); focusSibling(event.currentTarget, -1); }
    else if (!event.ctrlKey && !event.metaKey && !event.altKey && k.toLowerCase() === "r") { event.preventDefault(); onReply(message); }
    else if (!event.ctrlKey && !event.metaKey && !event.altKey && k.toLowerCase() === "e") { event.preventDefault(); setEmojiOpen(true); }
    else if (!event.ctrlKey && !event.metaKey && !event.altKey && k.toLowerCase() === "c") { event.preventDefault(); void copy(plainTextOf(message), "Message"); }
    else if (k === "Enter" || k === "ContextMenu" || (k === "F10" && event.shiftKey)) { event.preventDefault(); setMenuOpen(true); }
    else if (k === "Escape") { setEmojiOpen(false); setMenuOpen(false); setTapShown(false); }
  }

  // touch: long-press opens the sheet, tap toggles the inline toolbar
  const onTouchStart = (event: React.TouchEvent) => {
    if (!isCoarse() || deleted) return;
    const t = event.touches[0];
    const timer = window.setTimeout(() => { press.current = null; navigator.vibrate?.(10); setSheet(true); }, LONG_PRESS_MS);
    press.current = { x: t.clientX, y: t.clientY, timer, scrolled: false };
  };
  const onTouchMove = (event: React.TouchEvent) => {
    const p = press.current; if (!p) return;
    const t = event.touches[0];
    if (cancelsLongPress(t.clientX - p.x, t.clientY - p.y, p.scrolled)) { window.clearTimeout(p.timer); press.current = null; }
  };
  const onTouchEnd = () => { const p = press.current; if (p) { window.clearTimeout(p.timer); press.current = null; if (!selectionIn(ref.current)) setTapShown(v => !v); } };

  const mineReaction = message.reactions?.find(r => r.actorType === "user");

  if (deleted) {
    return <article ref={ref} id={`msg-${message.id}`} data-message-id={message.id} data-testid="message-item" data-role={message.role} data-deleted="true" className={cn("group min-w-0 max-w-[85%] sm:max-w-[75%]", mine ? "ml-auto" : "mr-auto")}>
      <p className="rounded-bubble border border-dashed border-border px-3.5 py-2 text-sm italic text-muted-foreground">Message deleted</p>
    </article>;
  }

  return (
    <article
      ref={ref}
      id={`msg-${message.id}`}
      data-message-id={message.id}
      data-testid="message-item"
      data-role={message.role}
      tabIndex={0}
      aria-label={`${mine ? "You" : botName}: ${plainTextOf(message).slice(0, 80)}`}
      onKeyDown={onKeyDown}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      className={cn(fresh && "motion-rise", "group relative min-w-0 max-w-[85%] rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-[75%]", mine ? "ml-auto" : "mr-auto")}
    >
      <div
        role="toolbar"
        aria-label="Message actions"
        data-testid="message-toolbar"
        data-forced={forced ? "true" : undefined}
        className={cn(
          "absolute z-10 flex items-center gap-0.5 rounded-md border border-border bg-popover p-0.5 shadow-sm transition-opacity motion-reduce:transition-none",
          "-top-8 sm:top-0", mine ? "right-0 sm:right-full sm:mr-1" : "left-0 sm:left-full sm:ml-1",
          "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          forced && "pointer-events-auto opacity-100", selected && !forced && "hidden",
        )}
        onKeyDown={event => {
          if (!["ArrowRight", "ArrowLeft"].includes(event.key)) return;
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
          const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (idx < 0) return;
          event.preventDefault();
          buttons[(idx + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}
      >
        <ToolButton ref={reactRef} testId="msg-react" label="Add reaction" popup expanded={emojiOpen} onClick={() => setEmojiOpen(v => !v)}><SmilePlus className="h-4 w-4" /></ToolButton>
        <ToolButton testId="msg-reply" label="Reply" onClick={() => onReply(message)}><Reply className="h-4 w-4" /></ToolButton>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <ToolButton ref={moreRef} testId="msg-more" label="More" popup expanded={menuOpen}><MoreHorizontal className="h-4 w-4" /></ToolButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={mine ? "end" : "start"} data-testid="message-menu" onCloseAutoFocus={event => { event.preventDefault(); ref.current?.focus(); }}>{items()}</DropdownMenuContent>
        </DropdownMenu>
        <PopoverLite open={emojiOpen} onClose={() => setEmojiOpen(false)} label="Pick a reaction" anchorRef={reactRef} className={cn("top-full mt-1 w-72", mine ? "right-0" : "left-0")}>
          <EmojiPicker current={mineReaction?.emoji} onPick={emoji => { setEmojiOpen(false); onReact(message.id, emoji); announce("Reaction updated"); ref.current?.focus(); }} />
        </PopoverLite>
      </div>

      {!mine ? <div className="mb-1 flex items-center gap-2 text-xs"><BotAvatar botId={bot?.id} shape={bot?.shape} color={bot?.color} size={20} primary={bot?.primary} /><span data-testid="bot-name-label" className="font-medium text-bot-text">{botName}</span></div> : null}
      <div>{children}</div>
      {(message.reactions ?? []).length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {message.reactions?.map(reaction => {
            const own = reaction.actorType === "user";
            return <Button variant="outline" size="sm" key={reaction.id ?? `${reaction.actorType}-${reaction.emoji}`} type="button" data-testid="reaction-pill" data-emoji={reaction.emoji} data-actor={reaction.actorType}
              aria-pressed={own ? true : undefined}
              aria-label={own ? `${reaction.emoji} by you, remove` : `${reaction.emoji} by ${botName}`}
              title={own ? "You" : botName} className="min-h-6 rounded-md border border-border bg-card px-2 py-0.5 text-sm"
              onClick={() => { if (own) onReact(message.id, reaction.emoji); }}>{reaction.emoji}</Button>;
          })}
        </div>
      ) : null}
      <time className="mt-1 block px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{formatWhen(message.createdAt)}</time>

      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="bottom" data-testid="message-sheet">
          <SheetHeader><SheetTitle>Message</SheetTitle></SheetHeader>
          <div className="mt-3 grid gap-1">
            <div className="flex gap-1">{QUICK_REACTIONS.map(e => <Button key={e} variant="ghost" className="h-11 w-11 text-lg" onClick={() => { setSheet(false); onReact(message.id, e); }}>{e}</Button>)}</div>
            <Button variant="ghost" className="h-11 justify-start" onClick={() => { setSheet(false); onReply(message); }}><Reply className="h-4 w-4" />Reply</Button>
            <Button variant="ghost" className="h-11 justify-start" onClick={() => { setSheet(false); void copy(plainTextOf(message), "Message"); }}><Copy className="h-4 w-4" />Copy</Button>
            <Button variant="ghost" className="h-11 justify-start" disabled={!message.requestId} onClick={() => { setSheet(false); void copy(message.requestId ?? "", "Request ID"); }}>Copy request ID</Button>
            {canRetry ? <Button variant="ghost" className="h-11 justify-start" onClick={() => { setSheet(false); void retry(); }}>Retry</Button> : null}
            {message.role === "assistant" ? <Button variant="ghost" className="h-11 justify-start" onClick={() => { setSheet(false); void remember(); }}>Remember this</Button> : null}
            {running || isQuestion ? null : <Button variant="ghost" className="h-11 justify-start text-destructive" onClick={() => { setSheet(false); setConfirmDelete(true); }}>Delete</Button>}
          </div>
        </SheetContent>
      </Sheet>
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent data-testid="delete-message-dialog">
          <DialogHeader><DialogTitle>Delete this message?</DialogTitle><DialogDescription>The bot may already have seen it.</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="destructive" data-testid="confirm-delete-message" disabled={busy} onClick={() => void remove()}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}

const Item = ({ children, onSelect, testId, disabled, destructive, title }: { children: ReactNode; onSelect: () => void; testId: string; disabled?: boolean; destructive?: boolean; title?: string }) =>
  <DropdownMenuItem data-testid={testId} disabled={disabled} title={title} className={destructive ? "text-destructive focus:text-destructive" : undefined} onSelect={onSelect}>{children}</DropdownMenuItem>;
const Sep = () => <DropdownMenuSeparator />;

import { forwardRef } from "react";
const ToolButton = forwardRef<HTMLButtonElement, { label: string; testId: string; children: ReactNode; onClick?: () => void; popup?: boolean; expanded?: boolean }>(
  function ToolButton({ label, testId, children, onClick, popup, expanded, ...rest }, ref) {
    return <button ref={ref} type="button" data-testid={testId} aria-label={label} title={label} aria-haspopup={popup ? "menu" : undefined} aria-expanded={popup ? !!expanded : undefined}
      onClick={onClick} {...rest}
      className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-bot-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11">{children}</button>;
  });

function EmojiPicker({ onPick, current }: { onPick: (emoji: string) => void; current?: string }) {
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);
  const list = searchEmoji(query);
  useEffect(() => { gridRef.current?.parentElement?.querySelector<HTMLButtonElement>("[data-quick]")?.focus(); }, []);
  function move(event: KeyboardEvent<HTMLDivElement>) {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 };
    if (!(event.key in keys)) return;
    const cells = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-cell]") ?? []);
    const idx = cells.indexOf(document.activeElement as HTMLButtonElement);
    if (idx < 0) return;
    event.preventDefault();
    cells[Math.max(0, Math.min(cells.length - 1, idx + keys[event.key]))]?.focus();
  }
  return <div data-testid="reaction-picker" className="grid gap-2">
    <div className="flex gap-1">{QUICK_REACTIONS.map((e, i) => <button key={e} type="button" data-quick={i === 0 ? "" : undefined} data-testid={`quick-${e}`} aria-label={`React ${e}`} aria-pressed={current === e} className="grid h-8 w-8 place-items-center rounded-md text-lg hover:bg-bot-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-bot-soft" onClick={() => onPick(e)}>{e}</button>)}</div>
    <input aria-label="Search emoji" placeholder="Search emoji" value={query} onChange={event => setQuery(event.target.value)} className="h-8 rounded-md border border-border bg-card px-2 text-xs" />
    <div ref={gridRef} role="group" aria-label="Emoji" onKeyDown={move} className="grid max-h-40 grid-cols-8 gap-0.5 overflow-y-auto">
      {list.map((item, i) => <button key={item.e} type="button" data-cell="" aria-label={`${item.e}, ${i + 1} of ${list.length}`} className="grid h-8 w-8 place-items-center rounded-md text-lg hover:bg-bot-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onPick(item.e)}>{item.e}</button>)}
    </div>
    <input data-testid="reaction-custom" aria-label="Custom emoji" placeholder="Custom emoji" value={custom} onChange={event => setCustom(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter" && custom.trim()) { event.preventDefault(); onPick(custom.trim()); } }} className="h-8 rounded-md border border-border bg-card px-2 text-xs" />
  </div>;
}

/** The body of a message: ordered parts (quotes, replies, text) in the sent bubble, with the 20-line clamp. */
export function MessageBody({ message, mine, byId, onJump, fallback }: { message: ChatMessage; mine: boolean; byId: Map<string, ChatMessage>; onJump: (id: string) => void; fallback: ReactNode }) {
  const parts = message.parts ?? null;
  const videoAnalysis = !parts?.length ? message.videoAnalysis ?? readVideoAnalysis(message.content) : null;
  const box = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(() => EXPANDED.get(message.id) ?? false);
  const [clamped, setClamped] = useState(false);
  const clampable = mine;
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || !clampable) return;
    const measure = () => setClamped(needsClamp(node.scrollHeight));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [clampable, message.content, expanded]);
  const [settled, setSettled] = useState(true);
  const toggle = () => {
    const next = !expanded;
    EXPANDED.set(message.id, next);
    setSettled(false);
    setExpanded(next);
    // Expanding animates max-height up to the content, then releases it so the bubble can grow freely.
    window.setTimeout(() => setSettled(true), 320);
  };
  const clampStyle = clampable && clamped
    ? (expanded ? (settled ? undefined : { maxHeight: (box.current?.scrollHeight ?? CLAMP_MAX_PX) + 1, overflow: "hidden" as const }) : { maxHeight: CLAMP_MAX_PX, overflow: "hidden" as const })
    : undefined;
  const bubble = mine ? "bg-user-bubble text-user-bubble-foreground border border-bot-border/40" : "bg-assistant-bubble text-assistant-bubble-foreground";
  const inner = parts && parts.length
    ? <div className="space-y-2">{parts.map((part, i) => <PartView key={i} part={part} byId={byId} expanded={expanded} onJump={onJump} />)}</div>
    : null;
  return <div className={cn("relative rounded-bubble px-3.5 py-2 text-sm", bubble)} data-testid={mine ? "user-bubble" : "assistant-bubble"}>
    {message.skill ? <span data-testid="skill-chip" className="mb-1.5 inline-flex items-center gap-1 rounded-full border border-current/25 bg-black/10 px-2 py-0.5 text-xs font-medium"><Sparkles className="h-3 w-3" aria-hidden />{message.skill.label}</span> : null}
    <div ref={box} id={`body-${message.id}`} style={clampStyle}
      className={cn("motion-clamp", clampable && clamped && !expanded && "[mask-image:linear-gradient(to_bottom,black_85%,transparent)]")}>
      {message.page ? <PageCard page={message.page} /> : inner ?? (videoAnalysis ? <VideoAnalysisCard analysis={videoAnalysis} /> : <div data-testid="message-text" className="space-y-2">{fallback}</div>)}
      {message.attachments?.length ? <div className="mt-2 space-y-1">{message.attachments.map(item => <div key={item.path} data-testid="recording-attachment" className="flex min-h-9 items-center gap-2 rounded-lg border border-current/20 bg-black/10 px-2.5 py-1.5 text-xs"><Video className="h-4 w-4 shrink-0" aria-hidden /><span className="truncate" title={item.path}>{item.name}</span></div>)}</div> : null}
    </div>
    {clampable && (clamped || expanded) ? <button type="button" data-testid="bubble-toggle" aria-expanded={expanded} aria-controls={`body-${message.id}`} onClick={toggle}
      className="mt-1 inline-flex min-h-6 items-center gap-1 text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {expanded ? <>Show less <ChevronUp className="h-3 w-3" /></> : <>Show more <ChevronDown className="h-3 w-3" /></>}</button> : null}
  </div>;
}

function PartView({ part, byId, expanded, onJump }: { part: MessagePartView; byId: Map<string, ChatMessage>; expanded: boolean; onJump: (id: string) => void }) {
  if (part.type === "text") return <Markdown text={part.text} />;
  if (part.type === "quote") {
    return <blockquote data-testid="quote-block" className={cn("border-l-2 border-current/40 bg-black/10 px-2 py-1 text-[13px] opacity-75 [overflow-wrap:anywhere] whitespace-pre-wrap", !expanded && "line-clamp-4")}>
      <span className="sr-only">Quoted text: </span>{part.text}</blockquote>;
  }
  const target = byId.get(part.messageId);
  const gone = !!target?.deleted;
  const author = part.author || "Message";
  return <button type="button" data-testid="reply-block" data-reply-to={part.messageId} disabled={gone} onClick={() => onJump(part.messageId)}
    aria-label={gone ? "Original message deleted" : `Jump to the original message from ${author}`}
    className="flex w-full items-start gap-2 rounded-lg border border-current/30 bg-black/10 px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-black/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60">
    <Reply className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
    <span className="min-w-0 flex-1">
      <span className="block text-[11px] font-semibold opacity-80">{author}</span>
      <span className="line-clamp-2 opacity-80 [overflow-wrap:anywhere]">{gone ? "Original message deleted" : part.excerpt}</span>
    </span>
  </button>;
}
