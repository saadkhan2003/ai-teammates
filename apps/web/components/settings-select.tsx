"use client";

import dynamic from "next/dynamic";
import type { SettingsSelectProps } from "@/components/settings-select-control";

// Keep the select popper/focus machinery out of settings' initial route chunks.
export const SettingsSelect = dynamic<SettingsSelectProps>(
  () => import("@/components/settings-select-control").then(module => module.SettingsSelectControl),
  { ssr: false, loading: () => <div className="h-9" aria-busy="true" /> },
);
