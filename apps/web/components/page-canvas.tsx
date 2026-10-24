"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BarChart3, CheckSquare, ClipboardList, Copy, Download, FileText, History, Link2, Loader2, Maximize2, Minimize2, Search, Share2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type PageCardData = { id: string; title: string; kind: string; version?: number };
export type PageData = PageCardData & { shareMode: "private" | "link"; source: string; currentVersion: number; version: number; summary: string; updatedAt: string };
type Version = { addedLines: number; removedLines: number; version: number; summary: string; author: string; createdAt: string };
type Share = { id: string; createdAt: string; revokedAt?: string | null };
const kinds = ["report", "dashboard", "tracker", "plan", "other"];
const kindIcons = { report: FileText, dashboard: BarChart3, tracker: CheckSquare, plan: ClipboardList, other: FileText };
function KindIcon({ kind, className }: { kind: string; className?: string }) { const Icon = kindIcons[kind as keyof typeof kindIcons] ?? FileText; return <Icon className={className ?? "h-4 w-4"} aria-hidden />; }
export function openPage(id: string) { document.dispatchEvent(new CustomEvent("page:open", { detail: { id } })); }

export function PageCard({ page }: { page: PageCardData }) {
  return <article data-testid="page-card" className="my-1 flex min-w-[240px] max-w-sm items-center gap-3 rounded-md border border-border bg-card p-3 text-card-foreground shadow-sm">
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-border bg-muted/40"><KindIcon kind={page.kind} className="h-5 w-5" /></span>
    <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{page.title}</p><p className="mt-0.5 text-xs capitalize text-muted-foreground">{page.kind} · Page{page.version ? ` · v${page.version}` : ""}</p></div>
    <Button variant="outline" size="sm" className="rounded-md" onClick={() => openPage(page.id)}>Open</Button>
  </article>;
}

export function PageFrame({ source, title }: { source: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useRef("");
  const [rendered, setRendered] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const send = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: "page:render", source, channel: channel.current, theme: document.documentElement.classList.contains("light") ? "light" : "dark" }, "*");
  }, [source]);
  useEffect(() => {
    channel.current = crypto.randomUUID(); setRendered(false); setFailed(false);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      if (event.data?.type === "page:ready") send();
      if (event.data?.type === "page:rendered" && event.data.channel === channel.current) setRendered(true);
    };
    window.addEventListener("message", receive);
    const observer = new MutationObserver(send); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const timeout = window.setTimeout(() => setFailed(true), 15000);
    send();
    return () => { window.clearTimeout(timeout); observer.disconnect(); window.removeEventListener("message", receive); };
  }, [send, attempt]);
  return <div className="relative min-h-0 flex-1" data-testid="page-frame-container">
    {!rendered && <div className="absolute inset-0 grid place-items-center bg-background" role="status">{failed ? <div className="space-y-3 text-center text-sm"><p>Could not load this page.</p><Button variant="outline" onClick={() => setAttempt(value => value + 1)}>Try again</Button></div> : <span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading page…</span>}</div>}
    <iframe key={attempt} ref={frame} title={title} src="/page-renderer" sandbox="allow-scripts" {...{ credentialless: "" }} referrerPolicy="no-referrer" onLoad={send} className={cn("h-full min-h-[300px] w-full border-0", !rendered && "invisible")} data-testid="page-frame" />
  </div>;
}

export function PagesLibrary({ botId }: { botId: string }) {
  const [query, setQuery] = useState(""); const [kind, setKind] = useState("");
  const [rows, setRows] = useState<Array<PageCardData & { current_version: number; updated_at: string }> | null>(null);
  const [error, setError] = useState(false); const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setError(false);
    const load = () => { void api<typeof rows>(`/api/bots/${botId}/pages?${new URLSearchParams({ q: query, kind })}`).then(result => { if (active) { setRows(result); setError(false); } }).catch(() => { if (active) setError(true); }); };
    const timer = window.setTimeout(load, 180); const interval = window.setInterval(load, 8000);
    return () => { active = false; window.clearTimeout(timer); window.clearInterval(interval); };
  }, [botId, query, kind, retry]);
  return <section data-testid="pages-library" className="space-y-4">
    <div><h3 className="text-sm font-semibold">Pages</h3><p className="mt-1 text-xs text-muted-foreground">Reports, dashboards and plans from your conversations.</p></div>
    <div className="flex gap-2"><div className="relative min-w-0 flex-1"><Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" /><Input aria-label="Search pages" placeholder="Search pages" value={query} onChange={e => setQuery(e.target.value)} className="h-9 rounded-md pl-8" /></div>
      <select aria-label="Page kind" value={kind} onChange={e => setKind(e.target.value)} className="h-9 max-w-[130px] rounded-md border border-input bg-background px-2 text-xs"><option value="">All kinds</option>{kinds.map(k => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</select></div>
    {error ? <div role="alert" className="rounded-md border border-border p-4 text-sm">Could not load pages.<Button variant="ghost" size="sm" onClick={() => setRetry(n => n + 1)}>Try again</Button></div> : rows === null ? <div role="status" className="space-y-3"><span className="sr-only">Loading pages</span>{[1, 2, 3].map(n => <Skeleton key={n} className="h-14 w-full rounded-md" />)}</div> : rows.length === 0 ? <div className="rounded-md border border-dashed border-border px-4 py-10 text-center"><FileText className="mx-auto mb-3 h-6 w-6 text-muted-foreground" /><p className="text-sm font-medium">{query || kind ? "No matching pages" : "Your next idea starts here"}</p><p className="mt-1 text-xs text-muted-foreground">{query || kind ? "Try another search or kind." : "Ask your teammate to make a page."}</p></div> : <ul className="divide-y divide-border rounded-md border border-border">{rows.map(row => <li key={row.id}><button onClick={() => openPage(row.id)} className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><KindIcon kind={row.kind} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{row.title}</span><span className="mt-0.5 block text-xs capitalize text-muted-foreground">{row.kind} · v{row.current_version}</span></span><time className="text-[11px] text-muted-foreground" dateTime={row.updated_at} title={new Date(row.updated_at).toLocaleString()}>{new Date(row.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></button></li>)}</ul>}
  </section>;
}

export function PageCanvasHost({ botId, onOpen }: { botId: string; onOpen: () => void }) {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => { setId(null); }, [botId]);
  useEffect(() => {
    const listener = (event: Event) => { const next = (event as CustomEvent).detail?.id; if (typeof next === "string" && /^[a-f\d-]{36}$/i.test(next)) { setId(next); onOpen(); } };
    document.addEventListener("page:open", listener); return () => document.removeEventListener("page:open", listener);
  }, [onOpen]);
  return id ? <PageCanvas key={id} id={id} onClose={() => setId(null)} /> : null;
}

function PageCanvas({ id, onClose }: { id: string; onClose: () => void }) {
  const [page, setPage] = useState<PageData | null>(null); const [error, setError] = useState(false);
  const requestSequence = useRef(0);
  const [width, setWidth] = useState(620); const [full, setFull] = useState(false);
  const [historyError, setHistoryError] = useState(false); const [historyRetry, setHistoryRetry] = useState(0);
  const [linksLoading, setLinksLoading] = useState(false);
  const [history, setHistory] = useState(false); const [versions, setVersions] = useState<Version[] | null>(null);
  const [view, setView] = useState<number | null>(null); const [share, setShare] = useState(false); const [links, setLinks] = useState<Share[]>([]);
  const [shareUrl, setShareUrl] = useState(""); const [busy, setBusy] = useState(false); const [shareError, setShareError] = useState(false);
  const load = useCallback(async () => { const sequence = ++requestSequence.current; try { const result = await api<PageData>(`/api/pages/${id}${view ? `?version=${view}` : ""}`); if (sequence === requestSequence.current) { setPage(result); setError(false); } } catch { if (sequence === requestSequence.current) setError(true); } }, [id, view]);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 5000); return () => { window.clearInterval(timer); requestSequence.current++; }; }, [load]);
  useEffect(() => { if (!history) return; setVersions(null); setHistoryError(false); void api<Version[]>(`/api/pages/${id}/versions`).then(setVersions).catch(() => setHistoryError(true)); }, [history, id, page?.currentVersion, historyRetry]);
  useEffect(() => { if (!share) return; setShareError(false); setLinksLoading(true); void api<Share[]>(`/api/pages/${id}/shares`).then(setLinks).catch(() => setShareError(true)).finally(() => setLinksLoading(false)); }, [id, share]);
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId); const start = event.clientX; const initial = width;
    const move = (e: PointerEvent) => setWidth(Math.max(360, Math.min(window.innerWidth - 320, initial + start - e.clientX)));
    const done = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", done); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", done, { once: true });
  };
  const restore = async () => {
    if (!view) return; setBusy(true);
    try { const restored = await api<PageData>(`/api/pages/${id}/restore/${view}`, { method: "POST" }); requestSequence.current++; setPage(restored); setView(null); toast.success(`Restored as version ${restored.version}.`); }
    catch { toast.error("Could not restore this version."); } finally { setBusy(false); }
  };
  const createLink = async () => {
    setBusy(true); setShareError(false);
    try { const result = await api<{ id: string; url: string }>(`/api/pages/${id}/shares`, { method: "POST" }); setShareUrl(new URL(result.url, location.origin).href); setLinks(await api<Share[]>(`/api/pages/${id}/shares`)); void load(); }
    catch { setShareError(true); } finally { setBusy(false); }
  };
  const revoke = async (link: string) => {
    setBusy(true); try { await api(`/api/pages/${id}/shares/${link}`, { method: "DELETE" }); setShareUrl(""); setLinks(await api<Share[]>(`/api/pages/${id}/shares`)); void load(); toast.success("Link revoked."); } catch { setShareError(true); } finally { setBusy(false); }
  };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast.success("Copied."); } catch { toast.error("Could not copy. Try exporting the Markdown."); } };
  const download = () => { if (!page) return; const url = URL.createObjectURL(new Blob([page.source], { type: "text/markdown;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = page.title.replace(/[^a-z\d _-]/gi, "_").slice(0, 100) + ".md"; link.click(); URL.revokeObjectURL(url); };
  return <aside aria-label="Page canvas" data-testid="page-canvas" style={full ? undefined : { width }} className={cn("relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background text-foreground max-md:!w-full max-md:fixed max-md:inset-0 max-md:z-40", full && "!fixed inset-0 z-40 !w-full")}>
    {!full && <div role="separator" aria-label="Resize page canvas" aria-orientation="vertical" aria-valuemin={360} aria-valuemax={1200} aria-valuenow={width} tabIndex={0} onPointerDown={resize} onKeyDown={e => { if (e.key === "ArrowLeft") { e.preventDefault(); setWidth(w => Math.min(window.innerWidth - 320, w + 40)); } if (e.key === "ArrowRight") { e.preventDefault(); setWidth(w => Math.max(360, w - 40)); } }} className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none hover:bg-brand/20 focus-visible:bg-brand/20 max-md:hidden" />}
    <header className="flex min-h-14 items-center gap-2 border-b border-border px-4"><KindIcon kind={page?.kind ?? "other"} /><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{page?.title ?? "Page"}</h2><p className="text-[11px] text-muted-foreground">{page ? `Version ${page.version} · ${view ? "Viewing history" : page.shareMode === "link" ? "Shared by link" : "Private"}` : "Loading…"}</p></div>
      <Button variant="ghost" size="icon" aria-label="Version history" onClick={() => setHistory(!history)} className="h-8 w-8"><History className="h-4 w-4" /></Button>
      <Button variant="ghost" size="icon" aria-label="Share page" onClick={() => setShare(true)} className="h-8 w-8"><Share2 className="h-4 w-4" /></Button>
      <Button variant="ghost" size="icon" aria-label={full ? "Exit full screen" : "Full screen page"} onClick={() => setFull(!full)} className="h-8 w-8">{full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</Button>
      <Button variant="ghost" size="icon" aria-label="Close page" onClick={onClose} className="h-8 w-8"><X className="h-4 w-4" /></Button></header>
    <div className="flex items-center gap-1 border-b border-border px-3 py-1.5"><Button variant="ghost" size="sm" className="h-7 text-xs" disabled={!page} onClick={() => page && void copy(page.source)}><Copy className="mr-1.5 h-3.5 w-3.5" />Copy Markdown</Button><Button variant="ghost" size="sm" className="h-7 text-xs" disabled={!page} onClick={download}><Download className="mr-1.5 h-3.5 w-3.5" />Export</Button><span className="ml-auto text-[11px] capitalize text-muted-foreground">{page?.kind}</span></div>
    {view && <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs"><span className="flex-1">Viewing version {view}</span><Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setView(null)}>Back to latest</Button><Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void restore()}>Restore version</Button></div>}
    {history && <section data-testid="page-history" aria-label="Page version history" className="max-h-64 shrink-0 overflow-y-auto border-b border-border bg-muted/20 p-4"><h3 className="mb-3 text-xs font-semibold">Version history</h3>{historyError ? <div role="alert" className="text-xs">Could not load history.<Button variant="ghost" size="sm" onClick={() => setHistoryRetry(n => n + 1)}>Try again</Button></div> : versions === null ? <p role="status" className="text-xs text-muted-foreground">Loading history…</p> : <ol className="space-y-2">{versions.map(v => <li key={v.version}><button onClick={() => setView(v.version)} className="w-full rounded-md border border-border bg-card px-3 py-2 text-left hover:bg-muted/40"><span className="text-xs font-medium">Version {v.version} · {v.author === "bot" ? "Teammate" : "You"}</span><time className="ml-2 text-[11px] text-muted-foreground">{new Date(v.createdAt).toLocaleString()}</time><span className="mt-1 block text-xs text-muted-foreground">{v.summary || "Updated page"}<span className="ml-2 font-mono text-[11px]" aria-label={`${v.addedLines} lines added, ${v.removedLines} lines removed`}>+{v.addedLines} −{v.removedLines}</span></span></button></li>)}</ol>}</section>}
    {error ? <div role="alert" className="grid flex-1 place-content-center gap-3 px-6 text-center text-sm"><p>This page is unavailable or could not be loaded.</p><Button variant="outline" onClick={() => void load()}>Try again</Button></div> : page ? <PageFrame source={page.source} title={page.title} /> : <div role="status" className="space-y-5 p-8"><span className="sr-only">Loading page</span><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40 w-full" /></div>}
    <Dialog open={share} onOpenChange={setShare}><DialogContent data-testid="page-share-dialog" className="rounded-md"><DialogHeader><DialogTitle>Share page</DialogTitle><DialogDescription>Private by default. Anyone with a link can read the latest version. Revoke a link to stop future access.</DialogDescription></DialogHeader>
      {shareError && <p role="alert" className="text-sm text-destructive">Could not update sharing. Please try again.</p>}
      {shareUrl && <div className="flex gap-2"><Input readOnly aria-label="Page share link" value={shareUrl} /><Button variant="outline" onClick={() => void copy(shareUrl)}>Copy link</Button></div>}
      <Button className="justify-self-start rounded-md" disabled={busy || !page} onClick={() => void createLink()}><Link2 className="mr-2 h-4 w-4" />Create read-only link</Button>
      <div className="space-y-2">{links.filter(link => !link.revokedAt).map((link, index) => <div key={link.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2"><span className="min-w-0 flex-1 text-xs">Link {index + 1} · {new Date(link.createdAt).toLocaleDateString()}</span><Button variant="ghost" size="sm" disabled={busy} onClick={() => void revoke(link.id)}>Revoke</Button></div>)}{linksLoading && <p role="status" className="text-xs text-muted-foreground">Loading share links…</p>}{!linksLoading && !shareError && links.every(link => link.revokedAt) && <p className="text-xs text-muted-foreground">No active share links.</p>}</div>
    </DialogContent></Dialog>
  </aside>;
}

export function SharedPage({ token }: { token: string }) {
  const [page, setPage] = useState<{ title: string; kind: string; source: string; current_version: number } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const load = async () => { try { const response = await fetch(`/api/public/pages/${encodeURIComponent(token)}`, { credentials: "omit", cache: "no-store" }); if (!response.ok) throw new Error(); const data = await response.json(); if (active) { setPage(data); setError(false); } } catch { if (active) { setError(true); setPage(null); } } };
    void load(); const timer = window.setInterval(() => void load(), 15000); return () => { active = false; window.clearInterval(timer); };
  }, [token]);
  return <main data-testid="shared-page" className="flex h-dvh min-h-0 flex-col bg-background text-foreground"><header className="flex items-center gap-3 border-b border-border px-6 py-4"><FileText className="h-5 w-5" /><h1 className="flex-1 text-sm font-semibold">{page?.title ?? "Shared page"}</h1><span className="text-xs text-muted-foreground">Read-only{page ? ` · v${page.current_version}` : ""}</span></header>{error ? <div role="alert" className="m-auto max-w-sm p-8 text-center"><h2 className="text-lg font-semibold">This page isn’t available</h2><p className="mt-2 text-sm text-muted-foreground">The link may have been revoked. Ask the owner for a new link.</p></div> : page ? <PageFrame source={page.source} title={page.title} /> : <p role="status" className="m-auto text-sm text-muted-foreground">Loading shared page…</p>}</main>;
}
