"use client";

import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import type { LoginField, LoginRequest } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

const masked = new Set(["password", "otp", "username", "email"]);

export function LoginCard({ request, onDone }: { request: LoginRequest; onDone: () => void }) {
  const fields = request.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [save, setSave] = useState(false);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const payload: Record<string, string> = {};
    for (const field of fields) {
      const kind = field.kind;
      if (!kind) continue;
      payload[kind] = values[kind] ?? "";
    }
    try {
      await api(`/api/login-requests/${request.id}`, {
        method: "POST",
        body: JSON.stringify({ values: payload, saveToVault: save }),
      });
      setValues({});
      setDone(true);
      onDone();
    } catch (caught) {
      setError(errorMessage(caught, "Could not submit the login."));
    } finally {
      for (const key of Object.keys(payload)) payload[key] = "";
      setPending(false);
    }
  }

  async function cancel() {
    setPending(true);
    setError(null);
    try {
      await api(`/api/login-requests/${request.id}/cancel`, { method: "POST" });
      setValues({});
      setDone(true);
      onDone();
    } catch (caught) {
      setError(errorMessage(caught, "Could not cancel the login."));
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <Card data-testid="login-card" data-state="done" className="min-w-0 max-w-full">
        <CardHeader className="p-4">
          <CardTitle className="text-body-sm">Done ✓</CardTitle>
          <CardDescription className="break-words">{request.domain}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card data-testid="login-card" data-state="open" className="min-w-0 max-w-full">
      <CardHeader className="p-4">
        <CardTitle className="text-body-sm">Sign in</CardTitle>
        <CardDescription>
          Domain <strong data-testid="login-domain">{request.domain}</strong>
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <p className="text-body-sm text-muted-foreground">The values stay in this form. The bot does not see them.</p>
        <form className="mt-3 flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
          {fields.map((field) => (
            <Field
              key={field.kind}
              field={field}
              value={values[field.kind] ?? ""}
              onChange={(next) => setValues((current) => ({ ...current, [field.kind]: next }))}
            />
          ))}
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="login-save-vault" className="text-body-sm font-normal">
              Save to vault
            </Label>
            <Switch id="login-save-vault" data-testid="login-save-vault" checked={save} onCheckedChange={setSave} />
          </div>
          <div className="flex gap-2">
            <Button data-testid="login-card-submit" type="submit" size="sm" className="rounded-md" disabled={pending}>
              Submit
            </Button>
            <Button data-testid="login-card-cancel" type="button" size="sm" variant="outline" className="rounded-md" disabled={pending} onClick={() => void cancel()}>
              Cancel
            </Button>
          </div>
        </form>
        {error ? (
          <p role="alert" className="mt-2 text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Field({ field, value, onChange }: { field: LoginField; value: string; onChange: (value: string) => void }) {
  const label = field.label || field.kind;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`login-${field.kind}`}>{label}</Label>
      <Input
        id={`login-${field.kind}`}
        data-testid={`login-field-${field.kind}`}
        type={masked.has(field.kind) ? "password" : "text"}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
