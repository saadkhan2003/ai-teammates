"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { cardClass, PageError, PageSkeleton, pillClass, SectionTitle } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { filesChangedLabel, jobSubtitle, liveStepText, normalizeCodingJob, type CodingJob } from "@/lib/chat-ui";
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
        const next = normalizeCodingJob(body);
        if (!next) setError("This coding job could not be loaded.");
        else setJob(next);
      })
      .catch((caught) => {
        if (live) setError(errorMessage(caught, "This coding job could not be loaded."));
      });
    return () => {
      live = false;
    };
  }, [botId, jobId]);

  return (
    <main data-testid="coding-job-page" className="mx-auto flex w-full max-w-[56rem] flex-col gap-8 px-6 py-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            <Link href={botId ? `/bots/${botId}/jobs` : "/"} className="underline">
              All coding jobs
            </Link>
          </p>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">{job?.title ?? "Coding job"}</h1>
          {job ? <p className="mt-1 text-sm text-muted-foreground">{jobSubtitle(job) ?? liveStepText(job)}</p> : null}
        </div>
        {job?.prUrl ? (
          <Button asChild className={pillClass}>
            <a href={job.prUrl} target="_blank" rel="noopener noreferrer">
              Open pull request
            </a>
          </Button>
        ) : null}
      </header>
      {error ? <PageError title="This coding job could not be loaded." detail={error} /> : null}
      {!job && !error ? <PageSkeleton /> : null}
      {job ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Status", job.status],
              ["Files", filesChangedLabel(job.filesChanged)],
              ["Additions", `+${job.additions}`],
              ["Deletions", `−${job.deletions}`],
            ].map(([label, value]) => (
              <article key={label} className={`${cardClass} p-4`}>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                <p className="mt-2 text-2xl font-semibold capitalize tabular-nums">{value}</p>
              </article>
            ))}
          </section>
          <section className={`${cardClass} flex flex-col gap-3 p-4`}>
            <SectionTitle>Progress</SectionTitle>
            <p className="text-sm">{job.step || "Waiting for the next step."}</p>
            <p className="text-sm text-muted-foreground">{job.branch ? `Branch ${job.branch}` : "No branch yet."}</p>
            {job.prNumber ? <p className="text-sm tabular-nums">Pull request #{job.prNumber}</p> : null}
          </section>
        </>
      ) : null}
    </main>
  );
}
