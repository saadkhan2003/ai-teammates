"use client";

import { useState } from "react";
import { useAdmin } from "@/components/admin-state";
import { Card, control, cores, DataTable, Empty, gigabytes, hostName, Meter, onSubmit, primary, Section, SkeletonBlock, Stat, useConsole, useToast } from "@/components/panel";
import { api, ApiError } from "@/lib/api";

type Computer = {
  computerId: string;
  username: string;
  status: string;
  host: string;
  quotaCpuMillis: number;
  quotaMemoryBytes: number;
  quotaDiskBytes: number;
  cpuRatio: number | null;
  memoryBytes: number | null;
  diskBytes: number | null;
  metrics: string;
};
type Job = { id: string; title: string; status: string; username: string };
type Payload = { computers?: Computer[]; jobs?: Job[]; maxComputers?: number; savedMaxComputers?: number | null; host?: string };

export default function ComputersPage() {
  const { canOperate } = useAdmin();
  const data = useConsole<Payload>("/api/admin/console/computers");
  const toast = useToast();
  const [max, setMax] = useState("3");
  const computers = data.data?.computers ?? [];
  const jobs = data.data?.jobs ?? [];
  const server = hostName(data.data?.host);

  async function power(id: string, action: "wake" | "sleep" | "stop") {
    try {
      await api(`/api/admin/console/computers/${id}/${action}`, { method: "POST" });
      toast(action === "wake" ? "Wake requested." : action === "sleep" ? "Sleep requested." : "Stop requested.");
      await data.reload();
    } catch (caught) {
      toast(caught instanceof ApiError ? caught.message : "The runtime did not accept that.");
    }
  }

  return (
    <Section title="Computers" detail="Memory, processor, and disk for each computer. Live numbers appear when the runtime answers. Otherwise the row shows the plan allowance." testid="section-computers">
      {data.loading && !data.data ? <SkeletonBlock /> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Server" value={data.data ? server : "—"} help="The machine running this installation." />
        <Stat label="Computer limit" value={data.data?.maxComputers != null ? String(data.data.maxComputers) : "—"} help="How many computers can run right now." />
        <Stat label="Saved limit" value={data.data?.savedMaxComputers != null ? String(data.data.savedMaxComputers) : "Not saved"} help="Applied the next time the service starts." />
      </div>
      {computers.length === 0 && !data.loading ? (
        <Empty title="No computers yet." detail="A computer appears here after someone starts one." />
      ) : (
        <DataTable
          rows={computers}
          rowKey={(row) => row.computerId}
          searchText={(row) => `${row.username} ${row.status} ${server}`}
          emptyTitle="No computers match that search."
          filters={[{ id: "status", label: "Status", value: (row) => row.status }]}
          columns={[
            { id: "person", header: "Person", sortValue: (row) => row.username, cell: (row) => <span>{row.username}<p className="text-xs capitalize text-muted-foreground">{row.status} · {row.metrics === "live" ? "Live" : "From the plan"}</p></span> },
            { id: "server", header: "Server", cell: () => server },
            {
              id: "cpu",
              header: "Processor",
              sortValue: (row) => row.cpuRatio ?? row.quotaCpuMillis,
              cell: (row) => (
                <div className="min-w-44">
                  <Meter
                    label="Processor"
                    usedLabel={row.cpuRatio == null ? "Not measured" : `${Math.round(row.cpuRatio * 100)}%`}
                    limitLabel={cores(row.quotaCpuMillis)}
                    summary={row.cpuRatio == null ? `${cores(row.quotaCpuMillis)} allowance` : `${Math.round(row.cpuRatio * 100)}% of ${cores(row.quotaCpuMillis)}`}
                    used={row.cpuRatio == null ? 0 : row.cpuRatio * (row.quotaCpuMillis || 1)}
                    limit={row.quotaCpuMillis || 1}
                  />
                </div>
              ),
            },
            {
              id: "ram",
              header: "Memory",
              cell: (row) => (
                <div className="min-w-44">
                  <Meter label="Memory" usedLabel={row.memoryBytes == null ? "Not measured" : gigabytes(row.memoryBytes)} limitLabel={gigabytes(row.quotaMemoryBytes || 1)} summary={row.memoryBytes == null ? `${gigabytes(row.quotaMemoryBytes || 0)} allowance` : `${gigabytes(row.memoryBytes)} of ${gigabytes(row.quotaMemoryBytes || 1)}`} used={row.memoryBytes ?? 0} limit={row.quotaMemoryBytes || 1} />
                </div>
              ),
            },
            {
              id: "disk",
              header: "Disk",
              cell: (row) => (
                <div className="min-w-44">
                  <Meter label="Disk" usedLabel={row.diskBytes == null ? "Not measured" : gigabytes(row.diskBytes)} limitLabel={gigabytes(row.quotaDiskBytes || 1)} summary={row.diskBytes == null ? `${gigabytes(row.quotaDiskBytes || 0)} allowance` : `${gigabytes(row.diskBytes)} of ${gigabytes(row.quotaDiskBytes || 1)}`} used={row.diskBytes ?? 0} limit={row.quotaDiskBytes || 1} />
                </div>
              ),
            },
          ]}
          menus={canOperate ? [
            { label: "Wake", onSelect: (row) => void power(row.computerId, "wake") },
            { label: "Sleep", onSelect: (row) => void power(row.computerId, "sleep") },
            { label: "Stop", confirmTitle: "Stop this computer?", confirmDetail: "The runtime is asked to stop. If it refuses, the computer stays as it is.", onSelect: (row) => void power(row.computerId, "stop") },
          ] : undefined}
        />
      )}
      <Card title="Background jobs" help="Work still queued or running. Stopping a job cancels it.">
        {jobs.length === 0 ? (
          <div className="mt-4"><Empty title="No background jobs." detail="Running and queued work shows up here." /></div>
        ) : (
          <DataTable
            rows={jobs}
            rowKey={(job) => job.id}
            searchText={(job) => `${job.title} ${job.username} ${job.status}`}
            emptyTitle="No jobs match that search."
            columns={[
              { id: "title", header: "Job", sortValue: (job) => job.title, cell: (job) => job.title },
              { id: "person", header: "Person", sortValue: (job) => job.username, cell: (job) => job.username },
              { id: "status", header: "Status", sortValue: (job) => job.status, cell: (job) => <span className="capitalize">{job.status}</span> },
            ]}
            menus={canOperate ? [{
              label: "Stop job",
              confirmTitle: "Stop this job?",
              confirmDetail: "The job is cancelled. Work already finished stays finished.",
              onSelect: (job) => void api(`/api/admin/console/jobs/${job.id}/kill`, { method: "POST" }).then(() => data.reload()).then(() => toast("Job stopped.")),
            }] : undefined}
          />
        )}
      </Card>
      {canOperate ? (
        <Card title="Computer limit" help="The number above is the live limit. Saving a new number takes effect the next time the service starts.">
          <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={onSubmit(async () => { await api("/api/admin/console/capacity", { method: "PUT", body: JSON.stringify({ maxComputers: Number(max) }) }); toast("Computer limit saved for the next start."); await data.reload(); })}>
            <label className="grid w-full max-w-xs gap-2 text-sm">
              Computers on this server
              <input className={control} inputMode="numeric" aria-label="Computers on this server" placeholder="3" value={max} onChange={(event) => setMax(event.target.value)} />
            </label>
            <button type="submit" className={`${primary} w-fit`}>Save limit</button>
          </form>
          <p className="mt-2 text-sm text-muted-foreground">Use a whole number from 1 to 100. Saving takes effect the next time the service starts.</p>
        </Card>
      ) : null}
    </Section>
  );
}
