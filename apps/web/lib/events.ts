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
      report("open");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped && gen === generation) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
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
          if (dataLines.length) onMessage(dataLines.join("\n"));
        }
        if (lastId) report("open");
      }
    } catch {
      // The visibility or online handler aborts the reader on purpose.
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
  };
}
