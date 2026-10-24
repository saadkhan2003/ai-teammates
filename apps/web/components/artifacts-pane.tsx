import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Artifact } from "@/lib/types";
import { formatWhen } from "@/lib/utils";

export function ArtifactsPane({
  artifacts,
  error,
  loaded,
  onRetry,
}: {
  artifacts: Artifact[];
  error: string | null;
  loaded: boolean;
  onRetry?: () => void;
}) {
  return (
    <div data-testid="artifact-list" className="rounded-lg border border-line bg-paper p-4">
      {!loaded ? <Skeleton className="h-20 w-full" /> : null}
      {loaded && error ? (
        <div className="space-y-2"><p role="alert" className="text-body-sm text-clay">
          Could not load artifacts. {error}
        </p><Button variant="outline" size="sm" onClick={onRetry}>Retry</Button></div>
      ) : null}
      {loaded && !error && artifacts.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">No artifacts yet. Finished files and evidence will collect here.</p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {artifacts.map((artifact) => (
          <li key={artifact.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-3 last:border-0">
            <div>
              <p className="font-medium">{artifact.title || artifact.name}</p>
              <p className="text-meta text-muted-foreground">
                {[artifact.mime, artifact.createdAt ? formatWhen(artifact.createdAt) : ""].filter(Boolean).join(" · ")}
              </p>
            </div>
            <a className="text-body-sm font-medium text-copper-deep underline" href={`/api/artifacts/${artifact.id}/download`}>
              Download
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
