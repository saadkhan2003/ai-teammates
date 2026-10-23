import type { CSSProperties } from "react";

/** Status text with a left-to-right shimmer: a bright band sweeps across dimmer words (about 2 s a loop). */
export function ShimmerText({ text, className = "" }: { text: string; className?: string }) {
  const words = text.split(/(\s+)/);
  const count = Math.max(1, words.filter(w => w.trim()).length);
  let index = 0;
  return <span data-testid="working-status" className={`shimmer-text ${className}`} aria-label={text}>
    {words.map((word, i) => {
      if (!word.trim()) return word;
      const style = { "--i": index++, "--n": count } as CSSProperties;
      return <span key={i} aria-hidden className="shimmer-word" style={style}>{word}</span>;
    })}
  </span>;
}

export type StatusEvent = { type: string; tool?: unknown; name?: unknown; text?: unknown; title?: unknown; status?: unknown; label?: unknown };

/** What the working row says: "Typing…" while a reply streams, else the live step, else the task title. */
export function workingStatus(events: StatusEvent[], typing: boolean, taskTitle?: string): string {
  if (typing) return "Typing…";
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "status" || e.type === "step") {
      const text = String(e.text ?? e.title ?? e.label ?? "").trim();
      if (text) return text.slice(0, 80);
    }
    if (e.type === "tool" || e.type === "tool_call") {
      const tool = String(e.tool ?? e.name ?? "").replace(/[_.-]+/g, " ").trim();
      if (tool) return `Using ${tool}`;
    }
  }
  const title = (taskTitle ?? "").trim();
  return title ? title.slice(0, 80) : "Working…";
}
