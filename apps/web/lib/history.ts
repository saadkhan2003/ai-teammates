// Chat history paging: older pages are kept client-side and merged in front of the live window.
export type HasId = { id: string };

/** Older pages first, then the live window; a message that appears in both keeps the live copy. */
export function mergeHistory<T extends HasId>(older: T[], live: T[]): T[] {
  if (!older.length) return live;
  const liveIds = new Set(live.map(m => m.id));
  const seen = new Set<string>();
  const head = older.filter(m => !liveIds.has(m.id) && !seen.has(m.id) && (seen.add(m.id), true));
  return [...head, ...live];
}

export const HISTORY_PAGE = 100;
export const MAX_JUMP_PAGES = 20;

/** Pages back until `id` is loaded. `load` returns whether more history remains. Stops at the cap. */
export async function loadUntil(id: string, isLoaded: (id: string) => boolean, load: () => Promise<boolean>, maxPages = MAX_JUMP_PAGES): Promise<boolean> {
  for (let page = 0; page < maxPages; page++) {
    if (isLoaded(id)) return true;
    const more = await load();
    if (isLoaded(id)) return true;
    if (!more) return false;
  }
  return isLoaded(id);
}

export type HighlightPhase = "on" | "fade" | "off";
export const HIGHLIGHT_HOLD_MS = 3000;
export const HIGHLIGHT_FADE_MS = 600;
export const HIGHLIGHT_REDUCED_MS = 1000;

/** Timeline for the jump highlight: held 3 s, then fades 600 ms (ease-out in CSS). Reduced motion: brief static hold, no fade. */
export function highlightPlan(reduced: boolean): { phase: HighlightPhase; after: number }[] {
  return reduced
    ? [{ phase: "on", after: 0 }, { phase: "off", after: HIGHLIGHT_REDUCED_MS }]
    : [{ phase: "on", after: 0 }, { phase: "fade", after: HIGHLIGHT_HOLD_MS }, { phase: "off", after: HIGHLIGHT_HOLD_MS + HIGHLIGHT_FADE_MS }];
}
