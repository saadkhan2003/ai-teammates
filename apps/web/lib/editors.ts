/** Editors the user can open a coding task in. Deep links work on the user's own machine. */
export type EditorId = "cursor" | "vscode" | "zed";

export const EDITORS: { id: EditorId; label: string }[] = [
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "zed", label: "Zed" },
];

const KEY = "teammates-editors";

type Store = Pick<Storage, "getItem" | "setItem">;

/** Every editor is on until the user turns it off in Settings. */
export function readEnabledEditors(store?: Store | null): EditorId[] {
  try {
    const raw = (store ?? (typeof window === "undefined" ? null : window.localStorage))?.getItem(KEY);
    if (!raw) return EDITORS.map((e) => e.id);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return EDITORS.map((e) => e.id);
    return EDITORS.filter((e) => parsed.includes(e.id)).map((e) => e.id);
  } catch {
    return EDITORS.map((e) => e.id);
  }
}

export function writeEnabledEditors(ids: EditorId[], store?: Store | null) {
  try {
    (store ?? window.localStorage).setItem(KEY, JSON.stringify(ids));
    if (typeof window !== "undefined") window.dispatchEvent(new Event("teammates-editors"));
  } catch {
    // Storage may be unavailable; the default (all editors) applies.
  }
}

/** A deep link that clones the repository on the user's machine and opens it in the chosen editor. */
export function editorLink(editor: EditorId, repoUrl: string): string | null {
  if (!/^https?:\/\/|^git@/.test(repoUrl)) return null;
  const url = encodeURIComponent(repoUrl);
  if (editor === "cursor") return `cursor://vscode.git/clone?url=${url}`;
  if (editor === "vscode") return `vscode://vscode.git/clone?url=${url}`;
  return `zed://git/clone?repo=${url}`;
}
