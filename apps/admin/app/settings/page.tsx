"use client";

import { useEffect, useState } from "react";
import { plans, useAdmin } from "@/components/admin-state";
import { Card, ConfirmButton, control, danger, Field, onSubmit, primary, Section, SkeletonBlock, useConsole, useToast } from "@/components/panel";
import { api, ApiError } from "@/lib/api";

type Settings = {
  brand_name?: string;
  support_email?: string;
  app_domain?: string;
  admin_domain?: string;
  legal_terms?: string;
  legal_privacy?: string;
};

export default function AdminSettingsPage() {
  const { payload, modelId, setModelId, modelLabel, setModelLabel, allowances, setAllowances, savePlatform, canOwn } = useAdmin();
  const remote = useConsole<Settings>("/api/admin/console/settings");
  const toast = useToast();
  const [brand, setBrand] = useState({ brandName: "", supportEmail: "", appDomain: "", adminDomain: "", legalTerms: "", legalPrivacy: "" });
  const [gdpr, setGdpr] = useState("");
  const [confirm, setConfirm] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const data = remote.data;
    if (!data) return;
    const read = data as Settings & { brandName?: string; supportEmail?: string; appDomain?: string; adminDomain?: string; legalTerms?: string; legalPrivacy?: string };
    if (read.brand_name == null && read.brandName == null && read.app_domain == null && read.appDomain == null) return;
    setBrand({
      brandName: read.brandName || read.brand_name || "",
      supportEmail: read.supportEmail || read.support_email || "",
      appDomain: read.appDomain || read.app_domain || "",
      adminDomain: read.adminDomain || read.admin_domain || "",
      legalTerms: read.legalTerms || read.legal_terms || "",
      legalPrivacy: read.legalPrivacy || read.legal_privacy || "",
    });
  }, [remote.data]);

  if (!payload) return null;

  return (
    <Section title="Settings" detail="The platform model, branding, domains, legal pages, and data requests." testid="section-settings">
      {remote.loading && !remote.data ? <SkeletonBlock /> : null}
      <form data-testid="platform-form" onSubmit={(event) => void savePlatform(event)} className="rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
        <h3 className="text-base font-medium">Model and credits</h3>
        <p className="mt-1 text-sm text-muted-foreground">The label is the name stored for staff. People using the product do not see a model name. No provider key is stored here.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="grid gap-2 text-sm" htmlFor="model-id">
            Model id
            <input id="model-id" data-testid="model-id" className="min-h-11 rounded-[8px] border border-input bg-card px-3" value={modelId} onChange={(event) => setModelId(event.target.value)} />
            <span className="text-sm text-muted-foreground">The registry id staff use. It is not shown in the product.</span>
          </label>
          <label className="grid gap-2 text-sm" htmlFor="model-label">
            Staff label
            <input id="model-label" data-testid="model-label" className="min-h-11 rounded-[8px] border border-input bg-card px-3" value={modelLabel} onChange={(event) => setModelLabel(event.target.value)} />
            <span className="text-sm text-muted-foreground">A short name for this console. Current value: {payload.modelLabel || "not set"}.</span>
          </label>
          {plans.map((plan) => (
            <label key={plan} className="grid gap-2 text-sm" htmlFor={`grant-${plan}`}>
              <span>{plan[0].toUpperCase() + plan.slice(1)} credits / month</span>
              <input id={`grant-${plan}`} data-testid={`grant-${plan}`} className="min-h-11 rounded-[8px] border border-input bg-card px-3 tabular-nums" inputMode="numeric" value={allowances[plan] ?? ""} onChange={(event) => setAllowances((current) => ({ ...current, [plan]: event.target.value }))} />
              <span className="text-sm text-muted-foreground">Credits included each month on the {plan} plan.</span>
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <button data-testid="platform-save" type="submit" className="inline-flex min-h-11 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground">
            Save settings
          </button>
        </div>
      </form>
      <Card title="Branding and domains">
        <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={onSubmit(async () => { await api("/api/admin/console/settings", { method: "PUT", body: JSON.stringify(brand) }); setNotice("Branding saved."); toast("Branding saved."); })}>
          <Field label="Brand name" help="The product name on the public site."><input className={control} aria-label="Brand name" value={brand.brandName} onChange={(event) => setBrand({ ...brand, brandName: event.target.value })} /></Field>
          <Field label="Support email" help="Where people write when they need help."><input className={control} aria-label="Support email" value={brand.supportEmail} onChange={(event) => setBrand({ ...brand, supportEmail: event.target.value })} /></Field>
          <Field label="App domain" help="The host people use, without https."><input className={control} aria-label="App domain" value={brand.appDomain} onChange={(event) => setBrand({ ...brand, appDomain: event.target.value })} /></Field>
          <Field label="Admin domain" help="The host for this console."><input className={control} aria-label="Admin domain" value={brand.adminDomain} onChange={(event) => setBrand({ ...brand, adminDomain: event.target.value })} /></Field>
          <Field className="md:col-span-2" label="Terms" help="Shown on the public terms page when this is filled in."><textarea className={`${control} min-h-28 py-2`} aria-label="Terms" value={brand.legalTerms} onChange={(event) => setBrand({ ...brand, legalTerms: event.target.value })} /></Field>
          <Field className="md:col-span-2" label="Privacy" help="Shown on the public privacy page when this is filled in."><textarea className={`${control} min-h-28 py-2`} aria-label="Privacy" value={brand.legalPrivacy} onChange={(event) => setBrand({ ...brand, legalPrivacy: event.target.value })} /></Field>
          {canOwn ? <div className="md:col-span-2 flex justify-end"><button type="submit" className={primary}>Save branding</button></div> : <p className="text-sm text-muted-foreground">An owner saves branding and legal text.</p>}
        </form>
        {notice ? <p className="mt-3 text-sm text-muted-foreground">{notice}</p> : null}
      </Card>
      <Card title="Data export and deletion">
        <p className="mt-1 text-sm text-muted-foreground">Export is a JSON copy of the account. Deletion removes the person and the rows that belong to them.</p>
        <form className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={onSubmit(async () => { const file = await api(`/api/admin/console/gdpr/${gdpr}`); setNotice("Export ready."); toast("Export ready."); void file; })}>
          <Field label="Account id" help="Paste the id from the person's profile.">
            <input className={control} aria-label="Account id" placeholder="Account id" value={gdpr} onChange={(event) => setGdpr(event.target.value)} />
          </Field>
          <button type="submit" className={primary}>Export</button>
        </form>
        {canOwn ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Username" help="Must match the account before deletion runs.">
              <input className={control} aria-label="Username to confirm deletion" placeholder="Username" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            </Field>
            <ConfirmButton className={danger} label="Delete personal data" title="Delete this person's data?" detail="The account and the rows that belong to them are removed." onConfirm={async () => { try { await api(`/api/admin/console/gdpr/${gdpr}`, { method: "DELETE", body: JSON.stringify({ confirm }) }); setNotice("Account deleted."); toast("Account deleted."); } catch (caught) { toast(caught instanceof ApiError ? caught.message : "Could not delete that account."); } }} />
          </div>
        ) : null}
      </Card>
    </Section>
  );
}
