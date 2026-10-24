"use client";

import { useState } from "react";
import { useAdmin } from "@/components/admin-state";
import { Card, ConfirmButton, control, DataTable, Empty, Field, onSubmit, primary, quiet, Section, SkeletonBlock, useConsole, useToast } from "@/components/panel";
import { api } from "@/lib/api";

type Session = { id: string; username: string; role: string; ip?: string };
type Key = { id: string; name: string; prefix: string; revoked_at?: string | null; revokedAt?: string | null };
type Allow = { id: string; cidr: string; note?: string };
type Secret = { id: string; name: string; username?: string; maskedSuffix?: string; masked_suffix?: string };
type Event = { id: number; actor: string; action: string; at: string };

export default function SecurityPage() {
  const { canOwn, canOperate } = useAdmin();
  const data = useConsole<{ sessions?: Session[]; apiKeys?: Key[]; allowlist?: Allow[]; secrets?: Secret[]; totp?: { username: string; enrolled: boolean }[] }>("/api/admin/console/security");
  const audit = useConsole<{ events?: Event[] }>("/api/admin/console/audit");
  const toast = useToast();
  const [cidr, setCidr] = useState("");
  const [note, setNote] = useState("");
  const [keyName, setKeyName] = useState("");
  const [secretOnce, setSecretOnce] = useState("");
  const [code, setCode] = useState("");
  const [otp, setOtp] = useState("");
  const sessions = data.data?.sessions ?? [];
  const keys = data.data?.apiKeys ?? [];
  const allow = data.data?.allowlist ?? [];
  const secrets = data.data?.secrets ?? [];
  const events = audit.data?.events ?? [];

  return (
    <Section title="Security" detail="Sessions, authenticator enrollment, masked secrets, the IP allowlist, and the audit log." testid="section-security">
      {data.loading && !data.data ? <SkeletonBlock /> : null}
      <Card title="Authenticator" help="Owners and admins enroll before they can change the platform.">
        {(data.data?.totp ?? []).length === 0 ? (
          <div className="mt-4"><Empty title="No staff to enroll." detail="Enrollment appears for owners and admins." /></div>
        ) : (
          <ul className="mt-3 divide-y divide-border text-sm">
            {(data.data?.totp ?? []).map((row) => (
              <li key={row.username} className="flex items-center justify-between py-3">
                <span>{row.username}</span>
                <span className="text-muted-foreground">{row.enrolled ? "Enrolled" : "Not enrolled"}</span>
              </li>
            ))}
          </ul>
        )}
        {canOperate ? (
          <form className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr_auto] sm:items-end" onSubmit={onSubmit(async () => { await api("/api/admin/console/totp/confirm", { method: "POST", body: JSON.stringify({ code }) }); setCode(""); toast("Authenticator confirmed."); await data.reload(); })}>
            <button type="button" className={quiet} onClick={() => void api<{ secret: string }>("/api/admin/console/totp/start", { method: "POST" }).then((row) => setOtp(row.secret)).then(() => toast("Setup key ready. Enter the 6-digit code."))}>Start enrollment</button>
            <Field label="6-digit code" help={otp ? `Setup key ${otp}` : "Start enrollment to get a setup key."}>
              <input className={control} inputMode="numeric" aria-label="6-digit code" placeholder="6 digits" value={code} onChange={(event) => setCode(event.target.value)} />
            </Field>
            <button className={primary} type="submit">Confirm</button>
          </form>
        ) : null}
      </Card>
      {sessions.length === 0 && !data.loading ? (
        <Empty title="No staff sessions." detail="A session appears when a staff member is signed in." />
      ) : sessions.length > 0 ? (
        <DataTable
          rows={sessions}
          rowKey={(session) => session.id}
          searchText={(session) => `${session.username} ${session.role} ${session.ip || ""}`}
          emptyTitle="No sessions match that search."
          filters={[{ id: "role", label: "Role", value: (session) => session.role }]}
          columns={[
            { id: "person", header: "Person", sortValue: (session) => session.username, cell: (session) => session.username },
            { id: "role", header: "Role", sortValue: (session) => session.role, cell: (session) => <span className="capitalize">{session.role}</span> },
            { id: "ip", header: "Address", cell: (session) => session.ip || "Address not recorded" },
          ]}
          menus={canOwn ? [{
            label: "Revoke",
            confirmTitle: "Revoke this session?",
            confirmDetail: "That person is signed out of the admin console.",
            onSelect: (session) => void api(`/api/admin/console/sessions/${session.id}`, { method: "DELETE" }).then(() => data.reload()).then(() => toast("Session revoked.")),
          }] : undefined}
        />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="API keys" help="The full key is shown once, when it is created.">
          {keys.length === 0 ? <div className="mt-4"><Empty title="No admin keys." detail="Create a key when another service should call the admin API." /></div> : (
            <ul className="mt-3 divide-y divide-border text-sm">
              {keys.map((key) => (
                <li key={key.id} className="flex items-center justify-between gap-3 py-3">
                  <span>{key.name}<p className="text-xs tabular-nums text-muted-foreground">{key.prefix}•••• {key.revokedAt || key.revoked_at ? "· Revoked" : ""}</p></span>
                  {canOwn && !(key.revokedAt || key.revoked_at) ? (
                    <ConfirmButton label="Revoke" title="Revoke this key?" detail="Anything using this key stops working." onConfirm={async () => { await api(`/api/admin/console/api-keys/${key.id}`, { method: "DELETE" }); toast("Key revoked."); await data.reload(); }} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {secretOnce ? <p className="mt-3 text-sm">Copy this value now. It is not shown again. <span className="tabular-nums">{secretOnce}</span></p> : null}
          {canOwn ? (
            <form className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={onSubmit(async () => { const created = await api<{ secret: string }>("/api/admin/console/api-keys", { method: "POST", body: JSON.stringify({ name: keyName }) }); setSecretOnce(created.secret); setKeyName(""); toast("Key created. Copy it now."); await data.reload(); })}>
              <Field label="Key name" help="A name you will recognize later, such as Ops.">
                <input className={control} aria-label="Key name" placeholder="Ops" value={keyName} onChange={(event) => setKeyName(event.target.value)} />
              </Field>
              <button className={primary} type="submit">Create key</button>
            </form>
          ) : null}
        </Card>
        <Card title="Secrets" help="Only the last four characters are shown.">
          {secrets.length === 0 ? <div className="mt-4"><Empty title="No secrets." detail="Platform secrets appear here after they are stored." /></div> : (
            <ul className="mt-3 divide-y divide-border text-sm">
              {secrets.map((secret) => (
                <li key={secret.id} className="flex items-center justify-between gap-3 py-3">
                  <span>{secret.username || "Platform"} · {secret.name}<p className="text-xs tabular-nums text-muted-foreground">••••{secret.maskedSuffix || secret.masked_suffix || ""}</p></span>
                  {canOwn ? (
                    <ConfirmButton label="Rotate" title="Rotate this secret?" detail="The current value stops working. The new value is shown once." onConfirm={async () => { const row = await api<{ secret: string }>(`/api/admin/console/secrets/${secret.id}/rotate`, { method: "POST" }); setSecretOnce(row.secret); toast("Secret rotated. Copy the new value."); }} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="IP allowlist" help="An empty list allows every address. The edge proxy can still limit who reaches this site.">
        {allow.length === 0 ? (
          <div className="mt-4"><Empty title="Every address is allowed." detail="Add a network when only those addresses should call the admin API." /></div>
        ) : (
          <ul className="mt-3 divide-y divide-border text-sm">
            {allow.map((row) => <li key={row.id} className="py-3 tabular-nums">{row.cidr}{row.note ? <span className="ml-2 text-muted-foreground">{row.note}</span> : null}</li>)}
          </ul>
        )}
        {canOwn ? (
          <form className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={onSubmit(async () => { await api("/api/admin/console/allowlist", { method: "POST", body: JSON.stringify({ cidr, note }) }); setCidr(""); setNote(""); toast("Network added."); await data.reload(); })}>
            <Field label="Network" help="For example, 10.0.0.0/8.">
              <input className={control} aria-label="Network" placeholder="10.0.0.0/8" value={cidr} onChange={(event) => setCidr(event.target.value)} />
            </Field>
            <Field label="Note" help="Optional. Who this network is for.">
              <input className={control} aria-label="Allowlist note" placeholder="Office" value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>
            <button className={primary} type="submit">Add network</button>
          </form>
        ) : null}
      </Card>
      <Card title="Audit log" help="Each row is the action, who did it, and when. Export downloads the current filter as a file.">
        {events.length === 0 && !audit.loading ? (
          <div className="mt-4"><Empty title="No audit events yet." detail="Changes made in this console are recorded here." /></div>
        ) : events.length > 0 ? (
          <div className="mt-4">
            <DataTable
              rows={events}
              rowKey={(event) => String(event.id)}
              searchText={(event) => `${event.action} ${event.actor}`}
              emptyTitle="No events match that search."
              columns={[
                { id: "action", header: "Action", sortValue: (event) => event.action, cell: (event) => <span className="capitalize">{event.action.replaceAll(".", " ").replaceAll("_", " ")}</span> },
                { id: "actor", header: "Person", sortValue: (event) => event.actor, cell: (event) => event.actor },
                { id: "at", header: "When", align: "right", sortValue: (event) => event.at, cell: (event) => <span className="tabular-nums">{event.at.replace("T", " ").replace("Z", " UTC")}</span> },
              ]}
            />
          </div>
        ) : null}
        <div className="mt-4 flex justify-end">
          <a className={quiet} href="/api/admin/console/audit?format=csv">Export</a>
        </div>
      </Card>
    </Section>
  );
}
