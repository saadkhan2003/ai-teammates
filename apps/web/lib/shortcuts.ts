export type ShortcutAction = "search" | "new-bot" | "go-bot" | "compact" | "settings" | "shortcuts" | "focus-chat" | "find-chat" | "dictate" | "selection" | "previous-bot" | "next-bot" | "back" | "forward" | "switch-bots" | "details" | "skills" | "connect" | "zoom-in" | "zoom-out" | "zoom-reset" | "fullscreen";

export function matchShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): ShortcutAction | null {
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  if (event.altKey && key === "arrowup") return "previous-bot";
  if (event.altKey && key === "arrowdown") return "next-bot";
  if (mod && event.altKey && key === "b") return "details";
  if (mod && event.shiftKey && key === "w") return "skills";
  if (mod && event.shiftKey && key === "m") return "connect";
  if (mod && event.shiftKey && key === "f") return "search";
  if (mod) {
    if (key === "k") return "search"; if (key === "n") return "new-bot";
    if (/^[1-9]$/.test(key)) return "go-bot"; if (key === "b") return "compact";
    if (key === ",") return "settings"; if (key === "/") return "shortcuts";
    if (key === "i") return "focus-chat"; if (key === "f") return "find-chat";
    if (key === "d") return "dictate"; if (key === "l") return "selection";
    if (key === "[") return "back"; if (key === "]") return "forward";
    if (key === "tab") return "switch-bots";
    if (key === "+" || key === "=") return "zoom-in"; if (key === "-") return "zoom-out"; if (key === "0") return "zoom-reset";
  }
  if (key === "f11") return "fullscreen";
  return null;
}
