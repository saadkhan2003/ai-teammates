import { Badge } from "@/components/ui/badge";

export function statusTone(status?: string): "neutral" | "copper" | "sage" | "clay" {
  const value = (status ?? "").toLowerCase();
  if (["completed", "complete", "valid", "idle", "succeeded", "success", "connected"].includes(value)) return "sage";
  if (["failed", "invalid", "denied", "cancelled", "canceled", "error"].includes(value)) return "clay";
  if (value.startsWith("waiting") || ["running", "planning", "paused", "recovering", "queued"].includes(value)) {
    return "copper";
  }
  return "neutral";
}

export function StatusBadge({ status }: { status?: string }) {
  const tone = statusTone(status);
  const variant = tone === "clay" ? "destructive" : tone === "copper" ? "secondary" : "outline";
  return (
    <Badge variant={variant} className={tone === "sage" ? "rounded-full border-sage/40 text-sage" : "rounded-full"}>
      {status}
    </Badge>
  );
}
