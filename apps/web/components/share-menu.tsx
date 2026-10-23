"use client";
import { useState } from "react";
import { Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";

export function ShareMenu({ botId, onCreated }: { botId: string; onCreated?: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function act(path: string) {
    setBusy(true);
    try {
      const result = await api<Record<string, unknown>>(path, { method: "POST" });
      if (path.endsWith("/clone")) {
        toast.success("Copy created. Its routines are disabled until you enable them.");
        onCreated?.(String(result.id ?? ""));
      } else {
        const value = String(result.template ?? "");
        const encoded = btoa(unescape(encodeURIComponent(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        if (encoded.length > 8192) throw new Error("Template is too large to share as a link.");
        const url = `${window.location.origin}/#template=${encoded}`;
        await navigator.clipboard.writeText(url);
        toast.success("Template link copied. It is encoded in the link and is not stored on the server.");
      }
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not share this bot."); }
    finally { setBusy(false); }
  }
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Share bot" disabled={busy}><Share2 className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void act(`/api/bots/${botId}/clone`)}>Create a copy</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void act(`/api/bots/${botId}/template`)}>Share a template link</DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
}
