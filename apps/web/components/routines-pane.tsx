"use client";

import { Skeleton } from "@/components/ui/skeleton";

import { FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { Routine } from "@/lib/types";
import { errorMessage, formatWhen } from "@/lib/utils";

export function RoutinesPane({
  botId,
  routines,
  error,
  loaded,
  onChanged,
}: {
  botId: string;
  routines: Routine[];
  error: string | null;
  loaded: boolean;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [cron, setCron] = useState("");
  const [instruction, setInstruction] = useState("");
  const [watchRef, setWatchRef] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api(`/api/bots/${botId}/routines`, {
        method: "POST",
        body: JSON.stringify({
          name,
          cron,
          instruction,
          watchKind: watchRef.trim() ? "http" : "",
          watchRef: watchRef.trim(),
        }),
      });
      setName("");
      setCron("");
      setInstruction("");
      setWatchRef("");
      toast.success("Routine scheduled.");
      onChanged();
    } catch (caught) {
      setFormError(errorMessage(caught, "Could not create that routine."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2">
      <form className="flex flex-col gap-3 rounded-lg border border-line bg-paper p-4" onSubmit={create}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="routine-name">Name</Label>
          <Input
            id="routine-name"
            data-testid="routine-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Weekday digest"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="routine-cron">Cron</Label>
          <Input
            id="routine-cron"
            data-testid="routine-cron"
            value={cron}
            onChange={(event) => setCron(event.target.value)}
            placeholder="0 9 * * 1-5"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="routine-watch">Watch URL</Label>
          <Input
            id="routine-watch"
            data-testid="routine-watch"
            value={watchRef}
            onChange={(event) => setWatchRef(event.target.value)}
            placeholder="https://example.com/status"
          />
          <p className="text-xs text-muted-foreground">Leave empty to run on every cron tick. A URL runs the model only when the page changes.</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="routine-instruction">Instruction</Label>
          <Textarea
            id="routine-instruction"
            data-testid="routine-instruction"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="Check the inbox and draft a summary of what needs a reply."
            required
          />
        </div>
        {formError ? (
          <p role="alert" className="text-sm text-clay">
            {formError}
          </p>
        ) : null}
        <Button data-testid="routine-create" type="submit" className="self-end" disabled={saving}>
          {saving ? "Scheduling…" : "Create routine"}
        </Button>
      </form>
      <div className="rounded-lg border border-line bg-paper p-4">
        {!loaded ? <Skeleton className="h-20 w-full" /> : null}
        {loaded && error ? (
          <div className="space-y-2"><p role="alert" className="text-sm text-clay">
            Could not load routines. {error}
          </p><Button variant="outline" size="sm" onClick={onChanged}>Retry</Button></div>
        ) : null}
        {loaded && !error && routines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No routines scheduled. A routine runs on its cron even when this page is closed.</p>
        ) : null}
        <ul className="flex flex-col gap-3">
          {routines.map((routine) => (
            <li key={routine.id} className="border-b border-line pb-3 last:border-0">
              <p className="font-medium">{routine.name}</p>
              <p className="font-mono text-xs text-muted-foreground">{routine.cron}</p>
              {routine.instruction ? <p className="mt-1 text-sm">{routine.instruction}</p> : null}
              {routine.watchRef ? <p className="mt-1 text-xs text-muted-foreground">Watches {routine.watchRef}</p> : null}
              {routine.nextRunAt ? <p className="mt-1 text-xs text-muted-foreground">Next run {formatWhen(routine.nextRunAt)}</p> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
