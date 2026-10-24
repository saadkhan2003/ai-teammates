"use client";

import { useCallback, useEffect, useState } from "react";
import { cardClass, PageEmpty, PageError, PageSkeleton, pillClass, SectionTitle } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { api, asList } from "@/lib/api";
import { errorMessage, formatWhen } from "@/lib/utils";

type Note = { id: string; title: string; body: string; kind: string; read: boolean; createdAt?: string };

function readNotes(data: unknown): Note[] {
  return asList(data, ["items", "notifications"]).map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      id: typeof record.id === "string" ? record.id : `note-${index + 1}`,
      title: typeof record.title === "string" ? record.title : "Notification",
      body: typeof record.body === "string" ? record.body : "",
      kind: typeof record.kind === "string" ? record.kind : "info",
      read: Boolean(record.readAt ?? record.read_at),
      createdAt: typeof record.createdAt === "string" ? record.createdAt : typeof record.created_at === "string" ? record.created_at : undefined,
    };
  });
}

export default function NotificationsPage() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setNotes(readNotes(await api<unknown>("/api/notifications")));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load notifications."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function markRead() {
    setBusy(true);
    try {
      await api("/api/notifications/read", { method: "POST" });
      await load();
    } catch (caught) {
      setError(errorMessage(caught, "Could not mark notifications read."));
    } finally {
      setBusy(false);
    }
  }

  const unread = notes?.filter((note) => !note.read).length ?? 0;

  return (
    <div data-testid="settings-notifications" className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Notifications</h2>
          <p className="mt-1 text-sm text-muted-foreground">Account notices for invites, runs, and billing.</p>
        </div>
        <Button variant="outline" className={pillClass} disabled={busy || unread === 0} onClick={() => void markRead()}>
          Mark read
        </Button>
      </header>
      {notes ? (
        <section className="grid gap-4 sm:grid-cols-2">
          <article className={`${cardClass} p-4`}>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Unread</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{unread}</p>
          </article>
          <article className={`${cardClass} p-4`}>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">All</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{notes.length}</p>
          </article>
        </section>
      ) : null}
      {error ? <PageError title="Could not load notifications." detail={error} onRetry={() => void load()} /> : null}
      {!notes && !error ? <PageSkeleton /> : null}
      {notes && notes.length === 0 ? <PageEmpty title="No notifications yet" detail="Invites and finished runs show up here." /> : null}
      {notes && notes.length > 0 ? (
        <section className={`${cardClass} overflow-x-auto`}>
          <div className="px-4 pt-4">
            <SectionTitle>Inbox</SectionTitle>
          </div>
          <table className="mt-2 w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="px-4 py-3 text-left font-medium">Notice</th>
                <th scope="col" className="px-4 py-3 text-left font-medium">When</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {notes.map((note) => (
                <tr key={note.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium">{note.title}</p>
                    {note.body ? <p className="text-muted-foreground">{note.body}</p> : null}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{note.createdAt ? formatWhen(note.createdAt) : "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-xs capitalize">{note.read ? "Read" : "New"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
