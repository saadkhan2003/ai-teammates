import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import Script from "next/script";
import { AppShell } from "@/components/app-shell";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

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
  var mode = localStorage.getItem("teammates-theme") || "dark";
  var systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  var light = mode === "light" || (mode === "system" && !systemDark);
  document.documentElement.classList.toggle("light", light);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  var color = light ? "#fafafa" : "#141414";
  document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
    meta.setAttribute("content", color);
  });
  var accent = localStorage.getItem("teammates-accent");
  if (accent) document.documentElement.style.setProperty("--brand", accent);
  var lang = localStorage.getItem("teammates-locale");
  if (lang) document.documentElement.lang = lang;
} catch (e) {}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${sans.variable} ${mono.variable} font-sans antialiased`}>
        <Script id="theme-boot" strategy="beforeInteractive">
          {themeBoot}
        </Script>
        <AppShell>{children}</AppShell>
        <Toaster />
      </body>
    </html>
  );
}
