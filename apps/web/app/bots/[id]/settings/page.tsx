"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { cardClass, controlClass, PageError, PageSkeleton, pillClass, SectionTitle } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

type Bot = {
  id?: string;
  name?: string;
  role?: string;
  instructions?: string;
  status?: string;
  notificationsEnabled?: boolean;
};

export default function TeammateSettingsPage() {
  const params = useParams<{ id: string }>();
  const botId = typeof params.id === "string" ? params.id : "";
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [notifications, setNotifications] = useState(true);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!botId) return;
    let live = true;
    api<{ bot?: Bot }>(`/api/bots/${botId}/workspace`)
      .then((body) => {
        if (!live) return;
        const bot = body.bot ?? {};
        setName(bot.name ?? "");
        setRole(bot.role ?? "");
        setInstructions(bot.instructions ?? "");
        setNotifications(bot.notificationsEnabled !== false);
        setStatus(bot.status ?? "");
        setError(null);
      })
      .catch((caught) => {
        if (live) setError(errorMessage(caught, "This teammate could not be loaded."));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [botId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    setError(null);
    try {
      await api(`/api/bots/${botId}`, {
        method: "PATCH",
        body: JSON.stringify({ name, role, instructions, notifications }),
      });
      setSaved(true);
    } catch (caught) {
      setError(errorMessage(caught, "Could not save teammate settings."));
    }
  }

  return (
    <main data-testid="teammate-settings-page" className="mx-auto flex w-full max-w-[var(--content-width)] flex-col gap-[var(--space-section)] px-[var(--space-page)] py-[var(--space-page)]">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-body-sm text-muted-foreground">
            <Link href={botId ? `/bots/${botId}` : "/"} className="underline">
              Back to chat
            </Link>
          </p>
          <h1 className="mt-2 text-title">Teammate settings</h1>
          <p className="mt-1 text-body-sm text-muted-foreground">Name, role, and notifications for this teammate.</p>
        </div>
        {status ? <span className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-meta capitalize">{status}</span> : null}
      </header>
      {loading ? <PageSkeleton /> : null}
      {error && loading === false && !name ? <PageError title="Could not load this teammate." detail={error} /> : null}
      {!loading && (name || !error) ? (
        <form data-testid="teammate-settings-form" className={`${cardClass} flex flex-col gap-4 p-4`} onSubmit={(event) => void save(event)}>
          <SectionTitle>Profile</SectionTitle>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="teammate-name">Name</Label>
              <Input id="teammate-name" data-testid="teammate-name" className={`${controlClass} min-h-11`} value={name} onChange={(event) => setName(event.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="teammate-role">Role</Label>
              <Input id="teammate-role" data-testid="teammate-role" className={`${controlClass} min-h-11`} value={role} onChange={(event) => setRole(event.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="teammate-instructions">Instructions</Label>
            <Textarea id="teammate-instructions" data-testid="teammate-instructions" className={`${controlClass} min-h-28`} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
          </div>
          <div className="flex min-h-11 items-center justify-between gap-3 border-t border-border pt-4">
            <div>
              <p className="text-body-sm">Notifications</p>
              <p className="text-meta text-muted-foreground">Tell this teammate when work finishes.</p>
            </div>
            <Switch data-testid="teammate-notifications" checked={notifications} onCheckedChange={setNotifications} aria-label="Notifications" />
          </div>
          {error && name ? <p role="alert" className="text-body-sm text-destructive">{error}</p> : null}
          {saved ? <p role="status" className="text-body-sm text-muted-foreground">Settings saved.</p> : null}
          <div className="flex justify-end">
            <Button type="submit" className={pillClass}>
              Save
            </Button>
          </div>
        </form>
      ) : null}
    </main>
  );
}
