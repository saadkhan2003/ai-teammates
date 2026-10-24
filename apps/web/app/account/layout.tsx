"use client";

import type { ReactNode } from "react";
import { AccountFrame } from "@/components/account/chrome";

export default function AccountLayout({ children }: { children: ReactNode }) {
  return <AccountFrame>{children}</AccountFrame>;
}
