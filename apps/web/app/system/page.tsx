"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { SettingsFrame } from "@/components/settings-nav";
import { Input } from "@/components/ui/input";
import { StateMessage } from "@/components/state-message";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { asList, api, extractPrompt, readModelCalls, readProvider } from "@/lib/api";
import { errorMessage, formatWhen } from "@/lib/utils";

type PromptRow = { id: string; prompt: string; when?: string; model?: string };

function readPrompts(data: unknown): PromptRow[] {
  return asList(data, ["requests", "modelRequests", "items", "prompts"]).map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      id: typeof record.id === "string" ? record.id : `request-${index + 1}`,
      prompt: extractPrompt(entry),
      when: typeof record.createdAt === "string" ? record.createdAt : typeof record.created_at === "string" ? record.created_at : undefined,
      model: typeof record.model === "string" ? record.model : undefined,
    };
  });
}

export default function SystemPage() {
  const [costUsd, setCostUsd] = useState<number | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [chromeProcesses, setChromeProcesses] = useState<number | null>(null);
  const [memoryBytes, setMemoryBytes] = useState<number | null>(null);
  const [modelCalls, setModelCalls] = useState<number | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<PromptRow[]>([]);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [outbound, setOutbound] = useState<Array<Record<string, unknown>>>([]);

  const load = useCallback(async () => {
    const [usageResult, requestResult] = await Promise.allSettled([api<unknown>("/api/usage"), api<unknown>("/api/model-requests")]);
    if (usageResult.status === "fulfilled") {
      setModelCalls(readModelCalls(usageResult.value));
      setProvider(readProvider(usageResult.value));
      const usage = usageResult.value as Record<string, unknown>;
      setCostUsd(typeof usage.costUsd === "number" ? usage.costUsd : null);
      setLatencyMs(typeof usage.latencyMs === "number" ? usage.latencyMs : null);
      setChromeProcesses(typeof usage.chromeProcesses === "number" ? usage.chromeProcesses : null);
      setMemoryBytes(typeof usage.computerMemoryBytes === "number" ? usage.computerMemoryBytes : null);
      setUsageError(null);
    } else {
      setUsageError(errorMessage(usageResult.reason, "Could not load usage."));
    }
    if (requestResult.status === "fulfilled") {
      setPrompts(readPrompts(requestResult.value));
      setProvider((current) => current ?? readProvider(requestResult.value));
      setRequestError(null);
    } else {
      setRequestError(errorMessage(requestResult.reason, "Could not load model requests."));
    }
    setLoading(false);
    try {
      setHealth(await api<Record<string, unknown>>("/api/admin/health"));
    } catch {
      setHealth(null);
    }
    try {
      const rows = await api<unknown>("/api/admin/outbound-actions");
      setOutbound(asList(rows, ["actions", "items"]).filter((row): row is Record<string, unknown> => !!row && typeof row === "object"));
    } catch {
      setOutbound([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mock = provider?.toLowerCase() === "mock";

  async function invite(event: FormEvent) {
    event.preventDefault();
    setInviteError(null);
    setInviteToken(null);
    try {
      const created = await api<{ token?: string }>("/api/invitations", {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      setInviteToken(created.token ?? null);
      setInviteEmail("");
    } catch (caught) {
      setInviteError(errorMessage(caught, "Could not create that invitation."));
    }
  }

  return (
    <SettingsFrame>
      <div id="system" className="contents">
      {health?.computerIsolation === false ? (
        <p role="alert" data-testid="isolation-alert" className="rounded-lg border border-line bg-paper p-4 text-sm text-clay">
          Computer isolation rules are missing. Computers will not start until the rules are installed again.
        </p>
      ) : null}
      {health ? (
        <section data-testid="admin-health" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[
            ["Postgres", health.postgres ? "up" : "down"],
            ["Isolation", health.computerIsolation === false ? "down" : "up"],
            ["Users", String(health.users ?? "—")],
            ["Computers", String(health.computers ?? "—")],
            ["Stuck tasks", String(health.stuckTasks ?? "—")],
          ].map(([label, value]) => (
            <article key={label} className="rounded-lg border border-line bg-paper p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-2xl font-semibold">{value}</p>
            </article>
          ))}
        </section>
      ) : null}
      {health ? (
        <form className="flex flex-col gap-3 rounded-lg border border-line bg-paper p-5 sm:flex-row sm:items-end" onSubmit={invite}>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Invite email
            <Input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} type="email" required />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Role
            <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)} className="h-10 rounded-md border border-line bg-paper px-3 text-sm">
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <Button type="submit">Invite</Button>
          {inviteToken ? <p className="text-xs text-muted-foreground sm:basis-full">Token (shown once): {inviteToken}</p> : null}
          {inviteError ? <p className="text-sm text-clay sm:basis-full">{inviteError}</p> : null}
        </form>
      ) : null}
      <section data-testid="outbound-actions" className="rounded-lg border border-line bg-paper p-4">
        <h2 className="text-sm font-medium">Outbound actions</h2>
        <p className="mt-1 text-sm text-muted-foreground">Sends, posts, purchases, and plugin writes. A retry replays the stored result.</p>
        {outbound.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No outbound actions recorded yet.</p> : null}
        <ul className="mt-3 flex flex-col gap-2">
          {outbound.map((row, index) => (
            <li key={String(row.id ?? index)} className="text-sm">
              {String(row.kind ?? "action")} · {String(row.tool ?? "")} · {String(row.status ?? "")}
            </li>
          ))}
        </ul>
      </section>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-sm font-medium">System</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Model calls and recorded prompts. Prompts are shown without credentials or raw request bodies.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      </header>
      {loading ? <StateMessage title="Loading system metrics…" detail="Reading usage and recorded model requests." /> : null}
      {provider ? <p className="text-sm">Provider: {provider}</p> : null}
      {mock ? <p className="text-sm">Provider is mock. These calls stayed on this server and were not sent to OpenRouter.</p> : null}
      <section data-testid="metrics-model-calls" className="rounded-lg border border-line bg-paper p-5 shadow-none">
        <p className="text-sm text-muted-foreground">Model calls</p>
        <p className="text-2xl font-medium">{modelCalls == null ? "—" : modelCalls}</p>
        <p data-testid="metrics-cost" className="mt-3 text-sm">
          Cost {costUsd == null ? "—" : `$${costUsd.toFixed(4)}`}
        </p>
        <p data-testid="metrics-latency" className="text-sm">
          Latency {latencyMs == null ? "—" : `${Math.round(latencyMs)} ms`}
        </p>
        <p data-testid="metrics-memory" className="text-sm">
          Computer memory {memoryBytes == null ? "—" : `${Math.round(memoryBytes / (1024 * 1024))} MB`}
        </p>
        <p data-testid="metrics-chrome" className="text-sm">
          Chrome processes {chromeProcesses == null ? "—" : chromeProcesses}
        </p>
        {usageError ? (
          <p role="alert" className="mt-2 text-sm text-clay">
            Could not load usage. {usageError}
          </p>
        ) : null}
      </section>
      <section className="rounded-lg border border-line bg-paper p-4">
        <h2 className="text-sm font-medium">Prompts</h2>
        {requestError ? (
          <p role="alert" className="mt-2 text-sm text-clay">
            Could not load model requests. {requestError}
          </p>
        ) : null}
        {!loading && !requestError && prompts.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No model requests recorded yet.</p>
        ) : null}
        <ScrollArea className="mt-3 h-[min(50dvh,520px)]">
          <ol className="flex flex-col gap-3">
            {prompts.map((row) => (
              <li key={row.id} className="rounded-lg border border-line px-3 py-2">
                <p className="text-xs text-muted-foreground">{[row.model, row.when ? formatWhen(row.when) : ""].filter(Boolean).join(" · ") || "Prompt"}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">{row.prompt || "This request did not include a prompt."}</p>
              </li>
            ))}
          </ol>
        </ScrollArea>
      </section>
      </div>
    </SettingsFrame>
  );
}
