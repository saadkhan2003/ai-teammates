"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { StateMessage } from "@/components/state-message";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  api,
  isOpenRouterSecret,
  normalizeSecret,
  normalizeSecrets,
  normalizeUsage,
  readSecretTest,
  splitList,
} from "@/lib/api";
import type { SecretRecord, SecretTestResult, SecretUsageEvent } from "@/lib/types";
import { errorMessage, formatWhen } from "@/lib/utils";

const SECRET_TYPES = [
  "API_KEY",
  "PASSWORD",
  "TOKEN",
  "OAUTH_REFRESH_TOKEN",
  "PLUGIN_CREDENTIAL",
  "SSH_PRIVATE_KEY",
  "WEBHOOK_SECRET",
  "DATABASE_CREDENTIAL",
  "GENERIC",
];

const OPENROUTER_DRAFT = { namespace: "openrouter", name: "default", type: "API_KEY" };

function TestReadout({ result }: { result: SecretTestResult | null }) {
  if (!result) return null;
  return (
    <div>
      <p className={result.state === "valid" ? "text-sage" : "text-clay"}>{result.state}</p>
      {typeof result.limitRemaining === "number" ? <p>limitRemaining: {result.limitRemaining}</p> : null}
    </div>
  );
}

export default function SecretsPage() {
  const [secrets, setSecrets] = useState<SecretRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [testResult, setTestResult] = useState<SecretTestResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [usage, setUsage] = useState<SecretUsageEvent[]>([]);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [addName, setAddName] = useState("");
  const [addNamespace, setAddNamespace] = useState("");
  const [addType, setAddType] = useState("API_KEY");
  const [addValue, setAddValue] = useState("");
  const [addDomains, setAddDomains] = useState("");
  const [addTools, setAddTools] = useState("");
  const [addExpires, setAddExpires] = useState("");
  const [addBots, setAddBots] = useState("");
  const [usageNonce, setUsageNonce] = useState(0);

  const openRouter = secrets.find(isOpenRouterSecret) ?? null;

  const load = useCallback(async () => {
    try {
      const next = normalizeSecrets(await api<unknown>("/api/secrets"));
      setSecrets(next);
      setError(null);
      setSelectedId((current) => {
        if (current) return current;
        return next.find(isOpenRouterSecret)?.id ?? next[0]?.id ?? null;
      });
    } catch (caught) {
      setError(errorMessage(caught, "Could not load secrets."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setUsage([]);
      return;
    }
    let cancelled = false;
    setUsageLoading(true);
    void api<unknown>(`/api/secrets/${selectedId}/usage`)
      .then((data) => {
        if (cancelled) return;
        setUsage(normalizeUsage(data) as SecretUsageEvent[]);
        setUsageError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setUsage([]);
        setUsageError(errorMessage(caught, "Could not load usage."));
      })
      .finally(() => {
        if (!cancelled) setUsageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, usageNonce]);

  async function testDraft() {
    setBusy("test-draft");
    setFormError(null);
    try {
      const data = await api<unknown>("/api/secrets/test", {
        method: "POST",
        body: JSON.stringify({ ...OPENROUTER_DRAFT, value }),
      });
      setTestResult(readSecretTest(data));
    } catch (caught) {
      setFormError(errorMessage(caught, "Could not test that key."));
    } finally {
      setBusy(null);
    }
  }

  async function saveOpenRouter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("save");
    setFormError(null);
    const draft = value;
    try {
      const created = normalizeSecret(
        await api<unknown>("/api/secrets", {
          method: "POST",
          body: JSON.stringify({ ...OPENROUTER_DRAFT, value: draft }),
        }),
      );
      setValue("");
      setTestResult(null);
      if (created.id) setSelectedId(created.id);
      toast.success("OpenRouter key saved.");
      await load();
    } catch (caught) {
      setFormError(errorMessage(caught, "Could not save that key."));
    } finally {
      setBusy(null);
    }
  }

  async function testSaved(secret: SecretRecord) {
    setBusy("test-saved");
    setFormError(null);
    try {
      const result = readSecretTest(await api<unknown>(`/api/secrets/${secret.id}/test`, { method: "POST" }));
      setTestResult(result);
      setSecrets((current) => current.map((item) => (item.id === secret.id ? { ...item, validationStatus: result.state } : item)));
    } catch (caught) {
      setFormError(errorMessage(caught, "Could not test the saved key."));
    } finally {
      setBusy(null);
    }
  }

  async function rotate(secret: SecretRecord) {
    const next = window.prompt("New value");
    if (next == null) return;
    if (!next) {
      setFormError("Enter a new value to rotate this secret.");
      return;
    }
    setBusy("rotate");
    setFormError(null);
    try {
      await api(`/api/secrets/${secret.id}/rotate`, {
        method: "POST",
        body: JSON.stringify({ value: next }),
      });
      setTestResult(null);
      setSelectedId(secret.id);
      setUsageNonce((current) => current + 1);
      toast.success("Secret rotated. The new value is not shown.");
      await load();
    } catch (caught) {
      setFormError(errorMessage(caught, "Could not rotate that secret."));
    } finally {
      setBusy(null);
    }
  }

  async function remove(secret: SecretRecord) {
    setBusy("delete");
    setFormError(null);
    try {
      await api(`/api/secrets/${secret.id}`, { method: "DELETE" });
      setTestResult(null);
      setValue("");
      setSelectedId(secret.id);
      setUsageNonce((current) => current + 1);
      toast.success("Secret deleted.");
      await load();
    } catch (caught) {
      setFormError(errorMessage(caught, "Could not delete that secret."));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(secret: SecretRecord) {
    setBusy("revoke");
    setFormError(null);
    try {
      await api(`/api/secrets/${secret.id}/revoke`, { method: "POST" });
      setSelectedId(secret.id);
      setUsageNonce((current) => current + 1);
      toast.success("Secret revoked. Resolution fails immediately.");
      await load();
    } catch (caught) {
      setFormError(errorMessage(caught, "Could not revoke that secret."));
    } finally {
      setBusy(null);
    }
  }

  async function addSecret(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("add");
    setFormError(null);
    const draft = addValue;
    try {
      await api("/api/secrets", {
        method: "POST",
        body: JSON.stringify({
          name: addName,
          namespace: addNamespace,
          type: addType,
          value: draft,
          allowedDomains: splitList(addDomains),
          allowedTools: splitList(addTools),
          expiresAt: addExpires || null,
          allowedBotIds: splitList(addBots),
        }),
      });
      setAddName("");
      setAddNamespace("");
      setAddType("API_KEY");
      setAddValue("");
      setAddDomains("");
      setAddTools("");
      setAddExpires("");
      setAddBots("");
      toast.success("Secret saved. The value is not shown again.");
      await load();
    } catch (caught) {
      setFormError(errorMessage(caught, "Could not add that secret."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header>
        <h2 className="text-body-sm font-medium">Vault</h2>
        <p className="mt-2 text-body-sm text-muted-foreground">
          Values are write-only. Bots see references such as secret://openrouter/default, never the raw secret.
        </p>
      </header>

      {loading ? <StateMessage title="Loading secrets…" detail="Checking which keys are already stored." /> : null}
      {!loading && error ? (
        <StateMessage
          tone="error"
          title="Could not load secrets."
          detail={error}
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      ) : null}

      {!loading && !error && !openRouter ? (
        <Card>
          <CardHeader>
            <CardTitle>OpenRouter API Key</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-4" onSubmit={saveOpenRouter}>
              <div className="flex flex-col gap-2">
                <Label htmlFor="secret-value">API key</Label>
                <Input
                  id="secret-value"
                  data-testid="secret-value"
                  type="password"
                  autoComplete="new-password"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  required
                />
              </div>
              <p>Used securely by the model gateway. Bots never receive the raw key.</p>
              <TestReadout result={testResult} />
              {formError ? (
                <p role="alert" className="text-body-sm text-clay">
                  {formError}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button data-testid="test-connection" type="button" variant="secondary" disabled={busy !== null} onClick={() => void testDraft()}>
                  Test connection
                </Button>
                <Button data-testid="save-secret" type="submit" disabled={busy !== null}>
                  Save securely
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {!loading && !error && openRouter ? (
        <Card>
          <CardHeader>
            <CardTitle>OpenRouter</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p data-testid="connected-banner" className="text-sage">Connected ✓</p>
            <p data-testid="masked-suffix">Key ending in: ...{openRouter.maskedSuffix}</p>
            <TestReadout result={testResult} />
            {formError ? (
              <p role="alert" className="text-body-sm text-clay">
                {formError}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void testSaved(openRouter)}>
                  Test
                </Button>
                <Button data-testid="rotate-secret" type="button" variant="secondary" disabled={busy !== null} onClick={() => void rotate(openRouter)}>
                  Rotate
                </Button>
              </div>
              <Button data-testid="delete-secret" type="button" variant="destructive" disabled={busy !== null} onClick={() => void remove(openRouter)}>
                Delete
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!loading && !error ? (
        <Card>
          <CardHeader>
            <CardTitle>Add secret</CardTitle>
          </CardHeader>
          <CardContent>
            <form data-testid="add-secret" className="grid gap-3 sm:grid-cols-2" onSubmit={addSecret}>
              <div className="flex flex-col gap-2">
                <Label htmlFor="add-name">Name</Label>
                <Input id="add-name" name="name" value={addName} onChange={(event) => setAddName(event.target.value)} required />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="add-namespace">Namespace</Label>
                <Input id="add-namespace" name="namespace" value={addNamespace} onChange={(event) => setAddNamespace(event.target.value)} required />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="add-type">Type</Label>
                <select
                  id="add-type"
                  name="type"
                  value={addType}
                  onChange={(event) => setAddType(event.target.value)}
                  className="h-10 rounded-md border border-input bg-card px-3 text-body-sm"
                >
                  {SECRET_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <p className="text-meta text-muted-foreground">OAuth and connector credentials are stored as plugin credentials.</p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="add-value">Value</Label>
                <Input
                  id="add-value"
                  name="value"
                  type="password"
                  autoComplete="new-password"
                  value={addValue}
                  onChange={(event) => setAddValue(event.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-2 sm:col-span-2">
                <Label htmlFor="add-domains">Allowed domains</Label>
                <Input
                  id="add-domains"
                  name="allowedDomains"
                  value={addDomains}
                  onChange={(event) => setAddDomains(event.target.value)}
                  placeholder="example.com, api.example.com"
                />
              </div>
              <div className="flex flex-col gap-2 sm:col-span-2">
                <Label htmlFor="add-tools">Allowed tools</Label>
                <Input
                  id="add-tools"
                  name="allowedTools"
                  value={addTools}
                  onChange={(event) => setAddTools(event.target.value)}
                  placeholder="plugin:stripe"
                />
              </div>
              <div className="flex flex-col gap-2 sm:col-span-2">
                <Label htmlFor="add-expires">Expiry</Label>
                <Input id="add-expires" type="datetime-local" value={addExpires} onChange={(event) => setAddExpires(event.target.value)} />
              </div>
              <div className="flex flex-col gap-2 sm:col-span-2">
                <Label htmlFor="add-bots">Bot grants</Label>
                <Input id="add-bots" value={addBots} onChange={(event) => setAddBots(event.target.value)} placeholder="Bot ids, comma separated. Empty means every bot." />
              </div>
              {formError && openRouter ? (
                <p role="alert" className="text-body-sm text-clay sm:col-span-2">
                  {formError}
                </p>
              ) : null}
              <div className="flex justify-end sm:col-span-2">
                <Button type="submit" disabled={busy !== null}>
                  Add secret
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {!loading && !error ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-h1">Stored secrets</h2>
          {secrets.length === 0 ? <p className="text-body-sm text-muted-foreground">No secrets stored yet.</p> : null}
          <ul className="flex flex-col gap-2">
            {secrets.map((secret) => (
              <li key={secret.id} data-testid="secret-row" data-ref={`secret://${secret.namespace}/${secret.name}`} className="min-w-0 max-w-full rounded-lg border border-line bg-paper px-4 py-3">
                <button
                  type="button"
                  data-testid="secret-select"
                  onClick={() => setSelectedId(secret.id)}
                  className="w-full text-left"
                >
                  <p className="break-all font-medium">
                    secret://{secret.namespace}/{secret.name}
                  </p>
                  <p className="text-body-sm text-muted-foreground">
                    {secret.type} · {secret.maskedSuffix ? `····${secret.maskedSuffix}` : "••••"} · last used {formatWhen(secret.lastUsedAt)}
                    {secret.revokedAt ? " · revoked" : ""}
                  </p>
                </button>
                <div className="mt-2 flex flex-wrap gap-2">
                  {secret.revokedAt ? null : (
                    <Button data-testid="secret-revoke" type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => void revoke(secret)}>
                      Revoke
                    </Button>
                  )}
                  <Button data-testid="secret-row-delete" type="button" size="sm" variant="destructive" disabled={busy !== null} onClick={() => void remove(secret)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section data-testid="secret-usage" className="rounded-lg border border-line bg-paper p-4">
        <h2 className="font-display text-h1">Usage</h2>
        {!selectedId ? <p className="mt-2 text-body-sm text-muted-foreground">Save a secret to see its usage.</p> : null}
        {usageLoading ? <p className="mt-2 text-body-sm text-muted-foreground">Loading usage…</p> : null}
        {usageError ? (
          <p role="alert" className="mt-2 text-body-sm text-clay">
            Could not load usage. {usageError}
          </p>
        ) : null}
        {selectedId && !usageLoading && !usageError && usage.length === 0 ? (
          <p className="mt-2 text-body-sm text-muted-foreground">No usage recorded for this secret.</p>
        ) : null}
        <ul className="mt-3 flex flex-col gap-3">
          {usage.map((event) => (
            <li key={event.id} className="border-b border-line pb-3 text-body-sm last:border-0">
              <p className="font-medium">{event.event || "event"}</p>
              <p className="text-muted-foreground">
                {[event.createdAt ? formatWhen(event.createdAt) : "", event.actor, event.tool, event.destination, event.decision, event.reasonCode]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
