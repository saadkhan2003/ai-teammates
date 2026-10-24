"use client";

import { useEffect } from "react";
import { api } from "@/lib/api";
import { applyTheme, parseTheme, readTheme, themeUserRevision, watchSystemTheme } from "@/lib/theme";

export function ThemeSync() {
  useEffect(() => {
    const seen = themeUserRevision();
    let live = true;
    void api<{ theme?: string }>("/api/auth/me")
      .then((me) => {
        if (!live || themeUserRevision() !== seen) return;
        const mode = parseTheme(me.theme);
        if (mode) applyTheme(mode, "sync");
      })
      .catch(() => undefined);
    const stop = watchSystemTheme(() => {
      if (readTheme() === "system") applyTheme("system", "sync");
    });
    return () => {
      live = false;
      stop();
    };
  }, []);
  return null;
}
