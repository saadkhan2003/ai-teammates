import type { AgentEvent } from "./events";
import type { Task } from "./types";

const active = new Set(["queued", "planning", "running"]);

/** Video analysis runs without a desktop. An established desktop keeps its normal lifecycle. */
export function computerVideoProgress(tasks: Task[], events: AgentEvent[], hasDesktopSession: boolean): AgentEvent | null {
  if (hasDesktopSession) return null;
  const byId = new Map(tasks.map(task => [task.id, task]));
  const progress = events.findLast(event => event.type === "video_progress"
    && (typeof event.taskId !== "string" || !byId.has(event.taskId) || active.has(byId.get(event.taskId)!.status.toLowerCase())));
  if (progress) return progress;
  const task = tasks.find(task => active.has(task.status.toLowerCase()) && (task.kind === "video"
    || /\b(?:watch|watching|analyze|analyzing|analyse|analysing|summarize|summarise)\b.*\bvideo\b/i.test(`${task.title ?? ""} ${task.instruction ?? ""}`)));
  return task ? { type: "video_progress", taskId: task.id, stage: "Preparing video" } : null;
}
