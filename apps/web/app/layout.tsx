import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import { AppShell } from "@/components/app-shell";
import { ThemeSync } from "@/components/theme-sync";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Teammates",
  description: "Bots that keep a computer, a conversation, and the work you assign.",
  icons: { icon: "/favicon.svg" },
  manifest: "/manifest.webmanifest",
  applicationName: "Teammates",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Teammates" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#141414" },
  ],
};

const themeBoot = `
try {
  var mode = localStorage.getItem("teammates-theme") || "system";
  if (mode !== "light" && mode !== "dark" && mode !== "system") mode = "system";
  var systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  var light = mode === "light" || (mode === "system" && !systemDark);
  document.documentElement.classList.toggle("light", light);
  document.documentElement.dataset.theme = mode;
  var color = light ? "#fafafa" : "#141414";
  document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
    meta.setAttribute("content", color);
  });
  var accents = {
    blue: ["#3b6fd8", "#8eb6ff"],
    sage: ["#1f7a45", "#8fd0a8"],
    sand: ["#8a5a12", "#e6c27a"],
    clay: ["#9f2d2d", "#f0a8a0"]
  };
  var accentId = localStorage.getItem("teammates-accent-id") || "blue";
  var pair = accents[accentId] || accents.blue;
  document.documentElement.style.setProperty("--brand", light ? pair[0] : pair[1]);
  var lang = localStorage.getItem("teammates-locale");
  if (lang) document.documentElement.lang = lang;
} catch (e) {}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Script id="theme-boot" strategy="beforeInteractive">
          {themeBoot}
        </Script>
        <ThemeSync />
        <AppShell>{children}</AppShell>
        <Toaster />
      </body>
    </html>
  );
}
