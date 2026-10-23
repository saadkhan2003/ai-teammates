"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { Skill } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

export function SkillsPane({
  skills,
  error,
  loaded,
  onChanged,
}: {
  skills: Skill[];
  error: string | null;
  loaded: boolean;
  onChanged: () => void;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

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
      {!loaded ? <p className="text-sm text-muted-foreground">Loading skills…</p> : null}
      {loaded && error ? (
        <p role="alert" className="text-sm text-clay">
          Could not load skills. {error}
        </p>
      ) : null}
      {loaded && !error && skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">No skills yet. Workflows this bot learns will appear here for replay.</p>
      ) : null}
      <ul className="flex flex-col gap-3">
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
      {formError ? (
        <p role="alert" className="mt-3 text-sm text-clay">
          {formError}
        </p>
      ) : null}
    </div>
  );
}
