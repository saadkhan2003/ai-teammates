"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { JobMark } from "@/components/coding-jobs";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { jobSubtitle, liveStepText, normalizeCodingJob, readableAccent, type CodingJob } from "@/lib/chat-ui";
import { errorMessage } from "@/lib/utils";

export default function CodingJobPage() {
  const params = useParams<{ id: string; jobId: string }>();
  const botId = typeof params.id === "string" ? params.id : "";
  const jobId = typeof params.jobId === "string" ? params.jobId : "";
  const [job, setJob] = useState<CodingJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!botId || !jobId) return;
    let live = true;
    api<unknown>(`/api/bots/${botId}/coding-jobs/${jobId}`)
      .then((body) => {
        if (!live) return;
        setJob(normalizeCodingJob(body));
      })
      .catch((caught) => {
        if (live) setError(errorMessage(caught, "This coding job could not be loaded."));
      });
    return () => {
      live = false;
    };
  }, [botId, jobId]);

  const accent = readableAccent();
  return (
    <main data-testid="coding-job-page" className="mx-auto flex w-full max-w-[var(--content-width)] flex-col gap-[var(--space-section)] px-[var(--space-page)] py-[var(--space-page)]">
      <Link href={botId ? `/bots/${botId}` : "/"} className="text-sm text-muted-foreground">
        Back to chat
      </Link>
      {error ? (
        <p role="alert" className="rounded-lg border border-border bg-card p-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {job ? (
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-medium">
              <JobMark job={job} accent={accent} />
              {job.title}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{jobSubtitle(job) ?? liveStepText(job)}</p>
          </div>
          {job.prUrl ? (
            <Button asChild>
              <a href={job.prUrl} target="_blank" rel="noopener noreferrer">
                Open pull request
              </a>
            </Button>
          ) : null}
        </header>
      ) : error ? null : (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading coding job">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      )}
    </main>
  );
}
