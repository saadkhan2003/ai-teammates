// Composer parts model for "Add to chat" quotes, replies and the sent-bubble clamp.
// Mirrors the server rules in apps/api/MessageParts.cs (docs/BOT_MESSAGING.md sections 9 and 10).

export type QuotePart = { type: "quote"; id: string; text: string; sourceMessageId?: string };
export type TextPart = { type: "text"; id: string; text: string };
export type ReplyPart = { type: "reply"; id: string; messageId: string; author: string; excerpt: string; image?: { src: string; alt: string } };
export type ComposerPart = QuotePart | TextPart | ReplyPart;

export const MAX_BLOCKS = 10;
export const MAX_QUOTE_CHARS = 4000;
export const MAX_QUOTE_TOTAL = 12000;
export const CLAMP_MAX_PX = 448; // 28rem

let counter = 0;
export const partId = () => `p${Date.now().toString(36)}${(counter++).toString(36)}`;
export const emptyText = (): TextPart => ({ type: "text", id: partId(), text: "" });
export const initialParts = (): ComposerPart[] => [emptyText()];

/** Rendered plain text of a selection: trimmed, 3+ newlines collapsed, cut at a word boundary after 4,000 chars. */
export function normalizeSelection(raw: string): { text: string; truncated: boolean } {
  let text = raw.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= MAX_QUOTE_CHARS) return { text, truncated: false };
  text = text.slice(0, MAX_QUOTE_CHARS - 1);
  const cut = text.lastIndexOf(" ");
  if (cut > MAX_QUOTE_CHARS * 0.6) text = text.slice(0, cut);
  return { text: text.trimEnd() + "…", truncated: true };
}

const blocks = (parts: ComposerPart[]) => parts.filter(p => p.type !== "text");
const quoteTotal = (parts: ComposerPart[]) => parts.reduce((n, p) => n + (p.type === "quote" ? p.text.length : 0), 0);

export type AddResult = { parts: ComposerPart[]; added: boolean; reason?: "duplicate" | "limit" | "empty" };

/** Appends the quote then a new empty text segment, so quote, comment, quote, comment can be built in order. */
export function addQuote(parts: ComposerPart[], text: string, sourceMessageId?: string): AddResult {
  const clean = text.trim();
  if (!clean) return { parts, added: false, reason: "empty" };
  if (parts.some(p => p.type === "quote" && p.text === clean)) return { parts, added: false, reason: "duplicate" };
  if (blocks(parts).length >= MAX_BLOCKS || quoteTotal(parts) + clean.length > MAX_QUOTE_TOTAL) return { parts, added: false, reason: "limit" };
  const next = [...parts];
  // an empty trailing segment is reused for the quote's position: quote goes before it
  const last = next[next.length - 1];
  const quote: QuotePart = { type: "quote", id: partId(), text: clean, sourceMessageId };
  if (last && last.type === "text" && last.text === "") next.splice(next.length - 1, 0, quote);
  else next.push(quote);
  if (next[next.length - 1].type !== "text") next.push(emptyText());
  return { parts: next, added: true };
}

export function removePart(parts: ComposerPart[], id: string): ComposerPart[] {
  const next = parts.filter(p => p.id !== id);
  if (next.length === 0 || next[next.length - 1].type !== "text") next.push(emptyText());
  return next;
}

/** One reply block per message in v1: a second Reply replaces the first. Placed at the top. */
export function setReply(parts: ComposerPart[], reply: { messageId: string; author: string; excerpt: string; image?: { src: string; alt: string } }): ComposerPart[] {
  const rest = parts.filter(p => p.type !== "reply");
  return [{ type: "reply", id: partId(), ...reply }, ...(rest.length ? rest : [emptyText()])];
}

export const hasBlocks = (parts: ComposerPart[]) => parts.some(p => p.type !== "text");

/** Clipboard and drop uploads are handled only when files are actually present. */
export const hasFiles = (files: { length: number } | null | undefined): boolean => (files?.length ?? 0) > 0;

export function canSend(parts: ComposerPart[]): boolean {
  if (parts.some(p => p.type === "quote")) return true;
  return parts.some(p => p.type === "text" && p.text.trim().length > 0);
}

export function toPayload(parts: ComposerPart[]): Array<Record<string, string>> {
  return parts.flatMap((p): Array<Record<string, string>> => {
    if (p.type === "text") return p.text.trim() ? [{ type: "text", text: p.text }] : [];
    if (p.type === "quote") return [{ type: "quote", text: p.text, ...(p.sourceMessageId ? { sourceMessageId: p.sourceMessageId } : {}) }];
    return [{ type: "reply", messageId: p.messageId }];
  });
}

/** Flattened readable copy: quotes as "> " lines, then the following text. Same output as the server. */
export function flatten(parts: Array<{ type: string; text?: string }>): string {
  const out: string[] = [];
  for (const p of parts) {
    if (p.type === "quote") out.push((p.text ?? "").replace(/\r\n/g, "\n").split("\n").map(l => `> ${l}`).join("\n"));
    else if (p.type === "text" && (p.text ?? "").trim()) out.push((p.text ?? "").trim());
  }
  return out.join("\n\n");
}

export const needsClamp = (contentHeight: number, max = CLAMP_MAX_PX) => contentHeight > max + 4;

/** Clamp a floating element's top-left so it stays inside the viewport with a margin. */
export function clampToViewport(x: number, y: number, w: number, h: number, vw: number, vh: number, margin = 8) {
  return { x: Math.max(margin, Math.min(x, vw - w - margin)), y: Math.max(margin, Math.min(y, vh - h - margin)) };
}

/** Where the "Add to chat" pill sits: centred above the end of the selection (below on touch). */
export function pillPosition(rect: { left: number; right: number; top: number; bottom: number }, size: { w: number; h: number }, vw: number, vh: number, touch: boolean) {
  const cx = rect.right - Math.min(24, (rect.right - rect.left) / 2);
  const y = touch ? rect.bottom + 6 : rect.top - size.h - 6;
  const flipped = !touch && y < 8;
  return clampToViewport(cx - size.w / 2, flipped ? rect.bottom + 6 : y, size.w, size.h, vw, vh);
}

/** A long-press is cancelled by 10 px of movement or any scroll. */
export const cancelsLongPress = (dx: number, dy: number, scrolled: boolean) => scrolled || Math.hypot(dx, dy) > 10;
export const LONG_PRESS_MS = 500;

export const EXPANDED = new Map<string, boolean>();
