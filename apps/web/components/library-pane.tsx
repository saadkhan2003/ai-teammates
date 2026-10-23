"use client";

import { ListSkeleton } from "@/components/ui/skeleton";
import { useMemo, useState } from "react";
import { Copy, Download, File, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import type { Artifact, FileEntry } from "@/lib/types";
import { formatAge, groupByDay, type LibraryEntry } from "@/lib/library";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BotAvatar } from "@/components/bot-avatar";

export function LibraryPane({ botId, botName, botShape, botColor, files, artifacts, loaded }: { botId: string; botName: string; botShape?: string; botColor?: string; files: FileEntry[]; artifacts: Artifact[]; loaded: boolean }) {
  const [limit, setLimit] = useState(10);
  const [preview, setPreview] = useState<LibraryEntry | null>(null);
  const entries = useMemo(() => [
    ...files.filter(file => !file.directory).map(file => ({ id: file.path, path: file.path, name: file.name, kind: "file" as const })),
    ...artifacts.map(item => ({ id: item.id, name: item.title || item.name, kind: "artifact" as const, createdAt: item.createdAt, mime: item.mime })),
  ], [files, artifacts]);
  const groups = groupByDay<LibraryEntry>(entries);
  const shown = groups.flatMap(group => group.entries).slice(0, limit);
  const visibleGroups = groups.map(group => ({ ...group, entries: group.entries.filter(entry => shown.includes(entry)) })).filter(group => group.entries.length);
  if (!loaded) return <ListSkeleton label="Loading library" testId="library-loading" />;
  if (!entries.length) return <p className="py-5 text-sm text-muted-foreground">Nothing here yet. Files and finished artifacts will collect here.</p>;
  return <div className="relative" onKeyDown={event => { if (event.key === "Escape") setPreview(null); }}>
    {visibleGroups.map(group => <section key={group.day} className="motion-fade mb-4">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{group.day}</h3>
      <ul className="space-y-1">{group.entries.map(entry => {
        const url = entry.kind === "artifact" ? `/api/artifacts/${entry.id}/download` : `/api/bots/${botId}/files/raw?path=${encodeURIComponent(entry.path || "")}`;
        const image = entry.mime?.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(entry.name);
        return <li key={`${entry.kind}:${entry.id}`} className="group relative flex items-center gap-2 rounded-md px-2 py-2 transition-colors duration-fast ease-out hover:bg-accent focus-within:bg-accent" onMouseEnter={() => setPreview(entry)} onMouseLeave={() => setPreview(null)} onFocus={() => setPreview(entry)}>
          <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-card">{image ? <img className="h-full w-full object-cover" src={url} alt="" /> : <File className="h-4 w-4 text-muted-foreground" />}</span>
          <a href={url} className="min-w-0 flex-1 truncate text-sm" title={entry.name}>{entry.name}</a>
          <span className="text-xs text-muted-foreground">{formatAge(entry.createdAt)}</span>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Actions for ${entry.name}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem asChild><a href={url}><Download />Open / Download</a></DropdownMenuItem><DropdownMenuItem onSelect={() => { void navigator.clipboard?.writeText(entry.name); toast.success("Name copied."); }}><Copy />Copy name</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          {preview?.id === entry.id && <div role="tooltip" className="pointer-events-none absolute left-8 top-10 z-20 hidden w-64 rounded-md border border-border bg-popover p-3 shadow-md group-hover:block group-focus-within:block"><div className="mb-2 grid h-32 place-items-center overflow-hidden rounded border border-border bg-card">{image ? <img src={url} alt="" className="h-full w-full object-contain" /> : <File className="h-8 w-8 text-muted-foreground" />}</div><p className="truncate text-sm font-medium">{entry.name}</p><p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><BotAvatar shape={botShape} color={botColor} size={18} />{botName}{entry.createdAt ? ` · ${new Date(entry.createdAt).toLocaleString()}` : ""}</p></div>}
        </li>;
      })}</ul>
    </section>)}
    {entries.length > limit && <Button variant="outline" size="sm" className="w-full" onClick={() => setLimit(value => value + 10)}>Show more</Button>}
  </div>;
}
