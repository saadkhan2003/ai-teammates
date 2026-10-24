"use client";

import { UsageCreditControls } from "@/components/usage-credit-controls";
import { useState } from "react";
import { useAdmin } from "@/components/admin-state";
import { Card, ConfirmButton, control, DataTable, Empty, Field, fileSize, money, onSubmit, primary, Section, SkeletonBlock, useConsole, useToast } from "@/components/panel";
import { api } from "@/lib/api";

type Usage = { id?: string; username?: string; aiCalls?: number; ai_calls?: number; computerTasks?: number; computer_tasks?: number; storageBytes?: number; storage_bytes?: number; credits?: number };
type Invoice = { id?: string; number?: string; username?: string; amountCents?: number; amount_cents?: number; status?: string; provider?: string };

export default function BillingPage() {
  const { canOperate, canOwn } = useAdmin();
  const data = useConsole<{ usage?: Usage[]; invoices?: Invoice[]; provider?: { name?: string; status?: string; chargesCard?: boolean } }>("/api/admin/console/billing");
  const toast = useToast();
  const [userId, setUserId] = useState("");
  const [credits, setCredits] = useState("100");
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const usage = data.data?.usage ?? [];
  const invoices = data.data?.invoices ?? [];
  const provider = data.data?.provider;

  return (
    <Section title="Usage and billing" detail="Credits split by AI calls, computer tasks, and stored files. The payment provider does not charge a card in this build." testid="section-billing">
      <UsageCreditControls />
      {data.loading && !data.data ? <SkeletonBlock /> : null}
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Payment provider" help="Paddle and Lemon Squeezy stay unavailable until a later build.">
          <p className="mt-3 text-sm">{provider ? `${provider.name === "mock" ? "Test provider" : provider.name} · ${provider.status === "mock" ? "records only" : provider.status}` : "No data yet"}</p>
          <p className="mt-1 text-sm text-muted-foreground">{provider?.chargesCard ? "Charges a card." : "Does not charge a card."}</p>
        </Card>
        <Card title="This view" help="AI is call count, computer is task count, and storage is file bytes.">
          <p className="mt-3 text-3xl font-semibold tabular-nums">{usage.length}</p>
          <p className="text-sm text-muted-foreground">accounts in the breakdown</p>
        </Card>
      </div>
      {usage.length === 0 && !data.loading ? <Empty title="No usage yet." detail="Usage appears after an account makes a call or stores a file." /> : usage.length > 0 ? (
        <DataTable
          rows={usage}
          rowKey={(row) => row.id || row.username || "row"}
          searchText={(row) => row.username || ""}
          emptyTitle="No accounts match that search."
          columns={[
            { id: "person", header: "Person", sortValue: (row) => row.username || "", cell: (row) => row.username },
            { id: "ai", header: "AI calls", align: "right", sortValue: (row) => row.aiCalls ?? row.ai_calls ?? 0, cell: (row) => <span className="tabular-nums">{row.aiCalls ?? row.ai_calls ?? 0}</span> },
            { id: "computer", header: "Computer tasks", align: "right", sortValue: (row) => row.computerTasks ?? row.computer_tasks ?? 0, cell: (row) => <span className="tabular-nums">{row.computerTasks ?? row.computer_tasks ?? 0}</span> },
            { id: "storage", header: "Storage", align: "right", sortValue: (row) => row.storageBytes ?? row.storage_bytes ?? 0, cell: (row) => <span className="tabular-nums">{fileSize(row.storageBytes ?? row.storage_bytes ?? 0)}</span> },
            { id: "credits", header: "Credits left", align: "right", sortValue: (row) => row.credits ?? 0, cell: (row) => <span className="tabular-nums">{row.credits ?? 0}</span> },
          ]}
        />
      ) : null}
      <Card title="Invoices" help="Refunds are recorded here. They do not call a payment provider.">
        {invoices.length === 0 ? <div className="mt-4"><Empty title="No invoices yet." detail="An invoice is created when a paid plan is checked out." /></div> : (
          <ul className="mt-3 divide-y divide-border text-sm">
            {invoices.map((invoice) => (
              <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <span>{invoice.number} · {invoice.username}</span>
                <span className="tabular-nums">{money(invoice.amountCents ?? invoice.amount_cents ?? 0)} · {invoice.status} · {invoice.provider === "mock" ? "test provider" : invoice.provider}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {canOperate ? (
        <Card title="Credit grant and top-up pack" help="A grant adds credits now. A pack is recorded only when packs are turned on, and it does not charge a card.">
          <form className="mt-4 grid gap-3 lg:grid-cols-[1fr_8rem_auto_auto] lg:items-end" onSubmit={onSubmit(async () => { await api("/api/admin/console/grants", { method: "POST", body: JSON.stringify({ userId, credits: Number(credits) }) }); toast("Credits granted."); await data.reload(); })}>
            <Field label="Account id"><input className={control} placeholder="Paste the account id" aria-label="Account id" value={userId} onChange={(event) => setUserId(event.target.value)} /></Field>
            <Field label="Credits"><input className={control} inputMode="numeric" aria-label="Credits to grant" value={credits} onChange={(event) => setCredits(event.target.value)} /></Field>
            <button className={primary} type="submit">Grant</button>
            <button className={primary} type="button" onClick={() => void api("/api/admin/console/topup-packs", { method: "POST", body: JSON.stringify({ userId }) }).then(() => data.reload()).then(() => toast("Pack recorded. No card was charged."))}>Record pack</button>
          </form>
        </Card>
      ) : null}
      {canOwn ? (
        <Card title="Refund" help="The amount cannot be larger than the invoice. This writes a refund record only.">
          <form className="mt-4 grid gap-3 lg:grid-cols-4 lg:items-end" onSubmit={(event) => event.preventDefault()}>
            <Field label="Invoice id" help="The invoice this refund applies to."><input className={control} aria-label="Invoice id" value={invoiceId} onChange={(event) => setInvoiceId(event.target.value)} /></Field>
            <Field label="Amount" help="US dollars. This cannot be larger than the invoice."><input className={control} inputMode="decimal" aria-label="Refund amount" placeholder="20.00" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>
            <Field label="Reason" help="Stored with the refund record."><input className={control} aria-label="Refund reason" value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
            <ConfirmButton className={primary} label="Refund" title="Record this refund?" detail="This writes a refund record. A card is not charged or refunded." confirmLabel="Refund" onConfirm={async () => { await api("/api/admin/console/refunds", { method: "POST", body: JSON.stringify({ invoiceId, amountCents: Math.round(Number(amount) * 100), reason }) }); toast("Refund recorded."); await data.reload(); }} />
          </form>
        </Card>
      ) : null}
    </Section>
  );
}
