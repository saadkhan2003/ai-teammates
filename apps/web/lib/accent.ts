// Per-bot accent colour. The accent a user picks for a bot drives every accent place in the UI through
// CSS variables set on <html>. Foregrounds are computed so text stays readable (WCAG AA) on any swatch.

export type AccentVars = Record<string, string>;

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [255, 48, 69];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function mixHex(a: string, b: string, k: number): string {
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k]);
}

/** White or near-black text, whichever reads better on the accent (always >= 4.5:1 for every picker swatch). */
export function accentForeground(accent: string): string {
  return contrast(accent, "#ffffff") >= contrast(accent, "#111111") ? "#ffffff" : "#111111";
}

/** The accent used as a fill behind text: nudged darker or lighter until its best foreground reaches 4.5:1. */
export function accentFill(accent: string): string {
  const best = (c: string) => Math.max(contrast(c, "#ffffff"), contrast(c, "#111111"));
  if (best(accent) >= 4.5) return accent;
  const towardBlack = contrast(accent, "#ffffff") >= contrast(accent, "#111111");
  const target = towardBlack ? "#000000" : "#ffffff";
  for (let k = 0.04; k <= 1.0001; k += 0.04) {
    const candidate = mixHex(accent, target, k);
    if (best(candidate) >= 4.5) return candidate;
  }
  return target;
}

/** The accent adjusted so it can be used as text or an icon on the page background at >= minRatio. */
export function accentOn(accent: string, background: string, minRatio = 4.5): string {
  if (contrast(accent, background) >= minRatio) return accent;
  const toward = luminance(background) < 0.5 ? "#ffffff" : "#000000";
  for (let k = 0.1; k <= 1.0001; k += 0.1) {
    const candidate = mixHex(accent, toward, k);
    if (contrast(candidate, background) >= minRatio) return candidate;
  }
  return toward;
}

const BG = { dark: "#141414", light: "#fafafa" } as const;

export function accentVars(accent: string, mode: "dark" | "light"): AccentVars {
  const bg = BG[mode];
  const fill = accentFill(accent);
  const fg = accentForeground(fill);
  const text = accentOn(accent, bg, 4.5);
  const ring = accentOn(accent, bg, 3);
  const [r, g, b] = hexToRgb(accent);
  return {
    "--bot-accent": fill,
    "--bot-accent-fg": fg,
    "--bot-accent-text": text,
    "--bot-accent-ring": ring,
    "--bot-accent-soft": `rgba(${r}, ${g}, ${b}, ${mode === "dark" ? 0.18 : 0.14})`,
    "--bot-accent-border": mixHex(fill, mode === "dark" ? "#ffffff" : "#000000", 0.28),
    // The generic tokens that carry accent in the Grok-style layout follow the bot colour too.
    "--user-bubble": fill,
    "--user-bubble-foreground": fg,
    "--primary": fill,
    "--primary-foreground": fg,
    "--ring": ring,
    "--sidebar-ring": ring,
    "--brand": text,
  };
}

export function applyAccent(accent: string | null | undefined, mode: "dark" | "light") {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const valid = /^#[0-9a-fA-F]{6}$/.test(accent ?? "");
  const names = Object.keys(accentVars("#ff3045", mode));
  if (!valid) { for (const name of names) root.style.removeProperty(name); delete root.dataset.accent; return; }
  const vars = accentVars(accent!, mode);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.dataset.accent = accent!.toLowerCase();
}
