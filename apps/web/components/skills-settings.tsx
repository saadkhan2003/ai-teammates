"use client";

import { FileText, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ListSkeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";

type Skill = { id: string; name: string; title: string; whenToUse: string; kind: string; source: string; version: number; body: string; files: Record<string, string> | string };
type Revision = { version: number; title: string; whenToUse: string; body: string; files: Record<string, string>; author: string; createdAt: string };
type Draft = { name: string; description: string; body: string; filesText: string };
const blank: Draft = { name: "", description: "", body: "", filesText: "{}" };
function parseFiles(value: Record<string, string> | string | null | undefined): Record<string, string> {
  if (typeof value === "string") { try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {}; } catch { return {}; } }
  return value && typeof value === "object" ? value : {};
}

function Markdown({ value }: { value: string }) {
  const blocks = value.split(/\n\s*\n/).filter(Boolean);
  return <div className="space-y-3 text-sm leading-6">{blocks.map((block, i) => {
    const lines = block.split("\n");
    if (lines.every(line => /^\s*[-*]\s+/.test(line))) return <ul key={i} className="list-disc space-y-1 pl-5">{lines.map((line, j) => <li key={j}>{inline(line.replace(/^\s*[-*]\s+/, ""))}</li>)}</ul>;
    if (lines.every(line => /^\s*\d+[.)]\s+/.test(line))) return <ol key={i} className="list-decimal space-y-1 pl-5">{lines.map((line, j) => <li key={j}>{inline(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>)}</ol>;
    if (/^#{1,4}\s/.test(lines[0])) { const level = Math.min(4, lines[0].match(/^#+/)?.[0].length ?? 2); const text = inline(lines[0].replace(/^#{1,4}\s+/, "")); return level === 1 ? <h3 key={i} className="text-xl font-semibold">{text}</h3> : <h4 key={i} className="text-base font-semibold">{text}</h4>; }
    if (block.startsWith("```")) return <pre key={i} className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}</pre>;
    return <p key={i}>{lines.map((line, j) => <span key={j}>{j > 0 ? <br /> : null}{inline(line)}</span>)}</p>;
  })}</div>;
}
function inline(value: string) { return value.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, i) => part.startsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part.startsWith("*") ? <em key={i}>{part.slice(1, -1)}</em> : part.startsWith("`") ? <code key={i} className="rounded bg-muted px-1">{part.slice(1, -1)}</code> : part); }

export function SkillsSettings() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState<Draft>(blank);
  const [dialog, setDialog] = useState<"delete" | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setSkills(await api<Skill[]>("/api/skill-library")); setError(null); }
    catch { setError("Could not load your skills. Try again."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const visible = useMemo(() => skills.filter(skill => (filter === "all" || filter === "mine" && skill.source !== "builtin" && skill.kind !== "replay" || filter === "builtin" && skill.source === "builtin" || filter === "replay" && skill.kind === "replay") && `${skill.name} ${skill.title} ${skill.whenToUse}`.toLowerCase().includes(search.toLowerCase())), [skills, filter, search]);

  async function choose(skill: Skill) {
    setSelected(skill); setDraft({ name: skill.name, description: skill.whenToUse, body: skill.body, filesText: JSON.stringify(parseFiles(skill.files), null, 2) }); setMode("view"); setDialog(null);
    setRevisions(await api<Revision[]>(`/api/skill-library/${skill.id}/revisions`).catch(() => []));
  }
  function newSkill() { setSelected(null); setRevisions([]); setDraft(blank); setMode("edit"); }
  async function save() {
    let files: Record<string, string>;
    try { files = JSON.parse(draft.filesText || "{}"); if (!files || Array.isArray(files) || typeof files !== "object") throw new Error(); }
    catch { setError("Helper files must be a JSON object with file paths and text contents."); return; }
    setSaving(true); setError(null);
    try {
      const payload = { name: draft.name.trim(), title: draft.name.trim(), description: draft.description.trim(), body: draft.body, files };
      if (selected) await api(`/api/skill-library/${selected.id}`, { method: "PUT", body: JSON.stringify({ ...payload, whenToUse: payload.description }) });
      else { const created = await api<{ id: string }>("/api/skill-library", { method: "POST", body: JSON.stringify(payload) }); const after = await api<Skill[]>("/api/skill-library"); setSkills(after); const item = after.find(skill => skill.id === created.id); if (item) await choose(item); }
      await load();
      if (selected) { const fresh = await api<Skill[]>("/api/skill-library"); const item = fresh.find(skill => skill.id === selected.id); if (item) await choose(item); }
      setMode("view");
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 409 && caught.message === "skill_name_taken"
        ? "A skill with this name already exists. Choose a different name."
        : "Could not save this skill. Check the name, description, and file contents.");
    }
    finally { setSaving(false); }
  }
  async function remove() {
    if (!selected) return;
    setSaving(true);
    try { await api(`/api/skill-library/${selected.id}/archive`, { method: "POST" }); setDialog(null); setSelected(null); await load(); }
    catch { setError("Could not delete this skill."); }
    finally { setSaving(false); }
  }

  return <div className="flex min-h-[540px] flex-col gap-5" data-testid="skills-settings">
    <header className="flex flex-wrap items-start justify-between gap-3 pr-8"><div><h2 className="text-lg font-medium">Skills</h2><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Reusable guides shared by your teammates. Built-in guides are read-only.</p></div><Button data-testid="skill-new" onClick={newSkill}><Plus />New skill</Button></header>
    {error ? <div role="alert" className="rounded-md border border-clay/30 bg-clay/5 px-3 py-2 text-sm text-clay">{error}<Button variant="link" size="sm" className="ml-2 px-0" onClick={() => void load()}>Retry</Button></div> : null}
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.35fr)]">
      <section className="overflow-hidden rounded-lg border border-line bg-paper">
        <div className="space-y-3 border-b border-line p-4"><label className="relative block"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground"/><Input aria-label="Search skills" placeholder="Search skills" value={search} onChange={event => setSearch(event.target.value)} className="pl-9" /></label>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter skills">{[["all", "All"], ["builtin", "Built-in"], ["mine", "Mine"], ["replay", "Replay"]].map(([key, label]) => <Button key={key} size="sm" variant={filter === key ? "secondary" : "ghost"} onClick={() => setFilter(key)} aria-pressed={filter === key}>{label}</Button>)}</div>
        </div>
        {loading ? <ListSkeleton label="Loading skills" rows={4} /> : <ul data-testid="skills-list" className="max-h-[540px] divide-y divide-line overflow-y-auto">{visible.map(skill => <li key={skill.id}><Button variant="ghost" onClick={() => void choose(skill)} aria-current={selected?.id === skill.id ? "true" : undefined} className="h-auto w-full flex-col items-stretch justify-start gap-0 whitespace-normal rounded-none p-4 text-left hover:bg-accent/50 aria-[current=true]:bg-accent/50"><span className="flex min-w-0 items-center justify-between gap-2"><span className="min-w-0 truncate font-medium">{skill.title || skill.name}</span><span className="flex shrink-0 gap-1">{skill.source === "builtin" ? <Badge variant="outline" className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground">Built-in</Badge> : skill.kind === "replay" ? <Badge variant="outline" className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground">Replay</Badge> : null}</span></span><span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">{skill.whenToUse}</span><span className="mt-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground"><FileText className="h-3 w-3 shrink-0"/><span className="min-w-0 truncate">{skill.name}, version {skill.version}{Object.keys(parseFiles(skill.files)).length ? `, ${Object.keys(parseFiles(skill.files)).length} helper files` : ""}</span></span></Button></li>)}{!visible.length ? <li className="p-8 text-center text-sm text-muted-foreground">{skills.length ? "No skills match this search." : "Your skill library is empty."}</li> : null}</ul>}
      </section>
      <section className="min-w-0 rounded-lg border border-line bg-paper">
        {mode === "edit" ? <div data-testid="skill-editor" className="space-y-4 p-5"><div className="flex items-center justify-between"><div><h3 className="text-base font-semibold">{selected ? "Edit skill" : "New skill"}</h3><p className="mt-1 text-sm text-muted-foreground">The name becomes the skill slug in its frontmatter.</p></div><Button variant="ghost" size="icon" aria-label="Cancel editing" onClick={() => { setMode("view"); setError(null); }}><X /></Button></div>
          <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm font-medium">Name<Input data-testid="skill-name" value={draft.name} maxLength={80} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="weekly-review" /></label><label className="space-y-1 text-sm font-medium">When to use<Input data-testid="skill-description" value={draft.description} maxLength={240} onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="When reviewing a week’s work" /></label></div>
          <label className="block space-y-1 text-sm font-medium">Markdown body<Textarea data-testid="skill-body" value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} className="min-h-48 font-mono text-xs" placeholder="# Steps&#10;Describe the reusable process." /></label>
          <label className="block space-y-1 text-sm font-medium">Helper files <span className="font-normal text-muted-foreground">(JSON paths and text)</span><Textarea data-testid="skill-files" value={draft.filesText} onChange={e => setDraft({ ...draft, filesText: e.target.value })} className="min-h-20 font-mono text-xs" /></label>
          <section className="border-t border-line pt-4"><h4 className="mb-3 text-sm font-semibold">Preview</h4><Markdown value={draft.body || "Your markdown preview will appear here."}/></section>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setMode("view")}>Cancel</Button><Button data-testid="skill-save" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save skill"}</Button></div>
        </div> : selected ? <div data-testid="skill-detail" className="flex h-full flex-col">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-5"><div><p className="text-xs text-muted-foreground">{selected.source === "builtin" ? "Built-in guide" : selected.kind === "replay" ? "Replay skill" : "Shared skill"}, version {selected.version}</p><h3 className="mt-1 text-xl font-semibold">{selected.title || selected.name}</h3><p className="mt-1 text-sm text-muted-foreground">{selected.whenToUse}</p></div><div className="flex gap-2">{selected.source !== "builtin" && selected.kind !== "replay" ? <><Button variant="outline" data-testid="skill-edit" onClick={() => setMode("edit")}><Pencil />Edit</Button><Button variant="outline" data-testid="skill-delete" onClick={() => setDialog("delete")}><Trash2 />Delete</Button></> : <span className="self-start rounded border border-line px-2 py-1 text-xs text-muted-foreground">Read-only</span>}</div></div>
          <div className="grid flex-1 gap-4 overflow-y-auto p-5 xl:grid-cols-[minmax(0,1fr)_220px]"><article className="min-w-0"><Markdown value={selected.body}/>{Object.entries(parseFiles(selected.files)).map(([path, content]) => <details key={path} className="mt-4 border-t border-line pt-3"><summary className="cursor-pointer text-sm font-medium">{path}</summary><pre className="mt-3 whitespace-pre-wrap text-xs text-muted-foreground">{content}</pre></details>)}</article>
            <aside className="space-y-2"><h4 className="text-sm font-semibold">Version history</h4>{[
              { version: selected.version, body: selected.body },
              ...revisions.filter(revision => revision.version > 0 && revision.version < selected.version),
            ].map(revision => <div key={revision.version} className="border-t border-line py-3"><p className="text-sm font-medium">Version {revision.version}</p><p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{revision.body || "Initial version"}</p></div>)}</aside></div>
        </div> : <div className="grid min-h-[420px] place-items-center p-8 text-center"><div><FileText className="mx-auto h-8 w-8 text-muted-foreground"/><h3 className="mt-3 font-medium">Choose a skill to preview</h3><p className="mt-1 text-sm text-muted-foreground">Select a guide from your library or create one.</p></div></div>}
      </section>
    </div>
    <Dialog open={dialog === "delete"} onOpenChange={open => { if (!open) setDialog(null); }}><DialogContent data-testid="skill-delete-dialog"><DialogHeader><DialogTitle>Delete “{selected?.title || selected?.name}”?</DialogTitle><DialogDescription>This removes the skill from your shared library. Previous versions will no longer be available.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button variant="destructive" data-testid="skill-confirm-delete" disabled={saving} onClick={() => void remove()}><Trash2 />Delete skill</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
