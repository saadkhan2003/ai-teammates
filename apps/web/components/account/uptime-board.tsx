"use client";

import { useEffect, useState } from "react";
import { cardClass } from "@/components/account/chrome";
import { cn } from "@/lib/utils";

export type UptimeDay = { date: string; state: "up" | "degraded" | "down" | "nodata" | string; uptimePercent: number | null; incidents: number };
export type UptimeService = { id: string; name: string; description: string; status: string; days: UptimeDay[] };
export type UptimeIncident = { id: string; service: string; title: string; status: string; startedAt: string; resolvedAt?: string | null };
export type UptimePayload = { indicator: string; description: string; services: UptimeService[]; incidents: UptimeIncident[] };

const barColor: Record<string, string> = {
  up: "bg-sage",
  degraded: "bg-[#d97706]",
  down: "bg-destructive",
  nodata: "bg-[#b5b5b5]",
};

const label: Record<string, string> = {
  up: "Operational",
  degraded: "Degraded",
  down: "Outage",
  nodata: "No data",
};

const labelClass: Record<string, string> = {
  up: "text-sage",
  degraded: "text-[#d97706] [html.light_&]:text-[#9a5b00]",
  down: "text-destructive",
  nodata: "text-muted-foreground",
};

function formatDay(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

function formatPercent(value: number | null) {
  if (value == null || Number.isNaN(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function windowPercent(days: UptimeDay[]) {
  const known = days.filter((day) => day.uptimePercent != null);
  if (known.length === 0) return null;
  return known.reduce((sum, day) => sum + (day.uptimePercent ?? 0), 0) / known.length;
}

export function UptimeBoard({ status }: { status: UptimePayload }) {
  const [wide, setWide] = useState(false);
  const [history, setHistory] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1536px)");
    const apply = () => setWide(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  const showAll = history || wide;
  const bannerClass = status.indicator === "major"
    ? "border-destructive/40 bg-destructive/10"
    : status.indicator === "minor"
      ? "border-[#d97706]/40 bg-[#d97706]/10"
      : status.indicator === "none"
        ? "border-sage/40 bg-sage-soft"
        : "border-border bg-card";

  return (
    <div data-testid="uptime-board" className="flex flex-col gap-4">
      <section data-testid="status-banner" className={cn(cardClass, "px-4 py-4", bannerClass)}>
        <h3 className={cn("text-lg font-semibold tracking-tight", labelClass[status.indicator === "major" ? "down" : status.indicator === "minor" ? "degraded" : status.indicator === "none" ? "up" : "nodata"])}>
          {status.description}
        </h3>
      </section>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-muted-foreground">
        <p>Uptime over the past {showAll ? "90" : "30"} days.</p>
        <a
          href="#past-incidents"
          data-testid="view-history"
          className="text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setHistory(true)}
        >
          View history
        </a>
      </div>
      <div className="flex flex-col gap-4">
        {status.services.map((service) => {
          const visible = showAll ? service.days : service.days.slice(-30);
          const percent = formatPercent(windowPercent(visible));
          return (
            <article key={service.id} data-testid={`service-${service.id}`} className={cn(cardClass, "p-4")}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-medium">{service.name}</h3>
                  <button
                    type="button"
                    data-testid="service-help"
                    className="group relative grid size-5 place-items-center rounded-full border border-border text-[11px] text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`About ${service.name}`}
                  >
                    ?
                    <span role="tooltip" className="absolute left-1/2 top-full z-20 mt-2 hidden w-56 -translate-x-1/2 rounded-[8px] bg-neutral-950 px-3 py-2 text-left text-xs font-normal leading-4 text-white shadow-lg group-hover:block group-focus-visible:block">
                      {service.description}
                    </span>
                  </button>
                </div>
                <p className={cn("text-sm font-medium", labelClass[service.status] ?? labelClass.nodata)}>{label[service.status] ?? "No data"}</p>
              </div>
              <div className="mt-4 flex h-10 items-end gap-[3px]" data-testid="uptime-bars">
                {visible.map((day) => (
                  <div key={day.date} className="group relative h-full min-w-0 flex-1">
                    <div data-testid="uptime-bar" className={cn("h-full w-full rounded-[2px]", barColor[day.state] ?? barColor.nodata)} />
                    <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-max max-w-[14rem] -translate-x-1/2 rounded-[8px] bg-neutral-950 px-2 py-1 text-center text-[11px] leading-4 text-white group-hover:block">
                      {formatDay(day.date)} · {formatPercent(day.uptimePercent)}% uptime · {day.incidents} {day.incidents === 1 ? "incident" : "incidents"}
                    </span>
                  </div>
                ))}
              </div>
              <p data-testid="uptime-footer" className="mt-3 flex items-center justify-between gap-3 text-xs tabular-nums text-muted-foreground">
                <span>{showAll ? "90" : "30"} days ago</span>
                <span className="h-px flex-1 bg-border" />
                <span>{percent}% uptime</span>
                <span className="h-px flex-1 bg-border" />
                <span>Today</span>
              </p>
            </article>
          );
        })}
      </div>
      <section id="past-incidents" data-testid="past-incidents" className={cn(cardClass, "p-4")}>
        <h3 className="text-base font-medium">Past incidents</h3>
        {status.incidents.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No incidents recorded.</p> : null}
        <ul className="mt-3 flex flex-col gap-2">
          {status.incidents.map((incident) => (
            <li key={incident.id} className="flex min-h-11 items-center justify-between gap-3 rounded-[8px] border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">{incident.title}</p>
                <p className="text-xs text-muted-foreground">{incident.service} · {formatDay(incident.startedAt.slice(0, 10))}</p>
              </div>
              <span className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-xs capitalize">{incident.status}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
