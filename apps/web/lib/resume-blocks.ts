export type ResumeReason = "lease_expired" | "computer_recovered" | "network_interrupted" | "attempt_limit";
export type ResumeCardReason = "budget_reached" | "no_progress" | "resume_exhausted";

export type ResumeBlock =
  | { kind: "resume"; count: number; attempt: number; reason: ResumeReason; stepsUsed: number; current: string; firstAt: string; lastAt: string }
  | { kind: "resume_card"; reason: ResumeCardReason; state: "open" | "continued" | "stopped"; taskId: string; stepsUsed: number; maxSteps: number; secondsUsed: number; maxSeconds: number; current: string };

const resumeReasons = new Set<ResumeReason>(["lease_expired", "computer_recovered", "network_interrupted", "attempt_limit"]);
const cardReasons = new Set<ResumeCardReason>(["budget_reached", "no_progress", "resume_exhausted"]);
const states = new Set(["open", "continued", "stopped"]);
const clamp = (value: unknown, min = 0, max = 1_000_000): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : null;
const shortText = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 500 ? value : null;

export function parseResumeBlock(record: unknown): ResumeBlock | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const item = record as Record<string, unknown>;
  if (item.type === "resume") {
    if (typeof item.reason !== "string" || !resumeReasons.has(item.reason as ResumeReason)) return null;
    const count = clamp(item.count, 1, 10_000);
    const attempt = clamp(item.attempt, 1, 10_000);
    const stepsUsed = clamp(item.stepsUsed);
    const current = shortText(item.current);
    const firstAt = shortText(item.firstAt);
    const lastAt = shortText(item.lastAt);
    if (count === null || attempt === null || stepsUsed === null || current === null || firstAt === null || lastAt === null || !Number.isFinite(Date.parse(firstAt)) || !Number.isFinite(Date.parse(lastAt))) return null;
    return { kind: "resume", count, attempt, reason: item.reason as ResumeReason, stepsUsed, current, firstAt, lastAt };
  }
  if (item.type === "resume_card") {
    if (typeof item.reason !== "string" || !cardReasons.has(item.reason as ResumeCardReason) || typeof item.state !== "string" || !states.has(item.state)) return null;
    const taskId = typeof item.taskId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.taskId) ? item.taskId : null;
    const values = [item.stepsUsed, item.maxSteps, item.secondsUsed, item.maxSeconds].map((value) => clamp(value));
    const current = shortText(item.current);
    if (!taskId || values.some((value) => value === null) || current === null) return null;
    const [stepsUsed, maxSteps, secondsUsed, maxSeconds] = values as number[];
    return { kind: "resume_card", reason: item.reason as ResumeCardReason, state: item.state as "open" | "continued" | "stopped", taskId, stepsUsed, maxSteps, secondsUsed, maxSeconds, current };
  }
  return null;
}

export function resumeText(block: Extract<ResumeBlock, { kind: "resume" }>): string {
  return block.count === 1
    ? `Resumed after an interruption (attempt ${block.attempt}). Continuing: ${block.current}`
    : `Resumed ${block.count} times in the last 12 min. Continuing: ${block.current}`;
}

export function cardCopy(reason: ResumeCardReason): string {
  switch (reason) {
    case "budget_reached": return "I reached my step or time budget and paused. Continue to give me more.";
    case "no_progress": return "I stopped after two attempts with no progress, so I don't loop. Tell me what to do or continue.";
    case "resume_exhausted": return "I was restarted too many times this hour and stopped. Continue when you're ready.";
  }
}
