export type VideoAnalysisView = {
  summary?: string;
  duration?: number;
  timeline?: Array<{ timestamp?: number; summary?: string; text?: string }>;
};

export function readVideoAnalysis(content: string): VideoAnalysisView | null {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const analysis = value.videoAnalysis && typeof value.videoAnalysis === "object"
      ? value.videoAnalysis as Record<string, unknown> : value;
    if (typeof analysis.summary !== "string" || !Array.isArray(analysis.timeline)) return null;
    return {
      summary: analysis.summary,
      duration: typeof analysis.duration === "number" ? analysis.duration : undefined,
      timeline: analysis.timeline.filter((part): part is Record<string, unknown> => !!part && typeof part === "object")
        .map(part => ({
          timestamp: typeof part.timestamp === "number" ? part.timestamp : undefined,
          summary: typeof part.summary === "string" ? part.summary : typeof part.content === "string" ? part.content : undefined,
          text: typeof part.text === "string" ? part.text : undefined,
        })),
    };
  } catch { return null; }
}

export function timestampLabel(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
