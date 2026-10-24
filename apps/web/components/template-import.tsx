"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

export function TemplateImport({ onTemplate }: { onTemplate: (template: Record<string, unknown>) => void }) {
  const [value, setValue] = useState(""); const [error, setError] = useState("");
  async function importValue() {
    setError("");
    try {
      let raw = value.trim();
      const match = raw.match(/#template=([A-Za-z0-9_-]+)/);
      if (match) raw = decodeURIComponent(escape(atob(match[1].replace(/-/g, "+").replace(/_/g, "/"))));
      const candidate = raw.startsWith("{") ? JSON.parse(raw) : JSON.parse(raw);
      const clean = await api<Record<string, unknown>>("/api/templates/preview", { method: "POST", body: JSON.stringify(candidate) });
      onTemplate(clean); setValue("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "That template could not be imported."); }
  }
  return <section className="grid gap-2 rounded-md border border-border p-3"><p className="text-sm font-medium">Import template</p><p className="text-xs text-muted-foreground">Paste a template link or JSON. The template is validated before it fills the form.</p><Input aria-label="Template link or JSON" placeholder="Paste link or JSON" value={value} onChange={event => setValue(event.target.value)} /><Button type="button" variant="outline" size="sm" onClick={() => void importValue()} disabled={!value.trim()}>Import</Button>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</section>;
}
