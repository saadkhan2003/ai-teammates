"use client";

import type { ReactNode } from "react";
import { SettingsFrame } from "@/components/settings-nav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsFrame>{children}</SettingsFrame>;
}
