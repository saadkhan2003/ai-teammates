"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { cardClass, DevBadge, PageEmpty, PageSkeleton, pillClass, SectionTitle } from "@/components/account/chrome";
import { SettingsFrame } from "@/components/settings-nav";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
      setRequestError(errorMessage(requestResult.reason, "Could not load prompts."));
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
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-title">System</h2>
          <p className="mt-1 text-body-sm text-muted-foreground">
            Health, invitations, and usage. Prompts are shown without credentials or raw request bodies.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DevBadge show={mock} />
          <Button variant="outline" className={pillClass} onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </header>
      {health?.computerIsolation === false ? (
        <p role="alert" data-testid="isolation-alert" className={`${cardClass} p-4 text-body-sm text-destructive`}>
          Computer isolation rules are missing. Computers will not start until the rules are installed again.
        </p>
      ) : null}
      {health ? (
        <section data-testid="admin-health" className="grid gap-[var(--space-card)] sm:grid-cols-2 lg:grid-cols-5">
          {[
            ["Postgres", health.postgres ? "up" : "down"],
            ["Isolation", health.computerIsolation === false ? "down" : "up"],
            ["Users", String(health.users ?? "—")],
            ["Computers", String(health.computers ?? "—")],
            ["Stuck tasks", String(health.stuckTasks ?? "—")],
          ].map(([label, value]) => (
            <article key={label} className={`${cardClass} p-4`}>
              <p className="text-meta font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className="mt-2 text-h2 tabular-nums">{value}</p>
            </article>
          ))}
        </section>
      ) : null}
      {health ? (
        <form className={`${cardClass} flex flex-col gap-4 p-4`} onSubmit={invite}>
          <div>
            <SectionTitle>Invite a member</SectionTitle>
            <p className="mt-1 text-body-sm text-muted-foreground">The token is shown once.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-email">Invite email</Label>
              <Input id="invite-email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} type="email" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger id="invite-role" className="min-h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">member</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {inviteToken ? <p className="text-meta text-muted-foreground">Token (shown once): {inviteToken}</p> : null}
          {inviteError ? <p className="text-body-sm text-destructive">{inviteError}</p> : null}
          <div className="flex justify-end">
            <Button type="submit" className={pillClass}>Invite</Button>
          </div>
        </form>
      ) : null}
      <section data-testid="outbound-actions" className={`${cardClass} p-4`}>
        <SectionTitle>Outbound actions</SectionTitle>
        <p className="mt-1 text-body-sm text-muted-foreground">Sends, posts, purchases, and plugin writes. A retry replays the stored result.</p>
        {outbound.length === 0 ? <div className="mt-4"><PageEmpty title="No outbound actions yet" detail="Sends and posts show up here." /></div> : (
          <table className="mt-4 w-full text-body-sm">
            <thead className="text-meta uppercase tracking-wide text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-3 text-left font-medium">Kind</th>
                <th className="py-3 text-left font-medium">Tool</th>
                <th className="py-3 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {outbound.map((row, index) => (
                <tr key={String(row.id ?? index)} className="border-b border-border last:border-0">
                  <td className="py-3">{String(row.kind ?? "action")}</td>
                  <td className="py-3 text-muted-foreground">{String(row.tool ?? "")}</td>
                  <td className="py-3 text-right"><span className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-meta capitalize">{String(row.status ?? "")}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {loading ? <PageSkeleton /> : null}
      <section data-testid="metrics-model-calls" className={`${cardClass} p-4`}>
        <p className="text-meta font-medium uppercase tracking-wide text-muted-foreground">Calls</p>
        <p className="mt-2 text-h1 tabular-nums">{modelCalls == null ? "—" : modelCalls}</p>
        <p data-testid="metrics-cost" className="mt-3 text-body-sm">
          Cost {costUsd == null ? "—" : `$${costUsd.toFixed(4)}`}
        </p>
        <p data-testid="metrics-latency" className="text-body-sm">
          Latency {latencyMs == null ? "—" : `${Math.round(latencyMs)} ms`}
        </p>
        <p data-testid="metrics-memory" className="text-body-sm">
          Computer memory {memoryBytes == null ? "—" : `${Math.round(memoryBytes / (1024 * 1024))} MB`}
        </p>
        <p data-testid="metrics-chrome" className="text-body-sm">
          Chrome processes {chromeProcesses == null ? "—" : chromeProcesses}
        </p>
        {usageError ? (
          <p role="alert" className="mt-2 text-body-sm text-clay">
            Could not load usage. {usageError}
          </p>
        ) : null}
      </section>
      <section className={`${cardClass} p-4`}>
        <SectionTitle>Prompts</SectionTitle>
        {requestError ? (
          <p role="alert" className="mt-2 text-body-sm text-clay">
            Could not load prompts. {requestError}
          </p>
        ) : null}
        {!loading && !requestError && prompts.length === 0 ? (
          <div className="mt-4"><PageEmpty title="No prompts yet" detail="Prompts show up here after a teammate runs." /></div>
        ) : null}
        <ScrollArea className="mt-3 h-[min(50dvh,520px)]">
          <ol className="flex flex-col gap-3">
            {prompts.map((row) => (
              <li key={row.id} className="flex min-h-11 flex-col justify-center rounded-control border border-border px-3 py-2">
                <p className="text-meta text-muted-foreground">{row.when ? formatWhen(row.when) : "Prompt"}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-body-sm">{row.prompt || "This request did not include a prompt."}</p>
              </li>
            ))}
          </ol>
        </ScrollArea>
      </section>
    </SettingsFrame>
  );
}
