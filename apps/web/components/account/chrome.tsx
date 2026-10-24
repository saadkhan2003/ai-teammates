"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode } from "react";
import { Activity, CircleHelp, CreditCard, FileText, ScrollText, Shield, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const groups = [
  {
    label: "Account",
    items: [
      { href: "/account", label: "Profile", exact: true, icon: User },
      { href: "/account/billing", label: "Billing", icon: CreditCard },
    ],
  },
  {
    label: "Support",
    items: [
      { href: "/account/help", label: "Help", icon: CircleHelp },
      { href: "/account/status", label: "Status", icon: Activity },
      { href: "/account/changelog", label: "Changelog", icon: ScrollText },
    ],
  },
  {
    label: "Legal",
    items: [
      { href: "/account/legal/terms", label: "Terms", icon: FileText },
      { href: "/account/legal/privacy", label: "Privacy", icon: Shield },
    ],
  },
];

export const cardClass = "rounded-[12px] border border-border bg-card text-card-foreground shadow-[var(--shadow-card)]";
export const controlClass = "rounded-[8px]";
export const pillClass = "rounded-full";
export const focusClass = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export function AccountFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const wide = pathname.startsWith("/account/billing");

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav aria-label="Account" data-testid="account-nav" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 py-3 md:w-56 md:flex-col md:gap-0 md:overflow-visible md:border-b-0 md:border-r md:px-3 md:py-4">
        <h1 className="hidden px-3 pb-2 text-base font-semibold tracking-tight md:block">Settings</h1>
        {groups.map((group) => (
          <div key={group.label} className="flex shrink-0 gap-1 md:mt-4 md:flex-col md:gap-1">
            <p className="hidden px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:block">{group.label}</p>
            {group.items.map((link) => {
              const active = link.exact ? pathname === link.href : pathname === link.href || pathname.startsWith(`${link.href}/`);
              const Icon = link.icon;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[8px] px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    focusClass,
                    active && "bg-accent font-medium text-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {link.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto flex w-full flex-col gap-8 px-6 py-6", wide ? "max-w-[56rem]" : "max-w-[var(--content-width)]")}>{children}</div>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{subtitle}</p>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </header>
  );
}

export function SectionTitle({ icon, children, className }: { icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <h3 className={cn("flex items-center gap-2 text-base font-medium", className)}>
      {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      {children}
    </h3>
  );
}

export function DevBadge({ show }: { show: boolean }) {
  if (process.env.NODE_ENV === "production" || !show) return null;
  return (
    <span data-testid="dev-badge" className="inline-flex h-6 items-center rounded-full border border-border bg-muted px-2 text-[11px] font-medium text-muted-foreground">
      Dev
    </span>
  );
}

export function PageSkeleton() {
  return (
    <div data-testid="page-skeleton" className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-40 rounded-[8px]" />
      <Skeleton className="h-32 w-full rounded-[12px]" />
      <Skeleton className="h-32 w-full rounded-[12px]" />
    </div>
  );
}

export function PageError({ title, detail, onRetry }: { title: string; detail?: string; onRetry?: () => void }) {
  return (
    <div role="alert" data-testid="page-error" className={cn(cardClass, "px-4 py-4")}>
      <p className="font-medium text-destructive">{title}</p>
      {detail ? <p className="mt-1 text-sm text-muted-foreground">{detail}</p> : null}
      {onRetry ? (
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="outline" className={cn(pillClass, focusClass)} onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function PageEmpty({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div role="status" data-testid="page-empty" className={cn(cardClass, "px-4 py-6 text-center")}>
      <p className="text-sm font-medium">{title}</p>
      {detail ? <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{detail}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex justify-end gap-2">{children}</div>;
}
