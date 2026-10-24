import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { AdminShell } from "@/components/admin-state";
import { ThemeSync } from "@/components/theme-sync";
import "./globals.css";

const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Teammates Admin",
  description: "Owner and admin tools for plans, credits, and the platform model.",
};

const themeBoot = `
try {
  var mode = localStorage.getItem("teammates-admin-theme") || "system";
  if (mode !== "light" && mode !== "dark" && mode !== "system") mode = "system";
  var systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  var light = mode === "light" || (mode === "system" && !systemDark);
  document.documentElement.classList.toggle("light", light);
  document.documentElement.dataset.theme = mode;
} catch (e) {}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${sans.variable} font-sans antialiased`}>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
        <ThemeSync />
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
