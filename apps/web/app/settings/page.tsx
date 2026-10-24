"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { cardClass, controlClass, focusClass, pillClass, SectionTitle } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsSelect } from "@/components/settings-select";
import { SettingsSwitch as Switch } from "@/components/settings-switch";
import { api } from "@/lib/api";
import { applyAccent, parseTheme, readTheme, saveTheme, type ThemeMode } from "@/lib/theme";
import { EDITORS, type EditorId, readEnabledEditors, writeEnabledEditors } from "@/lib/editors";

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
  const [editors, setEditors] = useState<EditorId[]>([]);

  useEffect(() => {
    setMode(readTheme());
    setLocale(window.localStorage.getItem("teammates-locale") || "en");
    setZone(window.localStorage.getItem("teammates-timezone") || "UTC");
    setAlerts(window.localStorage.getItem("teammates-desktop-notifications") === "on");
    setAccent(window.localStorage.getItem("teammates-accent-id") || "blue");
    setEditors(readEnabledEditors());
    void api<{ username?: string; role?: string; theme?: string; timezone?: string }>("/api/auth/me")
      .then((me) => {
        setUsername(me.username ?? "");
        setRole(me.role ?? "");
        if (me.timezone) setZone(me.timezone);
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
    void api("/api/auth/timezone", { method: "PATCH", body: JSON.stringify({ timezone: value }) }).catch(() => undefined);
  }

  function chooseEditor(id: EditorId, on: boolean) {
    const next = EDITORS.filter((e) => (e.id === id ? on : editors.includes(e.id))).map((e) => e.id);
    setEditors(next);
    writeEnabledEditors(next);
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
    <div id="general" className="flex flex-col gap-[var(--space-section)]">
      <header>
        <h2 className="text-title">General</h2>
        <p className="mt-1 text-body-sm text-muted-foreground">Appearance, language, and this session.</p>
      </header>
      <section id="account" className={`${cardClass} flex items-center justify-between gap-4 p-4`}>
        <div>
          <SectionTitle>Account</SectionTitle>
          <p className="mt-1 text-body-sm font-medium">{username || "Signed in"}</p>
          {role ? <p className="text-meta capitalize text-muted-foreground">{role}</p> : null}
        </div>
        <Button variant="outline" className={pillClass} asChild>
          <Link href="/account">Open profile</Link>
        </Button>
      </section>
      <section id="theme" className={`${cardClass} p-4`}>
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
      <section id="accent" className={`${cardClass} p-4`}>
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
            <div id="language" className="flex flex-col gap-2">
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
            <div id="timezone" className="flex flex-col gap-2">
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
          <div id="notifications" className="flex min-h-11 items-center justify-between gap-3 border-t border-border pt-4">
            <div>
              <p className="text-body-sm">Notifications</p>
              <p className="text-meta text-muted-foreground">Desktop alerts for this browser.</p>
            </div>
            <Switch checked={alerts} onCheckedChange={(checked) => void chooseAlerts(checked)} aria-label="Notifications" />
          </div>
        </div>
      </section>
      <section id="approval-rules" className={`${cardClass} p-4`}>
        <SectionTitle>Approval rules</SectionTitle>
        <div className="mt-4 space-y-1 text-body-sm text-muted-foreground">
          <p>The server enforces these. They are not switches on this page.</p>
          <ul className="list-disc space-y-1 pl-4">
            <li>Shell commands and environment setup are denied.</li>
            <li>A command that contains a secret reference is denied.</li>
            <li>Deleting a file asks for approval.</li>
            <li>Opening a site the account has not seen asks for approval.</li>
            <li>Typing a secret is allowed only when the reference resolves.</li>
          </ul>
        </div>
      </section>
      <section className={`${cardClass} p-4`}>
        <SectionTitle>Security keys</SectionTitle>
        <p className="mt-1 text-body-sm text-muted-foreground">API keys and plugin credentials live in the vault.</p>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" className={pillClass} asChild>
            <Link href="/settings/secrets">Open vault</Link>
          </Button>
        </div>
      </section>
      <section className="rounded-card border border-destructive/40 bg-card p-4 shadow-[var(--shadow-card)]">
        <SectionTitle className="text-destructive">Sign out</SectionTitle>
        <p className="mt-1 text-body-sm text-muted-foreground">Ends this browser session.</p>
        <section aria-label="Editors"><SectionTitle>Editors</SectionTitle>{EDITORS.map(editor => <label key={editor.id} className="flex items-center gap-2"><Switch data-testid={`editor-${editor.id}`} checked={editors.includes(editor.id)} onCheckedChange={on => chooseEditor(editor.id, on)} />{editor.label}</label>)}</section>
        <form className="mt-4 flex justify-end" onSubmit={signOut}>
          <Button type="submit" variant="destructive" className={pillClass}>
            Sign out
          </Button>
        </form>
      </section>
    </div>
  );
}

function cnPill(active: boolean) {
  return `${pillClass} min-h-11 ${active ? "" : "bg-card"}`;
}
