"use client";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { StateMessage } from "@/components/state-message";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { cardClass, controlClass, PageError, PageSkeleton, pillClass, SectionTitle } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsSelect } from "@/components/settings-select";
import { SettingsSwitch as Switch } from "@/components/settings-switch";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

const CLASSES = ["read", "write", "send_message", "payment", "sign", "delete", "credential_use", "external_post", "bot_message", "bot_manage"];
const MODES = ["ALLOW", "ASK", "DENY"];

type PolicyResponse = {
  classes?: Record<string, string>;
  modelAssist?: boolean;
};

type DenyRule = {
  code: string;
  description?: string;
  pattern?: string;
  builtin?: boolean;
};

type NetworkPolicyResponse = { mode?: "allow_all" | "defaults_with_team" | "team_only"; entries?: string[]; groups?: string[]; locked?: boolean; failClosed?: boolean };

export default function PolicySettingsPage() {
  const [classes, setClasses] = useState<Record<string, string>>({});
  const [assist, setAssist] = useState(false);
  const [role, setRole] = useState("");
  const [rules, setRules] = useState<DenyRule[]>([]);
  const [code, setCode] = useState("");
  const [pattern, setPattern] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [networkMode, setNetworkMode] = useState<"allow_all" | "defaults_with_team" | "team_only">("team_only");
  const [networkEntries, setNetworkEntries] = useState("");
  const [networkGroups, setNetworkGroups] = useState("");
  const [networkLocked, setNetworkLocked] = useState(false);
  const [networkFailClosed, setNetworkFailClosed] = useState(false);

  async function load() {
    const policy = await api<PolicyResponse>("/api/policy");
    const network = await api<NetworkPolicyResponse>("/api/network-policy");
    setNetworkMode(network.mode ?? "team_only");
    setNetworkEntries((network.entries ?? []).join("\n"));
    setNetworkGroups((network.groups ?? []).join("\n"));
    setNetworkLocked(Boolean(network.locked));
    setNetworkFailClosed(Boolean(network.failClosed));
    setClasses(policy.classes ?? {});
    setAssist(Boolean(policy.modelAssist));
    const me = await api<{ role?: string }>("/api/auth/me");
    setRole(me.role ?? "");
    if (me.role === "owner" || me.role === "admin") {
      const body = await api<{ rules?: DenyRule[] }>("/api/admin/policy/deny-list");
      setRules(body.rules ?? []);
    }
  }

  useEffect(() => {
    void load()
      .catch((caught) => setError(errorMessage(caught, "Could not load policy.")))
      .finally(() => setLoading(false));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api("/api/policy", {
        method: "PUT",
        body: JSON.stringify({ classes, modelAssist: assist }),
      });
      toast.success("Policy saved.");
    } catch (caught) {
      setError(errorMessage(caught, "Could not save policy."));
    }
  }

  async function saveNetwork(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api("/api/network-policy", {
        method: "PUT",
        body: JSON.stringify({
          mode: networkMode,
          entries: networkEntries.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
          groups: networkGroups.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
          locked: networkLocked,
          failClosed: networkFailClosed,
        }),
      });
      toast.success("Network policy saved.");
    } catch (caught) {
      setError(errorMessage(caught, "Could not save network policy."));
    }
  }

  async function addRule(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api("/api/admin/policy/deny-list", {
        method: "POST",
        body: JSON.stringify({ code, pattern, description }),
      });
      setCode("");
      setPattern("");
      setDescription("");
      await load();
    } catch (caught) {
      setError(errorMessage(caught, "Could not add that rule."));
    }
  }

  const staff = role === "owner" || role === "admin";

  return (
    <div id="policy" className="flex flex-col gap-[var(--space-section)]">
      <header>
        <h2 className="text-title">Policy</h2>
        <p className="mt-1 text-body-sm text-muted-foreground">Risky classes ask before the tool runs. A hard deny still wins.</p>
      </header>
      {loading && !error ? <PageSkeleton /> : null}
      {error && Object.keys(classes).length === 0 ? <PageError title="Could not load policy." detail={error} onRetry={() => void load().catch((caught) => setError(errorMessage(caught, "Could not load policy.")))} /> : null}
      <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
        <section className={`${cardClass} p-4`}>
          <SectionTitle>Action rules</SectionTitle>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {CLASSES.map((name) => (
                <div key={name} className={`${controlClass} flex min-h-11 items-center justify-between gap-3 border border-border px-3 transition-colors hover:bg-accent/40`}>
                <Label htmlFor={`policy-${name}`} className="text-body-sm font-normal">
                  {name}
                </Label>
                <SettingsSelect value={classes[name] ?? "ASK"} onValueChange={value => setClasses(current => ({ ...current, [name]: value }))} id={`policy-${name}`} data-testid={`policy-${name}`} className="h-9 w-28 rounded-md" options={MODES.map(value => ({ value, label: value }))} />
              </div>
            ))}
          <div className="flex min-h-11 items-center justify-between gap-3 border-t border-border pt-4 md:col-span-2">
              <div>
                <p className="text-body-sm">Tool assist</p>
                <p className="text-meta text-muted-foreground">Classify plugin tools. Built-in tools stay on the class rules.</p>
              </div>
              <Switch data-testid="policy-model-assist" checked={assist} onCheckedChange={setAssist} aria-label="Assisted classifier for plugin tools" />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button type="submit" className={pillClass}>Save policy</Button>
          </div>
        </section>
      </form>
      <form className="flex flex-col gap-4" onSubmit={(event) => void saveNetwork(event)}>
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">Network policy</CardTitle>
            <CardDescription>Controls outbound hosts for this account. Entries accept domains, *.domain, IP/CIDR, and host:port.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 p-4 pt-0">
            <SettingsSelect value={networkMode} onValueChange={value => setNetworkMode(value as typeof networkMode)} aria-label="Network policy mode" options={[{ value: "allow_all", label: "Allow all" }, { value: "defaults_with_team", label: "Defaults plus team entries" }, { value: "team_only", label: "Team entries only" }]} />
            <div className="grid gap-3 md:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="network-entries">Entries (one per line)</Label>
                <textarea id="network-entries" className="min-h-32 rounded-md border border-border bg-background p-2 text-sm" value={networkEntries} onChange={(event) => setNetworkEntries(event.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="network-groups">Group entries (one per line)</Label>
                <textarea id="network-groups" className="min-h-32 rounded-md border border-border bg-background p-2 text-sm" value={networkGroups} onChange={(event) => setNetworkGroups(event.target.value)} />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div><p className="text-sm">Lock policy</p><p className="text-xs text-muted-foreground">When locked, group entries are ignored.</p></div>
              <Switch checked={networkLocked} onCheckedChange={setNetworkLocked} aria-label="Lock network policy" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div><p className="text-sm">Fail closed when desktop route is lost</p><p className="text-xs text-muted-foreground">After the 90 second reconnect grace period, block outbound traffic instead of using the server route.</p></div>
              <Switch checked={networkFailClosed} onCheckedChange={setNetworkFailClosed} aria-label="Fail closed for egress" />
            </div>
          </CardContent>
        </Card>
        <Button type="submit" size="sm" className="w-fit rounded-md">Save network policy</Button>
      </form>
      {staff ? (
        <section className={`${cardClass} flex flex-col gap-4 p-4`}>
          <div>
            <SectionTitle>Hard deny list</SectionTitle>
            <p className="mt-1 text-body-sm text-muted-foreground">Staff only. Built-in rules cannot be removed, and approval cannot override them.</p>
          </div>
            <ul className="flex flex-col gap-2" data-testid="deny-list">
              {rules.map((rule) => (
                <li key={rule.code} className={`${controlClass} flex min-h-11 flex-col justify-center border border-border px-3 py-2 text-body-sm`}>
                  <span className="font-medium">{rule.code}</span>
                  {rule.builtin ? <span className="ml-2 text-meta text-muted-foreground">built-in</span> : null}
                  {rule.description ? <p className="text-muted-foreground">{rule.description}</p> : null}
                </li>
              ))}
            </ul>
            <form className="grid gap-2 md:grid-cols-4" onSubmit={(event) => void addRule(event)}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="deny-code">Code</Label>
                <Input id="deny-code" data-testid="deny-code" value={code} onChange={(event) => setCode(event.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="deny-pattern">Pattern</Label>
                <Input id="deny-pattern" data-testid="deny-pattern" value={pattern} onChange={(event) => setPattern(event.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="deny-description">Description</Label>
                <Input id="deny-description" value={description} onChange={(event) => setDescription(event.target.value)} />
              </div>
              <div className="flex items-end justify-end">
                <Button type="submit" variant="outline" className={pillClass}>
                  Add rule
                </Button>
              </div>
            </form>
        </section>
      ) : null}
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
