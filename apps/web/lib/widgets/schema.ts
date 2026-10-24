import { z } from "zod";

export const WIDGET_VERSION = 1 as const;
export const WIDGET_MAX_BYTES = 48_000;
export const WIDGET_MAX_DEPTH = 8;
const text = z.string().max(4000);
const id = z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.:-]+$/);
const action = z.object({ id, label: text.max(160), action: id, requires_approval: z.boolean().optional(), payload: z.record(z.string(), z.unknown()).optional() }).strict();
const base = { version: z.literal(WIDGET_VERSION), id, title: text.max(240).optional() };
const cell = z.union([text, z.number().finite(), z.boolean(), z.null()]);
const field = z.object({ name: id, label: text.max(160), type: z.enum(["text", "email", "number", "select", "textarea"]), required: z.boolean().optional(), options: z.array(text.max(160)).max(40).optional(), placeholder: text.max(240).optional() }).strict();
const point = z.object({ label: text.max(160), value: z.number().finite(), series: text.max(80).optional() }).strict();
const node = z.object({ id, label: text.max(160), x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000) }).strict();
const edge = z.object({ source: id, target: id, label: text.max(120).optional() }).strict();
const imageUrl = z.string().url().max(2048).refine(safeImageUrl, "Only HTTPS or same-origin image URLs are allowed");
function safeImageUrl(value: string): boolean {
  try { const u = new URL(value, "https://local.invalid"); return ((u.protocol === "https:" && u.hostname !== "local.invalid") || /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i.test(value)) && !u.username && !u.password; } catch { return false; }
}

export const WidgetSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("card"), body: text.optional(), items: z.array(text).max(40).optional(), actions: z.array(action).max(12).optional() }).strict(),
  z.object({ ...base, type: z.literal("list"), items: z.array(z.union([text, z.object({ title: text.max(240), description: text.optional() }).strict()])).max(100) }).strict(),
  z.object({ ...base, type: z.literal("table"), columns: z.array(text.max(120)).min(1).max(24), rows: z.array(z.array(cell).max(24)).max(200) }).strict(),
  z.object({ ...base, type: z.literal("form"), fields: z.array(field).min(1).max(24), submit: action }).strict(),
  z.object({ ...base, type: z.literal("buttons"), actions: z.array(action).min(1).max(16) }).strict(),
  z.object({ ...base, type: z.literal("badges"), items: z.array(z.object({ label: text.max(120), tone: z.enum(["neutral", "info", "success", "warning", "danger"]).optional() }).strict()).max(40) }).strict(),
  z.object({ ...base, type: z.literal("key-value"), items: z.array(z.object({ key: text.max(160), value: cell }).strict()).max(60) }).strict(),
  z.object({ ...base, type: z.literal("progress"), value: z.number().finite().min(0).max(100), label: text.max(160).optional() }).strict(),
  z.object({ ...base, type: z.literal("image-grid"), images: z.array(z.object({ url: imageUrl, alt: text.max(240), caption: text.max(240).optional() }).strict()).max(24) }).strict(),
  z.object({ ...base, type: z.literal("chart"), chart: z.enum(["bar", "line", "area", "pie"]), data: z.array(point).max(200), xKey: text.max(80).optional(), yKey: text.max(80).optional() }).strict(),
  z.object({ ...base, type: z.literal("flow"), nodes: z.array(node).max(80), edges: z.array(edge).max(160) }).strict(),
  z.object({ ...base, type: z.literal("code"), language: text.max(40), code: z.string().max(24000), original: z.string().max(24000).optional(), filename: text.max(240).optional() }).strict(),
]);
export type Widget = z.infer<typeof WidgetSchema>;
export type WidgetType = Widget["type"];

function depthOf(value: unknown, depth = 0): number {
  if (depth > WIDGET_MAX_DEPTH) return depth;
  if (Array.isArray(value)) return value.reduce((n, item) => Math.max(n, depthOf(item, depth + 1)), depth);
  if (value && typeof value === "object") return Object.values(value).reduce((n, item) => Math.max(n, depthOf(item, depth + 1)), depth);
  return depth;
}
export function validateWidget(value: unknown): Widget {
  const encoded = JSON.stringify(value);
  if (encoded.length > WIDGET_MAX_BYTES) throw new Error("Widget exceeds the maximum size");
  if (depthOf(value) > WIDGET_MAX_DEPTH) throw new Error("Widget exceeds the maximum nesting depth");
  return WidgetSchema.parse(value);
}
export function isSafeImageUrl(value: string): boolean { return safeImageUrl(value); }
