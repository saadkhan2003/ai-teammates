"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { cardClass, controlClass, PageError, PageSkeleton, pillClass, SectionTitle } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
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
  const [loading, setLoading] = useState(true);

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
    <>
      <header>
        <h2 className="text-xl font-semibold tracking-tight">Policy</h2>
        <p className="mt-1 text-sm text-muted-foreground">Risky classes ask before the tool runs. A hard deny still wins.</p>
      </header>
      {loading && !error ? <PageSkeleton /> : null}
      {error && Object.keys(classes).length === 0 ? <PageError title="Could not load policy." detail={error} onRetry={() => void load().catch((caught) => setError(errorMessage(caught, "Could not load policy.")))} /> : null}
      <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
        <section className={`${cardClass} p-4`}>
          <SectionTitle>Action rules</SectionTitle>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {CLASSES.map((name) => (
                <div key={name} className={`${controlClass} flex min-h-11 items-center justify-between gap-3 border border-border px-3 transition-colors hover:bg-accent/40`}>
                <Label htmlFor={`policy-${name}`} className="text-sm font-normal">
                  {name}
                </Label>
                <Select value={classes[name] ?? "ASK"} onValueChange={(value) => setClasses((current) => ({ ...current, [name]: value }))}>
                  <SelectTrigger id={`policy-${name}`} data-testid={`policy-${name}`} className="h-9 w-28 rounded-full">
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
          <div className="flex min-h-11 items-center justify-between gap-3 border-t border-border pt-4 md:col-span-2">
              <div>
                <p className="text-sm">Tool assist</p>
                <p className="text-xs text-muted-foreground">Classify plugin tools. Built-in tools stay on the class rules.</p>
              </div>
              <Switch data-testid="policy-model-assist" checked={assist} onCheckedChange={setAssist} aria-label="Assisted classifier for plugin tools" />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button type="submit" className={pillClass}>Save policy</Button>
          </div>
        </section>
      </form>
      {staff ? (
        <section className={`${cardClass} flex flex-col gap-4 p-4`}>
          <div>
            <SectionTitle>Hard deny list</SectionTitle>
            <p className="mt-1 text-sm text-muted-foreground">Staff only. Built-in rules cannot be removed, and approval cannot override them.</p>
          </div>
            <ul className="flex flex-col gap-2" data-testid="deny-list">
              {rules.map((rule) => (
                <li key={rule.code} className={`${controlClass} flex min-h-11 flex-col justify-center border border-border px-3 py-2 text-sm`}>
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
              <div className="flex items-end justify-end">
                <Button type="submit" variant="outline" className={pillClass}>
                  Add rule
                </Button>
              </div>
            </form>
        </section>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}
