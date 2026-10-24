"use client";

import Link from "next/link";
import { useState } from "react";
import { useAdmin, type AdminUser } from "@/components/admin-state";
import { Card, control, DataTable, Empty, onSubmit, primary, Section, useConsole, useToast } from "@/components/panel";
import { api } from "@/lib/api";

type Org = { id?: string; name?: string; members?: number };

export default function UsersPage() {
  const { payload, users, suspend, canOperate } = useAdmin();
  const orgs = useConsole<{ organizations?: Org[] }>("/api/admin/console/orgs");
  const toast = useToast();
  const [name, setName] = useState("");
  if (!payload) return null;
  const organizations = orgs.data?.organizations ?? [];

  return (
    <Section title="Users" detail="Search accounts, filter by role, and open a person to change plan or access." testid="section-users">
      <DataTable
        rows={users}
        rowKey={(user) => user.id}
        searchTestId="user-search"
        rowTestId={(user) => `user-${user.username}`}
        searchText={(user) => `${user.displayName} ${user.username} ${user.email}`}
        emptyTitle="No users match that search."
        emptyTestId="admin-empty"
        filters={[
          { id: "role", label: "Role", value: (user) => user.role },
          { id: "status", label: "Status", value: (user) => (user.suspended ? "Suspended" : user.status) },
        ]}
        columns={[
          {
            id: "name",
            header: "Name",
            sortValue: (user) => user.displayName || user.username,
            cell: (user) => (
              <span>
                <Link href={`/users/${user.id}`} className="font-medium underline-offset-2 hover:underline">{user.displayName || user.username}</Link>
                <p className="text-xs text-muted-foreground">{user.email || "No email"}</p>
              </span>
            ),
          },
          { id: "role", header: "Role", sortValue: (user) => user.role, cell: (user) => <span className="capitalize text-muted-foreground">{user.role}</span> },
          { id: "calls", header: "Calls", align: "right", sortValue: (user) => user.modelCalls, cell: (user) => <span className="tabular-nums">{user.modelCalls} calls</span> },
          {
            id: "status",
            header: "Status",
            align: "right",
            sortValue: (user) => user.status,
            cell: (user) => <span className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-xs capitalize">{user.suspended ? "Suspended" : user.status}</span>,
          },
          {
            id: "access",
            header: "Access",
            align: "right",
            cell: (user: AdminUser) => canOperate ? (
              <button type="button" data-testid={`suspend-${user.username}`} className="inline-flex min-h-11 items-center justify-center rounded-full border border-border px-4 text-sm hover:bg-accent" onClick={() => void suspend(user).then(() => toast(user.suspended ? `${user.username} can sign in.` : `${user.username} is suspended.`))}>
                {user.suspended ? "Unsuspend" : "Suspend"}
              </button>
            ) : <span className="text-sm text-muted-foreground">View</span>,
          },
        ]}
        menus={[
          { label: "Open profile", onSelect: (user) => { window.location.assign(`/users/${user.id}`); } },
        ]}
      />
      <Card title="Organizations" help="A group shares a name. Each person remains the account of record.">
        {organizations.length === 0 ? (
          <div className="mt-4">
            <Empty title="No organizations yet." detail="Create one when several people should share a name." />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border text-sm">
            {organizations.map((org) => (
              <li key={org.id} className="flex items-center justify-between py-3">
                <span>{org.name}</span>
                <span className="tabular-nums text-muted-foreground">{org.members ?? 0} members</span>
              </li>
            ))}
          </ul>
        )}
        {canOperate ? (
          <form className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={onSubmit(async () => { await api("/api/admin/console/orgs", { method: "POST", body: JSON.stringify({ name }) }); setName(""); toast("Organization created."); await orgs.reload(); })}>
            <label className="grid gap-2 text-sm">
              Organization name
              <input className={control} placeholder="For example, Northwind" aria-label="Organization name" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <button type="submit" className={primary}>Create</button>
          </form>
        ) : null}
      </Card>
    </Section>
  );
}
