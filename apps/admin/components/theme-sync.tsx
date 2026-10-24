"use client";

import { useEffect } from "react";
import { applyTheme, readTheme, watchSystemTheme } from "@/lib/theme";

export function ThemeSync() {
  useEffect(() => {
    applyTheme(readTheme());
    return watchSystemTheme(() => {
      if (readTheme() === "system") applyTheme("system");
    });
  }, []);
  return null;
}
