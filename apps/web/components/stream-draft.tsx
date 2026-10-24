"use client";
import { useEffect, useState } from 'react';
import { Markdown } from '@/components/markdown';
import { parseAgentEvent, subscribeEvents, type AgentEvent } from '@/lib/events';
import { frameBatch, mergeToolDelta, type ToolDelta } from '@/lib/event-patches';
import { toolLabel } from '@/lib/tool-status';

type Draft = { taskId: string; roundId: string; text: string; tools: ToolDelta[] };
/** This leaf owns token updates; the history list never renders for token arrivals. */
export function StreamDraft({botId, completed, onText, onTool}: {botId?: string; completed: string[]; onText?: () => void; onTool?: () => void}) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  useEffect(() => {
    const batch = frameBatch<AgentEvent>(events => {
      setDrafts(current => {
        let next = current;
        for (const event of events) {
          if (event.type === 'stream.gap') { next = []; continue; }
          if (event.type === 'model.error' || ['failed','cancelled','completed'].includes(String((event.task as {status?: string} | undefined)?.status ?? event.status))) { next = next.filter(d => d.taskId !== event.taskId); continue; }
          if (event.type === 'model.started') { next = next.filter(d => d.taskId !== event.taskId); continue; }
          if (!['message.delta','tool.delta'].includes(event.type) || !event.taskId || typeof event.roundId !== 'string') continue;
          const draft = next.find(d => d.taskId === event.taskId && d.roundId === event.roundId) ?? {taskId:event.taskId,roundId:event.roundId,text:'',tools:[]};
          const updated = event.type === 'message.delta'
            ? {...draft,text:(draft.text + String(event.delta ?? '')).slice(0,1_000_000)}
            : {...draft,tools:mergeToolDelta(draft.tools.filter(t => t.index !== Number(event.index)),{index:Number(event.index),name:String(event.name ?? '')})};
          next = [...next.filter(d => d.taskId !== event.taskId),updated].slice(-10);
        }
        return next;
      });
      if (events.some(e => e.type === 'message.delta')) onText?.();
      if (events.some(e => e.type === 'tool.delta')) onTool?.();
    },requestAnimationFrame,cancelAnimationFrame);
    const stop = subscribeEvents(data => {
      const event = parseAgentEvent(data);
      if (event && (event.botId === botId || event.type === 'stream.gap')) batch.push(event);
    });
    return () => { stop(); batch.stop(); };
  },[botId,onText,onTool]);
  return <>{drafts.filter(d => !completed.includes(d.taskId)).map(d => <div key={`${d.taskId}-${d.roundId}`}>
    {d.tools.map(t => <div data-testid="tool-call-card" role="status" key={t.index} className="mb-2 rounded-md border border-border px-3 py-2 text-sm">{toolLabel(t.name ?? '')}</div>)}
    {d.text ? <div data-testid="streaming-text" data-task-id={d.taskId} className="rounded-md bg-assistant-bubble p-3 text-sm"><Markdown text={d.text} /><span aria-hidden className="inline-block h-4 w-1 animate-pulse bg-foreground" /></div> : null}
  </div>)}</>;
}
