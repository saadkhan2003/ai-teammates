"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { applyTheme, readTheme, type ThemeMode } from "@/lib/theme";

const ACCENTS = [
  { id: "blue", dark: "#8eb6ff", light: "#3b6fd8" },
  { id: "sage", dark: "#8fd0a8", light: "#1f7a45" },
  { id: "sand", dark: "#e6c27a", light: "#8a5a12" },
  { id: "clay", dark: "#f0a8a0", light: "#9f2d2d" },
];

const LOCALES = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "ja", label: "日本語" },
];

const ZONES = ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Asia/Karachi", "Asia/Tokyo"];

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "Follow system" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export default function GeneralSettingsPage() {
  const router = useRouter();
  const [mode, setMode] = useState<ThemeMode>("dark");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState("");
  const [locale, setLocale] = useState("en");
  const [zone, setZone] = useState("UTC");
  const [alerts, setAlerts] = useState(false);
  const [accent, setAccent] = useState("blue");

  useEffect(() => {
    setMode(readTheme());
    setLocale(window.localStorage.getItem("teammates-locale") || "en");
    setZone(window.localStorage.getItem("teammates-timezone") || "UTC");
    setAlerts(window.localStorage.getItem("teammates-desktop-notifications") === "on");
    setAccent(window.localStorage.getItem("teammates-accent-id") || "blue");
    void api<{ username?: string; role?: string }>("/api/auth/me")
      .then((me) => {
        setUsername(me.username ?? "");
        setRole(me.role ?? "");
      })
      .catch(() => undefined);
  }, []);

  function choose(next: ThemeMode) {
    setMode(next);
    applyTheme(next);
    paintAccent(accent, next);
  }

  function paintAccent(id: string, theme: ThemeMode = mode) {
    const swatch = ACCENTS.find((item) => item.id === id) ?? ACCENTS[0];
    const light = theme === "light" || (theme === "system" && !window.matchMedia("(prefers-color-scheme: dark)").matches);
    const color = light ? swatch.light : swatch.dark;
    document.documentElement.style.setProperty("--brand", color);
    window.localStorage.setItem("teammates-accent", color);
    window.localStorage.setItem("teammates-accent-id", id);
    setAccent(id);
  }

  function chooseLocale(value: string) {
    setLocale(value);
    window.localStorage.setItem("teammates-locale", value);
    document.documentElement.lang = value;
  }

  function chooseZone(value: string) {
    setZone(value);
    window.localStorage.setItem("teammates-timezone", value);
  }

  async function chooseAlerts(next: boolean) {
    setAlerts(next);
    window.localStorage.setItem("teammates-desktop-notifications", next ? "on" : "off");
    if (next && "Notification" in window) await Notification.requestPermission().catch(() => undefined);
  }

  async function signOut(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // The cookie is cleared when the server accepts the call.
    }
    router.push("/login");
    router.refresh();
  }

  return (
    <div id="general" className="grid gap-4">
      <Card id="account">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">Account</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3 p-4 pt-0">
          <div>
            <p className="text-sm font-medium">{username || "Signed in"}</p>
            {role ? <p className="text-xs text-muted-foreground">{role}</p> : null}
          </div>
          <form onSubmit={signOut}>
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card id="theme">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">Theme</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 p-4 pt-0">
          {THEMES.map((item) => (
            <Button
              key={item.id}
              type="button"
              data-testid={`theme-${item.id}`}
              variant={mode === item.id ? "default" : "outline"}
              className="min-h-11"
              onClick={() => choose(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </CardContent>
      </Card>
      <Card id="accent">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">Accent colour</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2 p-4 pt-0">
          {ACCENTS.map((swatch) => (
            <button
              key={swatch.id}
              type="button"
              aria-label={swatch.id}
              aria-pressed={accent === swatch.id}
              className="h-7 w-7 rounded-md border border-border"
              style={{ background: swatch.dark }}
              onClick={() => paintAccent(swatch.id)}
            />
          ))}
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <div id="language" className="flex flex-col gap-1.5">
          <Label>Language</Label>
          <Select value={locale} onValueChange={chooseLocale}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCALES.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div id="timezone" className="flex flex-col gap-1.5">
          <Label>Timezone</Label>
          <Select value={zone} onValueChange={chooseZone}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ZONES.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div id="notifications" className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
        <div>
          <p className="text-sm">Notifications</p>
          <p className="text-xs text-muted-foreground">Desktop alerts for this browser.</p>
        </div>
        <Switch checked={alerts} onCheckedChange={(checked) => void chooseAlerts(checked)} aria-label="Notifications" />
      </div>
      <Card id="approval-rules">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">Approval rules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 p-4 pt-0 text-sm text-muted-foreground">
          <p>The server enforces these. They are not switches on this page.</p>
          <ul className="list-disc space-y-1 pl-4">
            <li>Shell commands and environment setup are denied.</li>
            <li>A command that contains a secret reference is denied.</li>
            <li>Deleting a file asks for approval.</li>
            <li>Opening a site the account has not seen asks for approval.</li>
            <li>Typing a secret is allowed only when the reference resolves.</li>
          </ul>
        </CardContent>
      </Card>
      <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
        <div>
          <p className="text-sm">Security keys</p>
          <p className="text-xs text-muted-foreground">API keys and plugin credentials live in the vault.</p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/settings/secrets">Open vault</Link>
        </Button>
      </div>
    </div>
  );
}
