import guide from "./app-guide.json" with { type: "json" };

export type SettingsPlace = {
  id: string;
  href: string;
  label: string;
  description: string;
};

export type PanelPlace = {
  id: string;
  tab: string;
  label: string;
  description: string;
  alias?: boolean;
};

export type AppLink =
  | { kind: "settings"; id: string; href: string }
  | { kind: "panel"; id: string; tab: string };

export const settingsPlaces = guide.settings as SettingsPlace[];
export const panelPlaces = guide.panels as PanelPlace[];

const APP_HREF = /^app:\/\/(settings|panel)\?([a-z]+)=([a-z0-9_-]+)$/i;

export function resolveAppHref(raw: string): AppLink | null {
  const match = raw.trim().match(APP_HREF);
  if (!match) return null;
  const host = match[1].toLowerCase();
  const key = match[2].toLowerCase();
  const value = match[3].toLowerCase();
  if (host === "settings" && key === "id") {
    const place = settingsPlaces.find((item) => item.id === value);
    if (!place) return null;
    return { kind: "settings", id: place.id, href: place.href };
  }
  if (host === "panel" && key === "tab") {
    const place = panelPlaces.find((item) => item.id === value);
    if (!place) return null;
    return { kind: "panel", id: place.id, tab: place.tab };
  }
  return null;
}

export function placeLabel(href: string): string {
  const resolved = resolveAppHref(href);
  if (!resolved) return href;
  if (resolved.kind === "settings") return settingsPlaces.find((item) => item.id === resolved.id)?.label ?? resolved.id;
  return panelPlaces.find((item) => item.id === resolved.id)?.label ?? resolved.id;
}

export type AppPill =
  | { pill: true; label: string; href: string; kind: AppLink["kind"]; id: string }
  | { pill: false; text: string };

export function pillFor(label: string, href: string): AppPill {
  const resolved = resolveAppHref(href);
  if (!resolved) return { pill: false, text: label };
  return { pill: true, label, href, kind: resolved.kind, id: resolved.id };
}

export function openAppLink(href: string) {
  const resolved = resolveAppHref(href);
  if (!resolved || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("teammates-app-link", { detail: resolved }));
}
