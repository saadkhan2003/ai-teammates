import { Fragment, type ReactNode } from "react";
import { LinkPill } from "@/components/link-pill";
import { linkTitle, type CodingJob } from "@/lib/chat-ui";

// Render a deliberately small Markdown subset as React nodes. Raw HTML is text.
function inline(text: string, jobs: CodingJob[]): ReactNode[] {
  return text.split(/(\[[^\]]+\]\([^)\s]+\)|`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) return <LinkPill key={i} href={link[2]} label={link[1]} title={linkTitle(link[2], link[1], jobs)} />;
    if (part.startsWith("`")) return <code key={i} className="rounded-sm bg-muted px-1 font-mono text-xs">{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}
export function Markdown({ text, jobs = [] }: { text: string; jobs?: CodingJob[] }) {
  const chunks = text.split(/(```[\s\S]*?(?:```|$))/g);
  return <div className="space-y-2 break-words">{chunks.map((chunk, index) => {
    if (chunk.startsWith("```")) return <pre key={index} className="overflow-x-auto rounded-md bg-background p-3 text-xs"><code>{chunk.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}</code></pre>;
    return <div key={index}>{chunk.split("\n").map((line, i) => {
      const heading = line.match(/^#{1,6}\s+(.+)/);
      const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)/);
      if (heading) return <p key={i} className="mt-3 font-semibold">{inline(heading[1], jobs)}</p>;
      if (bullet) return <div key={i} className="flex gap-2 pl-2"><span aria-hidden>•</span><span>{inline(bullet[1], jobs)}</span></div>;
      if (line.startsWith("> ")) return <blockquote key={i} className="border-l-2 pl-3 text-muted-foreground">{inline(line.slice(2), jobs)}</blockquote>;
      return <p key={i} className="min-h-[0.75em] whitespace-pre-wrap">{inline(line, jobs)}</p>;
    })}</div>;
  })}</div>;
}
