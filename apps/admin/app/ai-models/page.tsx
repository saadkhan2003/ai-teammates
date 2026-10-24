"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AiOverview, AiKeySlots, AiOperations } from "@/components/ai-controls";
import { api } from "@/lib/api";
import { type Config, type Model, type Provider, type Role, type State, type Target, type Version, button, card, emptyConfig, input } from "@/lib/ai";

type Audit = { id: number; action: string; actor: string; created_at: string; detail: unknown };
const kinds = ["openrouter", "anthropic", "openai", "google", "openai_compatible", "mock"];
const defaults: Record<string, string> = { openrouter: "https://openrouter.ai/api/v1", anthropic: "https://api.anthropic.com", openai: "https://api.openai.com/v1", google: "https://generativelanguage.googleapis.com/v1beta/openai", mock: "http://mock-openrouter:8090/api/v1" };
const model = (): Model => ({ id: "", label: "", tools: true, vision: false, caching: false, context_tokens: 0 });
const blank = (): Provider => ({ id: "", name: "", kind: "openrouter", base_url: defaults.openrouter, enabled: true, models: [model()], key_set: false });

function TargetSelect({ label, value, providers, onChange, roleName, role }: { roleName?: string; role?: Role; label: string; value: Target; providers: Provider[]; onChange: (target: Target) => void }) {
  return <label className="grid min-w-0 gap-1 text-sm"><span>{label}</span><select aria-label={label} className={input} value={`${value.provider}|${value.model}`} onChange={e => { const split = e.target.value.indexOf("|"); onChange({ provider: e.target.value.slice(0, split), model: e.target.value.slice(split + 1) }); }}>
    <option value="|">Choose model</option>
    {providers.filter(p => p.enabled).map(p => <optgroup key={p.id} label={p.name}>{p.models.map(m => { const reasons = [((roleName === "chat" || roleName === "coding") && !(m.supported_parameters?.includes("tools") ?? m.tools)) ? "requires tools" : "", roleName === "vision" && !(m.input_modalities?.includes("image") ?? m.vision) ? "requires image input" : "", m.context_tokens < (role?.min_context_tokens ?? 0) ? "context too small" : "", role?.privacy && p.kind !== "openrouter" ? "privacy unsupported" : ""].filter(Boolean); return <option disabled={reasons.length > 0} key={m.id} value={`${p.id}|${m.id}`}>{p.name} / {m.label || m.id} · {m.tools ? "Tools " : ""}{m.vision ? "Images " : ""}{m.context_tokens} ctx{reasons.length ? ` · ${reasons.join(", ")}` : ""}</option>; })}</optgroup>)}
  </select></label>;
}

export default function AiModels() {
  const [state, setState] = useState<State | null>(null);
  const [config, setConfig] = useState<Config>(emptyConfig);
  const [versions, setVersions] = useState<Version[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<Provider>(blank);
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  const [budgetText, setBudgetText] = useState("{}");
  const [priceText, setPriceText] = useState("{}");
  const [results, setResults] = useState<Record<string, string>>({});
  const dialog = useRef<HTMLDialogElement>(null);
  const load = useCallback(async () => {
    const [next, history, log] = await Promise.all([api<State>("/api/admin/ai"), api<Version[]>("/api/admin/ai/versions"), api<Audit[]>("/api/admin/ai/audit")]);
    setState(next); setVersions(history); setAudit(log);
    const merged = { ...emptyConfig(), ...next.active_config };
    setBudgetText(JSON.stringify(merged.budgets ?? {}, null, 2));
    setConfig({ ...merged, rollout: next.rollout }); setPriceText(JSON.stringify(merged.credit_prices ?? {}, null, 2));
  }, []);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);
  async function action(work: () => Promise<unknown>, message: string) {
    setBusy(true); setError("");
    try { await work(); await load(); setNotice(message); }
    catch (e) { setError(e instanceof Error ? e.message : "Request failed."); }
    finally { setBusy(false); }
  }
  function edit(provider = blank()) { setEditor(structuredClone(provider)); setKey(""); dialog.current?.showModal(); }
  async function saveProvider(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const result = await api<{ id: string }>(`/api/admin/ai/providers${editor.id ? `/${editor.id}` : ""}`, { method: editor.id ? "PUT" : "POST", body: JSON.stringify(editor.id ? editor : (({ id: _id, ...rest }) => rest)(editor)) });
      // Keep the provider id if saving the key fails, so retry edits rather than duplicates it.
      setEditor(current => ({ ...current, id: result.id }));
      if (key) await api(`/api/admin/ai/providers/${result.id}/key`, { method: "PUT", body: JSON.stringify({ key }) });
      setKey(""); dialog.current?.close(); await load(); setNotice("Provider saved. Changes take effect on the next request.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save provider."); }
    finally { setBusy(false); }
  }
  async function test(provider: Provider) {
    setResults(current => ({ ...current, [provider.id]: "Testing…" }));
    try { const result = await api<{ ok: boolean; latency_ms: number; error?: string }>(`/api/admin/ai/providers/${provider.id}/test`, { method: "POST" }); setResults(current => ({ ...current, [provider.id]: `${result.ok ? "Connected" : result.error ?? "Failed"} · ${result.latency_ms} ms` })); }
    catch (e) { setResults(current => ({ ...current, [provider.id]: e instanceof Error ? e.message : "Test failed" })); }
  }
  function updateRole(name: string, role: Role) { setConfig(current => ({ ...current, roles: { ...current.roles, [name]: role } })); }
  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    await action(async () => {
      const credit_prices = JSON.parse(priceText) as Config["credit_prices"];
      await api("/api/admin/ai/config", { method: "PUT", body: JSON.stringify({ config: { ...config, budgets: JSON.parse(budgetText), credit_prices }, note, as_candidate: true }) });
    }, "Configuration saved. Run eval and publish the candidate in Evals.");
  }
  if (!state) return <div aria-busy={!error}>{error ? <p role="alert">{error}</p> : "Loading AI configuration…"}<button className={button} onClick={() => void load().catch(e => setError(e.message))}>Refresh</button></div>;
  const fallbackTarget = { provider: "", model: "" };
  return <>
    <header><h2 className="text-xl font-semibold">AI models</h2><p className="mt-1 text-sm text-muted-foreground">Active version {state.version}{state.bootstrap ? " · environment defaults" : ""}. Published changes apply on the next model request, including running chats.</p></header>
    {notice && <p role="status" className="rounded-[6px] border border-border p-3 text-sm">{notice}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <AiOverview />
    <section className={card}><div className="flex items-center justify-between"><h3 className="font-medium">Providers &amp; keys</h3><button className={button} onClick={() => edit()}>Add provider</button></div>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["Provider", "Kind / URL", "Status", "Key", "Actions"].map(t => <th className="p-2" key={t}>{t}</th>)}</tr></thead><tbody>{state.providers.map(p => <tr key={p.id} className="border-t border-border"><td className="p-2">{p.name}</td><td className="max-w-72 break-all p-2">{p.kind}<br />{p.base_url}</td><td className="p-2">{p.enabled ? "Enabled" : "Disabled"}</td><td className="p-2">{p.key_set ? "Set" : "Not set"}{p.key_updated_at && <small className="block">{new Date(p.key_updated_at).toLocaleString()}</small>}</td><td className="p-2"><div className="flex gap-2"><button className={button} onClick={() => edit(p)}>Edit {p.name}</button><button className={button} onClick={() => void test(p)}>Test {p.name}</button><button className={button} disabled={busy} onClick={() => void action(() => api(`/api/admin/ai/providers/${p.id}`, { method: "DELETE" }), "Provider deleted.")}>Delete {p.name}</button></div><p role="status">{results[p.id]}</p><AiKeySlots id={p.id} refresh={load} /></td></tr>)}</tbody></table></div>
      {!state.providers.length && <p className="text-sm text-muted-foreground">Add a provider and its model list to replace environment defaults.</p>}
    </section>
    <dialog ref={dialog} onClose={() => setKey("")} className="m-auto max-h-[90dvh] w-[min(95vw,800px)] overflow-auto rounded-[8px] border border-border bg-card p-6 text-foreground backdrop:bg-black/50">
      <form onSubmit={event => void saveProvider(event)} className="space-y-4"><h3 className="text-lg font-semibold">{editor.id ? "Edit provider" : "Add provider"}</h3><p className="text-sm text-muted-foreground">Keys are write-only. Leave the key empty to keep the saved key.</p>
        <label className="grid gap-1">Provider name<input required className={input} value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} /></label>
        <label className="grid gap-1">Kind<select className={input} value={editor.kind} onChange={e => setEditor({ ...editor, kind: e.target.value, base_url: defaults[e.target.value] ?? editor.base_url })}>{kinds.map(k => <option key={k}>{k}</option>)}</select></label>
        <label className="grid gap-1">Base URL<input required type="url" className={input} value={editor.base_url} onChange={e => setEditor({ ...editor, base_url: e.target.value })} /></label>
        <label className="flex gap-2"><input type="checkbox" checked={editor.enabled} onChange={e => setEditor({ ...editor, enabled: e.target.checked })} />Enabled</label>
        <label className="grid gap-1">API key<input type="password" autoComplete="new-password" className={input} value={key} onChange={e => setKey(e.target.value)} /></label>
        <h4 className="font-medium">Model list</h4>{editor.models.map((m, i) => <fieldset key={i} className="grid gap-2 rounded-[6px] border border-border p-3 sm:grid-cols-2"><legend>Model {i + 1}</legend>{(["id", "label", "context_tokens", "max_completion_tokens"] as const).map(field => <label className="grid gap-1" key={field}>{field}<input required={field === "id"} type={field === "context_tokens" || field === "max_completion_tokens" ? "number" : "text"} min={0} className={input} value={m[field] ?? ""} onChange={e => setEditor({ ...editor, models: editor.models.map((item, n) => n === i ? { ...item, [field]: field === "context_tokens" || field === "max_completion_tokens" ? Number(e.target.value) : e.target.value } : item) })} /></label>)}<div className="grid gap-2">{(["prompt", "completion"] as const).map(price => <label key={price} className="grid gap-1">{price} USD per token (manual)<input className={input} type="number" min={0} step="any" value={m.pricing?.[price] ?? ""} onChange={e => setEditor({ ...editor, models: editor.models.map((item, n) => n === i ? { ...item, pricing: { ...item.pricing, [price]: e.target.value } } : item) })} /></label>)}</div><div className="flex flex-wrap gap-3">{(["vision", "tools", "caching"] as const).map(flag => <label className="flex items-center gap-1" key={flag}><input type="checkbox" checked={m[flag]} onChange={e => setEditor({ ...editor, models: editor.models.map((item, n) => n === i ? { ...item, [flag]: e.target.checked } : item) })} />{flag}</label>)}</div><button type="button" className={button} onClick={() => setEditor({ ...editor, models: editor.models.filter((_, n) => n !== i) })}>Remove model {i + 1}</button></fieldset>)}
        <button className={button} type="button" onClick={() => setEditor({ ...editor, models: [...editor.models, model()] })}>Add model</button>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className={button} onClick={() => dialog.current?.close()}>Cancel</button><button disabled={busy} className={button}>Save provider</button></div>
      </form>
    </dialog>
    <form onSubmit={event => void saveConfig(event)} className="space-y-6">
      <section className={card}><h3 className="font-medium">Roles</h3><p className="text-sm text-muted-foreground">Chat is required. Other roles inherit chat until configured. Fallbacks run in order on connection failures, timeouts, 429 and server errors.</p>
        {[["chat", "Chat / planner"], ["quick", "Quick / acknowledgements and titles"], ["vision", "Vision"], ["coding", "Coding"]].map(([name, label]) => {
          const role = config.roles[name] ?? { primary: fallbackTarget, fallbacks: [] };
          return <fieldset key={name} className="space-y-3 border-t border-border pt-3"><legend className="font-medium">{label}</legend><TargetSelect label={`${label} primary`} roleName={name} role={role} value={role.primary} providers={state.providers} onChange={primary => updateRole(name, { ...role, primary })} />
            {(role.fallbacks ?? []).map((t, i) => <div key={i} className="flex items-end gap-2"><div className="flex-1"><TargetSelect label={`${label} fallback ${i + 1}`} roleName={name} role={role} value={t} providers={state.providers} onChange={target => updateRole(name, { ...role, fallbacks: role.fallbacks.map((old, n) => n === i ? target : old) })} /></div><button type="button" className={button} disabled={i === 0} onClick={() => { const fallbacks = [...role.fallbacks]; [fallbacks[i - 1], fallbacks[i]] = [fallbacks[i], fallbacks[i - 1]]; updateRole(name, { ...role, fallbacks }); }}>Move up</button><button type="button" className={button} onClick={() => updateRole(name, { ...role, fallbacks: role.fallbacks.filter((_, n) => n !== i) })}>Remove</button></div>)}
            <div className="grid gap-3 sm:grid-cols-3"><label className="grid gap-1">{label} max tokens<input className={input} type="number" min={1} value={role.max_tokens ?? 2048} onChange={e => updateRole(name, { ...role, max_tokens: Number(e.target.value) })} /></label><label className="grid gap-1">{label} temperature<input className={input} type="number" min={0} max={2} step="0.1" value={role.temperature ?? ""} onChange={e => updateRole(name, { ...role, temperature: e.target.value ? Number(e.target.value) : undefined })} /></label><label className="grid gap-1">{label} minimum context<input className={input} type="number" min={0} value={role.min_context_tokens ?? 0} onChange={e => updateRole(name, { ...role, min_context_tokens: Number(e.target.value) })} /></label></div><label className="flex gap-2"><input type="checkbox" checked={role.privacy ?? false} onChange={e => updateRole(name, { ...role, privacy: e.target.checked })} />{label} privacy (ZDR; data collection denied)</label>
            <div className="flex gap-2"><button className={button} type="button" onClick={() => updateRole(name, { ...role, fallbacks: [...(role.fallbacks ?? []), fallbackTarget] })}>Add {name} fallback</button>{name !== "chat" && <button className={button} type="button" onClick={() => { const roles = { ...config.roles }; delete roles[name]; setConfig({ ...config, roles }); }}>Inherit chat</button>}</div>
          </fieldset>;
        })}
      </section>
      <section className={card}><h3 className="font-medium">Caching and latency</h3>{(["enabled", "anthropic_cache_control", "session_id_per_conversation"] as const).map(flag => <label className="flex gap-2" key={flag}><input type="checkbox" checked={config.caching?.[flag] ?? true} onChange={e => setConfig({ ...config, caching: { ...emptyConfig().caching, ...config.caching, [flag]: e.target.checked } })} />{flag.replaceAll("_", " ")}</label>)}<label className="grid gap-1">Cache TTL<select className={input} value={config.caching?.ttl ?? "5m"} onChange={e => setConfig({ ...config, caching: { ...emptyConfig().caching, ...config.caching, ttl: e.target.value } })}><option>5m</option><option>1h</option></select></label><label className="grid gap-1">Preferred maximum latency (ms, optional)<input type="number" min={1} className={input} value={config.latency?.preferred_max_latency_ms ?? ""} onChange={e => setConfig({ ...config, latency: { preferred_max_latency_ms: e.target.value ? Number(e.target.value) : null } })} /></label></section>
      <section className={card}><h3 className="font-medium">Credit price map per plan</h3><p className="text-sm text-muted-foreground">JSON: {`{"default":{"model-id":{"input_per_mtok":1,"output_per_mtok":3,"multiplier":1}}}`}. This deployment uses the default plan. Credits = tokens × price per million × multiplier.</p><label className="grid gap-1">Credit prices<textarea rows={7} className={`${input} py-2 font-mono`} value={priceText} onChange={e => setPriceText(e.target.value)} spellCheck={false} /></label></section>
      <section className={card}><h3 className="font-medium">Budgets</h3><p className="text-sm">USD caps by plans.default, users (owner UUID), and bots (bot UUID). Each entry supports daily, monthly, action (block or downgrade), and downgrade target (provider UUID and model ID). Plan and user caps both apply; block takes precedence. Spend checks are cached for three seconds.</p><label className="grid gap-1">Spend caps JSON<textarea rows={8} className={`${input} py-2 font-mono`} value={budgetText} onChange={e => setBudgetText(e.target.value)} /></label><h4>Retries and cooldown</h4>{(["max_retries", "allowed_fails", "cooldown_seconds"] as const).map(field => <label className="grid gap-1" key={field}>{field.replaceAll("_", " ")}<input type="number" min={field === "max_retries" ? 0 : 1} className={input} value={config.retry?.[field] ?? ({ max_retries: 1, allowed_fails: 3, cooldown_seconds: 30 })[field]} onChange={e => setConfig({ ...config, retry: { max_retries: 1, allowed_fails: 3, cooldown_seconds: 30, ...config.retry, [field]: Number(e.target.value) } })} /></label>)}</section>
      <section className={card}><label className="grid gap-1">Version note<input className={input} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></label><p className="text-sm text-muted-foreground">Saves a candidate at 0%. Run eval before publishing.</p><button disabled={busy} className={`${button} bg-primary text-primary-foreground`}>Save configuration</button></section>
    </form>
    <section className={card}><h3 className="font-medium">Rollout</h3><label className="grid gap-1">Candidate version<select className={input} value={config.rollout?.candidate_version ?? ""} onChange={e => setConfig({ ...config, rollout: { ...config.rollout, candidate_version: e.target.value ? Number(e.target.value) : null } })}><option value="">None</option>{versions.filter(v => !v.is_active).map(v => <option key={v.version} value={v.version}>Version {v.version} · {v.note}</option>)}</select></label><label className="grid gap-1">Percent<input className={input} type="number" min={0} max={100} value={config.rollout?.percent ?? 0} onChange={e => setConfig({ ...config, rollout: { ...config.rollout, percent: Number(e.target.value) } })} /></label><input aria-label="Rollout percentage" type="range" min={0} max={100} value={config.rollout?.percent ?? 0} onChange={e => setConfig({ ...config, rollout: { ...config.rollout, percent: Number(e.target.value) } })} className="w-full" /><div className="flex gap-2"><button disabled={busy} className={button} onClick={() => void action(() => api("/api/admin/ai/rollout", { method: "PUT", body: JSON.stringify(config.rollout) }), "Rollout updated.")}>Save rollout</button><button disabled={busy || !state.rollout.candidate_version} className={button} onClick={() => void action(() => api("/api/admin/ai/rollout/promote", { method: "POST" }), "Candidate activated.")}>Promote candidate</button></div></section>
    <AiOperations versions={versions} reload={load} />
    <section className={card}><h3 className="font-medium">Versions</h3>{versions.length === 0 && <p>No saved versions yet.</p>}{versions.map(v => <div key={v.version} className="flex items-center justify-between gap-3 border-t border-border pt-3"><p>Version {v.version} {v.is_active && <span className="rounded-[4px] bg-accent px-2">Active</span>}<span className="block text-sm text-muted-foreground">{v.note} · {new Date(v.created_at).toLocaleString()}</span></p><button disabled={busy} className={button} onClick={() => void action(() => api(`/api/admin/ai/versions/${v.version}/rollback`, { method: "POST" }), "Rollback saved. Active pointer restored.")}>Rollback to {v.version}</button></div>)}</section>
    <section className={card}><h3 className="font-medium">Audit log</h3>{!audit.length && <p>No changes yet.</p>}{audit.map(item => <details key={item.id} className="border-t border-border pt-2"><summary>{item.action} · {new Date(item.created_at).toLocaleString()}</summary><p className="text-sm text-muted-foreground">Actor {item.actor}</p><pre className="overflow-x-auto text-xs">{JSON.stringify(item.detail, null, 2)}</pre></details>)}</section>
  </>;
}
