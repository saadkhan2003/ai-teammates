"use client";
import { WidgetRenderer } from "@/components/widgets/widget-renderer";
const widgets = [
  { version: 1, id: "sample-card", type: "card", title: "Summary", body: "Your weekly review is ready.", items: ["Five tasks complete"], actions: [{ id: "open", label: "Open review", action: "open" }] },
  { version: 1, id: "sample-list", type: "list", title: "Next steps", items: ["Review draft", { title: "Share update", description: "With the project team" }] },
  { version: 1, id: "sample-table", type: "table", title: "Activity", columns: ["Day", "Tasks"], rows: [["Monday", 4], ["Tuesday", 6]] },
  { version: 1, id: "sample-form", type: "form", title: "Quick note", fields: [{ name: "note", label: "Note", type: "text", required: true }], submit: { id: "save", label: "Save note", action: "save_note" } },
  { version: 1, id: "sample-buttons", type: "buttons", title: "Choose", actions: [{ id: "continue", label: "Continue", action: "continue" }] },
  { version: 1, id: "sample-badges", type: "badges", title: "Status", items: [{ label: "Ready", tone: "success" }, { label: "In review", tone: "info" }] },
  { version: 1, id: "sample-kv", type: "key-value", title: "Details", items: [{ key: "Owner", value: "Sam" }, { key: "Updated", value: "Today" }] },
  { version: 1, id: "sample-progress", type: "progress", title: "Progress", label: "Import", value: 64 },
  { version: 1, id: "sample-images", type: "image-grid", title: "Images", images: [{ url: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=640", alt: "Mountain lake" }] },
  { version: 1, id: "sample-chart", type: "chart", title: "Weekly tasks", chart: "bar", data: [{ label: "Mon", value: 3 }, { label: "Tue", value: 5 }, { label: "Wed", value: 4 }] },
  { version: 1, id: "sample-flow", type: "flow", title: "Plan", nodes: [{ id: "start", label: "Gather", x: 0, y: 0 }, { id: "review", label: "Review", x: 180, y: 0 }, { id: "done", label: "Share", x: 360, y: 0 }], edges: [{ source: "start", target: "review" }, { source: "review", target: "done" }] },
  { version: 1, id: "sample-code", type: "code", title: "Read-only code", language: "typescript", filename: "answer.ts", code: "export const answer = 42", original: "export const answer = 41" },
] as const;
export default function WidgetsGallery() {
 return <main data-testid="widgets-gallery" className="h-full overflow-auto bg-background px-5 py-6 text-foreground"><div className="mx-auto max-w-5xl"><h1 className="text-lg font-semibold">Interactive message blocks</h1><p className="mb-5 mt-1 text-sm text-muted-foreground">Structured content stays readable and safe in every conversation.</p><div className="grid gap-3 md:grid-cols-2">{widgets.map(w=><WidgetRenderer key={w.id} value={w} onAction={async()=>{}} />)}</div></div></main>;
}
