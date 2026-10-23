"use client";

import { useState } from "react";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cardCopy, resumeText, type ResumeBlock } from "@/lib/resume-blocks";
import { errorMessage } from "@/lib/utils";

export function ResumeNotice({ block }: { block: Extract<ResumeBlock, { kind: "resume" | "compacted" }> }) {
  if (block.kind === "compacted") return <div data-testid="compacted-notice" role="status" className="inline-flex min-h-8 flex-wrap items-center gap-2 px-1 text-sm text-muted-foreground">
    <RotateCw className="h-3.5 w-3.5" aria-hidden />Condensed earlier work to keep going (kept the plan and the last {block.keptSteps} steps).
    <a className="underline underline-offset-4 hover:text-foreground" href={`/api/tasks/${block.taskId}/history`} target="_blank" rel="noreferrer">View full history</a>
  </div>;
  return <div data-testid="resume-notice" data-count={block.count} role="status" className="inline-flex min-h-8 items-center gap-2 px-1 text-sm text-muted-foreground">
    <RotateCw className="h-3.5 w-3.5" aria-hidden />{resumeText(block)}
  </div>;
}

export function ResumeCard({ block, onChanged }: { block: Extract<ResumeBlock, { kind: "resume_card" }>; onChanged: () => void }) {
  const [pending, setPending] = useState(false);
  const [state, setState] = useState(block.state);
  async function act(action: "continue" | "raise-budget" | "cancel") {
    if (pending) return;
    setPending(true);
    try {
      const body = action === "raise-budget" ? { maxSteps: block.maxSteps + 200, maxSeconds: block.maxSeconds + 3600 } : {};
      await api(`/api/tasks/${block.taskId}/${action}`, { method: "POST", ...(action === "cancel" ? {} : { body: JSON.stringify(body) }) });
      if (action === "cancel") setState("stopped");
      toast.success(action === "continue" ? "Task continued." : action === "raise-budget" ? "Task budget raised." : "Task stopped.");
      onChanged();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not update this task."));
    } finally { setPending(false); }
  }
  return <section data-testid="resume-card" data-state={state} data-reason={block.reason} className="max-w-md rounded-md border border-border bg-card px-4 py-3 shadow-sm">
    <p className="text-sm">{cardCopy(block.reason)}</p>
    {block.current ? <p className="mt-1 text-sm text-muted-foreground">Continuing: {block.current}</p> : null}
    {state === "open" ? <div className="mt-3 flex flex-wrap gap-2">
      <Button type="button" className="min-h-11" data-testid="resume-continue" disabled={pending} onClick={() => void act("continue")}>Continue</Button>
      {block.reason === "budget_reached" ? <Button type="button" variant="outline" className="min-h-11" data-testid="resume-raise" disabled={pending} onClick={() => void act("raise-budget")}>Raise budget</Button> : null}
      {block.reason !== "context_exhausted" ? <Button type="button" variant="outline" className="min-h-11" data-testid="resume-stop" disabled={pending} onClick={() => void act("cancel")}>Stop</Button> : null}
    </div> : <p className="mt-2 text-sm text-muted-foreground" role="status">{state === "continued" ? "Continued." : "Stopped."}</p>}
  </section>;
}
