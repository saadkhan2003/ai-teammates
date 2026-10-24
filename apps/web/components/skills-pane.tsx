"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { Skill } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

type Guide = { id: string; name: string; title: string; when_to_use: string; source: string; updated_at: string; version: number; allow_bot_edit: boolean; bot_id: string | null };
type GuideDetail = Guide & { body: string };
type Revision = { id: string; version: number; body: string; author: string; reason: string; created_at: string };
type Draft = { name: string; title: string; whenToUse: string; body: string; allowBotEdit: boolean };
const emptyDraft: Draft = { name: "", title: "", whenToUse: "", body: "", allowBotEdit: false };

function Markdown({ body }: { body: string }) {
  const blocks: Array<{ type: string; text: string }> = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) blocks.push({ type: "p", text: paragraph.join(" ") }); paragraph = []; };
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const item = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (heading) { flush(); blocks.push({ type: `h${heading[1].length}`, text: heading[2] }); }
    else if (item) { flush(); blocks.push({ type: "li", text: item[1] }); }
    else if (numbered) { flush(); blocks.push({ type: "li", text: numbered[1] }); }
    else paragraph.push(line);
  }
  flush();
  return <div className="space-y-2 text-sm leading-relaxed">{blocks.map((block, i) => {
    if (block.type === "h1" || block.type === "h2") return <h4 key={i} className="text-base font-semibold">{block.text}</h4>;
    if (block.type === "h3" || block.type === "h4") return <h5 key={i} className="font-semibold">{block.text}</h5>;
    if (block.type === "li") return <p key={i} className="pl-4 before:mr-2 before:content-['•']">{block.text}</p>;
    return <p key={i}>{block.text}</p>;
  })}</div>;
}

export function SkillsPane({ botId, skills, error, loaded, onChanged }: { botId: string; skills: Skill[]; error: string | null; loaded: boolean; onChanged: () => void }) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [selected, setSelected] = useState<GuideDetail | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadGuides = useCallback(async () => {
    try { setGuides(await api<Guide[]>(`/api/bots/${botId}/skill-library`)); }
    catch (caught) { setFormError(errorMessage(caught, "Could not load guide skills.")); }
  }, [botId]);
  useEffect(() => { void loadGuides(); }, [loadGuides]);

  async function viewGuide(id: string) {
    setFormError(null);
    try {
      const [detail, history] = await Promise.all([
        api<GuideDetail>(`/api/skill-library/${id}`),
        api<Revision[]>(`/api/skill-library/${id}/revisions`),
      ]);
      setSelected(detail); setRevisions(history);
    } catch (caught) { setFormError(errorMessage(caught, "Could not load skill history.")); }
  }

  function editGuide(guide: GuideDetail | null) {
    setEditingId(guide?.id ?? null);
    setDraft(guide ? { name: guide.name, title: guide.title, whenToUse: guide.when_to_use, body: guide.body, allowBotEdit: guide.allow_bot_edit } : emptyDraft);
    setEditorOpen(true); setFormError(null);
  }

  async function saveGuide(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setFormError(null);
    try {
      if (editingId) await api(`/api/skill-library/${editingId}`, { method: "PUT", body: JSON.stringify(draft) });
      else await api(`/api/bots/${botId}/skill-library`, { method: "POST", body: JSON.stringify(draft) });
      setEditorOpen(false); toast.success(editingId ? "Skill updated." : "Skill created."); await loadGuides();
      if (selected && editingId === selected.id) await viewGuide(selected.id);
    } catch (caught) { setFormError(errorMessage(caught, "Could not save skill.")); }
    finally { setBusy(false); }
  }

  async function archiveGuide(guide: Guide) {
    setPendingId(guide.id); setFormError(null);
    try { await api(`/api/skill-library/${guide.id}/archive`, { method: "POST" }); toast.success("Skill archived."); if (selected?.id === guide.id) setSelected(null); await loadGuides(); }
    catch (caught) { setFormError(errorMessage(caught, "Could not archive skill.")); }
    finally { setPendingId(null); }
  }

  async function revert(id: string, version: number) {
    setPendingId(id); setFormError(null);
    try { await api(`/api/skill-library/${id}/revert/${version}`, { method: "POST" }); toast.success(`Reverted to version ${version}.`); await loadGuides(); await viewGuide(id); }
    catch (caught) { setFormError(errorMessage(caught, "Could not revert skill.")); }
    finally { setPendingId(null); }
  }

  async function replay(id: string) {
    setPendingId(id); setFormError(null);
    try { await api(`/api/skills/${id}/replay`, { method: "POST" }); toast.success("Replay started."); onChanged(); }
    catch (caught) { setFormError(errorMessage(caught, "Could not replay that skill.")); }
    finally { setPendingId(null); }
  }

  return <div data-testid="skill-list" className="rounded-lg border border-line bg-paper p-4">
    <div className="mb-3 flex items-center justify-between"><h3 className="font-medium">Guide skills</h3><Button size="sm" onClick={() => editGuide(null)}>New skill</Button></div>
    {!loaded ? <Skeleton className="h-20 w-full" /> : null}
    {loaded && error ? <div className="space-y-2"><p role="alert" className="text-sm text-clay">Could not load replay skills. {error}</p><Button variant="outline" size="sm" onClick={onChanged}>Retry</Button></div> : null}
    {loaded && !error && skills.length === 0 && guides.length === 0 ? <p className="text-sm text-muted-foreground">No skills yet. Built-in guides and skills shared by your bots appear here.</p> : null}
    <ul className="flex flex-col gap-3">
      {guides.map((guide) => <li key={guide.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3 last:border-0">
        <div className="min-w-0"><p className="font-medium">{guide.name} <span className="rounded bg-muted px-1.5 py-0.5 text-xs capitalize">{guide.source}</span>{guide.bot_id ? <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs">This bot</span> : null}{guide.allow_bot_edit ? <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs">Bot edits allowed</span> : null}</p><p className="text-sm text-muted-foreground">{guide.when_to_use}</p><p className="text-xs text-muted-foreground">Updated {new Date(guide.updated_at).toLocaleDateString()}, version {guide.version}</p></div>
        <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => void viewGuide(guide.id)}>View</Button>{guide.source !== "builtin" ? <><Button variant="outline" size="sm" onClick={() => void api<GuideDetail>(`/api/skill-library/${guide.id}`).then(editGuide).catch(caught => setFormError(errorMessage(caught, "Could not open skill.")))}>Edit</Button><Button variant="ghost" size="sm" disabled={pendingId === guide.id} onClick={() => void archiveGuide(guide)}>Archive</Button></> : null}</div>
      </li>)}
      {skills.map((skill) => <li key={skill.id} className="flex flex-col gap-2 border-b border-line py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">{skill.name}</p>{skill.description ? <p className="text-sm text-muted-foreground">{skill.description}</p> : null}{skill.version != null ? <p className="text-xs text-muted-foreground">Version {skill.version}</p> : null}</div><Button data-testid="skill-replay" size="sm" disabled={pendingId === skill.id} onClick={() => void replay(skill.id)}>Replay</Button></li>)}
    </ul>
    {formError ? <p role="alert" className="mt-3 text-sm text-clay">{formError}</p> : null}
    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{selected?.title}, version {selected?.version}</DialogTitle><DialogDescription>{selected?.when_to_use}</DialogDescription></DialogHeader>{selected ? <><Markdown body={selected.body} /><div className="border-t border-line pt-3"><h4 className="mb-2 font-medium">Revision history</h4>{revisions.length ? <ul className="space-y-2">{revisions.map(revision => <li key={revision.id} className="space-y-2 rounded-md border border-line p-3 text-sm"><div className="flex items-center justify-between gap-3"><span>Version {revision.version}, {revision.reason}, {new Date(revision.created_at).toLocaleString()}, {revision.author}</span>{selected.source !== "builtin" && revision.version > 0 ? <Button size="sm" variant="outline" disabled={pendingId === selected.id} onClick={() => void revert(selected.id, revision.version)}>Revert</Button> : null}</div>{revision.body ? <Markdown body={revision.body} /> : <p className="text-xs text-muted-foreground">Empty initial revision.</p>}</li>)}</ul> : <p className="text-sm text-muted-foreground">No previous revisions.</p>}</div></> : null}</DialogContent></Dialog>
    <Dialog open={editorOpen} onOpenChange={setEditorOpen}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{editingId ? "Edit skill" : "Create skill"}</DialogTitle><DialogDescription>Write a reusable guide in Markdown. Secret shaped values are rejected.</DialogDescription></DialogHeader><form onSubmit={event => void saveGuide(event)} className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm">Name (slug)<Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} pattern="[a-z0-9]+(-[a-z0-9]+)*" required maxLength={80} disabled={!!editingId} /></label><label className="space-y-1 text-sm">Title<Input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} required maxLength={120} /></label></div><label className="block space-y-1 text-sm">When to use<Textarea value={draft.whenToUse} onChange={e => setDraft({ ...draft, whenToUse: e.target.value })} required maxLength={240} rows={2} /></label><label className="block space-y-1 text-sm">Markdown body<Textarea value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} required maxLength={32768} rows={12} /></label><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.allowBotEdit} onChange={e => setDraft({ ...draft, allowBotEdit: e.target.checked })} /><span>Allow bots to update this guide</span></label>{formError ? <p role="alert" className="text-sm text-clay">{formError}</p> : null}<DialogFooter><Button type="button" variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save skill"}</Button></DialogFooter></form></DialogContent></Dialog>
  </div>;
}
