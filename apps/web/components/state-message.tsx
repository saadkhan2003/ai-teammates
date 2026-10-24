import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function StateMessage({
  title,
  detail,
  tone = "neutral",
  action,
}: {
  title: string;
  detail?: string;
  tone?: "neutral" | "error";
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-lg border px-4 py-3",
        tone === "error" ? "border-clay/30 bg-[#f8e4df] text-clay" : "border-line bg-paper text-ink",
      )}
    >
      <p className="font-medium">{title}</p>
      {detail ? <p className="mt-1 text-body-sm text-muted-foreground">{detail}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
