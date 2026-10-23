export type MemoryKind = "profile" | "rule" | "journal" | "fact" | "summary";
export type MemoryRow = {
  id: string; content: string; kind: MemoryKind; status: string; pinned: boolean;
  visibility: string; author: string; createdAt?: string; updatedAt?: string; lastConfirmedAt?: string;
};
export type MemoryNoticeData = { action: "saved" | "updated" | "forgot" | "suggested" | "blocked"; memoryId?: string; kind?: string; content: string; previous?: string; reason?: string };

const str = (v: unknown) => typeof v === "string" ? v : v == null ? "" : String(v);
export function normalizeMemoryRows(data: unknown): MemoryRow[] {
  const list = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).items) ? (data as { items: unknown[] }).items : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).memories) ? (data as { memories: unknown[] }).memories : [];
  return list.map((entry, i) => {
    const r = (entry ?? {}) as Record<string, unknown>;
    const kind = str(r.kind) as MemoryKind;
    return { id: str(r.id) || `memory-${i + 1}`, content: str(r.content ?? r.text), kind: ["profile", "rule", "journal", "fact", "summary"].includes(kind) ? kind : "profile", status: str(r.status) || "active", pinned: r.pinned === true, visibility: str(r.visibility) || "bot", author: str(r.author) || "agent", createdAt: str(r.createdAt ?? r.created_at) || undefined, updatedAt: str(r.updatedAt ?? r.updated_at) || undefined, lastConfirmedAt: str(r.lastConfirmedAt ?? r.last_confirmed_at) || undefined };
  });
}
export function parseMemoryNotice(value: unknown): MemoryNoticeData | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>; if (String(r.type ?? r.kind ?? "") !== "memory" && String(r.type ?? "") !== "note") return null;
  const action = String(r.action ?? "saved"); if (!["saved", "updated", "forgot", "suggested", "blocked"].includes(action)) return null;
  return { action: action as MemoryNoticeData["action"], memoryId: str(r.memoryId ?? r.memory_id) || undefined, kind: str(r.kindName ?? r.memoryKind ?? r.noteKind) || (typeof r.kind === "string" && r.kind !== "memory" ? r.kind : undefined), content: str(r.content ?? r.text ?? r.fact), previous: str(r.previous) || undefined, reason: str(r.reason) || undefined };
}
export function memoryReason(reason?: string) {
  const reasons: Record<string, string> = { credential_shaped: "Not saved: it looked like a secret", secret: "Not saved: it looked like a secret", use_vault: "Not saved: contact details are not kept in notes", contact: "Not saved: contact details are not kept in notes", approval_rule: "Not saved: approval and security rules cannot be changed by notes", unsafe_rule: "Not saved: approval and security rules cannot be changed by notes", notes_full: "Not saved: notes are full" };
  return reasons[reason ?? ""] ?? "Not saved: this note could not be saved";
}
export function filterMemoryRows(rows: MemoryRow[], query: string, filter: string) {
  const q = query.trim().toLocaleLowerCase();
  return rows.filter(r => (!q || r.content.toLocaleLowerCase().includes(q)) && (filter === "all" || filter === "pinned" ? filter !== "pinned" || r.pinned : filter === "suggested" ? r.status === "pending" : r.kind === filter));
}
export function undoableMemoryAction(action: string) { return action === "saved" || action === "updated" || action === "forgot"; }
