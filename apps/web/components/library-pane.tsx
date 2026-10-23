"use client";

import { useCallback, useEffect, useState } from "react";
import { AudioLines, Copy, Download, FileArchive, FileCode, FileQuestion, FileText, FileType, Film, Image as ImageIcon, Link as LinkIcon, Loader2, MoreHorizontal, Table, LayoutPanelTop } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatAge, type LibraryGroup, type LibraryItem, type LibraryResponse } from "@/lib/library";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BotAvatar } from "@/components/bot-avatar";

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

export function LibraryPane({ botId, botName, botShape, botColor }: { botId: string; botName: string; botShape?: string; botColor?: string }) {
  const [data, setData] = useState<LibraryResponse>(initial);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [moreErrors, setMoreErrors] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<LibraryItem | null>(null);

  const load = useCallback(async (keepData = true) => {
    try {
      const response = await api<LibraryResponse>(`/api/bots/${botId}/library?limit=5`);
      setData(response);
      setError(false);
      setLoaded(true);
    } catch {
      setError(true);
      if (!keepData) setLoaded(true);
    }
  }, [botId]);

  useEffect(() => { void load(false); }, [load]);
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
  if (!populated && !error) return <div className="py-8 text-center">
    <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-lg border border-border bg-card text-muted-foreground"><FileText className="h-5 w-5" /></div>
    <p className="text-sm font-medium">Nothing here yet</p>
    <p className="mx-auto mt-1 max-w-64 text-xs text-muted-foreground">Files you send and files your teammate shares will show up here.</p>
  </div>;

  const visibleGroups = data.groups.filter(group => group.items.length > 0);
  const renderRow = (item: LibraryItem) => {
    const Icon = icons[item.kind] ?? FileQuestion;
    const href = `/api/artifacts/${item.id}/download`;
    const image = item.kind === "image" || item.kind === "screenshots";
    return <li key={item.id} className="group relative flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--bot-accent-soft)] focus-within:bg-[var(--bot-accent-soft)] motion-reduce:transition-none" onMouseEnter={() => setPreview(item)} onMouseLeave={() => setPreview(null)} onFocus={() => setPreview(item)}>
      <span data-testid={item.kind === "unknown" ? "library-unknown-icon" : undefined} data-kind={item.kind} className={`relative grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background ${item.kind === "unknown" ? "text-muted-foreground" : "text-foreground"}`}>
        {image && item.thumbUrl ? <img className="h-full w-full object-cover" src={item.thumbUrl} alt="" loading="lazy" /> : <Icon aria-hidden="true" className={`h-4 w-4 ${item.kind === "unknown" ? "text-muted-foreground" : "text-muted-foreground"}`} />}
        {item.kind === "pdf" && <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1 bg-red-500" />}
      </span>
      <a href={href} className="min-w-0 flex-1 truncate text-sm outline-none focus-visible:ring-1 focus-visible:ring-[var(--bot-accent-ring)]" title={item.name}>{item.name}</a>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Actions for ${item.name}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem asChild><a href={href} target="_blank" rel="noreferrer">Open</a></DropdownMenuItem><DropdownMenuItem asChild><a href={href} download={item.name}><Download />Download</a></DropdownMenuItem><DropdownMenuItem onSelect={() => { void navigator.clipboard?.writeText(item.name); toast.success("Name copied."); }}><Copy />Copy name</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      {preview?.id === item.id && <div role="tooltip" className="pointer-events-none absolute left-8 top-9 z-20 hidden w-64 rounded-md border border-border bg-popover p-3 shadow-md group-hover:block group-focus-within:block"><div className="mb-2 grid h-32 place-items-center overflow-hidden rounded border border-border bg-card">{image && item.thumbUrl ? <img src={item.thumbUrl} alt="" className="h-full w-full object-contain" /> : <Icon className="h-8 w-8 text-muted-foreground" />}</div><p className="truncate text-sm font-medium">{item.name}</p><p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><BotAvatar shape={botShape} color={botColor} size={18} />{item.direction === "in" ? "You" : botName} · {item.createdAt ? new Date(item.createdAt).toLocaleString() : formatAge()}</p></div>}
    </li>;
  };

  return <div className="space-y-4" onKeyDown={event => { if (event.key === "Escape") setPreview(null); }}>
    {error && <div role="alert" data-testid="library-error" className="rounded-lg border border-destructive/40 bg-card p-3 text-sm"><p>Could not load the library.</p><Button variant="link" className="mt-1 h-auto p-0 text-[var(--bot-accent-text)]" onClick={() => void load()}>Try again</Button></div>}
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
  </div>;
}
