import { Video } from "lucide-react";
import type { VideoAnalysisView } from "@/lib/video-analysis";
import { timestampLabel } from "@/lib/video-analysis";

export function VideoAnalysisCard({ analysis }: { analysis: VideoAnalysisView }) {
  return <section data-testid="video-analysis-card" className="rounded-lg border border-line bg-paper/70 p-3">
    <div className="flex items-center gap-2 text-sm font-medium"><Video className="h-4 w-4" aria-hidden />Video analysis</div>
    {analysis.summary ? <p className="mt-2 text-sm">{analysis.summary}</p> : null}
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer select-none">Timeline ({analysis.timeline?.length ?? 0})</summary>
      <ol className="mt-2 space-y-2 border-l border-line pl-3">
        {analysis.timeline?.map((part, index) => <li key={`${part.timestamp ?? index}-${index}`}>
          <span className="font-mono text-xs text-muted-foreground">{timestampLabel(part.timestamp ?? 0)}</span>
          <p>{part.summary ?? part.text ?? "Video segment"}</p>
        </li>)}
      </ol>
    </details>
  </section>;
}
