"use client";

import { Skeleton } from "@/components/ui/skeleton";

import { FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { MemoryItem } from "@/lib/types";
import { errorMessage, formatWhen } from "@/lib/utils";

export function MemoryPane({
  botId,
  memories,
  error,
  loaded,
  onChanged,
}: {
  botId: string;
  memories: MemoryItem[];
  error: string | null;
  loaded: boolean;
  onChanged: () => void;
}) {
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = content.trim();
    if (!text) {
      setFormError("Write the fact you want this bot to keep.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await api(`/api/bots/${botId}/memories`, {
        method: "POST",
        body: JSON.stringify({ content: text }),
      });
      setContent("");
      toast.success("Memory saved.");
      onChanged();
    } catch (caught) {
      setFormError(errorMessage(caught, "Could not save that memory."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form className="flex flex-col gap-3 rounded-lg border border-line bg-paper p-4" onSubmit={save}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="memory-input">Memory</Label>
          <Textarea
            id="memory-input"
            data-testid="memory-input"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="The owner prefers short drafts and wants purchases left for approval."
          />
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
      <div data-testid="memory-list" className="rounded-lg border border-line bg-paper p-4">
        {!loaded ? <Skeleton className="h-20 w-full" /> : null}
        {loaded && error ? (
          <div className="space-y-2"><p role="alert" className="text-body-sm text-clay">
            Could not load memories. {error}
          </p><Button variant="outline" size="sm" onClick={onChanged}>Retry</Button></div>
        ) : null}
        {loaded && !error && memories.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">No memories saved. Add a fact you want this bot to keep.</p>
        ) : null}
        <ul className="flex flex-col gap-3">
          {memories.map((memory) => (
            <li key={memory.id} className="border-b border-line pb-3 last:border-0">
              <p className="whitespace-pre-wrap text-body-sm">{memory.content}</p>
              {memory.createdAt ? <p className="mt-1 text-meta text-muted-foreground">{formatWhen(memory.createdAt)}</p> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
