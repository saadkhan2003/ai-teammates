export const JOB_STATUSES = ["queued", "running", "tests", "finished", "merged", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type CodingJob = {
  id: string;
  title: string;
  status: JobStatus;
  step: string;
  prNumber: number | null;
  prUrl: string;
  branch: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  updatedAt?: string;
  taskId?: string;
};

const ACTIVE = new Set<JobStatus>(["queued", "running", "tests"]);

export function readableAccent(color?: string): string {
  const hex = /^#[0-9a-fA-F]{6}$/.test(color ?? "") ? (color as string) : "#111111";
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.82 ? "#111111" : hex;
}

export function normalizeJobStatus(value: unknown): JobStatus {
  const text = String(value ?? "").trim().toLowerCase();
  return (JOB_STATUSES as readonly string[]).includes(text) ? (text as JobStatus) : "running";
}

export function normalizeCodingJob(entry: unknown, index = 0): CodingJob | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id ? record.id : `job-${index + 1}`;
  const title = String(record.title ?? "Coding job").trim() || "Coding job";
  const prRaw = record.prNumber ?? record.pr_number;
  const prNumber = typeof prRaw === "number" ? prRaw : typeof prRaw === "string" && /^\d+$/.test(prRaw) ? Number(prRaw) : null;
  return {
    id,
    title,
    status: normalizeJobStatus(record.status),
    step: String(record.step ?? "").trim(),
    prNumber,
    prUrl: String(record.prUrl ?? record.pr_url ?? ""),
    branch: String(record.branch ?? "").trim(),
    filesChanged: countOf(record.filesChanged ?? record.files_changed),
    additions: countOf(record.additions),
    deletions: countOf(record.deletions),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : typeof record.updated_at === "string" ? record.updated_at : undefined,
    taskId: typeof record.taskId === "string" ? record.taskId : undefined,
  };
}

function countOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return 0;
}

export function showsJobResult(job: Pick<CodingJob, "status" | "branch" | "prNumber" | "prUrl">): boolean {
  const status = normalizeJobStatus(job.status);
  if (status === "finished" || status === "merged" || status === "failed") return true;
  if (status === "queued") return false;
  return Boolean(job.branch.trim() || job.prNumber || job.prUrl);
}

export function filesChangedLabel(count: number): string {
  const total = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return `${total} ${total === 1 ? "file" : "files"} changed`;
}

export function applyCodingJob(current: CodingJob[], incoming: CodingJob): CodingJob[] {
  const index = current.findIndex((job) => job.id === incoming.id);
  if (index < 0) return [...current, incoming];
  return current.map((job, item) => (item === index ? { ...job, ...incoming } : job));
}

export function jobCountLabel(jobs: { status: string }[]): string {
  const count = jobs.length;
  const live = jobs.some((job) => ACTIVE.has(normalizeJobStatus(job.status)));
  const noun = live ? (count === 1 ? "agent" : "agents") : count === 1 ? "job" : "jobs";
  return `${count} ${noun}`;
}

export function jobSubtitle(job: Pick<CodingJob, "status" | "prNumber">): string | null {
  if (job.status === "merged") return job.prNumber ? `Merged · #${job.prNumber}` : "Merged";
  if (job.status === "failed") return "Failed";
  if (job.status === "finished") return job.prNumber ? `Ready for review · #${job.prNumber}` : "Finished";
  if (job.prNumber && isActiveJob(job.status)) return `Ready for review · #${job.prNumber}`;
  return null;
}

export type JobIconKind = "spinner" | "pr" | "merged" | "failed" | "finished";

export function jobIconKind(job: Pick<CodingJob, "status" | "prNumber" | "prUrl">): JobIconKind {
  if (isActiveJob(job.status)) return "spinner";
  if (job.status === "merged") return "merged";
  if (job.status === "failed") return "failed";
  if (job.prNumber || job.prUrl) return "pr";
  return "finished";
}

export function controlActionLabel(mode: "view" | "control", needsHelp: boolean): "Take control" | "Stop" | "I'm done" {
  if (mode === "view") return "Take control";
  return needsHelp ? "I'm done" : "Stop";
}

export function copyBotName(name: string): string {
  const base = name.trim() || "Teammate";
  return / copy$/i.test(base) ? base : `${base} copy`;
}

export function templateShareUrl(origin: string, botId: string): string {
  const root = origin.replace(/\/$/, "");
  return `${root}/bots/${botId}?template=1`;
}

export function isActiveJob(status: string): boolean {
  return ACTIVE.has(normalizeJobStatus(status));
}

export function liveJob(jobs: CodingJob[]): CodingJob | null {
  const active = jobs.filter((job) => isActiveJob(job.status));
  if (active.length === 0) return null;
  return [...active].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
}

export function liveStepText(job: CodingJob): string {
  if (job.step.trim()) return job.step.trim();
  if (job.status === "tests") return "Running test suites";
  if (job.status === "queued") return "Queued";
  return "Running";
}

export function visibleReactions<T extends { actorType?: string }>(role: string, reactions: T[] | undefined | null): T[] {
  return (reactions ?? []).filter((reaction) => role === "user" || reaction.actorType !== "bot");
}

export const QUICK_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉"] as const;

export const EXTRA_EMOJIS = ["😀", "😅", "😍", "🤔", "😢", "🔥", "✅", "🙏", "🚀", "✨", "👀", "💯"] as const;

export const QUOTE_HIGHLIGHT_MS = 3000;

export function reactionTooltip(actor: string, name: string, emoji: string): string {
  const who = actor === "bot" ? name : name || "You";
  return `${who} reacted with ${emoji}`;
}

export function pickerSide(spaceBelow: number, pickerHeight = 40): "above" | "below" {
  return spaceBelow < pickerHeight + 8 ? "above" : "below";
}

export function optionLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 25) return "";
  return String.fromCharCode(65 + index);
}

export function newMessagesLabel(count: number): string {
  const total = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return total === 1 ? "↓ 1 new message" : `↓ ${total} new messages`;
}

export function quotePlacement(role: string): "above" | "inside" {
  return role === "user" ? "above" : "inside";
}

export function truncateUrl(value: string, max = 36): string {
  const text = value.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function linkTitle(href: string, label: string, jobs: Array<Pick<CodingJob, "id" | "title" | "prUrl">> = []): string {
  const job = jobs.find((item) => (item.prUrl && href === item.prUrl) || (item.id.length > 0 && href.includes(item.id)));
  const named = job?.title.trim();
  if (named) return named;
  const text = label.trim();
  return text || href;
}

export function replySnippet(content: string): string {
  const text = content.replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`[\]]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "Message";
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

export function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export function isAppHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

export function safeHref(href: string): string | null {
  if (isExternalHref(href) || isAppHref(href)) return href;
  return null;
}

export function linkDisplayUrl(href: string): string {
  if (isAppHref(href)) return href;
  try {
    const url = new URL(href);
    const path = `${url.pathname}${url.search}`.replace(/\/$/, "");
    return `${url.host}${path && path !== "/" ? path : ""}`;
  } catch {
    return href;
  }
}

export function jobOpenHref(botId: string | undefined, job: Pick<CodingJob, "id" | "prUrl">): string {
  if (job.prUrl) return job.prUrl;
  if (botId) return `/bots/${botId}/jobs/${job.id}`;
  return `/jobs/${job.id}`;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function routineSchedule(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron || "Custom schedule";
  const [minute, hour, dom, month, dow] = parts;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return "Custom schedule";
  const h = Number(hour);
  const m = Number(minute);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12;
  const clock = `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
  if (dom === "*" && month === "*" && (dow === "*" || dow === "?")) return `Every day at ${clock}`;
  if (dom === "*" && month === "*" && /^\d$/.test(dow)) {
    const day = DAYS[Number(dow)] ?? "that day";
    return `Every ${day} at ${clock}`;
  }
  return cron;
}

export function splitJobMentions(text: string): Array<{ kind: "text"; text: string } | { kind: "job"; id: string }> {
  const parts = text.split(/(\[\[job:[0-9a-fA-F-]{8,}\]\])/g);
  return parts.filter(Boolean).map((part) => {
    const match = part.match(/^\[\[job:([0-9a-fA-F-]{8,})\]\]$/);
    return match ? { kind: "job" as const, id: match[1] } : { kind: "text" as const, text: part };
  });
}
