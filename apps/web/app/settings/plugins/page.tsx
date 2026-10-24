"use client";

import { PluginsPane } from "@/components/plugins-pane";

export default function PluginsSettingsPage() {
  return (
    <div id="plugins" className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-medium">Plugins</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One catalog for MCP servers, OpenAPI APIs, and built-ins. Search, install, connect a credential, and enable a plugin per teammate. Nothing runs until a tool is called.
        </p>
      </div>
      <PluginsPane mode="both" />
    </div>
  );
}
