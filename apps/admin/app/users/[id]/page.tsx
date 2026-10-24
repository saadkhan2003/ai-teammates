"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { plans, useAdmin } from "@/components/admin-state";

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const { payload, drafts, setDrafts, saveUser, suspend } = useAdmin();
  const user = payload?.users.find((item) => item.id === id) ?? null;

  if (!payload) return null;
  if (!user) {
    return (
      <div role="status" className="rounded-[12px] border border-border bg-card px-4 py-6 text-center text-sm shadow-(--shadow-card)">
        <p className="font-medium">That account is not here</p>
        <Link href="/users" className="mt-3 inline-flex min-h-11 items-center rounded-[6px] border border-border px-4 text-sm">
          Back to users
        </Link>
      </div>
    );
  }

  const draft = drafts[user.id] ?? { planId: user.planId, credits: String(user.creditBalance) };
  const used = Math.max(0, user.creditAllowance - user.creditBalance);
  const percent = user.creditAllowance <= 0 ? 0 : Math.min(100, Math.round((used * 100) / user.creditAllowance));

  return (
    <div data-testid="admin-user-detail" className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link href="/users" className="text-sm text-muted-foreground underline">
            Users
          </Link>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">{user.displayName || user.username}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {user.username} · {user.email || "No email"} · {user.role}
          </p>
        </div>
        <span className="inline-flex h-6 items-center rounded-[6px] bg-muted px-2 text-xs capitalize">{user.suspended ? "Suspended" : user.status}</span>
      </header>
      <section className="grid gap-4 sm:grid-cols-3">
        {[
          ["Plan", user.planId],
          ["Credits left", user.creditBalance.toLocaleString()],
          ["Model calls", String(user.modelCalls)],
        ].map(([label, value]) => (
          <article key={label} className="rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-2 text-3xl font-semibold capitalize tabular-nums">{value}</p>
          </article>
        ))}
      </section>
      <section className="rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
        <h3 className="text-base font-medium">Usage</h3>
        <p className="mt-3 text-3xl font-semibold tabular-nums">{user.creditBalance.toLocaleString()} <span className="text-base font-normal text-muted-foreground">credits left</span></p>
        <div className="mt-4 h-2 overflow-hidden rounded-[6px] bg-muted">
          <div className="h-full rounded-[6px] bg-brand" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{used.toLocaleString()} used · {percent}% of {user.creditAllowance.toLocaleString()}</p>
      </section>
      <p className="text-sm text-muted-foreground">This deployment uses the default plan. Configure per-model credit prices in <Link href="/ai-models" className="underline">AI models</Link>.</p>
      <section className="rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
        <h3 className="text-base font-medium text-destructive">{user.suspended ? "Restore access" : "Suspend account"}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{user.suspended ? "This person can sign in again." : "Suspended people cannot sign in."}</p>
        <div className="mt-4 flex justify-end">
          <button type="button" data-testid={`suspend-${user.username}`} className="inline-flex min-h-11 items-center rounded-[6px] bg-destructive px-4 text-sm font-medium text-destructive-foreground" onClick={() => void suspend(user)}>
            {user.suspended ? "Unsuspend" : "Suspend"}
          </button>
        </div>
      </section>
    </div>
  );
}
