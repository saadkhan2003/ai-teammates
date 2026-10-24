"use client";

import { useAdmin } from "@/components/admin-state";
import { Card, DataTable, Empty, Section, SkeletonBlock, Stat, useConsole, useToast } from "@/components/panel";
import { api } from "@/lib/api";

type Queue = { status?: string; count?: number };
type Alert = { id: string; enabled: boolean; threshold: string; channel: string };
type Failure = { id: string; title?: string; error?: string; provider?: string; model?: string };

const alertNames: Record<string, string> = {
  spend_cap: "Daily spend",
};

function alertName(id: string) {
  return alertNames[id] || id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function HealthPage() {
  const { canOperate } = useAdmin();
  const data = useConsole<{ postgres?: boolean; isolation?: boolean; queues?: Queue[]; errors?: Failure[]; modelErrors?: Failure[]; alerts?: Alert[]; uptime?: { banner?: { label?: string } } }>("/api/admin/console/health");
  const toast = useToast();
  const body = data.data;
  const queues = body?.queues ?? [];
  const errors = body?.errors ?? [];
  const modelErrors = body?.modelErrors ?? [];
  const alerts = body?.alerts ?? [];

  return (
    <Section title="Health" detail="Services, queues, error logs, uptime, and alert rules. A missing probe stays empty." testid="section-health">
      {data.loading && !body ? <SkeletonBlock /> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Database" value={body ? (body.postgres ? "Up" : "Down") : "—"} help="Postgres answered this request." />
        <Stat label="Computer isolation" value={body ? (body.isolation ? "Up" : "Down") : "—"} help="Whether the computer runtime answered." />
        <Stat label="Uptime" value={body?.uptime?.banner?.label || (body ? "No data yet" : "—")} help="From the public uptime board. Empty means no checks yet." />
      </div>
      {queues.length === 0 && !data.loading ? (
        <Empty title="No queued work." detail="Running and waiting jobs show up here." />
      ) : queues.length > 0 ? (
        <DataTable
          rows={queues.map((queue, index) => ({ ...queue, id: `${queue.status || "queue"}-${index}` }))}
          rowKey={(queue) => queue.id}
          searchText={(queue) => queue.status || ""}
          emptyTitle="No queues match that search."
          columns={[
            { id: "status", header: "Queue", sortValue: (queue) => queue.status || "", cell: (queue) => <span className="capitalize">{queue.status || "Unknown"}</span> },
            { id: "count", header: "Jobs", align: "right", sortValue: (queue) => queue.count ?? 0, cell: (queue) => <span className="tabular-nums">{queue.count ?? 0}</span> },
          ]}
        />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Failed work" help="Tasks that ended in an error.">
          {errors.length === 0 ? <div className="mt-4"><Empty title="No failed work." detail="Failures stay here for the recent window." /></div> : (
            <ul className="mt-3 space-y-2 text-sm">{errors.map((row) => <li key={row.id}><span className="font-medium">{row.title || "Task"}</span><p className="text-muted-foreground">{row.error || "No detail"}</p></li>)}</ul>
          )}
        </Card>
        <Card title="Model errors" help="Provider and model names stay on this site.">
          {modelErrors.length === 0 ? <div className="mt-4"><Empty title="No model errors." detail="A failed model call is listed with its provider." /></div> : (
            <ul className="mt-3 space-y-2 text-sm">{modelErrors.map((row) => <li key={row.id}>{row.provider} · {row.model}</li>)}</ul>
          )}
        </Card>
      </div>
      <Card title="Alerts" help="A rule writes to the audit log when its threshold is crossed. Delivery to chat or mail is not configured.">
        {alerts.length === 0 ? <div className="mt-4"><Empty title="No alert rules." detail="Rules appear after the platform settings are installed." /></div> : (
          <ul className="mt-3 divide-y divide-border text-sm">
            {alerts.map((alert) => (
              <li key={alert.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span>
                  <span className="font-medium">{alertName(alert.id)}</span>
                  <p className="text-muted-foreground">{alert.threshold} · {alert.channel === "audit" ? "Audit log" : alert.channel} · {alert.enabled ? "On" : "Off"}</p>
                </span>
                {canOperate ? (
                  <button type="button" className="inline-flex min-h-11 items-center rounded-full border border-border px-3" onClick={() => void api(`/api/admin/console/alerts/${alert.id}`, { method: "PUT", body: JSON.stringify({ enabled: !alert.enabled, threshold: alert.threshold, channel: alert.channel }) }).then(() => data.reload()).then(() => toast(`${alertName(alert.id)} is ${alert.enabled ? "off" : "on"}.`))}>
                    {alert.enabled ? "Turn off" : "Turn on"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Section>
  );
}
