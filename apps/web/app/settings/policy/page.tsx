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

const CLASSES = ["read", "write", "send_message", "payment", "sign", "delete", "credential_use", "external_post"];
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

export default function PolicySettingsPage() {
  const [classes, setClasses] = useState<Record<string, string>>({});
  const [assist, setAssist] = useState(false);
  const [role, setRole] = useState("");
  const [rules, setRules] = useState<DenyRule[]>([]);
  const [code, setCode] = useState("");
  const [pattern, setPattern] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const policy = await api<PolicyResponse>("/api/policy");
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
    <div id="policy" className="flex flex-col gap-4">
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
