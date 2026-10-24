"use client";

import { useAdmin } from "@/components/admin-state";
import { Card, ConfirmButton, DataTable, Empty, fileSize, primary, Section, SkeletonBlock, Stat, useConsole, useToast } from "@/components/panel";
import { api } from "@/lib/api";

type Row = { username?: string; bytes?: number; files?: number };
type Run = { id: string; status: string; note?: string; bytes?: number };

export default function StoragePage() {
  const { canOwn } = useAdmin();
  const data = useConsole<{ users?: Row[]; cleanups?: Run[]; backups?: Run[]; objectStore?: { status?: string; bucket?: string; keys?: number; detail?: string } }>("/api/admin/console/storage");
  const toast = useToast();
  const users = (data.data?.users ?? []).filter((row) => (row.files ?? 0) > 0 || (row.bytes ?? 0) > 0);
  const everyone = data.data?.users ?? [];
  const store = data.data?.objectStore;
  const total = everyone.reduce((sum, row) => sum + (row.bytes ?? 0), 0);

  return (
    <Section title="Storage" detail="File sizes by person, object storage, cleanup of files older than 90 days, and a recorded database size." testid="section-storage">
      {data.loading && !data.data ? <SkeletonBlock /> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Stored files" value={fileSize(total)} help="Sum of file sizes recorded for accounts." />
        <Stat label="Object store" value={store?.status === "ok" ? "Reachable" : store ? "Unavailable" : "—"} help={store ? `Bucket ${store.bucket}${store.keys != null ? `, ${store.keys} keys sampled` : ""}.` : "Waiting for a check."} />
        <Stat label="Latest backup" value={data.data?.backups?.[0]?.status === "recorded" ? "Size recorded" : "None yet"} help="A record of database size. An offsite copy is not configured." />
      </div>
      {store?.status === "unavailable" ? <p className="text-sm text-muted-foreground">Object storage did not answer ({store.detail || "no endpoint"}). File sizes below still come from the database.</p> : null}
      {users.length === 0 && !data.loading ? <Empty title="No files yet." detail="A person's files appear here after something is stored." /> : users.length > 0 ? (
        <DataTable
          rows={users}
          rowKey={(row) => row.username || "user"}
          searchText={(row) => row.username || ""}
          emptyTitle="No files match that search."
          columns={[
            { id: "person", header: "Person", sortValue: (row) => row.username || "", cell: (row) => row.username },
            { id: "files", header: "Files", align: "right", sortValue: (row) => row.files ?? 0, cell: (row) => <span className="tabular-nums">{row.files ?? 0}</span> },
            { id: "size", header: "Size", align: "right", sortValue: (row) => row.bytes ?? 0, cell: (row) => <span className="tabular-nums">{fileSize(row.bytes ?? 0)}</span> },
          ]}
        />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Cleanup" help="Removes stored files older than 90 days. Nothing is removed when there is nothing that old.">
          {(data.data?.cleanups ?? []).length === 0 ? <div className="mt-4"><Empty title="No cleanup has run." detail="Run it when you want old files removed." /></div> : (
            <ul className="mt-3 space-y-2 text-sm">{(data.data?.cleanups ?? []).map((run) => <li key={run.id}>{run.status} · {run.note}</li>)}</ul>
          )}
          {canOwn ? <div className="mt-4"><ConfirmButton className={primary} label="Run cleanup" title="Remove files older than 90 days?" detail="Files newer than 90 days stay. This cannot be undone." confirmLabel="Run cleanup" onConfirm={async () => { await api("/api/admin/console/cleanup", { method: "POST" }); toast("Cleanup finished."); await data.reload(); }} /></div> : null}
        </Card>
        <Card title="Backups" help="Records how large the database is. It does not copy the database off this server.">
          {(data.data?.backups ?? []).length === 0 ? <div className="mt-4"><Empty title="No size recorded." detail="Record the database size when you want a checkpoint note." /></div> : (
            <ul className="mt-3 space-y-2 text-sm">{(data.data?.backups ?? []).map((run) => <li key={run.id}>{run.status === "recorded" ? "Size recorded" : run.status} · {run.note}</li>)}</ul>
          )}
          {canOwn ? <button type="button" className={`${primary} mt-4`} onClick={() => void api("/api/admin/console/backups", { method: "POST" }).then(() => data.reload()).then(() => toast("Database size recorded."))}>Record database size</button> : null}
        </Card>
      </div>
    </Section>
  );
}
