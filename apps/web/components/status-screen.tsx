import type { ReactNode } from "react";

const cardClass = "rounded-[12px] border border-border bg-card text-card-foreground shadow-[var(--shadow-card)]";

export function StatusScreen({
  testId,
  code,
  title,
  detail,
  action,
}: {
  testId: string;
  code: string;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div data-testid={testId} className="grid min-h-dvh place-items-center px-4 py-12">
      <div className={`${cardClass} w-full max-w-md px-6 py-8 text-center`}>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{code}</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm leading-5 text-muted-foreground">{detail}</p>
        {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}
