export type LibraryKind = "image" | "video" | "audio" | "pdf" | "text" | "markdown" | "code" | "doc" | "sheet" | "archive" | "page" | "link" | "screenshots" | "unknown";
export type LibraryItem = { id: string; name: string; kind: LibraryKind; ext: string; mime: string; sizeBytes: number; source: string; direction: string; createdAt: string; thumbUrl: string | null; thumbState?: "pending" | "ready" | "none" | "failed"; pinned: boolean; dlpState?: "clean" | "redacted" | "blocked"; messageId?: string | null };
export type LibraryGroup = { key: "today" | "week" | "older"; label: string; total: number; items: LibraryItem[]; nextCursor: string | null };
export type LibraryResponse = { pinned: LibraryItem[]; groups: LibraryGroup[] };

export const GROUPS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "older", label: "Older" },
] as const;

const extensionKinds: Record<string, LibraryKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", heic: "image",
  mp4: "video", webm: "video", mov: "video", mp3: "audio", wav: "audio", pdf: "pdf", txt: "text", log: "text",
  md: "markdown", markdown: "markdown", csv: "sheet", tsv: "sheet", xls: "sheet", xlsx: "sheet", ods: "sheet",
  doc: "doc", docx: "doc", odt: "doc", ppt: "doc", pptx: "doc", zip: "archive", tar: "archive", gz: "archive", rar: "archive", "7z": "archive",
  html: "code", htm: "code", css: "code", js: "code", mjs: "code", ts: "code", tsx: "code", jsx: "code", py: "code", cs: "code", json: "code", xml: "code", yaml: "code", yml: "code", sh: "code", sql: "code",
};

export function detectKind(name: string, mime = ""): LibraryKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (name.includes(".") && extensionKinds[ext]) return extensionKinds[ext];
  const type = mime.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (type.includes("spreadsheet") || type === "text/csv") return "sheet";
  if (type.includes("wordprocessing") || type === "application/msword") return "doc";
  if (type === "text/markdown") return "markdown";
  if (type.startsWith("text/")) return "text";
  if (type === "application/json" || type.includes("xml")) return "code";
  if (type.includes("zip") || type.includes("compressed")) return "archive";
  return "unknown";
}

export function sanitizeName(value: string): string {
  const leaf = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^\.+|\.+$/g, "").slice(0, 255);
  return clean || "file";
}

export function groupForTimestamp(value: string | Date, now: Date, timeZone: string): "today" | "week" | "older" {
  const date = new Date(value);
  const localParts = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const localDate = localParts(date);
  const today = localParts(now);
  if (localDate === today) return "today";
  const start = new Date(`${today}T00:00:00Z`);
  const dayBefore = new Date(start.getTime() - 6 * 86400000);
  if (localDate >= dayBefore.toISOString().slice(0, 10)) return "week";
  return "older";
}

export function formatAge(value?: string, now = Date.now()): string {
  if (!value) return "now";
  const minutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
