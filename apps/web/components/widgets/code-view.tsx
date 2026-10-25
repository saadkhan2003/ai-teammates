"use client";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type { Widget } from "@/lib/widgets/schema";
export function CodeView({ widget }: { widget: Extract<Widget, { type: "code" }> }) {
  return <div data-testid="widget-code-editor" className="overflow-hidden rounded-md border border-border"><div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">{widget.filename ?? widget.language}</div>{widget.original !== undefined ? <DiffEditor height="280px" language={widget.language} original={widget.original} modified={widget.code} theme="vs-dark" options={{ readOnly: true, minimap: { enabled: false }, scrollBeyondLastLine: false }} /> : <Editor height="240px" language={widget.language} value={widget.code} theme="vs-dark" options={{ readOnly: true, minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: "on" }} />}</div>;
}
