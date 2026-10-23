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

export { workingStatus, toolLabel, type StatusEvent } from "@/lib/tool-status";
