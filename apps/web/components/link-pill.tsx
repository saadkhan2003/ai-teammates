"use client";

import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { isExternalHref, truncateUrl } from "@/lib/chat-ui";

export function LinkPill({ href, label, title }: { href: string; label: string; title: string }) {
  const external = isExternalHref(href);
  const host = (() => {
    try {
      return new URL(href).host;
    } catch {
      return "";
    }
  })();
  const fallback = "/favicon.svg";
  const [icon, setIcon] = useState(external && host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32` : fallback);
  return (
    <span data-testid="link-pill-wrap" className="group/link relative inline-flex max-w-full align-middle">
      <a
        data-testid="link-pill"
        href={href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium text-card-foreground no-underline"
      >
        <img src={icon} alt="" className="size-3.5 shrink-0 rounded-sm" onError={() => setIcon(fallback)} />
        <span className="truncate">{label}</span>
      </a>
      <span
        data-testid="link-preview"
        className="invisible absolute bottom-full left-0 z-30 mb-1.5 w-56 rounded-xl border border-border bg-popover p-2.5 text-popover-foreground opacity-0 shadow-md group-hover/link:visible group-hover/link:opacity-100"
      >
        <span className="line-clamp-2 block text-sm font-semibold leading-snug">{title}</span>
        <span className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <img src={icon} alt="" className="size-3.5 shrink-0 rounded-sm" />
          <span className="min-w-0 flex-1 truncate">{truncateUrl(href)}</span>
          <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
        </span>
      </span>
    </span>
  );
}
