"use client";

import { StatusView } from "@/components/account/status-view";

export default function PublicStatusPage() {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-[var(--content-width)] px-6 py-8">
      <StatusView />
    </main>
  );
}
