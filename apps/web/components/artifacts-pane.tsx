import type { Artifact } from "@/lib/types";
import { formatWhen } from "@/lib/utils";

export function ArtifactsPane({
  artifacts,
  error,
  loaded,
}: {
  artifacts: Artifact[];
  error: string | null;
  loaded: boolean;
}) {
  return (
    <div data-testid="artifact-list" className="rounded-lg border border-line bg-paper p-4">
      {!loaded ? <p className="text-sm text-muted-foreground">Loading artifacts…</p> : null}
      {loaded && error ? (
        <p role="alert" className="text-sm text-clay">
          Could not load artifacts. {error}
        </p>
      ) : null}
      {loaded && !error && artifacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No artifacts yet. Finished files and evidence will collect here.</p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {artifacts.map((artifact) => (
          <li key={artifact.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-3 last:border-0">
            <div>
              <p className="font-medium">{artifact.title || artifact.name}</p>
              <p className="text-xs text-muted-foreground">
                {[artifact.mime, artifact.createdAt ? formatWhen(artifact.createdAt) : ""].filter(Boolean).join(" · ")}
              </p>
            </div>
            <a className="text-sm font-medium text-copper-deep underline" href={`/api/artifacts/${artifact.id}/download`}>
              Download
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
