"use client";

import { useAdmin } from "@/components/admin-state";
import { money, Section, SkeletonBlock, Stat, useConsole } from "@/components/panel";

type Overview = {
  activeUsers?: number;
  mrrCents?: number;
  signups?: number;
  awakeComputers?: number;
  aiSpendTodayUsd?: number;
  aiSpendMonthUsd?: number;
  errors?: number;
  health?: string;
  spendSeries?: number[];
  signupSeries?: number[];
  errorSeries?: number[];
};

export default function AdminDashboard() {
  const { payload } = useAdmin();
  const overview = useConsole<Overview>("/api/admin/console/overview");
  if (!payload) return null;
  const live = overview.data;
  const measured = live != null && typeof live.activeUsers === "number";
  const users = payload.users;
  const active = users.filter((user) => !user.suspended).length;
  const calls = users.reduce((sum, user) => sum + user.modelCalls, 0);
  const credits = users.reduce((sum, user) => sum + user.creditBalance, 0);
  const max = Math.max(1, ...users.map((user) => user.modelCalls));

  return (
    <Section title="Overview" detail="People, monthly revenue, awake computers, and spend. Figures come from the database." testid="section-overview">
      {overview.loading && !live ? <SkeletonBlock /> : null}
      {measured ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Active users" value={String(live.activeUsers)} help="Accounts that can sign in." series={live.signupSeries} />
          <Stat label="MRR" value={money(live.mrrCents ?? 0)} help="Sum of paid plans on active accounts." />
          <Stat label="Signups" value={String(live.signups ?? 0)} help="New accounts this month." series={live.signupSeries} />
          <Stat label="Awake computers" value={String(live.awakeComputers ?? 0)} help="Computers running or recovering." />
          <Stat label="AI spend today" value={`$${Number(live.aiSpendTodayUsd ?? 0).toFixed(2)}`} help="Recorded model cost since midnight UTC." series={live.spendSeries} />
          <Stat label="AI spend this month" value={`$${Number(live.aiSpendMonthUsd ?? 0).toFixed(2)}`} help="Recorded model cost this month." series={live.spendSeries} />
          <Stat label="Errors" value={String(live.errors ?? 0)} help="Failed tasks in the last day." series={live.errorSeries} />
          <Stat label="Health" value={live.health === "up" ? "Up" : live.health === "down" ? "Down" : "No data yet"} help="Database check on this request." />
        </div>
      ) : overview.loading ? null : (
        <p className="text-sm text-muted-foreground">No data yet.</p>
      )}
      <section data-testid="admin-stats" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["People", String(users.length), "Accounts on this installation."],
          ["Active", String(active), "Accounts that are not suspended."],
          ["Credits left", credits.toLocaleString(), "Credits still available."],
          ["Model calls", String(calls), "Calls recorded for these accounts."],
        ].map(([label, value, help]) => (
          <article key={label} className="rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
            <p className="mt-2 text-sm text-muted-foreground">{help}</p>
          </article>
        ))}
      </section>
      <section data-testid="admin-chart" className="rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
        <h3 className="text-base font-medium">Model calls</h3>
        <p className="mt-1 text-sm text-muted-foreground">Calls recorded for each account.</p>
        <svg viewBox={`0 0 ${Math.max(640, users.length * 72)} 160`} className="mt-4 h-40 w-full" role="img" aria-label="Model calls by account">
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
    </Section>
  );
}
