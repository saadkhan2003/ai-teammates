"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const tabs = [
  { href: "/settings/billing", label: "Billing overview" },
  { href: "/settings/usage", label: "Usage details" },
];

export function SettingsBillingTabs() {
  const pathname = usePathname();
  return <nav aria-label="Billing sections" className="flex gap-1 border-b border-border">
    {tabs.map((tab) => {
      const active = pathname === tab.href;
      return <Link key={tab.href} href={tab.href} aria-current={active ? "page" : undefined} className={cn("border-b-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground", active ? "border-foreground font-medium text-foreground" : "border-transparent")}>{tab.label}</Link>;
    })}
  </nav>;
}
