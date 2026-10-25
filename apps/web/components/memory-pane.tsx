"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, normalizeMemories } from "@/lib/api";
import { filterMemoryRows, type MemoryRow } from "@/lib/memory-notes";
import type { MemoryItem } from "@/lib/types";
import { errorMessage, formatWhen } from "@/lib/utils";

const filters = [["all", "All"], ["rule", "Rules"], ["profile", "Profile"], ["journal", "Journal"], ["fact", "Facts"], ["pinned", "Pinned"], ["suggested", "Suggested"]] as const;
const plainReason: Record<string, string> = { unsafe_rule: "Approval and security requirements cannot be changed by notes.", credential_shaped: "This looks like a secret. Store credentials in the vault instead.", use_vault: "Contact details are not kept in notes.", notes_full: "Notes are full. Forget a note before adding another." };

export function MemoryPane({ botId, memories, error, loaded, onChanged, focusMemoryId, onFocused }: { botId: string; memories: MemoryItem[]; error: string | null; loaded: boolean; onChanged: () => void; focusMemoryId?: string; onFocused?: () => void }) {
  const [content, setContent] = useState(""); const [kind, setKind] = useState("profile"); const [saving, setSaving] = useState(false); const [formError, setFormError] = useState<string | null>(null);
  const [query, setQuery] = useState(""); const [filter, setFilter] = useState("all"); const [editing, setEditing] = useState<string | null>(null); const [draft, setDraft] = useState(""); const [rowError, setRowError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false); const [settings, setSettings] = useState({ mode: "auto", shareOwner: true }); const [snackbar, setSnackbar] = useState<{ id: string; label: string } | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null); const [history, setHistory] = useState<Array<Record<string, unknown>>>([]); const [cursor, setCursor] = useState<string | null>(null); const [extraRows, setExtraRows] = useState<MemoryRow[]>([]);
  const [serverSearch, setServerSearch] = useState<MemoryRow[] | null>(null); const [localHistory, setLocalHistory] = useState<Record<string, string[]>>({});
  const rows = useMemo(() => [...memories as MemoryRow[], ...extraRows.filter(r => !memories.some(m => m.id === r.id))], [memories, extraRows]);
  const visible = filterMemoryRows(serverSearch ?? rows, query, filter);
  const rules = visible.filter(row => row.kind === "rule" && row.status !== "pending");
  const others = visible.filter(row => row.kind !== "rule" || row.status === "pending");
  const pending = rows.filter(row => row.status === "pending").length;
  useEffect(() => { if (!focusMemoryId) return; const row = rows.find(item => item.id === focusMemoryId); if (!row) return; setEditing(row.id); setDraft(row.content); window.setTimeout(() => document.querySelector(`[data-memory-id="${CSS.escape(row.id)}"]`)?.scrollIntoView({ block: "center" }), 0); onFocused?.(); }, [focusMemoryId, rows, onFocused]);
  useEffect(() => { void api<{ mode?: string; shareOwner?: boolean }>(`/api/bots/${botId}/memory-settings`).then(s => setSettings({ mode: s.mode ?? "auto", shareOwner: s.shareOwner !== false })).catch(() => {}); void api<{ nextCursor?: string | null }>(`/api/bots/${botId}/memories`).then(page => setCursor(page.nextCursor ?? null)).catch(() => {}); }, [botId]);
  useEffect(() => { const q = query.trim(); if (!q) { setServerSearch(null); return; } const timer = window.setTimeout(() => { void api<unknown>(`/api/bots/${botId}/memories?q=${encodeURIComponent(q)}`).then(data => setServerSearch(normalizeMemories(data))).catch(() => setServerSearch([])); }, 250); return () => window.clearTimeout(timer); }, [botId, query]);
  useEffect(() => { if (!snackbar) return; const timer = window.setTimeout(() => setSnackbar(null), 10_000); return () => window.clearTimeout(timer); }, [snackbar]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const text = content.trim(); if (!text) { setFormError("Write a note for this teammate to keep."); return; }
    setSaving(true); setFormError(null); try { await api(`/api/bots/${botId}/memories`, { method: "POST", body: JSON.stringify({ content: text, kind }) }); setContent(""); toast.success("Memory saved."); onChanged(); }
    catch (caught) { const msg = errorMessage(caught, "Could not save that note."); setFormError(plainReason[msg] ?? msg); } finally { setSaving(false); }
  }
  async function patch(row: MemoryRow, body: Record<string, unknown>) { const result = await api<Record<string, unknown>>(`/api/bots/${botId}/memories/${row.id}`, { method: "PATCH", body: JSON.stringify(body) }); onChanged(); return result; }
  async function saveEdit(row: MemoryRow) { setRowError(""); try { const result = await patch(row, { content: draft }); const nextId = String(result.id ?? result.memoryId ?? row.id); setLocalHistory(current => ({ ...current, [nextId]: [...(current[nextId] ?? []), row.content] })); setEditing(null); } catch (caught) { const msg = errorMessage(caught, "Could not update this note."); setRowError(plainReason[msg] ?? msg); } }
  async function forget(row: MemoryRow) { try { await api(`/api/bots/${botId}/memories/${row.id}`, { method: "DELETE" }); setSnackbar({ id: row.id, label: "Note forgotten." }); onChanged(); } catch { setRowError("Could not forget this note. Try again."); } }
  async function undo() { if (!snackbar) return; try { await api(`/api/bots/${botId}/memories/${snackbar.id}/restore`, { method: "POST" }); setSnackbar(null); onChanged(); } catch { setRowError("Could not restore this note."); } }
  async function updateSettings(next: typeof settings) { setSettings(next); try { await api(`/api/bots/${botId}/memory-settings`, { method: "PUT", body: JSON.stringify(next) }); } catch { setFormError("Could not update memory settings."); } }
  async function loadMore() { if (!cursor) return; try { const data = await api<unknown>(`/api/bots/${botId}/memories?cursor=${encodeURIComponent(cursor)}`); setExtraRows(old => [...old, ...normalizeMemories(data)]); const page = data as { nextCursor?: string | null }; setCursor(page.nextCursor ?? null); } catch { setRowError("Could not load more notes."); } }
  async function showHistory(row: MemoryRow) { setHistoryId(row.id); try { setHistory(await api<Array<Record<string, unknown>>>(`/api/bots/${botId}/memories/${row.id}/history`)); } catch { setHistory([]); } }
  async function action(path: string) { try { await api(path, { method: "POST" }); onChanged(); } catch { setRowError("Could not update that suggestion."); } }
  function rowView(row: MemoryRow) {
    const staleDate = row.lastConfirmedAt || row.updatedAt || row.createdAt;
    const stale = row.kind !== "rule" && staleDate && Date.now() - new Date(staleDate).getTime() > (row.kind === "profile" ? 180 : 365) * 86400000;
    const memory = row;
    return <li key={row.id} className="space-y-2 border-b border-line py-3 last:border-0" data-memory-id={row.id}>
      {editing === row.id ? <div className="space-y-2"><Textarea aria-label="Edit note" value={draft} maxLength={1000} onChange={e => setDraft(e.target.value)} className="min-h-24"/><div className="flex items-center justify-between text-meta text-muted-foreground"><span>{draft.length}/1000</span><span>{rowError}</span></div>{rowError ? <p role="alert" className="text-body-sm text-clay">{rowError}</p> : null}<div className="flex gap-2"><Button className="min-h-11" size="sm" onClick={() => void saveEdit(row)}>Save</Button><Button className="min-h-11" size="sm" variant="outline" onClick={() => { setEditing(null); setRowError(""); }}>Cancel</Button></div></div> : <>
      <p className="whitespace-pre-wrap text-body-sm">{memory.content}</p>
      {memory.createdAt ? <p className="mt-1 text-meta text-muted-foreground">{formatWhen(memory.createdAt)}</p> : null}
      <p className="text-meta text-muted-foreground">{row.kind === "rule" ? "Rule" : row.kind === "journal" ? "Journal" : row.kind === "fact" ? "Fact" : "Profile"}{row.pinned ? " · Pinned" : ""}{row.visibility === "owner" ? " · Shared" : ""}{row.author === "user" ? " · Added by you" : ""}{stale ? " · Stale" : ""}</p>
      {row.status === "pending" ? <div className="flex gap-2"><Button className="min-h-11" size="sm" onClick={() => void action(`/api/bots/${botId}/memories/${row.id}/accept`)}>Accept</Button><Button className="min-h-11" size="sm" variant="outline" onClick={() => void action(`/api/bots/${botId}/memories/${row.id}/dismiss`)}>Dismiss</Button></div> : <div className="flex flex-wrap gap-2"><Button className="min-h-11" variant="outline" size="sm" onClick={() => { setEditing(row.id); setDraft(row.content); setRowError(""); }}>Edit</Button><Button className="min-h-11" variant="outline" size="sm" onClick={() => void patch(row, { pinned: !row.pinned })}>{row.pinned ? "Unpin" : "Pin"}</Button><Select value={row.kind} onValueChange={value => void patch(row, { content: row.content, kind: value })}><SelectTrigger className="min-h-11 w-36" aria-label="Change note type"><SelectValue /></SelectTrigger><SelectContent>{["profile", "rule", "fact", "journal"].map(k => <SelectItem key={k} value={k}>{k === "rule" ? "Rule" : k[0].toUpperCase() + k.slice(1)}</SelectItem>)}</SelectContent></Select><Button className="min-h-11" variant="outline" size="sm" onClick={() => void patch(row, { visibility: row.visibility === "owner" ? "bot" : "owner" })}>{row.visibility === "owner" ? "Unshare" : "Share"}</Button><Button className="min-h-11" variant="outline" size="sm" onClick={() => void forget(row)}>Forget</Button><Button className="min-h-11" variant="ghost" size="sm" onClick={() => void showHistory(row)}>History</Button></div>}
      </>}
      {historyId === row.id ? <div className="rounded-md border border-line p-2 text-meta"><div className="flex justify-between"><strong>History</strong><button className="min-h-11 px-2 underline" onClick={() => setHistoryId(null)}>Close</button></div>{[...(localHistory[row.id] ?? []), ...history.map(item => String(item.content ?? "" )).filter(Boolean)].map((version, index) => <p key={index} className="py-1">{version}</p>)}{(localHistory[row.id] ?? []).length === 0 && history.every(item => !item.content) ? <p>No previous versions are available.</p> : null}</div> : null}
    </li>;
  }
  return <div className="flex min-w-0 flex-col gap-4 [&_button]:rounded-control">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-lg font-semibold">Memory</h2><p className="text-body-sm text-muted-foreground">{rows.length} notes</p></div><div className="relative"><Button className="min-h-11" variant="outline" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(v => !v)}><Settings2 className="mr-2 h-4 w-4"/>Settings</Button>{settingsOpen ? <div className="absolute right-0 z-20 mt-2 w-72 space-y-3 rounded-md border border-line bg-paper p-4 shadow-lg"><Label htmlFor="memory-mode">Remember things</Label><Select value={settings.mode} onValueChange={mode => void updateSettings({ ...settings, mode })}><SelectTrigger id="memory-mode" className="min-h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">Auto</SelectItem><SelectItem value="ask">Ask first</SelectItem><SelectItem value="off">Off</SelectItem></SelectContent></Select><div className="flex items-center justify-between gap-3"><Label htmlFor="memory-share">Share with my other bots</Label><Switch id="memory-share" checked={settings.shareOwner} onCheckedChange={shareOwner => void updateSettings({ ...settings, shareOwner })}/></div></div> : null}</div></div>
    <Input data-testid="memory-search" aria-label="Search notes" placeholder="Search notes" value={query} onChange={e => setQuery(e.target.value)} className="min-h-11" />
    <div className="flex flex-wrap gap-2">{filters.map(([value, label]) => <Button key={value} type="button" variant={filter === value ? "secondary" : "outline"} className="min-h-11" onClick={() => setFilter(value)}>{label}{value === "suggested" ? ` (${pending})` : ""}</Button>)}</div>
    {settings.mode === "off" ? <p className="text-body-sm text-muted-foreground">Memory is off. Existing notes remain unchanged.</p> : null}
    <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-6">
      <form className="flex flex-col gap-3 rounded-lg border border-line bg-paper p-4" onSubmit={save}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="memory-input">Memory</Label>
          <Select value={kind} onValueChange={setKind}><SelectTrigger className="min-h-11 w-36" aria-label="Note type"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="profile">Profile</SelectItem><SelectItem value="rule">Rule</SelectItem><SelectItem value="fact">Fact</SelectItem><SelectItem value="journal">Journal</SelectItem></SelectContent></Select>
          <Textarea
            id="memory-input"
            data-testid="memory-input"
            value={content}
            maxLength={1000}
            onChange={(event) => setContent(event.target.value)}
            placeholder="The owner prefers short drafts and wants purchases left for approval."
          />
          <span className="text-meta text-muted-foreground">{content.length}/1000</span>
        </div>
        {formError ? (
          <p role="alert" className="text-body-sm text-clay">
            {formError}
          </p>
        ) : null}
        <Button data-testid="memory-save" type="submit" className="self-end" disabled={saving}>
          {saving ? "Saving…" : "Save memory"}
        </Button>
      </form>
      <div data-testid="memory-list" className="min-w-0 rounded-lg border border-line bg-paper p-4">
        <h3 className="font-medium">Standing rules</h3>
        <p className="mb-2 text-body-sm text-muted-foreground">Rules apply to every message and never change approval requirements.</p>
        {!loaded ? <Skeleton className="h-20 w-full" /> : null}
        {loaded && error ? (
          <div className="space-y-2"><p role="alert" className="text-body-sm text-clay">
            Could not load memories. {error}
          </p><Button variant="outline" size="sm" onClick={onChanged}>Retry</Button></div>
        ) : null}
        {loaded && !error && rows.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">No memories saved. Add a fact you want this bot to keep.</p>
        ) : null}
        {loaded && !error && rows.length > 0 && visible.length === 0 ? <p className="py-4 text-body-sm text-muted-foreground">No notes match your search or filter.</p> : null}
        {loaded && !error && visible.length > 0 ? <>
          <ul className="flex flex-col gap-3">{rules.map(rowView)}</ul>
          {rules.length === 0 ? <p className="mb-3 text-body-sm text-muted-foreground">No standing rules.</p> : null}
          <ul className="flex flex-col gap-3">{others.map(rowView)}</ul>
          {cursor ? <Button className="mt-3 min-h-11" variant="outline" onClick={() => void loadMore()}>Load more</Button> : null}
        </> : null}
        {rowError && editing === null ? <p role="alert" className="mt-2 text-body-sm text-clay">{rowError}</p> : null}
      </div>
    </div>
    {snackbar ? <div role="status" className="fixed bottom-4 left-1/2 z-30 flex min-h-11 -translate-x-1/2 items-center gap-3 rounded-md border border-line bg-paper px-4 shadow-lg">{snackbar.label}<Button className="min-h-11" variant="ghost" onClick={() => void undo()}>Undo</Button></div> : null}
  </div>;
}
