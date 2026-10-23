"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { StatusBadge } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import type { Task } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

export function TasksPane({
  botId,
  tasks,
  openrouterConnected,
  onChanged,
}: {
  botId: string;
  tasks: Task[];
  openrouterConnected: boolean;
  onChanged?: () => void;
}) {
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function saveSkill(task: Task) {
    setSavingId(task.id);
    setSaveError(null);
    try {
      const name = (task.title || task.instruction || "Learned workflow").slice(0, 80);
      await api(`/api/bots/${botId}/skills/from-task`, {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, name }),
      });
      toast.success("Saved as a skill.");
      onChanged?.();
    } catch (caught) {
      setSaveError(errorMessage(caught, "Could not save that task as a skill."));
    } finally {
      setSavingId(null);
    }
  }
  return (
    <div data-testid="task-list">
      {tasks.length === 0 ? (
        <p className="rounded-lg border border-line bg-paper px-4 py-3 text-sm text-muted-foreground">
          No tasks yet. Assign work from Chat and the status will show up here.
        </p>
      ) : (
        <ScrollArea className="h-[min(60dvh,640px)]">
          <ul className="flex flex-col gap-3">
            {tasks.map((task) => (
              <li key={task.id} data-testid="task-item" className="rounded-lg border border-line bg-paper p-4 shadow-none">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-medium">{task.title || task.instruction || "Untitled task"}</h3>
                  <StatusBadge status={task.status} />
                </div>
                {task.title && task.instruction ? <p className="mt-2 text-sm text-muted-foreground">{task.instruction}</p> : null}
                <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {task.kind ? (
                    <div>
                      <dt className="inline">Kind </dt>
                      <dd className="inline text-ink">{task.kind}</dd>
                    </div>
                  ) : null}
                  {typeof task.modelCalls === "number" ? (
                    <div>
                      <dt className="inline">Model calls </dt>
                      <dd className="inline text-ink">{task.modelCalls}</dd>
                    </div>
                  ) : null}
                </dl>
                {task.status === "failed" && task.error ? <p role="alert" data-testid="task-error" className="mt-2 whitespace-pre-wrap text-sm text-destructive">{task.error}</p> : null}
                {task.waitingReason ? <p className="mt-2 text-sm">{task.waitingReason}</p> : null}
                {task.status === "waiting_resource" && openrouterConnected === false ? (
                  <p className="mt-2 text-sm">
                    <Link href="/settings/secrets" className="font-medium text-copper-deep underline">
                      Connect OpenRouter
                    </Link>
                  </p>
                ) : null}
                {task.result ? <p className="mt-3 whitespace-pre-wrap text-sm">{task.result}</p> : null}
                {task.status === "completed" ? (
                  <Button
                    data-testid="save-skill"
                    className="mt-3"
                    size="sm"
                    variant="secondary"
                    disabled={savingId === task.id}
                    onClick={() => void saveSkill(task)}
                  >
                    Save as skill
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
      {saveError ? (
        <p role="alert" className="mt-3 text-sm text-clay">
          {saveError}
        </p>
      ) : null}
    </div>
  );
}
