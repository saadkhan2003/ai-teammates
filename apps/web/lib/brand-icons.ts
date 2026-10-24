import type { BrandIcon } from "./brand-icon-data";

export type { BrandIcon };

const ALIASES: Record<string, string> = {
  "1password": "1password",
  onepassword: "1password",
  drive: "googledrive",
  "google drive": "googledrive",
  calendar: "googlecalendar",
  "google calendar": "googlecalendar",
  sheets: "googlesheets",
  "google sheets": "googlesheets",
  docs: "googledocs",
  "google docs": "googledocs",
  meet: "googlemeet",
  "google meet": "googlemeet",
  vscode: "visualstudiocode",
  "vs code": "visualstudiocode",
  "visual studio code": "visualstudiocode",
};

let icons: Record<string, BrandIcon> | null = null;
const cache = new Map<string, BrandIcon | null>();

function slug(name: string): string {
  const lower = name.trim().toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  const compact = lower.replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
  return ALIASES[compact] ?? compact;
}

export async function loadBrandIcon(name: string): Promise<BrandIcon | null> {
  const key = slug(name);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key) ?? null;
  if (!icons) icons = (await import("./brand-icon-data")).BRAND_ICONS;
  const icon = icons[key] ?? null;
  cache.set(key, icon);
  return icon;
}
