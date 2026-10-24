"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsSelect } from "@/components/settings-select";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

type Rule = { id: string; botId: string | null; botName?: string | null; actionClass: string; tool: string; matcher: { kind: string; host?: string; prefix?: string }; createdAt: string; lastUsedAt?: string | null; useCount: number };

export function ApprovalRulesSettings() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [bots, setBots] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function load() { const [items, teammates] = await Promise.all([api<Rule[]>("/api/approval-rules"), api<Array<{ id: string; name: string }>>("/api/bots")]); setRules(items); setBots(teammates); }
  useEffect(() => { void load().catch((caught) => setError(errorMessage(caught, "Could not load approval rules."))); }, []);

  async function update(rule: Rule, patch: { botId?: string | null; matcher?: Record<string, string> }) {
    setBusy(rule.id); setError(null);
    try { await api(`/api/approval-rules/${rule.id}`, { method: "PATCH", body: JSON.stringify(patch) }); await load(); toast.success("Approval rule updated."); }
    catch (caught) { setError(errorMessage(caught, "Could not update approval rule.")); }
    finally { setBusy(null); }
  }

  async function revoke(rule: Rule) {
    if (!window.confirm("Revoke this approval rule? Future matching actions will ask again.")) return;
    setBusy(rule.id); setError(null);
    try { await api(`/api/approval-rules/${rule.id}`, { method: "DELETE" }); await load(); toast.success("Approval rule revoked."); }
    catch (caught) { setError(errorMessage(caught, "Could not revoke approval rule.")); }
    finally { setBusy(null); }
  }

  return <Card><CardHeader className="p-4"><CardTitle className="text-sm">Approval rules</CardTitle><CardDescription>Rules skip the approval prompt only for the saved scope. Denials and security checks still apply.</CardDescription></CardHeader><CardContent className="space-y-3 p-4 pt-0">
    {rules.length === 0 ? <p data-testid="approval-rules-empty" className="text-sm text-muted-foreground">No approval rules yet.</p> : rules.map((rule) => <div key={rule.id} data-testid="approval-rule" className="space-y-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-medium">{rule.tool.replaceAll("_", " ")}</p><p className="break-all text-xs text-muted-foreground">{rule.matcher.host ?? rule.matcher.prefix ?? (rule.matcher.kind === "command" ? "Exact command" : rule.matcher.kind === "recipient" ? "Same recipient" : "Scoped action")}</p></div><span className="rounded-md border px-2 py-1 text-xs">{rule.botId ? rule.botName ?? "This bot" : "All my bots"}</span></div>
      <p className="text-xs text-muted-foreground">Last used: {rule.lastUsedAt ? new Date(rule.lastUsedAt).toLocaleString() : "Never"} · {rule.useCount} uses</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor={`scope-${rule.id}`}>Applies to</Label><SettingsSelect value={rule.botId ?? "all"} disabled={busy === rule.id} onValueChange={value => void update(rule, { botId: value === "all" ? null : value })} id={`scope-${rule.id}`} options={[{ value: "all", label: "All my bots" }, ...bots.map(bot => ({ value: bot.id, label: bot.name }))]} /></div>
        {(rule.matcher.kind === "host" || rule.matcher.kind === "prefix") ? <div className="space-y-1"><Label htmlFor={`matcher-${rule.id}`}>{rule.matcher.kind === "host" ? "Host" : "Path prefix"}</Label><div className="flex gap-2"><Input id={`matcher-${rule.id}`} defaultValue={rule.matcher.host ?? rule.matcher.prefix} disabled={busy === rule.id} onBlur={(event) => { const value = event.currentTarget.value.trim(); const key = rule.matcher.kind === "host" ? "host" : "prefix"; const old = rule.matcher[key]; if (value && value !== old) void update(rule, { matcher: { ...rule.matcher, [key]: value } as Record<string, string> }); }} /><Button size="sm" variant="outline" disabled={busy === rule.id} onClick={() => { const input = document.getElementById(`matcher-${rule.id}`) as HTMLInputElement | null; if (input) input.blur(); }}>Save</Button></div></div> : null}
      </div>
      <Button size="sm" variant="outline" disabled={busy === rule.id} onClick={() => void revoke(rule)}>Revoke</Button>
    </div>)}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </CardContent></Card>;
}
