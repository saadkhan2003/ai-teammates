"use client";

import { Puzzle } from "lucide-react";
import { cardClass, SectionTitle } from "@/components/account/chrome";
import { PluginsPane } from "@/components/plugins-pane";

export default function PluginsSettingsPage() {
  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <header>
        <h2 className="text-title">Plugins</h2>
        <p className="mt-1 text-body-sm text-muted-foreground">
          One catalog for MCP servers, OpenAPI APIs, and built-ins. Search, install, connect a credential, and enable a plugin per teammate. Nothing runs until a tool is called.
        </p>
      </header>
      <section className={`${cardClass} p-4`}>
        <SectionTitle icon={<Puzzle className="size-4" aria-hidden="true" />}>Marketplace</SectionTitle>
        <div className="mt-4">
          <PluginsPane mode="both" />
        </div>
      </section>
    </div>
  );
}
