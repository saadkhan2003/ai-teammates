"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { BarChart3, Bell, KeyRound, Laptop, Puzzle, RefreshCw, ScrollText, Shield, SlidersHorizontal } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { focusClass } from "@/components/account/chrome";

type NavItem = {
  href: string;
  label: string;
  icon: typeof SlidersHorizontal;
  exact?: boolean;
  testId?: string;
  admin?: boolean;
};

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: "Preferences",
    items: [
      { href: "/settings", label: "General", exact: true, icon: SlidersHorizontal },
      { href: "/settings/updates", label: "Updates", icon: RefreshCw },
      { href: "/settings/notifications", label: "Notifications", icon: Bell },
      { href: "/settings/usage", label: "Usage", icon: BarChart3 },
    ],
  },
  {
    label: "Workspace",
    items: [
      { href: "/settings/policy", label: "Policy", testId: "nav-policy", icon: Shield },
      { href: "/settings/computer", label: "Computer", icon: Laptop },
      { href: "/settings/plugins", label: "Plugins", icon: Puzzle },
      { href: "/settings/secrets", label: "Vault", icon: KeyRound },
    ],
  },
  {
    label: "Staff",
    items: [{ href: "/system", label: "System", testId: "nav-system", icon: ScrollText, admin: true }],
  },
];

export function SettingsNav() {
  const pathname = usePathname();
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    void api<{ role?: string }>("/api/auth/me")
      .then((me) => setRole(me.role ?? "member"))
      .catch(() => setRole("member"));
  }, []);

  const staff = role == null || role === "owner" || role === "admin";

  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto px-2 py-1 md:flex-col md:gap-0 md:overflow-visible md:px-2">
      {groups.map((group) => {
        const items = group.items.filter((item) => !item.admin || staff);
        if (items.length === 0) return null;
        return (
          <div key={group.label} className="flex shrink-0 gap-1 md:mt-4 md:flex-col md:gap-1">
            <p className="hidden px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:block">{group.label}</p>
            {items.map((tab) => {
              const active = tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
              const Icon = tab.icon;
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  role="tab"
                  aria-selected={active}
                  data-testid={tab.testId}
                  className={cn(
                    "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[8px] px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:w-full",
                    focusClass,
                    active && "bg-accent font-medium text-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {tab.label}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

export function SettingsFrame({ children, edge = false }: { children: ReactNode; edge?: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="shrink-0 border-b border-border md:w-56 md:border-b-0 md:border-r md:py-4">
        <h1 className="px-4 pb-2 text-base font-semibold tracking-tight">Settings</h1>
        <SettingsNav />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto flex w-full max-w-[56rem] flex-col gap-8 px-6 py-6", edge && "pr-12")}>{children}</div>
      </div>
    </div>
  );
}
