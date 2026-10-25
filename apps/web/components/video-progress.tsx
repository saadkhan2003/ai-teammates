import { Film } from "lucide-react";
import type { AgentEvent } from "@/lib/events";

export function VideoProgress({ progress, testId = "video-progress" }: { progress: AgentEvent; testId?: string }) {
  const current = Number(progress.current);
  const count = Number.isFinite(current) && progress.total != null ? ` ${current}/${String(progress.total)}` : "";
  return <div data-testid={testId} role="status" aria-live="polite" className="inline-flex min-h-8 items-center gap-2 rounded-control border border-border bg-card px-2.5 text-meta text-muted-foreground">
    <Film className="size-3.5 shrink-0" aria-hidden />
    <span>{String(progress.stage ?? "Preparing video")}{count}</span>
  </div>;
}
