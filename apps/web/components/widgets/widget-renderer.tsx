"use client";
import dynamic from "next/dynamic";
import { useState, type FormEvent } from "react";
import { MotionConfig, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { validateWidget, type Widget } from "@/lib/widgets/schema";
const ChartView = dynamic(() => import("./chart-view").then(m => m.ChartView), { ssr: false, loading: () => <div className="h-56 animate-pulse rounded-md bg-muted" /> });
const FlowView = dynamic(() => import("./flow-view").then(m => m.FlowView), { ssr: false, loading: () => <div className="h-72 animate-pulse rounded-md bg-muted" /> });
const CodeView = dynamic(() => import("./code-view").then(m => m.CodeView), { ssr: false, loading: () => <div className="h-60 animate-pulse rounded-md bg-muted" /> });
export function WidgetRenderer({ value, onAction }: { value: unknown; onAction?: (widget: Widget, action: string, payload: Record<string, unknown>) => Promise<void> }) {
  let widget: Widget;
  try { widget = validateWidget(value); } catch { return <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground" data-testid="widget-fallback">This interactive content is unavailable.</div>; }
  const act = (action: string, payload: Record<string, unknown> = {}) => void onAction?.(widget, action, payload);
  const heading = widget.title ? <h3 className="mb-2 text-sm font-semibold">{widget.title}</h3> : null;
  let body;
  switch (widget.type) {
    case "card": body = <>{widget.body ? <p className="whitespace-pre-wrap text-sm">{widget.body}</p> : null}{widget.items?.length ? <ul className="mt-2 list-disc pl-5 text-sm">{widget.items.map((x,i)=><li key={i}>{x}</li>)}</ul> : null}{widget.actions?.map(a=><Button key={a.id} size="sm" variant="outline" className="mt-3 mr-2" onClick={()=>act(a.action,a.payload)}>{a.label}</Button>)}</>; break;
    case "list": body = <ul className="space-y-2">{widget.items.map((x,i)=><li key={i} className="text-sm">{typeof x === "string" ? x : <><strong>{x.title}</strong>{x.description ? <p className="text-muted-foreground">{x.description}</p> : null}</>}</li>)}</ul>; break;
    case "table": body = <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{widget.columns.map((c,i)=><th key={i} className="border-b border-border px-2 py-1.5">{c}</th>)}</tr></thead><tbody>{widget.rows.map((r,i)=><tr key={i}>{r.map((c,j)=><td key={j} className="border-b border-border/60 px-2 py-1.5">{String(c ?? "")}</td>)}</tr>)}</tbody></table></div>; break;
    case "form": body = <WidgetForm widget={widget} act={act} />; break;
    case "buttons": body = <div className="flex flex-wrap gap-2">{widget.actions.map(a=><Button key={a.id} size="sm" variant="outline" onClick={()=>act(a.action,a.payload)}>{a.label}</Button>)}</div>; break;
    case "badges": body = <div className="flex flex-wrap gap-2">{widget.items.map((x,i)=><span key={i} className="rounded-md border border-border px-2 py-1 text-xs">{x.label}</span>)}</div>; break;
    case "key-value": body = <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1 text-sm">{widget.items.map((x,i)=><div key={i} className="contents"><dt className="text-muted-foreground">{x.key}</dt><dd className="break-words">{String(x.value ?? "")}</dd></div>)}</dl>; break;
    case "progress": body = <div><div className="mb-1 flex justify-between text-xs"><span>{widget.label ?? "Progress"}</span><span>{widget.value}%</span></div><progress className="h-2 w-full accent-primary" max={100} value={widget.value} /></div>; break;
    case "image-grid": body = <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{widget.images.map((im,i)=><figure key={i}><img src={im.url} alt={im.alt} loading="lazy" className="aspect-video w-full rounded-md object-cover" />{im.caption ? <figcaption className="mt-1 text-xs text-muted-foreground">{im.caption}</figcaption> : null}</figure>)}</div>; break;
    case "chart": body = <ChartView widget={widget} />; break;
    case "flow": body = <FlowView widget={widget} />; break;
    case "code": body = <CodeView widget={widget} />; break;
    default: body = <div data-testid="widget-fallback">This content type is not supported.</div>;
  }
  return <MotionConfig reducedMotion="user"><motion.section data-testid={`widget-${widget.type}`} data-widget-id={widget.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }} className="my-2 rounded-md border border-border bg-card/70 p-3 text-card-foreground">{heading}{body}</motion.section></MotionConfig>;
}
function WidgetForm({ widget, act }: { widget: Extract<Widget, {type:"form"}>; act: (action:string,payload?:Record<string,unknown>)=>void }) {
  const [values,setValues]=useState<Record<string,string>>({});
  function submit(e:FormEvent){e.preventDefault();act(widget.submit.action,{...widget.submit.payload,values});}
  return <form onSubmit={submit} className="space-y-3">{widget.fields.map(f=><label key={f.name} className="block space-y-1 text-xs"><span>{f.label}{f.required ? " *" : ""}</span>{f.type==="textarea"?<Textarea required={f.required} placeholder={f.placeholder} value={values[f.name]??""} onChange={e=>setValues({...values,[f.name]:e.target.value})}/>:f.type==="select"?<select required={f.required} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={values[f.name]??""} onChange={e=>setValues({...values,[f.name]:e.target.value})}><option value="">Choose…</option>{(f.options??[]).map(o=><option key={o}>{o}</option>)}</select>:<Input required={f.required} type={f.type} placeholder={f.placeholder} value={values[f.name]??""} onChange={e=>setValues({...values,[f.name]:e.target.value})}/>}</label>)}<Button type="submit" size="sm">{widget.submit.label}</Button></form>;
}
