"use client";

import { useAdmin } from "@/components/admin-state";

export default function AdminDashboard() {
  const { payload } = useAdmin();
  if (!payload) return null;
  const users = payload.users;
  const active = users.filter((user) => !user.suspended).length;
  const calls = users.reduce((sum, user) => sum + user.modelCalls, 0);
  const credits = users.reduce((sum, user) => sum + user.creditBalance, 0);
  const max = Math.max(1, ...users.map((user) => user.modelCalls));

  return (
    <>
      <header>
        <h2 className="text-xl font-semibold tracking-tight">Dashboard</h2>
        <p className="mt-1 text-sm text-muted-foreground">Plans, credits, and model calls. Separate from the user app.</p>
      </header>
      <section data-testid="admin-stats" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["People", String(users.length)],
          ["Active", String(active)],
          ["Credits left", credits.toLocaleString()],
          ["Model calls", String(calls)],
        ].map(([label, value]) => (
          <article key={label} className="rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
          </article>
        ))}
      </section>
      <section data-testid="admin-chart" className="rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
        <h3 className="text-base font-medium">Model calls</h3>
        <p className="mt-1 text-sm text-muted-foreground">Calls recorded for each account.</p>
        <svg viewBox={`0 0 ${Math.max(320, users.length * 72)} 160`} className="mt-4 h-40 w-full" role="img" aria-label="Model calls by account">
          {users.map((user, index) => {
            const height = Math.max(4, Math.round((user.modelCalls / max) * 100));
            const x = 24 + index * 72;
            return (
              <g key={user.id}>
                <rect x={x} y={120 - height} width={36} height={height} rx="6" fill="var(--brand)" />
                <text x={x + 18} y={142} textAnchor="middle" fontSize="11" fill="currentColor">
                  {user.username}
                </text>
              </g>
            );
          })}
        </svg>
      </section>
    </>
  );
}
