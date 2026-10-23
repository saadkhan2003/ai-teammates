export const GROUPS = [{ key: "today", label: "Today" }, { key: "week", label: "This week" }, { key: "older", label: "Older" }];

const extensionKinds = { png:"image", jpg:"image", jpeg:"image", gif:"image", webp:"image", mp4:"video", webm:"video", mp3:"audio", wav:"audio", pdf:"pdf", txt:"text", md:"markdown", csv:"sheet", xlsx:"sheet", docx:"doc", zip:"archive", html:"code", js:"code", ts:"code", py:"code", json:"code" };
export function detectKind(name, mime = "") {
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

export function sanitizeName(value) {
  const leaf = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^\.+|\.+$/g, "").slice(0, 255);
  return clean || "file";
}

export function groupForTimestamp(value, now, timeZone) {
  const localParts = (date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const localDate = localParts(new Date(value));
  const today = localParts(now);
  if (localDate === today) return "today";
  const start = new Date(`${today}T00:00:00Z`);
  const dayBefore = new Date(start.getTime() - 6 * 86400000);
  if (localDate >= dayBefore.toISOString().slice(0, 10)) return "week";
  return "older";
}

export function formatAge(value, now = Date.now()) {
  if (!value) return "now";
  const minutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
