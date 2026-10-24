"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { cardClass, PageEmpty, PageError, PageSkeleton, SectionTitle } from "@/components/account/chrome";
import { api } from "@/lib/api";
import { filesChangedLabel, normalizeCodingJob, type CodingJob } from "@/lib/chat-ui";
import { errorMessage } from "@/lib/utils";

export default function CodingJobsPage() {
  const params = useParams<{ id: string }>();
  const botId = typeof params.id === "string" ? params.id : "";
  const [jobs, setJobs] = useState<CodingJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!botId) return;
    let live = true;
    api<{ codingJobs?: unknown[] }>(`/api/bots/${botId}/workspace`)
      .then((body) => {
        if (!live) return;
        setJobs((body.codingJobs ?? []).map((entry, index) => normalizeCodingJob(entry, index)).filter((job): job is CodingJob => job != null));
      })
      .catch((caught) => {
        if (live) setError(errorMessage(caught, "Coding jobs could not be loaded."));
      });
    return () => {
      live = false;
    };
  }, [botId]);

  const running = jobs?.filter((job) => job.status === "running" || job.status === "tests" || job.status === "queued").length ?? 0;

  return (
    <main data-testid="coding-jobs-page" className="mx-auto flex w-full max-w-[56rem] flex-col gap-8 px-6 py-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href={botId ? `/bots/${botId}` : "/"} className="underline">
              Back to chat
            </Link>
          </p>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">Coding jobs</h1>
          <p className="mt-1 text-sm text-muted-foreground">Pull requests and file changes for this teammate.</p>
        </div>
        <Link href={botId ? `/bots/${botId}/routines` : "/"} className="inline-flex min-h-11 items-center rounded-full border border-border px-4 text-sm hover:bg-accent">
          Routines
        </Link>
      </header>
      {jobs ? (
        <section className="grid gap-4 sm:grid-cols-3">
          {[
            ["Jobs", String(jobs.length)],
            ["In progress", String(running)],
            ["Files", String(jobs.reduce((sum, job) => sum + job.filesChanged, 0))],
          ].map(([label, value]) => (
            <article key={label} className={`${cardClass} p-4`}>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
            </article>
          ))}
        </section>
      ) : null}
      {error ? <PageError title="Could not load coding jobs." detail={error} /> : null}
      {!jobs && !error ? <PageSkeleton /> : null}
      {jobs && jobs.length === 0 ? <PageEmpty title="No coding jobs yet" detail="A job appears here when this teammate opens a pull request." /> : null}
      {jobs && jobs.length > 0 ? (
        <section className={`${cardClass} overflow-x-auto`}>
          <div className="px-4 pt-4">
            <SectionTitle>Jobs</SectionTitle>
          </div>
          <table className="mt-2 w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="px-4 py-3 text-left font-medium">Title</th>
                <th scope="col" className="px-4 py-3 text-left font-medium">Branch</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Changes</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} data-testid="job-list-row" className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/bots/${botId}/jobs/${job.id}`} className="underline-offset-2 hover:underline">
                      {job.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{job.branch || "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{filesChangedLabel(job.filesChanged)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-xs capitalize">{job.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </main>
  );
}
