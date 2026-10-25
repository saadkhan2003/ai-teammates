import type { AgentEvent } from './events';
import type { Bot, ChatMessage, Task, Workspace } from './types';

export function mergeRows<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const updates = new Map(incoming.map(row => [row.id, row]));
  const result = current.map(row => { const update = updates.get(row.id); updates.delete(row.id); return update ? { ...row, ...update } : row; });
  return [...result, ...updates.values()];
}
const localEvents = new Set(['model.started','model.finished','model.error','message.delta','tool.delta','grounding','tool','tool_call','tool_result','memory','plan','step','status','compacted']);
export function patchWorkspace(current: Workspace, event: AgentEvent): Workspace | null {
  if (event.type === 'stream.gap' || event.type === 'invalidate') return null;
  if (event.botId && event.botId !== current.bot.id) return current;
  const task = event.task as Task | undefined;
  const messages = event.messages as ChatMessage[] | undefined;
  const bot = event.bot as Bot | undefined;
  const pages = Array.isArray(event.pages) ? event.pages as Workspace['pages'] : undefined;
  if (!task && !messages && !bot && !pages && !localEvents.has(event.type) && event.type !== 'computer.mode') return null;
  if (!task && !messages && !bot && !pages && event.type !== "computer.mode") return current;
  const next = { ...current,
    bot: bot ? { ...current.bot, ...bot } : current.bot,
    tasks: task ? mergeRows(current.tasks, [task]) : current.tasks,
    messages: messages ? mergeRows(current.messages, messages) : current.messages,
    approvals: Array.isArray(event.approvals) ? event.approvals as Workspace['approvals'] : current.approvals,
    pages: pages ?? current.pages,
  };
  if (event.type === 'computer.mode') next.holder = event.mode === 'control' ? 'human' : 'agent';
  return next;
}
export function patchRoster<T extends { id: string }>(current: T[], event: AgentEvent): T[] | null {
  if (event.bot && typeof event.bot === 'object') return mergeRows(current, [event.bot as T]);
  if (event.type === 'bot.deleted') return current.filter(bot => bot.id !== event.botId);
  if (event.type === 'bots' || event.type === 'invalidate' || event.type === 'stream.gap') return null;
  if (event.taskId || event.botId || localEvents.has(event.type)) return current;
  return null;
}

export type ToolDelta = { index: number; id?: string; name?: string; arguments?: string };
export function mergeToolDelta(current: ToolDelta[], delta: ToolDelta): ToolDelta[] {
  const found = current.find(t => t.index === delta.index);
  const merged = { ...found, index: delta.index, id: (found?.id ?? '') + (delta.id ?? ''), name: (found?.name ?? '') + (delta.name ?? ''), arguments: (found?.arguments ?? '') + (delta.arguments ?? '') };
  return [...current.filter(t => t.index !== delta.index), merged].sort((a,b) => a.index-b.index);
}
/** One scheduled commit per animation frame, regardless of token frequency. */
export function frameBatch<T>(commit: (items: T[]) => void, request: (callback: FrameRequestCallback) => number, cancel: (id: number) => void) {
  let pending: T[] = []; let frame: number | null = null;
  return { push(item: T) { pending.push(item); if (frame === null) frame = request(() => { frame = null; const batch = pending; pending = []; commit(batch); }); }, stop() { if (frame !== null) cancel(frame); frame = null; pending = []; } };
}
