"use client";

import { useAdmin } from "@/components/admin-state";
import { DataTable, Empty, Section, SkeletonBlock, useConsole, useToast } from "@/components/panel";
import { api } from "@/lib/api";

type Plugin = { id: string; name: string; category?: string; blocked?: boolean; featured?: boolean; healthStatus?: string; health_status?: string };

export default function PluginsPage() {
  const { canOperate } = useAdmin();
  const data = useConsole<{ plugins?: Plugin[] }>("/api/admin/console/plugins");
  const toast = useToast();
  const plugins = data.data?.plugins ?? [];

  async function save(plugin: Plugin, next: { blocked?: boolean; featured?: boolean }) {
    await api(`/api/admin/console/plugins/${plugin.id}/state`, { method: "POST", body: JSON.stringify({ blocked: next.blocked ?? plugin.blocked, featured: next.featured ?? plugin.featured }) });
    toast("Catalog updated.");
    await data.reload();
  }

  return (
    <Section title="Plugins" detail="Turn catalog apps on or off, and choose which ones are featured for people." testid="section-plugins">
      {data.loading && !data.data ? <SkeletonBlock /> : null}
      {plugins.length === 0 && !data.loading ? <Empty title="No catalog apps yet." detail="Apps appear here after they are imported into the catalog." /> : plugins.length > 0 ? (
        <DataTable
          rows={plugins}
          rowKey={(plugin) => plugin.id}
          searchText={(plugin) => `${plugin.name} ${plugin.category || ""}`}
          emptyTitle="No apps match that search."
          filters={[{ id: "state", label: "State", value: (plugin) => (plugin.blocked ? "Disabled" : plugin.featured ? "Featured" : "Enabled") }]}
          columns={[
            { id: "app", header: "App", sortValue: (plugin) => plugin.name, cell: (plugin) => <span>{plugin.name}<p className="text-xs text-muted-foreground">{plugin.category || "Uncategorized"}</p></span> },
            { id: "health", header: "Health", sortValue: (plugin) => plugin.healthStatus || plugin.health_status || "", cell: (plugin) => { const value = plugin.healthStatus || plugin.health_status; return !value || value === "unknown" ? "Not checked" : value.charAt(0).toUpperCase() + value.slice(1); } },
            { id: "state", header: "Catalog", align: "right", cell: (plugin) => plugin.featured ? "Featured" : plugin.blocked ? "Disabled" : "Enabled" },
          ]}
          menus={canOperate ? [
            { label: "Disable", hidden: (plugin) => Boolean(plugin.blocked), onSelect: (plugin) => void save(plugin, { blocked: true }) },
            { label: "Enable", hidden: (plugin) => !plugin.blocked, onSelect: (plugin) => void save(plugin, { blocked: false }) },
            { label: "Feature", hidden: (plugin) => Boolean(plugin.featured), onSelect: (plugin) => void save(plugin, { featured: true }) },
            { label: "Unfeature", hidden: (plugin) => !plugin.featured, onSelect: (plugin) => void save(plugin, { featured: false }) },
          ] : undefined}
        />
      ) : null}
    </Section>
  );
}
