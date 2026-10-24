"use client";

import { useAdmin } from "@/components/admin-state";
import { Card, ConfirmButton, DataTable, Empty, primary, Section, SkeletonBlock, Stat, useConsole, useToast } from "@/components/panel";
import { api } from "@/lib/api";

type Model = { id: string; label: string; provider: string; enabled: boolean; isDefault?: boolean; is_default?: boolean; isFallback?: boolean; is_fallback?: boolean; dailySpendCapCents?: number; daily_spend_cap_cents?: number; killed: boolean };

export default function ModelsPage() {
  const { canOperate } = useAdmin();
  const data = useConsole<{ models?: Model[]; killSwitch?: boolean; merge?: { branch?: string; safetyFeatures?: number } }>("/api/admin/console/models");
  const toast = useToast();
  const models = data.data?.models ?? [];
  const killed = Boolean(data.data?.killSwitch);

  return (
    <Section
      title="Models"
      detail="Names and providers stay on this site. The user app never shows them."
      testid="section-models"
      action={canOperate ? (
        <ConfirmButton
          className={primary}
          label={killed ? "Allow calls" : "Kill switch"}
          title={killed ? "Allow model calls again?" : "Stop model calls?"}
          detail="speed-v1 reads this switch before a call. This page stores the choice."
          confirmLabel={killed ? "Allow calls" : "Stop calls"}
          onConfirm={async () => { await api("/api/admin/console/models/kill", { method: "POST", body: JSON.stringify({ killed: !killed }) }); toast(killed ? "Calls are allowed." : "Calls are switched off."); await data.reload(); }}
        />
      ) : undefined}
    >
      {data.loading && !data.data ? <SkeletonBlock /> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Merge point" help={`The ${data.data?.merge?.branch || "speed-v1"} branch owns the ${data.data?.merge?.safetyFeatures ?? 12} request-time safety checks.`}>
          <p className="mt-3 text-sm leading-5">This page stores the registry, the default, the fallback, spend caps, and the kill switch. A cap of zero means uncapped.</p>
        </Card>
        <Stat label="Model calls" value={data.data ? (killed ? "Stopped" : "Allowed") : "—"} help={killed ? "The kill switch is on, so calls are stopped." : "The kill switch is off, so calls are allowed."} />
      </div>
      {models.length === 0 && !data.loading ? <Empty title="No models yet." detail="Add a model when the registry has a row." /> : models.length > 0 ? (
        <DataTable
          rows={models}
          rowKey={(model) => model.id}
          searchText={(model) => `${model.label} ${model.provider} ${model.id}`}
          emptyTitle="No models match that search."
          filters={[{ id: "role", label: "Role", value: (model) => (model.isDefault || model.is_default ? "Default" : model.isFallback || model.is_fallback ? "Fallback" : "Other") }]}
          columns={[
            { id: "model", header: "Model", sortValue: (model) => model.label, cell: (model) => <span>{model.label}<p className="text-xs text-muted-foreground">{model.id}</p></span> },
            { id: "provider", header: "Provider", sortValue: (model) => model.provider, cell: (model) => model.provider },
            { id: "cap", header: "Daily cap", align: "right", sortValue: (model) => model.dailySpendCapCents ?? model.daily_spend_cap_cents ?? 0, cell: (model) => <span className="tabular-nums">{(model.dailySpendCapCents ?? model.daily_spend_cap_cents ?? 0) === 0 ? "Uncapped" : moneySafe(model.dailySpendCapCents ?? model.daily_spend_cap_cents ?? 0)}</span> },
            { id: "role", header: "Role", align: "right", cell: (model) => model.isDefault || model.is_default ? "Default" : model.isFallback || model.is_fallback ? "Fallback" : model.killed ? "Killed" : model.enabled ? "On" : "Off" },
          ]}
        />
      ) : null}
    </Section>
  );
}

function moneySafe(cents: number) {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}
