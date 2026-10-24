import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function PanelSection({ title, testId, extra, children }: { title: string; testId?: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section data-testid={testId} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="type-label">{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}

export function PanelCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`panel-card ${className}`}>{children}</div>;
}

export function PanelEmpty({ icon: Icon, title, detail, action }: { icon: LucideIcon; title: string; detail: string; action?: ReactNode }) {
  return (
    <PanelCard>
      <div className="flex items-start gap-3 px-3 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-control bg-muted text-muted-foreground">
          <Icon className="size-4" strokeWidth={1.5} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="type-body block font-medium text-card-foreground">{title}</span>
          <span className="type-caption mt-0.5 block">{detail}</span>
          {action ? <div className="mt-2">{action}</div> : null}
        </span>
      </div>
    </PanelCard>
  );
}
