"use client";

import { FileText, FolderOpen, MoreHorizontal, RotateCw, StickyNote } from "lucide-react";
import { useRef, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { ImageLightbox, type GalleryImage } from "@/components/image-lightbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LIBRARY_GROUPS, libraryGroup, libraryKind, libraryWhen, relativeAge, type LibraryItem } from "@/lib/library-items";
import type { Artifact, BrowserPage, FileEntry } from "@/lib/types";

const PAGE = 5;

function itemsFrom(botId: string, files: FileEntry[], artifacts: Artifact[], pages: BrowserPage[]): LibraryItem[] {
  const fileItems = files
    .filter((file) => !file.directory)
    .map((file) => {
      const kind = libraryKind(file.name);
      const href = `/api/bots/${botId}/files/raw?path=${encodeURIComponent(file.path)}`;
      return { id: `file:${file.path}`, kind, name: file.name, href, previewUrl: kind === "image" ? href : undefined, at: file.updatedAt };
    });
  const artifactItems = artifacts.map((artifact) => {
    const kind = libraryKind(artifact.name, artifact.mime);
    const href = `/api/artifacts/${artifact.id}/download`;
    return { id: `artifact:${artifact.id}`, kind, name: artifact.title || artifact.name, href, previewUrl: kind === "image" ? href : undefined, at: artifact.createdAt };
  });
  const pageItems = pages.map((page) => ({
    id: `page:${page.targetId || page.url}`,
    kind: "page" as const,
    name: page.title || page.url,
    href: page.url,
    at: undefined,
  }));
  const stamp = (item: LibraryItem) => {
    const time = Date.parse(item.at || "");
    return Number.isFinite(time) ? time : 0;
  };
  return [...fileItems, ...artifactItems, ...pageItems].sort((a, b) => stamp(b) - stamp(a) || a.name.localeCompare(b.name));
}

export function LibraryList({
  botId,
  botName,
  avatarShape,
  avatarColor,
  files,
  artifacts,
  pages,
  error,
  loaded,
  onRetry,
}: {
  botId: string;
  botName: string;
  avatarShape?: string;
  avatarColor?: string;
  files: FileEntry[];
  artifacts: Artifact[];
  pages: BrowserPage[];
  error: string | null;
  loaded: boolean;
  onRetry: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<number>(0);
  const hideTimer = useRef<number>(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [place, setPlace] = useState({ top: 0 });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [imageReady, setImageReady] = useState<string>("");
  const [viewer, setViewer] = useState<{ images: GalleryImage[]; index: number } | null>(null);
  const items = itemsFrom(botId, files, artifacts, pages);
  const active = items.find((item) => item.id === openId) ?? null;

  function placeCard(row: HTMLElement) {
    const root = rootRef.current;
    if (!root) return;
    const pane = root.closest("[data-testid='info-pane']")?.getBoundingClientRect();
    const host = root.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    const cardHeight = 280;
    let top = rect.bottom - host.top + 6;
    const limit = pane ? pane.bottom - host.top : host.height;
    if (rect.bottom + cardHeight > (pane?.bottom ?? host.bottom)) top = Math.max(4, rect.top - host.top - cardHeight - 6);
    if (top + cardHeight > limit) top = Math.max(4, limit - cardHeight);
    setPlace({ top });
  }

  function show(item: LibraryItem, row: HTMLElement, immediate: boolean) {
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(showTimer.current);
    const reveal = () => {
      placeCard(row);
      setOpenId(item.id);
    };
    if (immediate || openId) reveal();
    else showTimer.current = window.setTimeout(reveal, 300);
  }

  function hide() {
    window.clearTimeout(showTimer.current);
    hideTimer.current = window.setTimeout(() => setOpenId(null), 120);
  }

  const groups = LIBRARY_GROUPS.map((label) => ({ label, items: items.filter((item) => libraryGroup(item.at) === label) })).filter((group) => group.items.length > 0);

  return (
    <div ref={rootRef} data-testid="file-list" className="relative flex flex-col gap-4">
      <div data-testid="artifact-list" className="flex flex-col gap-4">
        {!loaded ? <div className="panel-card media-shimmer h-24" /> : null}
        {loaded && error ? (
          <div data-testid="library-error" className="panel-card flex items-center justify-between gap-3 px-3 py-3">
            <p className="type-body text-card-foreground">Couldn&apos;t load your pages</p>
            <button type="button" aria-label="Retry" className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent" onClick={onRetry}>
              <RotateCw className="size-4" strokeWidth={1.5} />
            </button>
          </div>
        ) : null}
        {loaded && !error && items.length === 0 ? (
          <div data-testid="library-empty" className="panel-card flex items-start gap-3 px-3 py-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-control bg-muted text-muted-foreground">
              <FolderOpen className="size-4" strokeWidth={1.5} aria-hidden />
            </span>
            <span>
              <span className="type-body block">Nothing in the library</span>
              <span className="type-caption mt-0.5 block">Files, images, and pages from this teammate show up here.</span>
            </span>
          </div>
        ) : null}
        {groups.map((group) => {
          const shown = expanded[group.label] ? group.items : group.items.slice(0, PAGE);
          return (
            <section key={group.label} className="flex flex-col gap-1">
              <h3 className="type-caption px-1.5">{group.label}</h3>
              <ul className="flex flex-col">
                {shown.map((item) => (
                  <li key={item.id} className="group relative" data-kind={item.kind}>
                    <a
                      href={item.href || "#"}
                      data-testid="library-row"
                      target={item.kind === "page" ? "_blank" : undefined}
                      rel={item.kind === "page" ? "noopener noreferrer" : undefined}
                      className="flex h-9 items-center gap-2 rounded-md px-1.5 pr-8 text-card-foreground transition-colors duration-150 hover:bg-accent focus-visible:bg-accent"
                      onClick={(event) => {
                        if (item.kind !== "image" || !item.previewUrl) return;
                        event.preventDefault();
                        const images = items.filter((entry) => entry.kind === "image" && entry.previewUrl).map((entry) => ({ src: entry.previewUrl || "", alt: entry.name }));
                        setViewer({ images, index: Math.max(0, images.findIndex((entry) => entry.src === item.previewUrl)) });
                      }}
                      onMouseEnter={(event) => show(item, event.currentTarget, false)}
                      onMouseLeave={hide}
                      onFocus={(event) => show(item, event.currentTarget, true)}
                      onBlur={hide}
                    >
                      <Thumb item={item} />
                      <span className="min-w-0 flex-1 truncate text-ui">{item.name}</span>
                      <span data-testid="library-age" className="type-caption tabular shrink-0">{relativeAge(item.at)}</span>
                    </a>
                    {item.href && item.kind !== "page" ? <a className="sr-only" href={item.href}>Download</a> : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button type="button" aria-label={`More actions for ${item.name}`} className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground opacity-0 hover:bg-background focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100">
                          <MoreHorizontal className="size-4" strokeWidth={1.5} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {item.href ? <DropdownMenuItem asChild><a href={item.href}>Open</a></DropdownMenuItem> : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                ))}
              </ul>
              {group.items.length > PAGE && !expanded[group.label] ? (
                <button type="button" data-testid="library-show-more" className="type-caption mx-auto block px-2 py-1 hover:text-foreground" onClick={() => setExpanded((current) => ({ ...current, [group.label]: true }))}>
                  Show more
                </button>
              ) : null}
            </section>
          );
        })}
      </div>
      {active ? (
        <div
          data-testid="library-preview"
          data-kind={active.kind}
          data-open="true"
          className="library-preview pointer-events-none absolute inset-x-2 z-20 border border-border bg-card p-2 text-card-foreground shadow-[var(--shadow-card)]"
          style={{ top: place.top }}
        >
          {active.kind === "image" && active.previewUrl ? (
            <span className="relative mb-2 block h-40 overflow-hidden rounded-control bg-muted">
              {imageReady !== active.previewUrl ? <span data-testid="library-preview-skeleton" className="media-shimmer absolute inset-0" /> : null}
              <img
                data-testid="library-preview-image"
                src={active.previewUrl}
                alt=""
                className="h-full w-full object-cover"
                onLoad={() => setImageReady(active.previewUrl || "")}
              />
            </span>
          ) : null}
          <p className="type-caption px-1">{active.kind === "image" ? "Image" : active.kind === "page" ? "Page" : "File"}</p>
          <p className="type-body truncate px-1">{active.name}</p>
          <p data-testid="library-preview-meta" className="mt-1 flex items-center gap-1.5 px-1">
            <BotAvatar botId={botId} shape={avatarShape} color={avatarColor} size={16} />
            <span className="type-caption truncate">{[botName, libraryWhen(active.at)].filter(Boolean).join(" · ")}</span>
          </p>
        </div>
      ) : null}
      {viewer ? <ImageLightbox images={viewer.images} index={viewer.index} onIndex={(index) => setViewer({ ...viewer, index })} onClose={() => setViewer(null)} /> : null}
    </div>
  );
}

function Thumb({ item }: { item: LibraryItem }) {
  if (item.kind === "image" && item.previewUrl) {
    return <img src={item.previewUrl} alt="" className="size-5 shrink-0 rounded-chip object-cover" />;
  }
  const Icon = item.kind === "page" ? StickyNote : FileText;
  return (
    <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
      <Icon className="size-4" strokeWidth={1.5} aria-hidden />
    </span>
  );
}
