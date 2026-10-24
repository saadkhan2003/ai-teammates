"use client";

import { useState } from "react";
import { useAdmin } from "@/components/admin-state";
import { Card, control, DataTable, Empty, onSubmit, primary, Section, SkeletonBlock, useConsole, useToast } from "@/components/panel";
import { api } from "@/lib/api";

type Flag = { key: string; enabled: boolean; description: string; kind: string };

const labels: Record<string, string> = {
  signups_open: "Signups",
  plugins_install: "Plugin installs",
  topups_open: "Top-up packs",
  model_kill: "Stop model calls",
  computers_kill: "Stop computer wake",
  bots_kill: "Stop bot restart",
  maintenance_mode: "Maintenance",
};

function nameOf(flag: Flag) {
  return labels[flag.key] || flag.key.replaceAll("_", " ");
}

function destructive(flag: Flag) {
  return flag.kind === "kill" || flag.kind === "maintenance" || flag.key.endsWith("_kill");
}

export default function FlagsPage() {
  const { canOperate, canOwn } = useAdmin();
  const data = useConsole<{ flags?: Flag[]; maintenanceMessage?: string }>("/api/admin/console/flags");
  const toast = useToast();
  const [message, setMessage] = useState("");
  const flags = data.data?.flags ?? [];

  function allowed(flag: Flag) {
    return flag.key === "maintenance_mode" ? canOwn : canOperate;
  }

  async function toggle(flag: Flag, enabled: boolean) {
    await api(`/api/admin/console/flags/${flag.key}`, { method: "PUT", body: JSON.stringify({ enabled, message }) });
    toast(`${nameOf(flag)} is ${enabled ? "on" : "off"}.`);
    await data.reload();
  }

  return (
    <Section title="Flags" detail="Turn product behavior on or off. Maintenance shows a banner in this console." testid="section-flags">
      {data.loading && !data.data ? <SkeletonBlock /> : null}
      {flags.length === 0 && !data.loading ? (
        <Empty title="No flags yet." detail="Flags appear after the platform settings are installed." />
      ) : flags.length > 0 ? (
        <DataTable
          rows={flags}
          rowKey={(flag) => flag.key}
          searchText={(flag) => `${nameOf(flag)} ${flag.description}`}
          emptyTitle="No flags match that search."
          filters={[{ id: "kind", label: "Kind", value: (flag) => (flag.kind === "kill" ? "Kill switch" : flag.kind === "maintenance" ? "Maintenance" : "Feature") }]}
          columns={[
            { id: "name", header: "Flag", sortValue: (flag) => nameOf(flag), cell: (flag) => <span>{nameOf(flag)}<p className="text-xs text-muted-foreground">{flag.description}</p></span> },
            { id: "state", header: "State", align: "right", sortValue: (flag) => (flag.enabled ? 1 : 0), cell: (flag) => (flag.enabled ? "On" : "Off") },
          ]}
          menus={canOperate || canOwn ? [
            {
              label: "Turn on",
              hidden: (flag) => flag.enabled || !allowed(flag),
              confirmTitle: "Turn this on?",
              confirmDetail: "People see the change on the next request.",
              onSelect: (flag) => void toggle(flag, true),
            },
            {
              label: "Turn off",
              hidden: (flag) => !flag.enabled || !allowed(flag) || destructive(flag),
              onSelect: (flag) => void toggle(flag, false),
            },
            {
              label: "Turn off",
              hidden: (flag) => !flag.enabled || !allowed(flag) || !destructive(flag),
              confirmTitle: "Turn this off?",
              confirmDetail: "This changes who can sign up, install, or call the product.",
              onSelect: (flag) => void toggle(flag, false),
            },
          ] : undefined}
        />
      ) : null}
      {canOwn ? (
        <Card title="Maintenance banner" help="People with the console see this sentence while maintenance is on.">
          <form className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={onSubmit(async () => { await api("/api/admin/console/flags/maintenance_mode", { method: "PUT", body: JSON.stringify({ enabled: true, message }) }); toast("Maintenance is on."); await data.reload(); })}>
            <label className="grid gap-2 text-sm">
              Banner text
              <input className={control} placeholder="We will be back shortly." aria-label="Banner text" value={message} onChange={(event) => setMessage(event.target.value)} />
              <span className="text-sm text-muted-foreground">Leave this blank to use the default sentence.</span>
            </label>
            <button type="submit" className={primary}>Turn maintenance on</button>
          </form>
        </Card>
      ) : null}
    </Section>
  );
}
