"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import type { Approval } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

const decided = new Set(["approved", "denied", "allow_once", "allowed", "rejected", "deny", "allow_domain"]);

function domainOf(target?: string) {
  if (!target || !target.includes("://")) return "";
  try {
    return new URL(target).hostname;
  } catch {
    return "";
  }
}

function needsDecision(status?: string) {
  if (!status) return true;
  return !decided.has(status.toLowerCase());
}

export function Approvals({ approvals, onChanged }: { approvals: Approval[]; onChanged: () => void }) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The workspace only lists pending approvals, so keep what was just decided on screen.
  const [settled, setSettled] = useState<Record<string, { action: string; target: string; denied: boolean }>>({});

  async function decide(id: string, decision: "allow_once" | "allow_domain" | "deny") {
    setPendingId(id);
    setError(null);
    try {
      await api(`/api/approvals/${id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      const decidedItem = approvals.find((item) => item.id === id);
      if (decidedItem) {
        setSettled((prev) => ({ ...prev, [id]: { action: decidedItem.action ?? "", target: decidedItem.target ?? "", denied: decision === "deny" } }));
      }
      toast.success(decision === "deny" ? "Denied." : decision === "allow_domain" ? "Allowed for this domain." : "Allowed once.");
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught, "Could not record that decision."));
    } finally {
      setPendingId(null);
    }
  }

  const settledOnly = Object.entries(settled).filter(([id]) => !approvals.some((item) => item.id === id));
  if (approvals.length === 0 && settledOnly.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {settledOnly.map(([id, item]) => (
        <div key={id} data-testid="approval-card" data-decided="true" className="rounded-md border border-border px-3 py-2 text-body-sm text-muted-foreground">{item.denied ? "Denied" : "Allowed"} {item.action} {domainOf(item.target) || item.target}</div>
      ))}
      {approvals.map((approval) => !needsDecision(approval.status) ? (
        <div key={approval.id} data-testid="approval-card" data-decided="true" className="rounded-md border border-border px-3 py-2 text-body-sm text-muted-foreground">{["denied", "deny", "rejected"].includes(approval.status ?? "") ? "Denied" : "Allowed"} {approval.action} {domainOf(approval.target) || approval.target}</div>
      ) : (
        <Card key={approval.id} data-testid="approval-card" className="min-w-0 max-w-full">
          <CardHeader className="p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <CardTitle className="min-w-0 break-words text-body-sm">{approval.action || "Approval"}</CardTitle>
              {approval.status ? <span className="text-meta text-muted-foreground">{approval.status}</span> : null}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 p-4 pt-0">
            {approval.riskClass ? <p className="text-meta uppercase tracking-wide text-muted-foreground">{approval.riskClass}</p> : null}
            {approval.summary ? <p data-testid="approval-summary" className="break-words text-body-sm">{approval.summary}</p> : null}
            {approval.target ? <p className="break-words text-body-sm">{approval.target}</p> : null}
            {approval.reason && approval.reason !== approval.summary ? <p className="break-words text-body-sm text-muted-foreground">{approval.reason}</p> : null}
            {needsDecision(approval.status) ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  data-testid="approve-once"
                  size="sm"
                  className="rounded-md"
                  disabled={pendingId === approval.id}
                  onClick={() => void decide(approval.id, "allow_once")}
                >
                  Allow once
                </Button>
                {approval.riskClass === "credential_use" && domainOf(approval.target) ? (
                  <Button
                    data-testid="approve-domain"
                    size="sm"
                    variant="outline"
                    className="rounded-md"
                    disabled={pendingId === approval.id}
                    onClick={() => void decide(approval.id, "allow_domain")}
                  >
                    Always allow site
                  </Button>
                ) : null}
                <Button
                  data-testid="deny"
                  size="sm"
                  variant="outline"
                  className="rounded-md"
                  disabled={pendingId === approval.id}
                  onClick={() => void decide(approval.id, "deny")}
                >
                  Deny
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
