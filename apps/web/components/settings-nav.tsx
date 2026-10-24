"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const tabs = [
  { href: "/settings", label: "General", exact: true },
  { href: "/settings/policy", label: "Policy", testId: "nav-policy" },
  { href: "/settings/computer", label: "Computer" },
  { href: "/settings/secrets", label: "Vault" },
  { href: "/settings/plugins", label: "Plugins" },
  { href: "/settings/usage", label: "Usage & Billing" },
  { href: "/settings/updates", label: "Updates" },
  { href: "/system", label: "System", testId: "nav-system", admin: true },
];

export function SettingsNav() {
  const pathname = usePathname();
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    void api<{ role?: string }>("/api/auth/me")
      .then((me) => setRole(me.role ?? "member"))
      .catch(() => setRole("member"));
  }, []);

  const visible = tabs.filter((tab) => !tab.admin || role == null || role === "owner" || role === "admin");

  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto px-2 py-1 md:flex-col md:overflow-visible md:px-2">
      {visible.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={active}
            data-testid={tab.testId}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground md:w-full",
              active && "bg-accent text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SettingsFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ block: "center" });
  }, [pathname]);
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
