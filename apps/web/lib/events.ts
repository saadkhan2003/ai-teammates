import { REFRESH_EVENT, reportFailure, reportSuccess } from "@/lib/connection";

export type StreamStatus = {
  state: "open" | "reconnecting" | "closed";
  lastId: string;
};

// Reads the app event stream and resumes with Last-Event-ID after the phone
// backgrounds the tab or the network returns. A new EventSource cannot set
// that header, so this uses fetch.
export function subscribeEvents(onMessage: (data: string) => void, onStatus?: (status: StreamStatus) => void): () => void {
  let lastId = "";
  let stopped = false;
  let generation = 0;
  let abort: AbortController | null = null;
  let timer = 0;

  const report = (state: StreamStatus["state"]) => onStatus?.({ state, lastId });
  const hidden = () => document.visibilityState === "hidden";

  const connect = async () => {
    if (stopped || hidden()) return;
    const gen = ++generation;
    abort?.abort();
    const local = new AbortController();
    abort = local;
    window.clearTimeout(timer);
    report("reconnecting");
    try {
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (lastId) headers["Last-Event-ID"] = lastId;
      const response = await fetch("/api/events", { headers, signal: local.signal, cache: "no-store" });
      if (gen !== generation || stopped) return;
      if (response.status === 401) {
        report("closed");
        return;
      }
      if (!response.ok || !response.body) throw new Error(String(response.status));
      reportSuccess();
      report("open");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped && gen === generation) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        if (buffer.length > 2_000_000) throw new Error("Event frame too large");
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          if (!chunk || chunk.startsWith(":")) continue;
          let id = "";
          const dataLines: string[] = [];
          for (const line of chunk.split("\n")) {
            if (line.startsWith("id:")) id = line.slice(3).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
          }
          if (id) lastId = id;
          if (dataLines.length) {
            try { onMessage(dataLines.join("\n")); } catch { /* A malformed event must not disconnect the stream. */ }
          }
        }
        if (lastId) report("open");
      }
    } catch {
      // The visibility or online handler aborts the reader on purpose; only a
      // still-current attempt counts as a connection failure.
      if (gen === generation && !stopped && !hidden()) reportFailure();
    } finally {
      if (gen === generation && !stopped && !hidden()) {
        report("reconnecting");
        timer = window.setTimeout(() => void connect(), 1000);
      }
    }
  };

  const onVisible = () => {
    if (hidden()) {
      generation += 1;
      abort?.abort();
      report("reconnecting");
      return;
    }
    void connect();
  };

  const onRefresh = () => { window.clearTimeout(timer); void connect(); };
  window.addEventListener(REFRESH_EVENT, onRefresh);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onVisible);
  void connect();

  return () => {
    stopped = true;
    generation += 1;
    abort?.abort();
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onVisible);
    window.removeEventListener(REFRESH_EVENT, onRefresh);
  };
}

export type AgentEvent = { type: string; botId?: string; taskId?: string; [key: string]: unknown };
export function parseAgentEvent(data: string): AgentEvent | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.type !== "string") return null;
    return record as AgentEvent;
  } catch { return null; }
}

export function mergeAgentEvent(current: AgentEvent[], event: AgentEvent): AgentEvent[] {
  if (["delta", "message.delta", "text_delta"].includes(event.type)) {
    const index = current.findIndex(item => item.taskId === event.taskId && ["delta", "message.delta", "text_delta"].includes(item.type));
    const incoming = typeof event.delta === "string" ? event.delta : typeof event.text === "string" ? event.text : "";
    if (index >= 0) return current.map((item, i) => i === index ? { ...item, ...event, delta: (String(item.delta ?? item.text ?? "") + incoming).slice(0, 1_000_000) } : item);
  }
  const callId = event.callId ?? event.toolCallId ?? event.id;
  if (event.type === "video_progress") {
    const index = current.findIndex(item => item.taskId === event.taskId && item.type === "video_progress");
    if (index >= 0) return current.map((item, i) => i === index ? { ...item, ...event } : item);
  }
  const toolEvent = ["tool", "tool_call", "tool_result"].includes(event.type);
  if (event.type === "grounding" || (toolEvent && callId != null)) {
    const index = current.findIndex(item => item.taskId === event.taskId && (event.type === "grounding" ? item.type === "grounding" : ["tool", "tool_call", "tool_result"].includes(item.type) && (item.callId ?? item.toolCallId ?? item.id) === callId));
    if (index >= 0) return current.map((item, i) => i === index ? { ...item, ...event } : item);
  }
  return [...current.slice(-99), event];
}
