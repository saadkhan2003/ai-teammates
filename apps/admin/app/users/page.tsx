"use client";

import Link from "next/link";
import { useAdmin } from "@/components/admin-state";

export default function UsersPage() {
  const { payload, users, query, setQuery, suspend } = useAdmin();
  if (!payload) return null;

  return (
    <>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Users</h2>
          <p className="mt-1 text-sm text-muted-foreground">Search accounts, then open one to change plan or access.</p>
        </div>
        <input data-testid="user-search" className="min-h-11 rounded-[8px] border border-input bg-card px-3 text-sm sm:max-w-xs" placeholder="Search name, username, or email" value={query} onChange={(event) => setQuery(event.target.value)} />
      </header>
      {users.length === 0 ? (
        <p data-testid="admin-empty" className="rounded-[12px] border border-border bg-card px-4 py-6 text-center text-sm shadow-(--shadow-card)">
          No users match that search.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[12px] border border-border bg-card shadow-(--shadow-card)">
          <table data-testid="user-list" className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="px-4 py-3 text-left font-medium">Name</th>
                <th scope="col" className="px-4 py-3 text-left font-medium">Role</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Calls</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Status</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Access</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} data-testid={`user-${user.username}`} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <Link href={`/users/${user.id}`} className="font-medium underline-offset-2 hover:underline">
                      {user.displayName || user.username}
                    </Link>
                    <p className="text-xs text-muted-foreground">{user.email || "No email"}</p>
                  </td>
                  <td className="px-4 py-3 capitalize text-muted-foreground">{user.role}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{user.modelCalls} calls</td>
                  <td className="px-4 py-3 text-right">
                    <span className="inline-flex h-6 items-center rounded-[6px] bg-muted px-2 text-xs capitalize">{user.suspended ? "Suspended" : user.status}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" data-testid={`suspend-${user.username}`} className="inline-flex min-h-11 items-center justify-center rounded-[6px] border border-border px-4 text-sm hover:bg-accent" onClick={() => void suspend(user)}>
                      {user.suspended ? "Unsuspend" : "Suspend"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
