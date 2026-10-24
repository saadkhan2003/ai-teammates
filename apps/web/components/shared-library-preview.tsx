"use client";

import { useEffect, useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";

type SharedItem = { name: string; kind: string; mime: string; sizeBytes: number; contentUrl: string };

export function SharedLibraryPreview({ token }: { token: string }) {
  const [item, setItem] = useState<SharedItem | null>(null);
  const [error, setError] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const content = `/api/public/library/${encodeURIComponent(token)}/content`;

  useEffect(() => {
    let active = true;
    void fetch(`/api/public/library/${encodeURIComponent(token)}`, { credentials: "omit", cache: "no-store" })
      .then(response => { if (!response.ok) throw new Error("not found"); return response.json() as Promise<SharedItem>; })
      .then(value => { if (active) setItem(value); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    if (!item || !["text", "markdown", "code", "sheet"].includes(item.kind) || item.sizeBytes > 2_000_000) return;
    let active = true;
    void fetch(content, { credentials: "omit", cache: "no-store" }).then(response => { if (!response.ok) throw new Error("unavailable"); return response.text(); }).then(value => { if (active) setText(value); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [content, item]);

  if (error) return <section role="alert" className="rounded-lg border border-border bg-card p-6"><h1 className="text-lg font-medium">This share link is unavailable</h1><p className="mt-2 text-sm text-muted-foreground">It may have expired or been revoked.</p></section>;
  if (!item) return <div role="status" aria-label="Loading shared item" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading shared item…</div>;

  return <article className="overflow-hidden rounded-lg border border-border bg-card">
    <header className="flex min-w-0 items-center gap-3 border-b border-border p-4"><FileText className="h-5 w-5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><h1 className="truncate text-base font-medium">{item.name}</h1><p className="text-xs text-muted-foreground">{item.kind} · {item.sizeBytes.toLocaleString()} bytes</p></div><a aria-label={`Download ${item.name}`} href={content} download={item.name} className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-muted"><Download className="h-4 w-4" />Download</a></header>
    <div className="max-h-[75vh] min-h-48 overflow-auto p-4">
      {item.kind === "image" || item.kind === "screenshots" ? <img src={content} alt={item.name} className="mx-auto max-h-[70vh] max-w-full object-contain" />
        : item.kind === "pdf" ? <iframe title={`Preview ${item.name}`} src={content} sandbox="" className="h-[70vh] w-full border-0" />
        : item.kind === "video" ? <video controls className="mx-auto max-h-[70vh] max-w-full" src={content} />
        : item.kind === "audio" ? <audio controls className="w-full" src={content} />
        : text !== null ? <pre className="whitespace-pre-wrap break-words font-mono text-xs">{text}</pre>
        : ["text", "markdown", "code", "sheet"].includes(item.kind) && item.sizeBytes <= 2_000_000 ? <p role="status" className="text-sm text-muted-foreground">Loading preview…</p>
        : <p className="text-sm text-muted-foreground">Preview is unavailable for this item. Use Download to view it.</p>}
    </div>
  </article>;
}
