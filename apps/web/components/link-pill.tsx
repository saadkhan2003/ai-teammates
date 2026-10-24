"use client";

import { ArrowUpRight } from "lucide-react";
import type { MouseEvent } from "react";
import { isAppHref, isExternalHref, linkDisplayUrl, safeHref } from "@/lib/chat-ui";
import { cn } from "@/lib/utils";

function hostLetter(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "").slice(0, 1).toUpperCase() || "•";
  } catch {
    return "•";
  }
}

function hostHue(href: string): number {
  let hash = 0;
  for (const char of href) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

function LinkMark({ href, external }: { href: string; external: boolean }) {
  if (!external) return <img src="/favicon.svg" alt="" className="size-3.5 rounded-control" />;
  return (
    <span
      aria-hidden
      className="grid size-3.5 place-items-center rounded-control text-micro font-semibold text-white"
      style={{ backgroundColor: `hsl(${hostHue(href)} 55% 42%)` }}
    >
      {hostLetter(href)}
    </span>
  );
}

export function LinkPill({
  href,
  title,
  label,
  testId,
  className,
  onClick,
}: {
  href: string;
  title: string;
  label?: string;
  testId?: string;
  className?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const text = (label ?? title).trim() || title;
  const safe = safeHref(href);
  if (!safe) return <span>{text}</span>;
  const external = isExternalHref(safe);
  const app = isAppHref(safe);
  const shown = linkDisplayUrl(safe);
  const mark = <LinkMark href={safe} external={external} />;
  return (
    <span data-testid="link-pill-wrap" className="group/pill relative inline-flex max-w-full align-middle">
      <a
        href={safe}
        data-testid={testId ?? "link-pill"}
        aria-label={text}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        className={cn(
          "inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-meta font-medium text-card-foreground no-underline",
          className,
        )}
        onClick={(event) => {
          if (app && onClick) onClick(event);
        }}
      >
        <span aria-hidden className="shrink-0">{mark}</span>
        <span className="truncate">{text}</span>
      </a>
      <span className="pointer-events-none absolute bottom-full left-0 z-30 hidden w-64 pb-1 group-hover/pill:block">
        <span data-testid="link-preview" className="block overflow-hidden rounded-card border border-border bg-card p-3 text-left text-card-foreground shadow-md">
          <span className="line-clamp-2 text-body-sm">{title}</span>
          <span className="mt-2 flex items-center gap-2 text-meta text-muted-foreground">
            <span aria-hidden className="shrink-0">{mark}</span>
            <span data-testid="link-preview-url" className="min-w-0 flex-1 truncate">{shown}</span>
            <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
          </span>
        </span>
      </span>
    </span>
  );
}
