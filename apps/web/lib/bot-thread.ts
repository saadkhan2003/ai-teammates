export type BotThreadStatus = "waiting" | "replied" | "approval" | "paused" | "failed" | "closed" | string;

export type BotRow =
  | { type: "bot_thread"; threadId: string; direction: "out" | "in"; peerName: string; title: string }
  | { type: "bot_action"; action: string; targetName: string; summary: string };

export type BotThreadView = {
  id: string;
  title: string;
  status: BotThreadStatus;
  errorCode?: string | null;
  messageCount?: number;
  initiatorBotId?: string;
  peerBotId?: string;
  initiatorName?: string;
  peerName?: string;
  lastReply?: string | null;
  firstRequest?: string | null;
};

/** Parses the JSON body of a `bot_thread` or `bot_action` chat row. Returns null for anything else. */
export function parseBotRow(kind: string | undefined, content: string): BotRow | null {
  if (kind !== "bot_thread" && kind !== "bot_action") return null;
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (kind === "bot_thread" && typeof value.threadId === "string") {
      return {
        type: "bot_thread",
        threadId: value.threadId,
        direction: value.direction === "received" || value.direction === "in" ? "in" : "out",
        peerName: String(value.peerName ?? "a teammate"),
        title: String(value.title ?? "Conversation"),
      };
    }
    if (kind === "bot_action") {
      return { type: "bot_action", action: String(value.action ?? ""), targetName: String(value.targetName ?? ""), summary: String(value.summary ?? "") };
    }
  } catch {
    // fall through
  }
  return null;
}

const LABELS: Record<string, string> = {
  waiting: "Waiting for a reply",
  replied: "Replied",
  approval: "Waiting for your approval",
  paused: "Paused",
  failed: "Failed",
  closed: "Closed",
};

export function threadStatusLabel(status?: string): string {
  return LABELS[status ?? ""] ?? "Working";
}

/** The row text: "Messaged Scout <title>" when this bot started it, "Scout messaged you <title>" otherwise. */
export function threadRowText(row: Extract<BotRow, { type: "bot_thread" }>): { lead: string; title: string } {
  return row.direction === "out"
    ? { lead: `Messaged ${row.peerName}`, title: row.title }
    : { lead: `${row.peerName} messaged you`, title: row.title };
}

export function actionRowText(row: Extract<BotRow, { type: "bot_action" }>): string {
  const target = row.targetName ? ` ${row.targetName}` : "";
  if (row.action === "create_bot") return `Created teammate${target}`;
  if (row.action === "create_routine") return `Scheduled a routine${target ? ` for${target}` : ""}`;
  if (row.action === "update_bot") return row.targetName ? `Updated${target}` : "Updated its bio";
  return row.summary || row.action || "Did something";
}
