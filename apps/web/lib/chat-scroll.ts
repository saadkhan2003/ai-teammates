/** Keep native browser anchoring disabled when using these corrections. */
export const VIRTUAL_CHAT_THRESHOLD = 50;
export function nearChatBottom(scrollTop: number, scrollHeight: number, clientHeight: number, threshold = 80): boolean {
  return scrollHeight - clientHeight - scrollTop < threshold;
}
export type ChatAnchor = { id: string; offset: number };
export function visibleChatAnchor(rows: Array<{ id: string; top: number; bottom: number }>, viewportTop: number): ChatAnchor | null {
  const row = rows.find(row => row.bottom > viewportTop);
  return row ? { id: row.id, offset: row.top - viewportTop } : null;
}
export function anchoredScrollTop(scrollTop: number, viewportTop: number, rowTop: number, anchor: ChatAnchor): number {
  return Math.max(0, scrollTop + rowTop - viewportTop - anchor.offset);
}
/** Only append announcements: paging older history must remain quiet. */
export function appendedAssistantText(previous: string[], messages: Array<{ id: string; role: string; content: string }>): string {
  if (!previous.length) return "";
  const last = messages.findIndex(message => message.id === previous[previous.length - 1]);
  return last < 0 ? "" : messages.slice(last + 1).filter(message => message.role === "assistant").map(message => message.content).join("\n");
}
