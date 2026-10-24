"use client";
import { ReactFlow, Background, Controls, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Widget } from "@/lib/widgets/schema";
export function FlowDiagram({ nodes, edges, label }: { nodes: Node[]; edges: Edge[]; label?: string }) {
  return <div className="h-60 overflow-hidden rounded-md border border-border" aria-label={label ?? "Flow diagram"}><ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}><Background /><Controls showInteractive={false} /></ReactFlow></div>;
}
export function FlowView({ widget }: { widget: Extract<Widget, { type: "flow" }> }) {
  const nodes: Node[] = widget.nodes.map(n => ({ id: n.id, position: { x: n.x, y: n.y }, data: { label: n.label }, type: "input" }));
  const edges: Edge[] = widget.edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target, label: e.label, animated: false }));
  return <FlowDiagram nodes={nodes} edges={edges} label={widget.title} />;
}
