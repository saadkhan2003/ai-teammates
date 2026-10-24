"use client";

import { useState } from "react";
import { useAdmin } from "@/components/admin-state";
import { Card, control, Empty, Field, money, onSubmit, primary, Section, SkeletonBlock, useConsole, useToast } from "@/components/panel";
import { api } from "@/lib/api";

type Plan = { planId?: string; plan_id?: string; priceCents?: number; price_cents?: number; weeklyCredits?: number; weekly_credits?: number; storageMb?: number; storage_mb?: number; ramMb?: number; ram_mb?: number; cpuMillis?: number; cpu_millis?: number };
type Topup = { enabled?: boolean; packCredits?: number; pack_credits?: number; packCents?: number; pack_cents?: number; maxPacksPerWeek?: number; max_packs_per_week?: number };

function idOf(plan: Plan) {
  return plan.planId || plan.plan_id || "";
}

function pretty(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export default function PlansPage() {
  const { canOperate } = useAdmin();
  const data = useConsole<{ plans?: Plan[]; topup?: Topup; caps?: { storageMb: number; ramMb: number } }>("/api/admin/console/plans");
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, Plan>>({});
  const plans = data.data?.plans ?? [];
  const topup = data.data?.topup;
  const capGb = ((data.data?.caps?.storageMb ?? 51200) / 1024).toFixed(0);

  return (
    <Section title="Plans and limits" detail={`Price, weekly credits, storage up to ${capGb} GB, memory up to 8 GB, and processor size. A person can also have an override.`} testid="section-plans">
      {data.loading && !data.data ? <SkeletonBlock /> : null}
      {plans.length === 0 && !data.loading ? <Empty title="No plans yet." detail="Free, Pro, and Team appear after the platform settings are installed." /> : (
        <div className="grid gap-4 xl:grid-cols-2">
          {plans.map((plan) => {
            const id = idOf(plan);
            const draft = drafts[id] ?? plan;
            const price = draft.priceCents ?? draft.price_cents ?? 0;
            const weekly = draft.weeklyCredits ?? draft.weekly_credits ?? 0;
            const storage = draft.storageMb ?? draft.storage_mb ?? 0;
            const ram = draft.ramMb ?? draft.ram_mb ?? 0;
            const cpu = draft.cpuMillis ?? draft.cpu_millis ?? 0;
            return (
              <Card key={id} title={id[0]?.toUpperCase() + id.slice(1)} help={`${money(Number(price))} a month · ${weekly.toLocaleString()} credits a week`}>
                <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={onSubmit(async () => {
                  await api(`/api/admin/console/plans/${id}`, { method: "PUT", body: JSON.stringify({ priceCents: Number(price), weeklyCredits: Number(weekly), storageMb: Number(storage), ramMb: Number(ram), cpuMillis: Number(cpu) }) });
                  toast(`${id} saved.`);
                  await data.reload();
                })}>
                  <Field label="Price" help="US dollars per month."><input className={control} inputMode="decimal" aria-label={`${id} price`} value={(Number(price) / 100).toFixed(2)} onChange={(event) => setDrafts({ ...drafts, [id]: { ...draft, priceCents: Math.round(Number(event.target.value) * 100) } })} /></Field>
                  <Field label="Weekly credits" help="Credits added each week on this plan."><input className={control} inputMode="numeric" aria-label={`${id} weekly credits`} value={weekly} onChange={(event) => setDrafts({ ...drafts, [id]: { ...draft, weeklyCredits: Number(event.target.value) } })} /></Field>
                  <Field label="Storage" help={`Gigabytes. The ceiling is ${capGb} GB.`}><input className={control} inputMode="decimal" aria-label={`${id} storage`} value={pretty(Number(storage) / 1024)} onChange={(event) => setDrafts({ ...drafts, [id]: { ...draft, storageMb: Math.round(Number(event.target.value) * 1024) } })} /></Field>
                  <Field label="Memory" help="Gigabytes. The ceiling is 8 GB."><input className={control} inputMode="decimal" aria-label={`${id} memory`} value={pretty(Number(ram) / 1024)} onChange={(event) => setDrafts({ ...drafts, [id]: { ...draft, ramMb: Math.round(Number(event.target.value) * 1024) } })} /></Field>
                  <Field label="Processor" help="Cores. One core is the usual allowance."><input className={control} inputMode="decimal" aria-label={`${id} processor`} value={pretty(Number(cpu) / 1000)} onChange={(event) => setDrafts({ ...drafts, [id]: { ...draft, cpuMillis: Math.round(Number(event.target.value) * 1000) } })} /></Field>
                  {canOperate ? <div className="sm:col-span-2 flex justify-end"><button className={primary} type="submit">Save {id}</button></div> : null}
                </form>
              </Card>
            );
          })}
        </div>
      )}
      <Card title="On-demand top-up" help={topup?.enabled ? "Packs can be recorded on an account. A card is not charged." : "Packs are off. Turning them on only records credit. It does not charge a card."}>
        <p className="mt-3 text-sm tabular-nums">{topup ? `${topup.packCredits ?? topup.pack_credits} credits · ${money(topup.packCents ?? topup.pack_cents ?? 0)} · ${topup.maxPacksPerWeek ?? topup.max_packs_per_week} packs a week` : "No pack rule yet."}</p>
        {canOperate && topup ? (
          <form className="mt-4" onSubmit={onSubmit(async () => { await api("/api/admin/console/topup", { method: "PUT", body: JSON.stringify({ enabled: !topup.enabled, packCredits: topup.packCredits ?? topup.pack_credits, packCents: topup.packCents ?? topup.pack_cents, maxPacksPerWeek: topup.maxPacksPerWeek ?? topup.max_packs_per_week }) }); toast(topup.enabled ? "Top-up packs are off." : "Top-up packs are on."); await data.reload(); })}>
            <button type="submit" className={primary}>{topup.enabled ? "Turn packs off" : "Turn packs on"}</button>
          </form>
        ) : null}
      </Card>
    </Section>
  );
}
