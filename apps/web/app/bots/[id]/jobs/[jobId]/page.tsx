"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { JobMark } from "@/components/coding-jobs";
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
    <main data-testid="coding-job-page" className="mx-auto flex max-w-xl flex-col gap-3 px-4 py-8">
      <Link href={botId ? `/bots/${botId}` : "/"} className="text-sm text-brand">
        Back to chat
      </Link>
      {error ? <p role="alert">{error}</p> : null}
      {job ? (
        <>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <JobMark job={job} accent={accent} />
            {job.title}
          </h1>
          <p className="text-sm text-muted-foreground">{jobSubtitle(job) ?? liveStepText(job)}</p>
          {job.prUrl ? (
            <a className="text-sm text-brand underline" href={job.prUrl} target="_blank" rel="noopener noreferrer">
              Open pull request
            </a>
          ) : null}
        </>
      ) : error ? null : (
        <p>Loading coding job…</p>
      )}
    </main>
  );
}
