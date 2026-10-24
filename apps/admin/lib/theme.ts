export type ThemeMode = "light" | "dark" | "system";

const key = "teammates-admin-theme";

export function parseTheme(value: unknown): ThemeMode | null {
  return value === "light" || value === "dark" || value === "system" ? value : null;
}

export function readTheme(): ThemeMode {
  if (typeof window === "undefined") return "system";
  return parseTheme(window.localStorage.getItem(key)) ?? "system";
}

export function systemIsDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function themeIsLight(mode: ThemeMode = readTheme()) {
  return mode === "light" || (mode === "system" && !systemIsDark());
}

export function applyTheme(mode: ThemeMode) {
  const light = themeIsLight(mode);
  document.documentElement.classList.toggle("light", light);
  document.documentElement.dataset.theme = mode;
  window.localStorage.setItem(key, mode);
}

export function watchSystemTheme(onChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = () => onChange();
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
