"use client";

import { useState } from "react";
import { useAdmin } from "@/components/admin-state";
import { Card, DataTable, Empty, Section, SkeletonBlock, useConsole, useToast } from "@/components/panel";
import { api, ApiError } from "@/lib/api";

type Bot = { id: string; name: string; status: string; username: string };
type Run = { id: string; title: string; status: string };
type Line = { seq: number; role: string; content?: string; bytes?: number; redacted?: boolean };
type Runs = { runs?: Run[]; transcript?: Line[]; revealed?: boolean };

export default function BotsPage() {
  const { canOperate } = useAdmin();
  const list = useConsole<{ bots?: Bot[] }>("/api/admin/console/bots");
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const runs = useConsole<Runs>(open ? `/api/admin/console/bots/${open}/runs?task=${open}&reveal=${reveal ? "1" : "0"}` : "/api/admin/console/bots");
  const bots = list.data?.bots ?? [];
  const selected = bots.find((bot) => bot.id === open);

  async function act(bot: Bot, action: "kill" | "restart") {
    try {
      await api(`/api/admin/console/bots/${bot.id}/${action}`, { method: "POST" });
      toast(action === "kill" ? `${bot.name} is stopped.` : `${bot.name} is restarting.`);
      await list.reload();
    } catch (caught) {
      toast(caught instanceof ApiError ? caught.message : "The runtime did not accept that.");
    }
  }

  return (
    <Section title="Bots" detail="Status, recent runs, and transcripts. Transcript text stays hidden until you reveal it." testid="section-bots">
      {list.loading && !list.data ? <SkeletonBlock /> : null}
      {bots.length === 0 && !list.loading ? (
        <Empty title="No bots yet." detail="A bot appears after someone creates one." />
      ) : bots.length > 0 ? (
        <DataTable
          rows={bots}
          rowKey={(bot) => bot.id}
          searchText={(bot) => `${bot.name} ${bot.username} ${bot.status}`}
          emptyTitle="No bots match that search."
          filters={[{ id: "status", label: "Status", value: (bot) => bot.status }]}
          columns={[
            { id: "bot", header: "Bot", sortValue: (bot) => bot.name, cell: (bot) => bot.name },
            { id: "person", header: "Person", sortValue: (bot) => bot.username, cell: (bot) => bot.username },
            { id: "status", header: "Status", sortValue: (bot) => bot.status, cell: (bot) => <span className="capitalize">{bot.status}</span> },
          ]}
          menus={[
            { label: "Recent runs", onSelect: (bot) => setOpen(bot.id) },
            ...(canOperate ? [
              { label: "Restart", onSelect: (bot: Bot) => void act(bot, "restart") },
              { label: "Stop bot", confirmTitle: "Stop this bot?", confirmDetail: "Running work for this bot is cancelled. The person can start it again.", onSelect: (bot: Bot) => void act(bot, "kill") },
            ] : []),
          ]}
        />
      ) : null}
      {open ? (
        <Card title={`Recent runs${selected ? ` · ${selected.name}` : ""}`} help="Hidden lines show a byte count until you reveal the text.">
          <label className="mt-4 flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={reveal} onChange={(event) => setReveal(event.target.checked)} />
            Reveal transcript text
          </label>
          {(runs.data?.runs ?? []).length === 0 ? (
            <div className="mt-4"><Empty title="No runs yet." detail="Runs appear after this bot does work." /></div>
          ) : (
            <ul className="mt-4 divide-y divide-border text-sm">
              {(runs.data?.runs ?? []).map((run) => (
                <li key={run.id} className="flex items-center justify-between py-3">
                  <span>{run.title}</span>
                  <span className="capitalize text-muted-foreground">{run.status}</span>
                </li>
              ))}
            </ul>
          )}
          {runs.data?.transcript ? (
            <ul className="mt-4 space-y-2 text-sm">
              {runs.data.transcript.map((line) => (
                <li key={line.seq} className="rounded-[8px] bg-muted px-3 py-2">
                  <span className="capitalize text-muted-foreground">{line.role}</span>
                  <p className="mt-1">{line.redacted ? `${line.bytes ?? 0} bytes hidden` : line.content}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}
    </Section>
  );
}
