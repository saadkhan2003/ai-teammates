"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
    void load().catch((caught) => setError(errorMessage(caught, "Could not load policy.")));
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
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">Action policy</CardTitle>
            <CardDescription>Risky classes ask before the tool runs. A hard deny still wins.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 p-4 pt-0 md:grid-cols-2">
            {CLASSES.map((name) => (
              <div key={name} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                <Label htmlFor={`policy-${name}`} className="text-sm font-normal">
                  {name}
                </Label>
                <Select value={classes[name] ?? "ASK"} onValueChange={(value) => setClasses((current) => ({ ...current, [name]: value }))}>
                  <SelectTrigger id={`policy-${name}`} data-testid={`policy-${name}`} className="h-9 w-28 rounded-md">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {mode}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </CardContent>
        </Card>
        <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
          <div>
            <p className="text-sm">Model assist</p>
            <p className="text-xs text-muted-foreground">Classify plugin tools. Built-in tools stay on the class rules.</p>
          </div>
          <Switch data-testid="policy-model-assist" checked={assist} onCheckedChange={setAssist} aria-label="Model-assisted classifier for plugin tools" />
        </div>
        <Button type="submit" size="sm" className="w-fit rounded-md">
          Save policy
        </Button>
      </form>
      <form className="flex flex-col gap-4" onSubmit={(event) => void saveNetwork(event)}>
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">Network policy</CardTitle>
            <CardDescription>Controls outbound hosts for this account. Entries accept domains, *.domain, IP/CIDR, and host:port.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 p-4 pt-0">
            <Select value={networkMode} onValueChange={(value) => setNetworkMode(value as typeof networkMode)}>
              <SelectTrigger aria-label="Network policy mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="allow_all">Allow all</SelectItem>
                <SelectItem value="defaults_with_team">Defaults plus team entries</SelectItem>
                <SelectItem value="team_only">Team entries only</SelectItem>
              </SelectContent>
            </Select>
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
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">Hard deny list</CardTitle>
            <CardDescription>Admin only. Built-in rules cannot be removed, and approval cannot override them.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 p-4 pt-0">
            <ul className="flex flex-col gap-2" data-testid="deny-list">
              {rules.map((rule) => (
                <li key={rule.code} className="rounded-lg border border-border px-3 py-2 text-sm">
                  <span className="font-medium">{rule.code}</span>
                  {rule.builtin ? <span className="ml-2 text-xs text-muted-foreground">built-in</span> : null}
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
              <Button type="submit" size="sm" variant="outline" className="mt-6 rounded-md">
                Add rule
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
