"use client";

import { Check, ChevronDown, Copy, ExternalLink, GitPullRequest, FileDiff, LoaderCircle, Terminal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { EDITORS, type EditorId, editorLink, readEnabledEditors } from "@/lib/editors";
import { cn, errorMessage } from "@/lib/utils";

export type CodingStatus = "running" | "ready_for_review" | "finished" | "merged" | "failed";

export interface CodingRow {
  id: string;
  title: string;
  branch: string;
  prNumber: number | null;
  prUrl: string;
  status: CodingStatus;
  ci: string;
  changedFiles: number;
  testsOk: boolean | null;
}

interface CodingDetail extends CodingRow {
  repoUrl: string;
  files: string[];
  diff: string;
  testsSummary: string;
  checkout: string;
}

export const STATUS_LABEL: Record<CodingStatus, string> = {
  running: "Running",
  ready_for_review: "Ready for review",
  finished: "Finished",
  merged: "Merged",
  failed: "Failed",
};

const STATUS_STYLE: Record<CodingStatus, string> = {
  running: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
  ready_for_review: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  finished: "bg-muted text-muted-foreground",
  merged: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  failed: "bg-destructive/15 text-destructive",
};

const CI_LABEL: Record<string, string> = { passing: "CI passing", failing: "CI failing", pending: "CI running" };

export function normalizeCoding(data: unknown): CodingRow[] {
  const list = Array.isArray(data) ? data : [];
  return list.flatMap((item) => {
    const r = item as Record<string, unknown>;
    if (typeof r?.id !== "string") return [];
    const status = (typeof r.status === "string" && r.status in STATUS_LABEL ? r.status : "finished") as CodingStatus;
    return [{
      id: r.id,
      title: typeof r.title === "string" ? r.title : "Coding task",
      branch: typeof r.branch === "string" ? r.branch : "",
      prNumber: typeof r.prNumber === "number" ? r.prNumber : null,
      prUrl: typeof r.prUrl === "string" ? r.prUrl : "",
      status,
      ci: typeof r.ci === "string" ? r.ci : "unknown",
      changedFiles: typeof r.changedFiles === "number" ? r.changedFiles : 0,
      testsOk: typeof r.testsOk === "boolean" ? r.testsOk : null,
    }];
  });
}

/** The Coding card on the Details tab: one row per coding task or pull request. */
export function CodingSection({ botId }: { botId: string }) {
  const [rows, setRows] = useState<CodingRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editors, setEditors] = useState<EditorId[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(normalizeCoding(await api<unknown>(`/api/bots/${botId}/coding`)));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Couldn't load coding work."));
    } finally {
      setLoaded(true);
    }
  }, [botId]);

  useEffect(() => {
    setLoaded(false);
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const read = () => setEditors(readEnabledEditors());
    read();
    window.addEventListener("teammates-editors", read);
    window.addEventListener("storage", read);
    return () => { window.removeEventListener("teammates-editors", read); window.removeEventListener("storage", read); };
  }, []);

  if (loaded && !error && rows.length === 0) return null;

  return (
    <section data-testid="coding-section" className="border-b border-border px-3 py-3">
      <h2 className="text-xs font-medium text-muted-foreground">Coding</h2>
      <div className="mt-2 overflow-hidden rounded-2xl border border-border bg-card">
        {!loaded ? (
          <div role="status" aria-busy="true" data-testid="coding-skeleton" className="divide-y divide-border">
            <span className="sr-only">Loading coding work</span>
            {[0, 1].map((row) => (
              <div key={row} aria-hidden className="space-y-1.5 px-3 py-3">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : null}
        {loaded && error ? (
          <div data-testid="coding-error" className="flex items-center justify-between gap-2 px-3 py-3">
            <p role="alert" className="text-sm text-destructive">Couldn&apos;t load coding work.</p>
            <Button type="button" variant="outline" size="sm" data-testid="coding-retry" onClick={() => void load()}>Try again</Button>
          </div>
        ) : null}
        {loaded && !error ? (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <CodingRowView key={row.id} row={row} editors={editors} onDiff={() => setOpen(row.id)} />
            ))}
          </ul>
        ) : null}
      </div>
      <DiffDialog id={open} onClose={() => setOpen(null)} />
    </section>
  );
}

function CodingRowView({ row, editors, onDiff }: { row: CodingRow; editors: EditorId[]; onDiff: () => void }) {
  const [detail, setDetail] = useState<CodingDetail | null>(null);

  async function ensureDetail() {
    if (detail) return detail;
    try {
      const d = await api<CodingDetail>(`/api/coding/${row.id}`);
      setDetail(d);
      return d;
    } catch (caught) {
      toast.error(errorMessage(caught, "Couldn't load that task."));
      return null;
    }
  }

  async function copyCheckout() {
    const d = await ensureDetail();
    if (!d?.checkout) { toast.error("No branch to check out yet."); return; }
    try { await navigator.clipboard.writeText(d.checkout); toast.success("Checkout command copied"); } catch { toast.error("Couldn't copy to the clipboard."); }
  }

  async function openEditor(editor: EditorId) {
    const d = await ensureDetail();
    const link = d ? editorLink(editor, d.repoUrl || row.prUrl.replace(/\/pull\/\d+.*$/, ".git")) : null;
    if (!link) { toast.error("This task has no repository to open yet."); return; }
    window.location.href = link;
  }

  return (
    <li data-testid="coding-row" data-status={row.status} className="group relative px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={row.title}>{row.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span
              data-testid="coding-status"
              className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[row.status])}
            >
              {row.status === "running" ? <LoaderCircle aria-hidden className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : null}
              {STATUS_LABEL[row.status]}
            </span>
            {row.prNumber != null ? <span data-testid="coding-pr" className="inline-flex items-center gap-0.5"><GitPullRequest className="h-3 w-3" aria-hidden />#{row.prNumber}</span> : null}
            {CI_LABEL[row.ci] ? (
              <span data-testid="coding-ci" className={cn(row.ci === "failing" && "text-destructive", row.ci === "passing" && "text-success")}>{CI_LABEL[row.ci]}</span>
            ) : null}
            <span data-testid="coding-files">{row.changedFiles} {row.changedFiles === 1 ? "file" : "files"}</span>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="coding-open"
              aria-label={`Open ${row.title}`}
              className="h-7 shrink-0 gap-1 px-2 text-xs opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
            >
              Open <ChevronDown className="h-3 w-3" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {row.prUrl ? (
              <DropdownMenuItem asChild data-testid="coding-menu-pr">
                <a href={row.prUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-2 h-4 w-4" aria-hidden />Open pull request</a>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem data-testid="coding-menu-diff" onSelect={onDiff}><FileDiff className="mr-2 h-4 w-4" aria-hidden />View diff and tests</DropdownMenuItem>
            {editors.length > 0 ? <DropdownMenuSeparator /> : null}
            {editors.length > 0 ? <DropdownMenuLabel className="text-xs text-muted-foreground">Open in editor</DropdownMenuLabel> : null}
            {EDITORS.filter((e) => editors.includes(e.id)).map((e) => (
              <DropdownMenuItem key={e.id} data-testid={`coding-menu-${e.id}`} onSelect={() => void openEditor(e.id)}>
                <Terminal className="mr-2 h-4 w-4" aria-hidden />{e.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="coding-menu-copy" onSelect={() => void copyCheckout()}><Copy className="mr-2 h-4 w-4" aria-hidden />Copy checkout command</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function DiffDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<CodingDetail | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setDetail(null);
    setError(false);
    if (!id) return;
    let alive = true;
    api<CodingDetail>(`/api/coding/${id}`).then((d) => { if (alive) setDetail(d); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [id]);

  return (
    <Dialog open={id != null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent data-testid="coding-diff" className="max-h-[85vh] max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle className="truncate">{detail?.title ?? "Changes"}</DialogTitle>
          <DialogDescription>
            {detail ? `${detail.changedFiles} ${detail.changedFiles === 1 ? "file" : "files"} changed${detail.branch ? ` on ${detail.branch}` : ""}` : "Loading changes"}
          </DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="text-sm text-destructive">Couldn&apos;t load this change.</p> : null}
        {!detail && !error ? <Skeleton className="h-40 w-full" /> : null}
        {detail ? (
          <div className="grid max-h-[60vh] gap-3 overflow-y-auto">
            <div data-testid="coding-tests" className="rounded-lg border border-border p-2 text-xs">
              <p className="flex items-center gap-1 font-medium">
                {detail.testsOk === true ? <><Check className="h-3.5 w-3.5 text-success" aria-hidden />Tests passed</> : detail.testsOk === false ? "Tests failed" : "No test run yet"}
              </p>
              {detail.testsSummary ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-muted-foreground">{detail.testsSummary}</pre> : null}
            </div>
            {detail.files.length > 0 ? (
              <ul data-testid="coding-file-list" className="text-xs">
                {detail.files.map((f) => <li key={f} className="truncate font-mono">{f}</li>)}
              </ul>
            ) : null}
            <pre data-testid="coding-diff-text" className="overflow-auto rounded-lg bg-muted p-2 font-mono text-xs leading-relaxed">
              {detail.diff ? detail.diff.split("\n").map((line, i) => (
                <span key={i} className={cn("block", line.startsWith("+") && !line.startsWith("+++") && "text-success", line.startsWith("-") && !line.startsWith("---") && "text-destructive")}>{line || " "}</span>
              )) : "No changes recorded."}
            </pre>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
