export type LibraryKind = "image" | "file" | "page";

export type LibraryItem = {
  id: string;
  kind: LibraryKind;
  name: string;
  href?: string;
  previewUrl?: string;
  at?: string;
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

export function libraryKind(name: string, mime?: string): LibraryKind {
  if (mime?.startsWith("image/") || IMAGE_EXT.test(name)) return "image";
  return "file";
}

export function libraryGroup(at: string | undefined, now = Date.now()): "Today" | "This week" | "Older" {
  const time = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time)) return "Older";
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (time >= start.getTime()) return "Today";
  if (time >= start.getTime() - 6 * 24 * 60 * 60 * 1000) return "This week";
  return "Older";
}

export function relativeAge(at: string | undefined, now = Date.now()): string {
  const time = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(1, Math.round((now - time) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor((now - time) / 3600000);
  if (hours < 24) return `${Math.max(1, hours)}h`;
  return `${Math.max(1, Math.floor((now - time) / 86400000))}d`;
}

export function libraryWhen(at: string | undefined, now = Date.now()): string {
  const time = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const clock = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (libraryGroup(at, now) === "Today") return `Today ${clock}`;
  const day = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `${day} ${clock}`;
}

export const LIBRARY_GROUPS = ["Today", "This week", "Older"] as const;
