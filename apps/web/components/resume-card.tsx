"use client";

import { useState } from "react";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cardCopy, resumeText, type ResumeBlock } from "@/lib/resume-blocks";
import { errorMessage } from "@/lib/utils";

export function ResumeNotice({ block }: { block: Extract<ResumeBlock, { kind: "resume" }> }) {
  return <div data-testid="resume-notice" data-count={block.count} role="status" className="inline-flex min-h-8 items-center gap-2 px-1 text-sm text-muted-foreground">
    <RotateCw className="h-3.5 w-3.5" aria-hidden />{resumeText(block)}
  </div>;
}

export function ResumeCard({ block, onChanged }: { block: Extract<ResumeBlock, { kind: "resume_card" }>; onChanged: () => void }) {
  const [pending, setPending] = useState(false);
  async function act(action: "continue" | "raise-budget" | "cancel") {
    if (pending) return;
    setPending(true);
    try {
      const body = action === "raise-budget" ? { maxSteps: block.maxSteps + 200, maxSeconds: block.maxSeconds + 3600 } : {};
      await api(`/api/tasks/${block.taskId}/${action}`, { method: "POST", ...(action === "cancel" ? {} : { body: JSON.stringify(body) }) });
      toast.success(action === "continue" ? "Task continued." : action === "raise-budget" ? "Task budget raised." : "Task stopped.");
      onChanged();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not update this task."));
    } finally { setPending(false); }
  }
  return <section data-testid="resume-card" data-state={block.state} data-reason={block.reason} className="max-w-md rounded-md border border-border bg-card px-4 py-3 shadow-sm">
    <p className="text-sm">{cardCopy(block.reason)}</p>
    {block.current ? <p className="mt-1 text-sm text-muted-foreground">Continuing: {block.current}</p> : null}
    {block.state === "open" ? <div className="mt-3 flex flex-wrap gap-2">
      <Button type="button" className="min-h-11" data-testid="resume-continue" disabled={pending} onClick={() => void act("continue")}>Continue</Button>
      {block.reason === "budget_reached" ? <Button type="button" variant="outline" className="min-h-11" data-testid="resume-raise" disabled={pending} onClick={() => void act("raise-budget")}>Raise budget</Button> : null}
      <Button type="button" variant="outline" className="min-h-11" data-testid="resume-stop" disabled={pending} onClick={() => void act("cancel")}>Stop</Button>
    </div> : <p className="mt-2 text-sm text-muted-foreground" role="status">{block.state === "continued" ? "Continued." : "Stopped."}</p>}
  </section>;
}
