"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { settingsNavGroups } from "./settings-nav-data.mjs";

type SettingsNavItem = { id: string; label: string; href?: string; section?: string; exact?: boolean; admin?: boolean; testId?: string };
type SettingsNavGroup = { heading: string; items: SettingsNavItem[] };

export function SettingsNav() {
  const pathname = usePathname();
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    void api<{ role?: string }>("/api/auth/me")
      .then((me) => setRole(me.role ?? "member"))
      .catch(() => setRole("member"));
  }, []);

  const isAdmin = role === "owner" || role === "admin";
  const groups = settingsNavGroups as SettingsNavGroup[];

  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto px-2 py-1 md:flex-col md:overflow-visible md:px-2">
      {groups.map((group) => {
        const items = group.items.filter((item) => !item.admin || isAdmin);
        if (!items.length) return null;
        return (
          <section key={group.heading} aria-label={group.heading} className="md:mb-2">
            <h2 className="hidden px-3 pb-1 pt-3 text-sm font-medium text-muted-foreground md:block">{group.heading}</h2>
            {items.map((item) => {
              const active = item.href && (item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`));
              if (!item.href) return <span key={item.id} data-settings-section={item.section} className="inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm text-muted-foreground md:w-full">{item.label}</span>;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  role="tab"
                  aria-selected={Boolean(active)}
                  data-testid={item.testId}
                  className={cn(
                    "inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground md:w-full",
                    active && "bg-accent text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </section>
        );
      })}
    </nav>
  );
}

export function SettingsFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="shrink-0 border-b border-border md:w-52 md:border-b-0 md:border-r">
        <h1 className="px-4 pb-1 pt-3 text-sm font-medium">Settings</h1>
        <SettingsNav />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-4">{children}</div>
      </div>
    </div>
  );
}
