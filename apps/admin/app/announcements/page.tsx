"use client";

import { useState } from "react";
import { useAdmin } from "@/components/admin-state";
import { Card, control, DataTable, Empty, Field, onSubmit, primary, Section, SkeletonBlock, Stat, useConsole, useToast } from "@/components/panel";
import { api } from "@/lib/api";

type Item = { id: string; title: string; body: string; kind: string; published: boolean };
type Template = { id: string; subject: string; body: string };

function kindLabel(kind: string) {
  if (kind === "changelog") return "Changelog";
  if (kind === "banner") return "Banner";
  return kind;
}

function templateName(id: string) {
  return id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function AnnouncementsPage() {
  const { canSupport, canOperate } = useAdmin();
  const news = useConsole<{ announcements?: Item[] }>("/api/admin/console/announcements");
  const mail = useConsole<{ templates?: Template[]; provider?: string; configured?: boolean }>("/api/admin/console/templates");
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState("banner");
  const items = news.data?.announcements ?? [];
  const templates = mail.data?.templates ?? [];

  return (
    <Section title="Announcements" detail="Changelog entries, in-app banners, and the email templates Resend sends when a key is configured." testid="section-announcements">
      {news.loading && !news.data ? <SkeletonBlock /> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Published" value={String(items.filter((item) => item.published).length)} help="Banners and changelog entries that are live." />
        <Stat label="Templates" value={String(templates.length)} help="Messages the product can send." />
        <Stat label="Email" value={mail.data ? (mail.data.configured ? "Ready" : "Not configured") : "—"} help={mail.data?.configured ? "Resend has a key." : "Resend has no key, so mail is not sent."} />
      </div>
      {items.length === 0 && !news.loading ? (
        <Empty title="No announcements yet." detail="Publish a banner or a changelog note for people to read." />
      ) : items.length > 0 ? (
        <DataTable
          rows={items}
          rowKey={(item) => item.id}
          searchText={(item) => `${item.title} ${item.body} ${item.kind}`}
          emptyTitle="No announcements match that search."
          filters={[{ id: "kind", label: "Kind", value: (item) => kindLabel(item.kind) }]}
          columns={[
            { id: "title", header: "Title", sortValue: (item) => item.title, cell: (item) => <span>{item.title}<p className="text-xs text-muted-foreground">{item.body}</p></span> },
            { id: "kind", header: "Kind", sortValue: (item) => item.kind, cell: (item) => kindLabel(item.kind) },
            { id: "state", header: "State", align: "right", sortValue: (item) => (item.published ? 1 : 0), cell: (item) => (item.published ? "Published" : "Draft") },
          ]}
        />
      ) : null}
      {canSupport ? (
        <Card title="New announcement" help="Published notes show on the changelog when the kind is changelog, and as a banner otherwise.">
          <form className="mt-4 grid gap-4" onSubmit={onSubmit(async () => { await api("/api/admin/console/announcements", { method: "POST", body: JSON.stringify({ title, body, kind, published: true }) }); setTitle(""); setBody(""); toast("Announcement published."); await news.reload(); })}>
            <Field label="Title" help="A short line people can scan."><input className={control} aria-label="Announcement title" value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
            <Field label="Body" help="One or two sentences."><textarea className={`${control} min-h-24 py-2`} aria-label="Announcement body" value={body} onChange={(event) => setBody(event.target.value)} /></Field>
            <Field label="Kind" help="Changelog entries also appear on the public changelog.">
              <select className={control} aria-label="Announcement kind" value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="banner">Banner</option>
                <option value="changelog">Changelog</option>
              </select>
            </Field>
            <div className="flex justify-end"><button className={primary} type="submit">Publish</button></div>
          </form>
        </Card>
      ) : null}
      {templates.length === 0 && !mail.loading ? (
        <Empty title="No email templates yet." detail="Welcome, password reset, and invoice templates are installed with the platform." />
      ) : templates.length > 0 ? (
        <DataTable
          rows={templates}
          rowKey={(template) => template.id}
          searchText={(template) => `${templateName(template.id)} ${template.subject} ${template.body}`}
          emptyTitle="No templates match that search."
          columns={[
            { id: "name", header: "Template", sortValue: (template) => template.id, cell: (template) => templateName(template.id) },
            { id: "subject", header: "Subject", sortValue: (template) => template.subject, cell: (template) => template.subject },
            { id: "body", header: "Body", cell: (template) => <span className="text-muted-foreground">{template.body}</span> },
          ]}
        />
      ) : null}
      {canOperate ? <p className="text-sm text-muted-foreground">Template text is stored with the platform. Sending still needs a Resend key.</p> : null}
    </Section>
  );
}
