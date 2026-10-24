"use client";

import { useState } from "react";
import { useAdmin } from "@/components/admin-state";
import { Card, control, DataTable, Empty, Section, SkeletonBlock, useConsole, useToast } from "@/components/panel";
import { api } from "@/lib/api";

type Ticket = { id: string; email: string; topic: string; body: string; status: string; staffNote?: string; staff_note?: string };
type Note = { id: string; username?: string; message?: string; category?: string };
type Down = { id: string; bot?: string; emoji?: string };

export default function SupportPage() {
  const { canSupport } = useAdmin();
  const data = useConsole<{ tickets?: Ticket[]; feedback?: Note[]; thumbsDown?: Down[] }>("/api/admin/console/support");
  const toast = useToast();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const tickets = data.data?.tickets ?? [];
  const feedback = data.data?.feedback ?? [];
  const downs = data.data?.thumbsDown ?? [];

  return (
    <Section title="Support" detail="Inbox, product feedback, and thumbs-down reports." testid="section-support">
      {data.loading && !data.data ? <SkeletonBlock /> : null}
      {tickets.length === 0 && !data.loading ? (
        <Empty title="No tickets yet." detail="A ticket appears when someone writes in." />
      ) : tickets.length > 0 ? (
        <DataTable
          rows={tickets}
          rowKey={(ticket) => ticket.id}
          searchText={(ticket) => `${ticket.email} ${ticket.topic} ${ticket.body}`}
          emptyTitle="No tickets match that search."
          filters={[{ id: "status", label: "Status", value: (ticket) => (ticket.status === "closed" ? "Closed" : "Open") }]}
          columns={[
            { id: "from", header: "From", sortValue: (ticket) => ticket.email, cell: (ticket) => <span>{ticket.email}<p className="text-xs capitalize text-muted-foreground">{ticket.topic}</p></span> },
            { id: "message", header: "Message", cell: (ticket) => <span>{ticket.body}<p className="text-xs text-muted-foreground">{ticket.staffNote || ticket.staff_note || "No staff note"}</p></span> },
            { id: "status", header: "Status", align: "right", sortValue: (ticket) => ticket.status, cell: (ticket) => <span className="capitalize">{ticket.status}</span> },
          ]}
          menus={canSupport ? [{
            label: "Close or reopen",
            onSelect: (ticket) => void api(`/api/admin/console/support/${ticket.id}`, { method: "POST", body: JSON.stringify({ status: ticket.status === "open" ? "closed" : "open", staffNote: notes[ticket.id] || ticket.staffNote || ticket.staff_note || "" }) }).then(() => data.reload()).then(() => toast(ticket.status === "open" ? "Ticket closed." : "Ticket reopened.")),
          }] : undefined}
        />
      ) : null}
      {canSupport && tickets.length > 0 ? (
        <Card title="Staff note" help="Saved the next time you close or reopen that ticket.">
          <div className="mt-4 grid gap-3">
            {tickets.map((ticket) => (
              <label key={ticket.id} className="grid gap-2 text-sm">
                Note for {ticket.email}
                <input className={control} aria-label={`Note for ${ticket.email}`} placeholder="What you told them" value={notes[ticket.id] ?? ""} onChange={(event) => setNotes({ ...notes, [ticket.id]: event.target.value })} />
              </label>
            ))}
          </div>
        </Card>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Feedback" help="Notes people left about the product.">
          {feedback.length === 0 ? (
            <div className="mt-4"><Empty title="No feedback yet." detail="Feedback shows up when someone sends a note." /></div>
          ) : (
            <ul className="mt-3 divide-y divide-border text-sm">
              {feedback.map((item) => (
                <li key={item.id} className="py-3">
                  <p>{item.message}</p>
                  <p className="text-xs text-muted-foreground">{item.username || "Someone"}{item.category ? ` · ${item.category}` : ""}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Thumbs down" help="Replies someone marked as unhelpful.">
          {downs.length === 0 ? (
            <div className="mt-4"><Empty title="No thumbs-down reports." detail="A report appears when someone marks a reply down." /></div>
          ) : (
            <ul className="mt-3 divide-y divide-border text-sm">
              {downs.map((item) => (
                <li key={item.id} className="flex items-center justify-between py-3">
                  <span>{item.bot || "Bot"}</span>
                  <span>{item.emoji || "Down"}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Section>
  );
}
