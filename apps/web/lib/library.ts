export type LibraryEntry = { id: string; name: string; kind: "file" | "artifact"; createdAt?: string; mime?: string; path?: string };

export function groupByDay<T extends { createdAt?: string }>(items: T[], now = new Date()): Array<{ day: string; entries: T[] }> {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const date = item.createdAt ? new Date(item.createdAt) : now;
    const day = new Date(date); day.setHours(0, 0, 0, 0);
    const title = day.getTime() === today.getTime() ? "Today" : day.getTime() === yesterday.getTime() ? "Yesterday" : date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
    groups.set(title, [...(groups.get(title) ?? []), item]);
  }
  return [...groups.entries()].map(([day, entries]) => ({ day, entries }));
}

export function formatAge(value?: string, now = Date.now()) {
  if (!value) return "now";
  const minutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
