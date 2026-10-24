"use client";

import { Skeleton } from "@/components/ui/skeleton";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { Skill } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

export function SkillsPane({
  botId,
  skills,
  error,
  loaded,
  onChanged,
}: {
  botId: string;
  skills: Skill[];
  error: string | null;
  loaded: boolean;
  onChanged: () => void;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [guides, setGuides] = useState<Array<{id:string;name:string;title:string;when_to_use:string;source:string;updated_at:string}>>([]);
  const [selected, setSelected] = useState<{title:string;body:string;version:number}|null>(null);
  useEffect(() => { void api<Array<{id:string;name:string;title:string;when_to_use:string;source:string;updated_at:string}>>(`/api/bots/${botId}/skill-library`).then(setGuides).catch(()=>{}); }, [botId]);
  async function viewGuide(id:string) { try { setSelected(await api(`/api/skill-library/${id}`)); } catch (caught) { setFormError(errorMessage(caught,"Could not load skill.")); } }

  async function replay(id: string) {
    setPendingId(id);
    setFormError(null);
    try {
      await api(`/api/skills/${id}/replay`, { method: "POST" });
      toast.success("Replay started.");
      onChanged();
    } catch (caught) {
      setFormError(errorMessage(caught, "Could not replay that skill."));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div data-testid="skill-list" className="rounded-lg border border-line bg-paper p-4">
      {!loaded ? <Skeleton className="h-20 w-full" /> : null}
      {loaded && error ? (
        <div className="space-y-2"><p role="alert" className="text-sm text-clay">
          Could not load skills. {error}
        </p><Button variant="outline" size="sm" onClick={onChanged}>Retry</Button></div>
      ) : null}
      {loaded && !error && skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">No skills yet. Workflows this bot learns will appear here for replay.</p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {guides.map((guide) => <li key={guide.id} className="flex items-center justify-between gap-3 border-b border-line py-3"><div><p className="font-medium">{guide.name} <span className="text-xs text-muted-foreground">{guide.source}</span></p><p className="text-sm text-muted-foreground">{guide.when_to_use}</p><p className="text-xs text-muted-foreground">{new Date(guide.updated_at).toLocaleDateString()}</p></div><Button variant="outline" size="sm" onClick={()=>void viewGuide(guide.id)}>View</Button></li>)}
        {skills.map((skill) => (
          <li key={skill.id} className="flex flex-col gap-2 border-b border-line py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">{skill.name}</p>
              {skill.description ? <p className="text-sm text-muted-foreground">{skill.description}</p> : null}
              {skill.version != null ? <p className="text-xs text-muted-foreground">Version {skill.version}</p> : null}
            </div>
            <Button data-testid="skill-replay" size="sm" disabled={pendingId === skill.id} onClick={() => void replay(skill.id)}>
              Replay
            </Button>
          </li>
        ))}
      </ul>
      {selected ? <div role="dialog" aria-modal="true" className="mt-4 rounded-lg border border-line bg-paper p-4"><div className="flex justify-between"><h3 className="font-semibold">{selected.title} · v{selected.version}</h3><Button variant="ghost" size="sm" onClick={()=>setSelected(null)}>Close</Button></div><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-sm">{selected.body}</pre></div> : null}
      {formError ? (
        <p role="alert" className="mt-3 text-sm text-clay">
          {formError}
        </p>
      ) : null}
    </div>
  );
}
