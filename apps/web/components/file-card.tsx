"use client";

import { Download, FileText, Reply, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
export function fileTypeLabel(name: string, mime?: string) {
  if (mime) {
    const subtype = mime.split("/")[1] ?? "";
    if (subtype) return subtype.replace(/^vnd\.[^+]+\+/, "").replace(/^x-/, "").slice(0, 12).toUpperCase();
  }
  const ext = name.split(".").pop() ?? "";
  return ext && ext !== name ? ext.slice(0, 8).toUpperCase() : "FILE";
}

export function fileSizeLabel(bytes?: number) {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileCard({
  name,
  url,
  mime,
  size,
  testId = "attachment-card",
  onReply,
}: {
  name: string;
  url?: string;
  mime?: string;
  size?: number;
  testId?: string;
  onReply?: () => void;
}) {
  const meta = [fileSizeLabel(size), fileTypeLabel(name, mime)].filter(Boolean).join(" · ");
  return (
    <div data-testid={testId} className="group/file relative flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-3 py-2 text-card-foreground">
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <FileText className="size-5" strokeWidth={1.5} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm">{name}</span>
        <span className="block truncate text-meta text-muted-foreground">{meta}</span>
      </span>
      <a
        href={url || "#"}
        download={name}
        data-testid="attachment-download"
        aria-label={`Download ${name}`}
        className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Download className="size-4" strokeWidth={1.5} />
      </a>
      {onReply ? (
        <div className="absolute top-1 right-full z-30 mr-1 flex items-center gap-0.5 rounded-full border border-border bg-card p-0.5 opacity-0 shadow-sm transition-opacity group-hover/file:opacity-100 group-focus-within/file:opacity-100">
          <button type="button" data-testid="attachment-reply" aria-label="Reply" className="grid size-7 place-items-center rounded-full hover:bg-accent" onClick={onReply}>
            <Reply className="size-3.5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" data-testid="attachment-more" aria-label="More attachment actions" className="grid size-7 place-items-center rounded-full hover:bg-accent">
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={() => {
                  if (url) void navigator.clipboard?.writeText(url);
                  toast.success(`Copied the link for ${name}.`);
                }}
              >
                Copy link
              </DropdownMenuItem>
              <DropdownMenuItem asChild disabled={!url}>
                <a href={url || "#"} download={name}>
                  Download
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </div>
  );
}
