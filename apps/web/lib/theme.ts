import { api } from "@/lib/api";

export type ThemeMode = "light" | "dark" | "system";

const ACCENTS: Record<string, { light: string; dark: string }> = {
  blue: { dark: "#8eb6ff", light: "#3b6fd8" },
  sage: { dark: "#8fd0a8", light: "#1f7a45" },
  sand: { dark: "#e6c27a", light: "#8a5a12" },
  clay: { dark: "#f0a8a0", light: "#9f2d2d" },
};

let userRevision = 0;

export function parseTheme(value: unknown): ThemeMode | null {
  return value === "light" || value === "dark" || value === "system" ? value : null;
}

export function readTheme(): ThemeMode {
  if (typeof window === "undefined") return "system";
  return parseTheme(window.localStorage.getItem("teammates-theme")) ?? "system";
}

export function themeUserRevision() {
  return userRevision;
}

export function systemIsDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function themeIsLight(mode: ThemeMode = readTheme()) {
  return mode === "light" || (mode === "system" && !systemIsDark());
}

export function applyAccent(id?: string | null, mode: ThemeMode = readTheme()) {
  const chosen = id || window.localStorage.getItem("teammates-accent-id") || "blue";
  const swatch = ACCENTS[chosen] ?? ACCENTS.blue;
  const color = themeIsLight(mode) ? swatch.light : swatch.dark;
  document.documentElement.style.setProperty("--brand", color);
  window.localStorage.setItem("teammates-accent", color);
  window.localStorage.setItem("teammates-accent-id", chosen in ACCENTS ? chosen : "blue");
}

export function applyTheme(mode: ThemeMode, source: "user" | "sync" = "sync") {
  if (source === "user") userRevision += 1;
  const light = themeIsLight(mode);
  document.documentElement.classList.toggle("light", light);
  document.documentElement.dataset.theme = mode;
  window.localStorage.setItem("teammates-theme", mode);
  const color = light ? "#fafafa" : "#141414";
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute("content", color));
  applyAccent(null, mode);
}

export async function saveTheme(mode: ThemeMode) {
  applyTheme(mode, "user");
  await api("/api/settings/appearance", {
    method: "PUT",
    body: JSON.stringify({ theme: mode }),
  });
}

export function watchSystemTheme(onChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = () => onChange();
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
