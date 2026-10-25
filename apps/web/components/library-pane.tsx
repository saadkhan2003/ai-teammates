"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Copy, Download, FileArchive, FileCode, FileQuestion, FileText, FileType, Film, Image as ImageIcon, Link as LinkIcon, Loader2, MoreHorizontal, Table, LayoutPanelTop, Search, Star, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { api, apiFetch } from "@/lib/api";
import { formatAge, LIBRARY_FILTERS, libraryTypeParam, nextLibraryRowIndex, type LibraryFilter, type LibraryGroup, type LibraryItem, type LibraryResponse } from "@/lib/library";
import { PagesLibrary } from "@/components/page-canvas";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BotAvatar } from "@/components/bot-avatar";
import { Markdown } from "@/components/markdown";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { KeyboardEvent } from "react";

const initial: LibraryResponse = { pinned: [], groups: [
  { key: "today", label: "Today", total: 0, items: [], nextCursor: null },
  { key: "week", label: "This week", total: 0, items: [], nextCursor: null },
  { key: "older", label: "Older", total: 0, items: [], nextCursor: null },
] };

const icons = {
  image: ImageIcon, video: Film, audio: AudioLines, pdf: FileText, text: FileText, markdown: FileText, code: FileCode,
  doc: FileType, sheet: Table, archive: FileArchive, page: LayoutPanelTop, link: LinkIcon, screenshots: ImageIcon,
  unknown: FileQuestion,
} as const;

function LibrarySkeleton() {
  return <div data-testid="library-loading" role="status" aria-busy="true" className="space-y-4 py-2">
    <span className="sr-only">Loading library</span>
    {[0, 1, 2].map(card => <div key={card} aria-hidden="true" className="space-y-2">
      <Skeleton className="h-3 w-16" />
      <div className="space-y-3 rounded-xl border border-border bg-card p-3">
        {[0, 1, 2].map(row => <div key={row} className="flex h-8 items-center gap-2"><Skeleton className="h-8 w-8 rounded-md" /><Skeleton className={`h-3 ${row === 1 ? "w-3/5" : "w-4/5"}`} /></div>)}
      </div>
    </div>)}
  </div>;
}

export function LibraryPane({ botId, botName, botShape, botColor, activeType, onTypeChange: setActiveType }: { botId: string; botName: string; botShape?: string; botColor?: string; activeType: LibraryFilter; onTypeChange: (type: LibraryFilter) => void }) {
  const [data, setData] = useState<LibraryResponse>(initial);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [moreErrors, setMoreErrors] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<LibraryItem | null>(null);
  const [hover, setHover] = useState<LibraryItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LibraryItem | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [direction, setDirection] = useState<"all" | "in" | "out">("all");
  const [searchItems, setSearchItems] = useState<LibraryItem[] | null>(null);
  const [shareInfo, setShareInfo] = useState<Record<string, { id: string; url?: string }[]>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (keepData = true) => {
    try {
      const params = new URLSearchParams({ limit: "5", type: libraryTypeParam(activeType) });
      if (direction !== "all") params.set("direction", direction);
      const response = await api<LibraryResponse>(`/api/bots/${botId}/library?${params}`);
      setData(response);
      setError(false);
      setLoaded(true);
    } catch {
      setError(true);
      if (!keepData) setLoaded(true);
    }
  }, [botId, activeType, direction]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!debouncedQuery) { setSearchItems(null); return; }
    let active = true;
    const params = new URLSearchParams({ q: debouncedQuery, type: libraryTypeParam(activeType) });
    if (direction !== "all") params.set("direction", direction);
    void api<{ items: LibraryItem[] }>(`/api/bots/${botId}/library?${params}`).then(result => { if (active) { setSearchItems(result.items); setLoaded(true); setError(false); } }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [botId, debouncedQuery, activeType, direction]);

  useEffect(() => { void load(false); }, [load]);
  useEffect(() => {
    if (!preview) { setContent(null); setContentError(false); setZoom(1); return; }
    const item = preview;
    if (!(["text", "markdown", "code", "sheet"].includes(item.kind)) || item.sizeBytes > 2_000_000) return;
    let active = true;
    void (async () => {
      try {
        const response = await apiFetch(`/api/bots/${botId}/library/${item.id}/content?inline=1`);
        if (!response.ok) throw new Error("content unavailable");
        const text = await response.text();
        if (text.length > 2_000_000) throw new Error("content too large");
        if (active) setContent(text);
      } catch { if (active) setContentError(true); }
    })();
    return () => { active = false; };
  }, [botId, preview]);
  useEffect(() => {
    let timer = 0;
    const scheduleMidnight = () => {
      const now = new Date();
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 25);
      timer = window.setTimeout(() => { void load(); scheduleMidnight(); }, Math.max(1000, midnight.getTime() - now.getTime()));
    };
    const refresh = () => { void load(); };
    scheduleMidnight();
    window.addEventListener("focus", refresh);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", refresh); };
  }, [load]);

  async function showMore(group: LibraryGroup) {
    if (!group.nextCursor || loadingMore) return;
    setLoadingMore(group.key);
    setMoreErrors(current => ({ ...current, [group.key]: false }));
    try {
      const page = await api<LibraryResponse>(`/api/bots/${botId}/library?group=${group.key}&limit=5&cursor=${encodeURIComponent(group.nextCursor)}`);
      const next = page.groups.find(item => item.key === group.key);
      if (next) setData(current => ({ ...current, groups: current.groups.map(item => item.key === group.key ? { ...item, items: [...item.items, ...next.items], nextCursor: next.nextCursor, total: next.total } : item) }));
    } catch { setMoreErrors(current => ({ ...current, [group.key]: true })); }
    finally { setLoadingMore(null); }
  }

  if (!loaded) return <LibrarySkeleton />;
  const populated = data.pinned.length > 0 || data.groups.some(group => group.items.length > 0);
  if (activeType === "Pages") return <div className="space-y-4"><Button variant="ghost" size="sm" onClick={() => setActiveType("All")}>← All library items</Button><PagesLibrary botId={botId} /></div>;
  if (!populated && !error) return <div className="py-8 text-center">
    <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-lg border border-border bg-card text-muted-foreground"><FileText className="h-5 w-5" /></div>
    <p className="text-sm font-medium">Nothing here yet</p>
    <p className="mx-auto mt-1 max-w-64 text-xs text-muted-foreground">Files you send and files your teammate shares will show up here.</p>
    <Button variant="outline" size="sm" className="mt-4" onClick={() => setActiveType("Pages")}>Pages</Button>
  </div>;

  const visibleGroups = data.groups.filter(group => group.items.length > 0);
  const allItems = [...data.pinned, ...data.groups.flatMap(group => group.items)];
  const PreviewIcon = preview ? icons[preview.kind] ?? FileQuestion : FileText;
  const movePreview = (offset: number) => {
    if (!preview) return;
    const index = allItems.findIndex(item => item.id === preview.id);
    setPreview(allItems[(index + offset + allItems.length) % allItems.length] ?? preview);
  };
  const itemUrl = (item: LibraryItem, inline = false) => `/api/bots/${botId}/library/${item.id}/content${inline ? "?inline=1" : item.dlpState === "redacted" ? "?confirm=1" : ""}`;
  const togglePin = async (item: LibraryItem) => {
    try { await api(`/api/bots/${botId}/library/${item.id}/pin`, { method: item.pinned ? "DELETE" : "POST" }); await load(); toast.success(item.pinned ? "Removed from Pinned." : "Pinned to Library."); }
    catch { toast.error("Could not update pin."); }
  };
  const deleteItem = async () => {
    if (!deleteTarget) return;
    try { await api(`/api/bots/${botId}/library/${deleteTarget.id}`, { method: "DELETE" }); setPreview(current => current?.id === deleteTarget.id ? null : current); setDeleteTarget(null); await load(); toast.success("Removed from Library."); }
    catch { toast.error("Could not delete this item."); }
  };
  const loadShares = async (item: LibraryItem) => {
    try {
      const result = await api<{ shares: { id: string; expiresAt: string; revokedAt: string | null }[] }>(`/api/bots/${botId}/library/${item.id}/share`);
      setShareInfo(current => ({ ...current, [item.id]: result.shares.filter(share => !share.revokedAt && new Date(share.expiresAt) > new Date()).map(share => ({ id: share.id, url: current[item.id]?.find(existing => existing.id === share.id)?.url })) }));
    } catch { /* menu remains usable for creating a new link */ }
  };
  const createShare = async (item: LibraryItem) => {
    try {
      const result = await api<{ url: string }>(`/api/bots/${botId}/library/${item.id}/share`, { method: "POST", body: JSON.stringify({ expiresInDays: 7 }) });
      const listed = await api<{ shares: { id: string; expiresAt: string; revokedAt: string | null }[] }>(`/api/bots/${botId}/library/${item.id}/share`);
      const latest = listed.shares.find(share => !share.revokedAt);
      setShareInfo(current => {
        if (!latest) return current;
        const shares = current[item.id] ?? [];
        const next = shares.some(share => share.id === latest.id)
          ? shares.map(share => share.id === latest.id ? { ...share, url: result.url } : share)
          : [...shares, { id: latest.id, url: result.url }];
        return { ...current, [item.id]: next };
      });
      await navigator.clipboard.writeText(result.url);
      toast.success("Share link copied.");
    } catch { toast.error("Could not create a share link."); }
  };
  const revokeShare = async (item: LibraryItem, shareId: string) => {
    try {
      await api(`/api/bots/${botId}/library/${item.id}/share/${shareId}`, { method: "DELETE" });
      setShareInfo(current => ({ ...current, [item.id]: (current[item.id] ?? []).filter(share => share.id !== shareId) }));
      toast.success("Share link revoked.");
    } catch { toast.error("Could not revoke the share link."); }
  };
  const renderRow = (item: LibraryItem) => {
    const Icon = icons[item.kind] ?? FileQuestion;
    const href = itemUrl(item);
    const image = item.kind === "image" || item.kind === "screenshots";
    return <li key={item.id} data-library-item={item.id} className="group relative flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--bot-accent-soft)] focus-within:bg-[var(--bot-accent-soft)] motion-reduce:transition-none" onMouseEnter={() => setHover(item)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(item)} onBlur={() => setHover(null)}>
      <span data-testid={item.kind === "unknown" ? "library-unknown-icon" : undefined} data-kind={item.kind} className={`relative grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background ${item.kind === "unknown" ? "text-muted-foreground" : "text-foreground"}`}>
        {image && item.thumbUrl ? (
          <>
            <Icon aria-hidden="true" className="absolute h-4 w-4 text-muted-foreground" />
            {/* impeccable-disable-next-line: item.thumbUrl is checked by the parent JSX condition; detector misses that guard */}
            <img className="relative h-full w-full object-cover opacity-0 transition-opacity duration-300 motion-reduce:transition-none" onLoad={event => event.currentTarget.classList.replace("opacity-0", "opacity-100")} src={item.thumbUrl} alt="" loading="lazy" />
          </>
        ) : <Icon aria-hidden="true" className={`h-4 w-4 ${item.kind === "unknown" ? "text-muted-foreground" : "text-muted-foreground"}`} />}
        {item.kind === "pdf" && <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1 bg-destructive" />}
      </span>
      <button type="button" className="min-w-0 flex-1 truncate text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-[var(--bot-accent-ring)]" title={item.name} onClick={() => setPreview(item)}>{item.name}</button>
      <a href={href} download={item.name} aria-label={`Download ${item.name}`} className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"><Download className="h-4 w-4" /></a>
      <DropdownMenu onOpenChange={open => { if (open) void loadShares(item); }}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Actions for ${item.name}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => setPreview(item)}>Open</DropdownMenuItem><DropdownMenuItem asChild><a href={href} download={item.name}><Download />Download</a></DropdownMenuItem><DropdownMenuItem onSelect={() => void togglePin(item)}><Star />{item.pinned ? "Unpin" : "Pin"}</DropdownMenuItem><DropdownMenuItem onSelect={() => void createShare(item)}><Copy />Share</DropdownMenuItem>{(shareInfo[item.id] ?? []).filter(share => share.url).map(share => <DropdownMenuItem key={share.id} onSelect={() => { void navigator.clipboard.writeText(share.url!); toast.success("Share link copied."); }}><Copy />Copy link</DropdownMenuItem>)}{(shareInfo[item.id] ?? []).map(share => <DropdownMenuItem key={`revoke-${share.id}`} onSelect={() => void revokeShare(item, share.id)} className="text-destructive">Revoke share link</DropdownMenuItem>)}<DropdownMenuItem onSelect={() => setDeleteTarget(item)} className="text-destructive"><Trash2 />Delete…</DropdownMenuItem><DropdownMenuItem onSelect={() => { void navigator.clipboard?.writeText(item.name); toast.success("Name copied."); }}><Copy />Copy name</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      {hover?.id === item.id && <div role="tooltip" className="pointer-events-none absolute left-8 top-9 z-20 hidden w-64 rounded-md border border-border bg-popover p-3 shadow-md group-hover:block group-focus-within:block"><div className="mb-2 grid h-32 place-items-center overflow-hidden rounded border border-border bg-card">{image && item.thumbUrl ? <img src={item.thumbUrl} alt="" className="h-full w-full object-contain" /> : <Icon className="h-8 w-8 text-muted-foreground" />}</div><p className="truncate text-sm font-medium">{item.name}</p><p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><BotAvatar shape={botShape} color={botColor} size={18} />{item.direction === "in" ? "You" : botName} · {item.createdAt ? new Date(item.createdAt).toLocaleString() : formatAge()}</p></div>}
    </li>;
  };

  const keyNav = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "/" && !["INPUT", "TEXTAREA"].includes((event.target as HTMLElement).tagName)) { event.preventDefault(); searchRef.current?.focus(); return; }
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-library-item]");
    if (!row) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-library-item]"));
    const index = rows.indexOf(row);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); rows[nextLibraryRowIndex(index, event.key === "ArrowDown" ? 1 : -1, rows.length)]?.querySelector<HTMLElement>("button")?.focus(); }
    if (event.key === "Enter" && !["BUTTON", "A"].includes((event.target as HTMLElement).tagName)) { event.preventDefault(); const item = [...(searchItems ?? []), ...allItems].find(candidate => candidate.id === row.dataset.libraryItem); if (item) setPreview(item); }
    if (event.key === "Delete") { event.preventDefault(); const item = [...(searchItems ?? []), ...allItems].find(candidate => candidate.id === row.dataset.libraryItem); if (item) setDeleteTarget(item); }
  };

  return <div className="space-y-4" onKeyDown={keyNav}>
    <div className="space-y-2">
      <label className="sr-only" htmlFor="library-search">Search library</label>
      <div className="relative"><Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input id="library-search" ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search library" className="pl-9" /></div>
      <div aria-label="Filter library by type" className="flex flex-wrap gap-1.5">
        {LIBRARY_FILTERS.map(label => <button type="button" key={label} aria-pressed={activeType === label} onClick={() => setActiveType(label)} className={`rounded-md border px-2 py-1 text-xs transition-colors ${activeType === label ? "border-[var(--bot-accent-border)] bg-[var(--bot-accent-soft)] text-[var(--bot-accent-text)]" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}>{label}</button>)}
      </div>
      <div role="group" aria-label="Filter library direction" className="flex gap-1.5">
        {[{ key: "all", label: "All" }, { key: "in", label: "Uploaded" }, { key: "out", label: "Generated" }].map(option => <button type="button" key={option.key} aria-pressed={direction === option.key} onClick={() => setDirection(option.key as "all" | "in" | "out")} className={`rounded-md border px-2 py-1 text-xs ${direction === option.key ? "border-[var(--bot-accent-border)] bg-[var(--bot-accent-soft)] text-[var(--bot-accent-text)]" : "border-border bg-card text-muted-foreground"}`}>{option.label}</button>)}
      </div>
    </div>
    {error && <div role="alert" data-testid="library-error" className="rounded-lg border border-destructive/40 bg-card p-3 text-sm"><p>Could not load the library.</p><Button variant="link" className="mt-1 h-auto p-0 text-[var(--bot-accent-text)]" onClick={() => void load()}>Try again</Button></div>}
    {searchItems !== null ? searchItems.length ? <section aria-label="Search results" className="space-y-1 rounded-xl border border-border bg-card p-2">{searchItems.map(item => <div key={item.id}><ul>{renderRow(item)}</ul><span className="ml-12 inline-block rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.kind}</span></div>)}</section> : <div role="status" className="py-6 text-center text-sm text-muted-foreground"><p>No matches</p><Button variant="link" className="text-[var(--bot-accent-text)]" onClick={() => setQuery("")}>Clear search</Button></div> : null}
    {searchItems === null && <>
    {data.pinned.length > 0 && <section><h3 className="mb-2 text-xs font-medium text-muted-foreground">Pinned</h3><ul className="space-y-1 rounded-xl border border-border bg-card p-2">{data.pinned.map(renderRow)}</ul></section>}
    {visibleGroups.map(group => <section key={group.key} data-testid={`library-group-${group.key}`}>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{group.label}</h3>
      <div className="rounded-xl border border-border bg-card p-2">
        <ul className="space-y-1">{group.items.map(renderRow)}</ul>
        {group.nextCursor && <div className="pt-1 text-center">
          <Button variant="link" size="sm" className="h-7 text-[var(--bot-accent-text)] hover:text-[var(--bot-accent)] focus-visible:ring-[var(--bot-accent-ring)]" disabled={loadingMore === group.key} onClick={() => void showMore(group)}>{loadingMore === group.key ? <><Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />Loading…</> : moreErrors[group.key] ? "Try again" : "Show more"}</Button>
          {moreErrors[group.key] && <p role="alert" className="text-xs text-destructive">Could not load more files.</p>}
        </div>}
      </div>
    </section>)}
    </>}
    <Dialog open={!!preview} onOpenChange={open => { if (!open) setPreview(null); }}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-hidden p-0" onKeyDown={event => { if (event.key === "ArrowLeft") { event.preventDefault(); movePreview(-1); } if (event.key === "ArrowRight") { event.preventDefault(); movePreview(1); } }}>
        {preview && <>
          <DialogHeader className="border-b border-border p-4 pr-12"><DialogTitle className="flex items-center gap-2 truncate"><PreviewIcon className="h-4 w-4 shrink-0" />{preview.name}</DialogTitle><DialogDescription className="flex items-center gap-2"><BotAvatar shape={botShape} color={botColor} size={18} />{preview.direction === "in" ? "Sent by you" : `Sent by ${botName}`} · {preview.createdAt ? new Date(preview.createdAt).toLocaleString() : formatAge()} · {preview.sizeBytes.toLocaleString()} bytes</DialogDescription></DialogHeader>
          <div className="max-h-[65vh] min-h-48 overflow-auto p-4">
            {preview.dlpState === "redacted" && <div role="status" className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">Contains sensitive data. Preview is redacted.</div>}
            {contentError ? <p role="alert" className="text-sm text-destructive">Could not load preview.</p> : preview.sizeBytes > 2_000_000 && ["text", "markdown", "code", "sheet"].includes(preview.kind) ? <div className="text-sm">This file is too large to preview.<a className="ml-2 underline" href={itemUrl(preview)} download={preview.name}>Download</a></div> : preview.kind === "image" || preview.kind === "screenshots" ? <img src={itemUrl(preview, true)} alt={preview.name} onClick={() => setZoom(value => value === 1 ? 2 : value === 2 ? 3 : 1)} style={{ transform: `scale(${zoom})` }} className="mx-auto max-h-[60vh] cursor-zoom-in object-contain transition-transform" /> : preview.kind === "pdf" ? <iframe title={`Preview ${preview.name}`} src={itemUrl(preview, true)} sandbox="" className="h-[60vh] w-full border-0" /> : preview.kind === "video" ? <video controls className="mx-auto max-h-[60vh] max-w-full" src={itemUrl(preview, true)} /> : preview.kind === "audio" ? <audio controls className="w-full" src={itemUrl(preview, true)} /> : preview.kind === "sheet" && content != null ? <div className="overflow-auto"><table className="w-full border-collapse text-xs">{content.split(/\r?\n/).slice(0, 1000).map((line, i) => <tr key={i}>{line.split(",").map((cell, j) => <td key={j} className="border border-border px-2 py-1">{cell.replace(/^\"|\"$/g, "")}</td>)}</tr>)}</table></div> : preview.kind === "markdown" && content != null ? <Markdown text={content} /> : ["text", "code"].includes(preview.kind) && content != null ? <pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{content}</pre> : <div className="rounded-md border border-border p-5 text-center"><FileQuestion className="mx-auto mb-2 h-8 w-8 text-muted-foreground" /><p className="text-sm">Preview is unavailable for this file.</p><a className="mt-3 inline-block underline" href={itemUrl(preview)} download={preview.name}>Download</a></div>}
          </div>
          <DialogFooter className="items-center border-t border-border p-3"><Button variant="outline" onClick={() => movePreview(-1)} aria-label="Previous item"><ChevronLeft /></Button><Button variant="outline" onClick={() => movePreview(1)} aria-label="Next item"><ChevronRight /></Button><span className="flex-1" />{preview.messageId && <Button variant="outline" onClick={() => { setPreview(null); document.dispatchEvent(new CustomEvent("library:open-message", { detail: preview.messageId })); }}>Open in chat</Button>}<Button asChild><a href={itemUrl(preview)} download={preview.name}><Download className="mr-2 h-4 w-4" />Download</a></Button></DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
    <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null); }}>
      <DialogContent className="max-w-md"><DialogHeader><DialogTitle>Delete {deleteTarget?.name}?</DialogTitle><DialogDescription>The file is removed from Library and cannot be recovered after 30 days.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" autoFocus onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" onClick={() => void deleteItem()}>Delete</Button></DialogFooter></DialogContent>
    </Dialog>
  </div>;
}
