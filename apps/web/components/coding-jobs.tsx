"use client";

import { ArrowUpRight, Box, Check, ChevronRight, Cloud, Eye, GitBranch, GitPullRequest, X } from "lucide-react";
import { useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { LinkPill } from "@/components/link-pill";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  filesChangedLabel,
  isActiveJob,
  jobCountLabel,
  isExternalHref,
  jobIconKind,
  jobOpenHref,
  jobSubtitle,
  liveStepText,
  routineSchedule,
  type CodingJob,
} from "@/lib/chat-ui";
import type { Routine } from "@/lib/types";

export function JobMark({ job, accent }: { job: CodingJob; accent: string }) {
  const kind = jobIconKind(job);
  const paint = { ["--bot-accent" as string]: accent };
  if (kind === "spinner") {
    return <span data-testid="job-spinner" className="job-spinner" style={paint} role="img" aria-label="Running" />;
  }
  if (kind === "pr") {
    return <GitPullRequest data-testid="job-pr" className="size-4 text-[color:var(--bot-accent)]" style={paint} aria-label="Pull request" />;
  }
  if (kind === "merged") {
    return (
      <span data-testid="job-merged" className="grid h-4 w-4 place-items-center rounded-full border border-success text-success" role="img" aria-label="Merged">
        <Check className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (kind === "failed") {
    return (
      <span data-testid="job-failed" className="grid h-4 w-4 place-items-center rounded-full border border-destructive text-destructive" role="img" aria-label="Failed">
        <X className="h-2.5 w-2.5" />
      </span>
    );
  }
  return (
    <span data-testid="job-finished" className="grid size-4 place-items-center rounded-full border border-muted-foreground text-muted-foreground" role="img" aria-label="Finished">
      <Check className="h-2.5 w-2.5" />
    </span>
  );
}

export function JobSubtitle({ job }: { job: CodingJob }) {
  const text = jobSubtitle(job);
  if (!text) return null;
  if (job.status === "failed") return <span className="text-xs text-destructive">{text}</span>;
  if (job.status === "merged") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Check className="h-3 w-3 text-success" aria-hidden />
        {text}
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">{text}</span>;
}

export function CodingJobsCard({
  jobs,
  accent,
  botId,
  onOpenJob,
}: {
  jobs: CodingJob[];
  accent: string;
  botId?: string;
  onOpenJob?: (job: CodingJob) => void;
}) {
  const [local, setLocal] = useState<CodingJob | null>(null);
  if (jobs.length === 0) return null;
  const open = (job: CodingJob) => (onOpenJob ? onOpenJob(job) : setLocal(job));
  return (
    <>
      <section data-testid="coding-jobs-card" aria-label="Coding jobs" className="w-full max-w-md rounded-2xl border border-border bg-card px-3 py-3 text-card-foreground shadow-sm" style={{ ["--bot-accent" as string]: accent }}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Cloud className="h-4 w-4" aria-hidden />
          Coding jobs
        </div>
        <p className="mt-2 text-sm font-semibold">{jobCountLabel(jobs)}</p>
        <ul className="mt-1">
          {jobs.map((job) => (
            <li key={job.id} data-testid="coding-job-row" data-status={job.status} data-job-id={job.id} className="group flex min-h-11 items-center gap-2 rounded-lg px-1 hover:bg-accent">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-label={job.title} onClick={() => open(job)}>
                <JobMark job={job} accent={accent} />
                <span className="truncate text-sm">{job.title}</span>
              </button>
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" data-testid="coding-job-watch" aria-label="Watch" className="grid size-8 place-items-center rounded-md hover:bg-background" onClick={() => open(job)}>
                      <Eye className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Watch</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <a data-testid="coding-job-open" aria-label="Open" href={jobOpenHref(botId, job)} target="_blank" rel="noopener noreferrer" className="grid size-8 place-items-center rounded-md text-[color:var(--bot-accent)] hover:bg-background">
                      <ArrowUpRight className="h-4 w-4" />
                    </a>
                  </TooltipTrigger>
                  <TooltipContent side="top">Open</TooltipContent>
                </Tooltip>
              </span>
            </li>
          ))}
        </ul>
      </section>
      {onOpenJob ? null : <JobDetailDialog job={local} accent={accent} onClose={() => setLocal(null)} />}
    </>
  );
}

export function CodingPanel({
  jobs,
  routines,
  accent,
  botId,
  avatarShape,
  avatarColor,
  onOpenJob,
  onToggleRoutine,
}: {
  jobs: CodingJob[];
  routines: Routine[];
  accent: string;
  botId?: string;
  avatarShape?: string;
  avatarColor?: string;
  onOpenJob: (job: CodingJob) => void;
  onToggleRoutine: (routine: Routine, enabled: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-[var(--space-section)]" style={{ ["--bot-accent" as string]: accent }}>
      <section data-testid="coding-list" aria-label="Coding">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs font-medium text-muted-foreground">Coding</h2>
          {jobs.length > 0 ? (
            <p data-testid="coding-count" className="text-xs text-muted-foreground">
              {jobCountLabel(jobs)}
            </p>
          ) : null}
        </div>
        {jobs.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No coding jobs yet.</p> : null}
        {jobs.length > 0 ? (
          <ul className="mt-2 rounded-xl bg-card p-1 text-card-foreground">
            {jobs.map((job) => (
              <li key={job.id} data-testid="coding-panel-row" data-status={job.status} data-job-id={job.id} className="group relative rounded-lg hover:bg-accent">
                <button type="button" className="flex min-h-11 w-full items-center gap-2 px-2 text-left" aria-label={job.title} onClick={() => onOpenJob(job)}>
                  <JobMark job={job} accent={accent} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-card-foreground">{job.title}</span>
                    <JobSubtitle job={job} />
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground group-hover:opacity-0 group-focus-within:opacity-0" aria-hidden />
                </button>
                <span className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" data-testid="coding-job-watch" aria-label="Watch" className="grid size-8 place-items-center rounded-md hover:bg-background" onClick={() => onOpenJob(job)}>
                        <Eye className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Watch</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <a data-testid="coding-job-open" aria-label="Open" href={jobOpenHref(botId, job)} target="_blank" rel="noopener noreferrer" className="grid size-8 place-items-center rounded-md text-[color:var(--bot-accent)] hover:bg-background">
                        <ArrowUpRight className="h-4 w-4" />
                      </a>
                    </TooltipTrigger>
                    <TooltipContent side="top">Open</TooltipContent>
                  </Tooltip>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <section data-testid="routines-list" aria-label="Routines">
        <h2 className="text-xs font-medium text-muted-foreground">Routines</h2>
        {routines.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No routines yet.</p> : null}
        {routines.length > 0 ? (
          <ul className="mt-2 rounded-xl bg-card px-2.5 py-1 text-card-foreground">
            {routines.map((routine) => {
              const enabled = routine.enabled !== false;
              return (
                <li key={routine.id} className="flex min-h-11 items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-card-foreground">{routine.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{routineSchedule(routine.cron)}</p>
                  </div>
                  <Switch
                    data-testid="routine-toggle"
                    className="bot-toggle"
                    checked={enabled}
                    aria-label={`${routine.name} routine`}
                    onCheckedChange={(value) => onToggleRoutine(routine, value)}
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
      <span className="sr-only">
        <BotAvatar botId={botId} shape={avatarShape} color={avatarColor} size={1} />
      </span>
    </div>
  );
}

export function JobMention({ job, accent, botId, onOpen }: { job: CodingJob; accent: string; botId?: string; onOpen: () => void }) {
  const href = jobOpenHref(botId, job);
  const external = isExternalHref(href);
  return (
    <LinkPill
      href={href}
      title={job.title}
      testId="job-mention"
      className="mx-0.5"
      onClick={
        external
          ? undefined
          : (event) => {
              event.preventDefault();
              onOpen();
            }
      }
    />
  );
}

export function JobDetailDialog({ job, accent, onClose }: { job: CodingJob | null; accent: string; onClose: () => void }) {
  return (
    <Dialog open={!!job} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="coding-job-detail">
        {job ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span style={{ ["--bot-accent" as string]: accent }}>
                  <JobMark job={job} accent={accent} />
                </span>
                {job.title}
              </DialogTitle>
              <DialogDescription>{jobSubtitle(job) ?? liveStepText(job)}</DialogDescription>
            </DialogHeader>
            <p className="text-sm">{isActiveJob(job.status) ? liveStepText(job) : job.status}</p>
            {job.prUrl ? (
              <a className="text-sm text-brand underline" href={job.prUrl} target="_blank" rel="noopener noreferrer">
                Open pull request
              </a>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function JobResultCard({ job, accent, onOpen }: { job: CodingJob; accent: string; onOpen: () => void }) {
  const failed = job.status === "failed";
  const running = isActiveJob(job.status);
  const prHref = job.prUrl || "";
  return (
    <article data-testid="job-result-card" data-status={job.status} className="w-full max-w-md rounded-2xl border border-border bg-card p-3 text-card-foreground shadow-sm">
      <button type="button" className="flex w-full items-start gap-3 text-left" aria-label={job.title} onClick={onOpen}>
        <span className="min-w-0 flex-1 truncate text-base font-semibold">{job.title}</span>
        {running ? (
          <span data-testid="job-result-running" className="job-spinner mt-0.5" style={{ ["--bot-accent" as string]: accent }} role="img" aria-label="Running" />
        ) : failed ? (
          <span data-testid="job-result-failed" className="grid size-5 shrink-0 place-items-center rounded-full bg-destructive text-destructive-foreground" role="img" aria-label="Failed">
            <X className="h-3 w-3" />
          </span>
        ) : job.status === "merged" ? (
          <span data-testid="job-result-succeeded" className="grid size-5 shrink-0 place-items-center rounded-full bg-success text-on-accent" role="img" aria-label="Merged">
            <Check className="h-3 w-3" />
          </span>
        ) : (
          <span data-testid="job-result-succeeded" className="grid size-5 shrink-0 place-items-center rounded-full border border-muted-foreground text-muted-foreground" role="img" aria-label="Finished">
            <Check className="h-3 w-3" />
          </span>
        )}
      </button>
      {job.branch || job.prNumber ? (
        <button type="button" className="mt-2 flex w-full items-center gap-2 text-left text-sm" onClick={onOpen}>
          <GitBranch className="size-4 shrink-0 text-sage" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sage">{job.branch}</span>
          {job.prNumber ? <span className="shrink-0 text-muted-foreground">PR #{job.prNumber}</span> : null}
        </button>
      ) : null}
      <button type="button" className="mt-1 flex w-full items-center gap-2 text-left text-sm text-muted-foreground" onClick={onOpen}>
        <span aria-hidden>±</span>
        <span>{filesChangedLabel(job.filesChanged)}</span>
        <span className="text-sage">+{job.additions}</span>
        <span className="text-destructive">-{job.deletions}</span>
      </button>
      <div className="mt-3 flex items-center gap-2">
        {prHref ? (
          <a
            data-testid="job-result-pr"
            href={prHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 min-w-0 flex-1 items-center justify-center rounded-xl bg-primary text-sm font-medium text-primary-foreground"
          >
            View PR
          </a>
        ) : (
          <button type="button" data-testid="job-result-pr" disabled className="inline-flex h-11 min-w-0 flex-1 items-center justify-center rounded-xl bg-primary text-sm font-medium text-primary-foreground opacity-50">
            View PR
          </button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" data-testid="job-result-open" aria-label="Open job" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-border bg-card hover:bg-accent" onClick={onOpen}>
              <Box className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Open job</TooltipContent>
        </Tooltip>
      </div>
    </article>
  );
}

export function LiveJobStep({
  job,
  botId,
  botName,
  shape,
  color,
}: {
  job: CodingJob;
  botId?: string;
  botName: string;
  shape?: string;
  color?: string;
}) {
  return (
    <p data-testid="coding-job-step" className="flex items-center gap-2 text-sm text-muted-foreground">
      <BotAvatar botId={botId} shape={shape} color={color} size={16} />
      <span>
        <span className="sr-only">{botName} </span>
        {liveStepText(job)}
      </span>
    </p>
  );
}
