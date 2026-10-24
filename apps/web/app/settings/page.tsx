"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { cardClass, controlClass, focusClass, pillClass, SectionTitle } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { applyAccent, parseTheme, readTheme, saveTheme, type ThemeMode } from "@/lib/theme";

const ACCENTS = [
  { id: "blue", swatch: "#8eb6ff" },
  { id: "sage", swatch: "#8fd0a8" },
  { id: "sand", swatch: "#e6c27a" },
  { id: "clay", swatch: "#f0a8a0" },
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
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

export default function GeneralSettingsPage() {
  const router = useRouter();
  const [mode, setMode] = useState<ThemeMode>("system");
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
    void api<{ username?: string; role?: string; theme?: string }>("/api/auth/me")
      .then((me) => {
        setUsername(me.username ?? "");
        setRole(me.role ?? "");
        const saved = parseTheme(me.theme);
        if (saved) setMode(saved);
      })
      .catch(() => undefined);
  }, []);

  function choose(next: ThemeMode) {
    setMode(next);
    void saveTheme(next).catch(() => undefined);
  }

  function paintAccent(id: string) {
    applyAccent(id, mode);
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
    <>
      <header>
        <h2 className="text-xl font-semibold tracking-tight">General</h2>
        <p className="mt-1 text-sm text-muted-foreground">Appearance, language, and this session.</p>
      </header>
      <section className={`${cardClass} flex items-center justify-between gap-4 p-4`}>
        <div>
          <SectionTitle>Account</SectionTitle>
          <p className="mt-1 text-sm font-medium">{username || "Signed in"}</p>
          {role ? <p className="text-xs capitalize text-muted-foreground">{role}</p> : null}
        </div>
        <Button variant="outline" className={pillClass} asChild>
          <Link href="/account">Open profile</Link>
        </Button>
      </section>
      <section className={`${cardClass} p-4`}>
        <SectionTitle>Appearance</SectionTitle>
        <div className="mt-4 flex flex-wrap gap-2">
          {THEMES.map((item) => (
            <Button
              key={item.id}
              type="button"
              data-testid={`theme-${item.id}`}
              variant={mode === item.id ? "default" : "outline"}
              className={cnPill(mode === item.id)}
              onClick={() => choose(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </section>
      <section className={`${cardClass} p-4`}>
        <SectionTitle>Accent</SectionTitle>
        <div className="mt-4 flex gap-2">
          {ACCENTS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-label={item.id}
              aria-pressed={accent === item.id}
              className={`${focusClass} size-10 rounded-full border border-border transition-transform hover:scale-105 ${accent === item.id ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : ""}`}
              style={{ background: item.swatch }}
              onClick={() => paintAccent(item.id)}
            />
          ))}
        </div>
      </section>
      <section className={`${cardClass} p-4`}>
        <SectionTitle>Preferences</SectionTitle>
        <div className="mt-4 flex flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label>Language</Label>
              <Select value={locale} onValueChange={chooseLocale}>
                <SelectTrigger className={`${controlClass} min-h-11`}>
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
            <div className="flex flex-col gap-2">
              <Label>Timezone</Label>
              <Select value={zone} onValueChange={chooseZone}>
                <SelectTrigger className={`${controlClass} min-h-11`}>
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
          <div className="flex min-h-11 items-center justify-between gap-3 border-t border-border pt-4">
            <div>
              <p className="text-sm">Notifications</p>
              <p className="text-xs text-muted-foreground">Desktop alerts for this browser.</p>
            </div>
            <Switch checked={alerts} onCheckedChange={(checked) => void chooseAlerts(checked)} aria-label="Notifications" />
          </div>
        </div>
      </section>
      <section className={`${cardClass} p-4`}>
        <SectionTitle>Security keys</SectionTitle>
        <p className="mt-1 text-sm text-muted-foreground">API keys and plugin credentials live in the vault.</p>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" className={pillClass} asChild>
            <Link href="/settings/secrets">Open vault</Link>
          </Button>
        </div>
      </section>
      <section className="rounded-[12px] border border-destructive/40 bg-card p-4 shadow-[var(--shadow-card)]">
        <SectionTitle className="text-destructive">Sign out</SectionTitle>
        <p className="mt-1 text-sm text-muted-foreground">Ends this browser session.</p>
        <form className="mt-4 flex justify-end" onSubmit={signOut}>
          <Button type="submit" variant="destructive" className={pillClass}>
            Sign out
          </Button>
        </form>
      </section>
    </>
  );
}

function cnPill(active: boolean) {
  return `${pillClass} min-h-11 ${active ? "" : "bg-card"}`;
}
