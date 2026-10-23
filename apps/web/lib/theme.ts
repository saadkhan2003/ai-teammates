export type ThemeMode = "light" | "dark" | "system";

export function readTheme(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem("teammates-theme");
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "dark";
}

export function applyTheme(mode: ThemeMode) {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const light = mode === "light" || (mode === "system" && !systemDark);
  document.documentElement.classList.toggle("light", light);
  document.documentElement.dataset.theme = mode;
  window.localStorage.setItem("teammates-theme", mode);
  const color = light ? "#fafafa" : "#141414";
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute("content", color));
}
