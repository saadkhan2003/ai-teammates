"use client";

import dynamic from "next/dynamic";

// Optional device, appearance and policy controls share the same lazy primitive.
export const SettingsSwitch = dynamic(
  () => import("@/components/ui/switch").then(module => module.Switch),
  { ssr: false, loading: () => <div className="h-5 w-9 shrink-0" aria-busy="true" /> },
);
