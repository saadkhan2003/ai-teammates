"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { plans, useAdmin } from "@/components/admin-state";
import { Card, ConfirmButton, control, danger, Empty, Meter, onSubmit, primary, quiet, Stat, useConsole, useToast } from "@/components/panel";
import { api, ApiError } from "@/lib/api";

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const { payload, drafts, setDrafts, saveUser, suspend, canOperate, canOwn, canSupport, load } = useAdmin();
  const extra = useConsole<{ notes?: { id: string; body: string; author?: string }[] }>(`/api/admin/console/users/${id || "missing"}`);
  const toast = useToast();
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState("");
  const [temporary, setTemporary] = useState("");
  const user = payload?.users.find((item) => item.id === id) ?? null;

  if (!payload) return null;
  if (!user) {
    return (
      <Empty title="That account is not here." detail="It may have been removed." action={<Link href="/users" className={quiet}>Back to users</Link>} />
    );
  }

  const draft = drafts[user.id] ?? { planId: user.planId, credits: String(user.creditBalance) };
  const used = Math.max(0, user.creditAllowance - user.creditBalance);

  return (
    <div data-testid="admin-user-detail" className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link href="/users" className="text-sm text-muted-foreground underline">Users</Link>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">{user.displayName || user.username}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{user.username} · {user.email || "No email"} · {user.role}</p>
        </div>
        {canOperate ? (
          <button type="button" className={quiet} onClick={() => void api("/api/admin/console/impersonate", { method: "POST", body: JSON.stringify({ userId: user.id }) }).then(() => window.location.reload())}>Impersonate</button>
        ) : null}
      </header>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Plan" value={user.planId ? user.planId[0].toUpperCase() + user.planId.slice(1) : "—"} help="The plan billed for this account." />
        <Stat label="Credits left" value={user.creditBalance.toLocaleString()} help={`${used.toLocaleString()} used of ${user.creditAllowance.toLocaleString()}.`} />
        <Stat label="Model calls" value={String(user.modelCalls)} help="Calls recorded for this account." />
      </div>
      <Card title="Usage" help="The bar is credits used against this month's allowance.">
        <div className="mt-4">
          <Meter label="Credits" usedLabel={`${used.toLocaleString()} used`} limitLabel={`${user.creditAllowance.toLocaleString()} credits`} used={used} limit={user.creditAllowance || 1} />
        </div>
      </Card>
      <form className="rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)" onSubmit={(event) => { event.preventDefault(); void saveUser(user).then(() => toast("Plan and credits saved.")); }}>
        <h3 className="text-base font-medium">Plan and credits</h3>
        <p className="mt-1 text-sm text-muted-foreground">Saving replaces the plan and the credit balance for this person.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="grid gap-2 text-sm" htmlFor="detail-plan">
            Plan
            <select id="detail-plan" aria-label={`${user.username} plan`} className={control} value={draft.planId} onChange={(event) => setDrafts((current) => ({ ...current, [user.id]: { ...draft, planId: event.target.value } }))}>
              {plans.map((plan) => <option key={plan} value={plan}>{plan}</option>)}
            </select>
          </label>
          <label className="grid gap-2 text-sm" htmlFor="detail-credits">
            Credits
            <input id="detail-credits" aria-label={`${user.username} credits`} className={`${control} tabular-nums`} inputMode="numeric" value={draft.credits} onChange={(event) => setDrafts((current) => ({ ...current, [user.id]: { ...draft, credits: event.target.value } }))} />
            <span className="text-sm text-muted-foreground">The balance after you save, not an amount to add.</span>
          </label>
        </div>
        <div className="mt-4 flex justify-end">
          {canOperate ? <button type="submit" className={primary}>Save</button> : <span className="text-sm text-muted-foreground">View only</span>}
        </div>
      </form>
      <section className="rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
        <h3 className="text-base font-medium">{user.suspended ? "Restore access" : "Suspend account"}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{user.suspended ? "This person can sign in again." : "Suspended people cannot sign in."}</p>
        <div className="mt-4 flex justify-end">
          {canOperate ? (
            <button type="button" data-testid={`suspend-${user.username}`} className="inline-flex min-h-11 items-center rounded-full bg-destructive px-4 text-sm font-medium text-destructive-foreground" onClick={() => void suspend(user).then(() => toast(user.suspended ? `${user.username} can sign in.` : `${user.username} is suspended.`))}>
              {user.suspended ? "Unsuspend" : "Suspend"}
            </button>
          ) : <span className="text-sm text-muted-foreground">View only</span>}
        </div>
      </section>
      <Card title="Notes" help="Visible to staff. The person does not see these.">
        {(extra.data?.notes ?? []).length === 0 ? (
          <div className="mt-4"><Empty title="No notes yet." detail="Add a note when the next person on shift should know something." /></div>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {(extra.data?.notes ?? []).map((item) => (
              <li key={item.id} className="rounded-[8px] bg-muted px-3 py-2">{item.body}{item.author ? <span className="mt-1 block text-xs text-muted-foreground">{item.author}</span> : null}</li>
            ))}
          </ul>
        )}
        {canSupport ? (
          <form className="mt-4 flex flex-col gap-2" onSubmit={onSubmit(async () => { await api(`/api/admin/console/users/${user.id}/notes`, { method: "POST", body: JSON.stringify({ body: note }) }); setNote(""); toast("Note saved."); await extra.reload(); })}>
            <label className="grid gap-2 text-sm">
              Staff note
              <textarea className={`${control} min-h-24 py-2`} aria-label="Staff note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="What happened" />
            </label>
            <div className="flex justify-end"><button type="submit" className={primary}>Save note</button></div>
          </form>
        ) : null}
      </Card>
      {canOperate ? (
        <Card title="Access" help="Ban blocks sign-in. A password reset shows a temporary password once.">
          <div className="mt-4 flex flex-wrap gap-2">
            <ConfirmButton
              label="Ban"
              title={`Ban ${user.username}?`}
              detail="They cannot sign in until an owner changes the status."
              onConfirm={async () => { await api(`/api/admin/console/users/${user.id}/status`, { method: "POST", body: JSON.stringify({ status: "banned" }) }); toast(`${user.username} is banned.`); await load(); }}
            />
            <ConfirmButton
              label="Reset password"
              title="Reset this password?"
              detail="A temporary password is shown once on this page."
              onConfirm={async () => {
                const result = await api<{ temporaryPassword?: string }>(`/api/admin/console/users/${user.id}/reset`, { method: "POST" });
                setTemporary(result.temporaryPassword ?? "");
                toast("Password reset. Copy the temporary password.");
              }}
            />
          </div>
          {temporary ? <p className="mt-3 text-sm">Temporary password: <span className="font-medium tabular-nums">{temporary}</span></p> : null}
        </Card>
      ) : null}
      {canOwn ? (
        <Card title="Delete account" help="Type the username, then confirm. The last owner cannot be deleted.">
          <label className="mt-4 grid gap-2 text-sm">
            Username
            <input className={control} aria-label="Username to confirm" placeholder={user.username} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            <span className="text-sm text-muted-foreground">Must match {user.username}.</span>
          </label>
          <div className="mt-4 flex justify-end">
            <ConfirmButton
              className={danger}
              label="Delete"
              title={`Delete ${user.username}?`}
              detail="The account and the rows that belong to them are removed."
              onConfirm={async () => {
                try {
                  await api(`/api/admin/console/users/${user.id}`, { method: "DELETE", body: JSON.stringify({ confirm }) });
                  toast("Account deleted.");
                  await load();
                } catch (caught) {
                  toast(caught instanceof ApiError ? caught.message : "Could not delete that account.");
                }
              }}
            />
          </div>
        </Card>
      ) : null}
    </div>
  );
}
