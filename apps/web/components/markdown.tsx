"use client";

import { Fragment, type ReactNode } from "react";
import { openAppLink, pillFor, placeLabel } from "../lib/app-links";

function AppPillButton({ label, href }: { label: string; href: string }) {
  const pill = pillFor(label, href);
  if (!pill.pill) return <>{pill.text}</>;
  return (
    <button
      type="button"
      data-testid="app-link-pill"
      data-kind={pill.kind}
      data-target={pill.id}
      className="mx-0.5 inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium text-brand"
      onClick={() => openAppLink(pill.href)}
    >
      {pill.label}
    </button>
  );
}

// Render a deliberately small Markdown subset as React nodes. Raw HTML is text.
function inline(text: string): ReactNode[] {
  return text.split(/(\[[^\]]+\]\(app:\/\/[^\s)]+\)|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|app:\/\/(?:settings|panel)\?[^\s)]+|`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    const app = part.match(/^\[([^\]]+)\]\((app:\/\/[^\s)]+)\)$/);
    if (app) return <AppPillButton key={i} label={app[1]} href={app[2]} />;
    const bare = part.match(/^(app:\/\/(?:settings|panel)\?[^\s)]+)$/);
    if (bare) return <AppPillButton key={i} label={placeLabel(bare[1])} href={bare[1]} />;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 break-all">{link[1]}</a>;
    if (part.startsWith("`")) return <code key={i} className="rounded-sm bg-muted px-1 font-mono text-xs">{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}
export function Markdown({ text }: { text: string }) {
  const chunks = text.split(/(```[\s\S]*?(?:```|$))/g);
  return <div className="space-y-2 break-words">{chunks.map((chunk, index) => {
    if (chunk.startsWith("```")) return <pre key={index} className="overflow-x-auto rounded-md bg-background p-3 text-xs"><code>{chunk.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}</code></pre>;
    return <div key={index}>{chunk.split("\n").map((line, i) => {
      const heading = line.match(/^#{1,6}\s+(.+)/);
      const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)/);
      if (heading) return <p key={i} className="mt-3 font-semibold">{inline(heading[1])}</p>;
      if (bullet) return <div key={i} className="flex gap-2 pl-2"><span aria-hidden>•</span><span>{inline(bullet[1])}</span></div>;
      if (line.startsWith("> ")) return <blockquote key={i} className="border-l-2 pl-3 text-muted-foreground">{inline(line.slice(2))}</blockquote>;
      return <p key={i} className="min-h-[0.75em] whitespace-pre-wrap">{inline(line)}</p>;
    })}</div>;
  })}</div>;
}
