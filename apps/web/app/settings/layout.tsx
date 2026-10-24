"use client";

import type { ReactNode } from "react";
import { SettingsFrame } from "@/components/settings-nav";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useRouter } from "next/navigation";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  return <Dialog open onOpenChange={(open) => { if (!open) router.push("/"); }}><DialogContent data-testid="settings-modal" className="h-[min(85vh,850px)] max-h-[90vh] w-[min(1100px,94vw)] max-w-none overflow-hidden rounded-[16px] p-0 shadow-[var(--shadow-card)]"><DialogTitle className="sr-only">Settings</DialogTitle><div className="h-full overflow-hidden"><SettingsFrame edge>{children}</SettingsFrame></div></DialogContent></Dialog>;
}
