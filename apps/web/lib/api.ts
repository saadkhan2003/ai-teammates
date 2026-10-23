import type { DesktopToken, SecretTestResult } from "@/lib/types";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function safeDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const detail = json.detail ?? json.title ?? json.error ?? json.message;
    if (typeof detail === "string") {
      return detail.replace(/\b(?:sk|ghp|github_pat|glpat|xox[baprs])-[A-Za-z0-9_\-]{6,}/g, "[redacted]").slice(0, 280);
    }
  } catch {
    if (trimmed.length <= 280 && !/sk-|ghp_|Bearer |password/i.test(trimmed)) return trimmed;
  }
  return "";
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
    cache: "no-store",
  });
  if (
    response.status === 401 &&
    typeof window !== "undefined" &&
    window.location.pathname !== "/login"
  ) {
    window.location.assign("/login");
  }
  return response;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(path, init);
  } catch {
    throw new ApiError(0, "The network request failed.");
  }
  if (response.status === 401) {
    throw new ApiError(401, "Sign in required.");
  }
  if (!response.ok) {
    const detail = safeDetail(await response.text().catch(() => ""));
    throw new ApiError(response.status, detail || `Request failed (${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) return undefined as T;
  return (await response.json()) as T;
}

export function asList(data: unknown, keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function normalizeFiles(data: unknown) {
  return asList(data, ["files", "entries", "items"]).map((entry, index) => {
    if (typeof entry === "string") {
      const name = entry.split("/").filter(Boolean).pop() || entry;
      return { path: entry, name, directory: false };
    }
    const record = (entry ?? {}) as Record<string, unknown>;
    const path = text(record.path || record.name || `file-${index + 1}`);
    const name = text(record.name) || path.split("/").filter(Boolean).pop() || path;
    const directory = record.directory === true || record.isDir === true || record.kind === "dir";
    const size = typeof record.size === "number" ? record.size : undefined;
    return { path, name, directory, size };
  });
}

export function normalizeMemories(data: unknown) {
  return asList(data, ["memories", "items"]).map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      id: text(record.id) || `memory-${index + 1}`,
      content: text(record.content ?? record.text),
      createdAt: text(record.createdAt ?? record.created_at) || undefined,
    };
  });
}

export function normalizeSkills(data: unknown) {
  return asList(data, ["skills", "items"]).map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      id: text(record.id) || `skill-${index + 1}`,
      name: text(record.name) || "Untitled skill",
      description: text(record.description ?? record.summary) || undefined,
      version: (record.version as string | number | undefined) ?? undefined,
    };
  });
}

export function normalizeRoutines(data: unknown) {
  return asList(data, ["routines", "items"]).map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      id: text(record.id) || `routine-${index + 1}`,
      name: text(record.name) || "Untitled routine",
      cron: text(record.cron),
      instruction: text(record.instruction) || undefined,
      nextRunAt: text(record.nextRunAt ?? record.next_run_at) || undefined,
      watchKind: text(record.watchKind ?? record.watch_kind) || undefined,
      watchRef: text(record.watchRef ?? record.watch_ref) || undefined,
    };
  });
}

export function normalizeArtifacts(data: unknown) {
  return asList(data, ["artifacts", "items"]).map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const name = text(record.name ?? record.filename) || "Artifact";
    return {
      id: text(record.id) || `artifact-${index + 1}`,
      name,
      title: text(record.title) || undefined,
      mime: text(record.mime ?? record.contentType ?? record.content_type) || undefined,
      createdAt: text(record.createdAt ?? record.created_at) || undefined,
    };
  });
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

export function normalizeSecrets(data: unknown) {
  return asList(data, ["secrets", "items"]).map((entry) => normalizeSecret(entry)).filter((item) => item.id);
}

export function normalizeSecret(entry: unknown) {
  const record = (entry ?? {}) as Record<string, unknown>;
  const masked = text(record.maskedSuffix ?? record.masked_suffix ?? record.suffix);
  return {
    id: text(record.id),
    name: text(record.name),
    namespace: text(record.namespace ?? record.provider) || "default",
    type: text(record.type) || "GENERIC",
    maskedSuffix: masked.replace(/^[.\u2022•…\s]+/, ""),
    validationStatus: text(record.validationStatus ?? record.validation_status) || undefined,
    lastUsedAt: text(record.lastUsedAt ?? record.last_used_at) || null,
    revokedAt: record.revokedAt || record.revoked_at ? text(record.revokedAt ?? record.revoked_at) : null,
    allowedDomains: stringList(record.allowedDomains ?? record.allowed_domains),
    allowedTools: stringList(record.allowedTools ?? record.allowed_tools),
  };
}

const USAGE_KEYS = [
  "event",
  "actor",
  "botId",
  "taskId",
  "tool",
  "destination",
  "decision",
  "reasonCode",
  "createdAt",
] as const;

export function normalizeUsage(data: unknown) {
  return asList(data, ["usage", "events", "items"]).map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const mapped: Record<string, string> = {
      id: text(record.id) || `usage-${index + 1}`,
      event: text(record.event),
      actor: text(record.actor),
      botId: text(record.botId ?? record.bot_id),
      taskId: text(record.taskId ?? record.task_id),
      tool: text(record.tool),
      destination: text(record.destination ?? record.domain),
      decision: text(record.decision),
      reasonCode: text(record.reasonCode ?? record.reason_code ?? record.reason),
      createdAt: text(record.createdAt ?? record.created_at ?? record.timestamp),
    };
    const safe = { id: mapped.id } as Record<(typeof USAGE_KEYS)[number] | "id", string>;
    safe.id = mapped.id;
    for (const key of USAGE_KEYS) safe[key] = mapped[key];
    return safe;
  });
}

export function readSecretTest(data: unknown): SecretTestResult {
  const record = (data ?? {}) as Record<string, unknown>;
  const raw = record.ok ?? record.valid ?? record.status ?? record.validationStatus ?? record.result;
  const state = raw === true || raw === "valid" || raw === "ok" ? "valid" : "invalid";
  const limit = record.limitRemaining ?? record.limit_remaining;
  if (typeof limit === "number" && Number.isFinite(limit)) return { state, limitRemaining: limit };
  if (typeof limit === "string" && limit.trim() && !Number.isNaN(Number(limit))) {
    return { state, limitRemaining: Number(limit) };
  }
  return { state };
}

export function readDesktopToken(data: unknown): DesktopToken {
  const record = (data ?? {}) as Record<string, unknown>;
  return {
    token: text(record.token),
    mode: text(record.mode) || "view",
  };
}

export function readModelCalls(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  for (const key of ["modelCalls", "model_calls", "totalModelCalls", "llmCalls"]) {
    if (typeof record[key] === "number") return record[key] as number;
  }
  for (const key of ["totals", "metrics", "usage"]) {
    if (record[key] && typeof record[key] === "object") {
      const nested = readModelCalls(record[key]);
      if (nested != null) return nested;
    }
  }
  return null;
}

export function readProvider(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  for (const key of ["llmProvider", "provider", "modelProvider"]) {
    if (typeof record[key] === "string" && (record[key] as string).trim()) return record[key] as string;
  }
  return null;
}

export function extractPrompt(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const record = entry as Record<string, unknown>;
  if (typeof record.prompt === "string") return record.prompt;
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.messages)) return "";
  return record.messages
    .map((message) => {
      if (!message || typeof message !== "object") return "";
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const textPart = (part as Record<string, unknown>).text;
          return typeof textPart === "string" ? textPart : "";
        })
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

export function isOpenRouterSecret(secret: { namespace?: string; name?: string }): boolean {
  return secret.namespace === "openrouter" && secret.name === "default";
}

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
