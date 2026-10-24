"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, type FormEvent, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiError, api, staffRole } from "@/lib/api";
import { applyTheme, readTheme, type ThemeMode } from "@/lib/theme";

export type AdminUser = {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: string;
  status: string;
  planId: string;
  creditBalance: number;
  creditAllowance: number;
  modelCalls: number;
  costUsd: number;
  suspended: boolean;
};

export type AdminPayload = {
  runtimeProvider: string;
  modelId: string;
  modelLabel: string;
  allowances: Record<string, number>;
  users: AdminUser[];
};

const plans = ["free", "pro", "team"];
const themes: ThemeMode[] = ["light", "dark", "system"];

type Draft = { planId: string; credits: string };

type AdminContextValue = {
  payload: AdminPayload | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  query: string;
  setQuery: (value: string) => void;
  users: AdminUser[];
  drafts: Record<string, Draft>;
  setDrafts: (updater: (current: Record<string, Draft>) => Record<string, Draft>) => void;
  theme: ThemeMode;
  chooseTheme: (next: ThemeMode) => void;
  modelId: string;
  setModelId: (value: string) => void;
  modelLabel: string;
  setModelLabel: (value: string) => void;
  allowances: Record<string, string>;
  setAllowances: (updater: (current: Record<string, string>) => Record<string, string>) => void;
  load: () => Promise<void>;
  savePlatform: (event: FormEvent) => Promise<void>;
  saveUser: (user: AdminUser) => Promise<void>;
  suspend: (user: AdminUser) => Promise<void>;
  signOut: () => Promise<void>;
};

const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin() {
  const value = useContext(AdminContext);
  if (!value) throw new Error("Admin state is only available inside the admin shell.");
  return value;
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [payload, setPayload] = useState<AdminPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [modelId, setModelId] = useState("anthropic/claude-haiku-5.5");
  const [modelLabel, setModelLabel] = useState("Claude Haiku 5.5");
  const [allowances, setAllowances] = useState<Record<string, string>>({ free: "500", pro: "5000", team: "20000" });
  const [drafts, setDraftsState] = useState<Record<string, Draft>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((next: AdminPayload) => {
    setPayload(next);
    setModelId(next.modelId || "anthropic/claude-haiku-5.5");
    setModelLabel(next.modelLabel || "Claude Haiku 5.5");
    setAllowances({
      free: String(next.allowances.free ?? 0),
      pro: String(next.allowances.pro ?? 0),
      team: String(next.allowances.team ?? 0),
    });
    setDraftsState(Object.fromEntries(next.users.map((user) => [user.id, { planId: user.planId, credits: String(user.creditBalance) }])));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      apply(await api<AdminPayload>("/api/admin/accounts"));
      setError(null);
    } catch (caught) {
      setPayload(null);
      if (caught instanceof ApiError && caught.status === 403) setError("Owners and admins only.");
      else setError(caught instanceof Error ? caught.message : "Could not load the admin site.");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    if (pathname.startsWith("/login")) return;
    setTheme(readTheme());
    void api<{ role?: string }>("/api/auth/me")
      .then((me) => {
        if (!staffRole(me.role)) {
          router.replace("/login");
          return;
        }
        setReady(true);
        void load();
      })
      .catch(() => router.replace("/login"));
  }, [load, pathname, router]);

  const users = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!payload) return [];
    if (!needle) return payload.users;
    return payload.users.filter((user) => [user.username, user.displayName, user.email].some((value) => value.toLowerCase().includes(needle)));
  }, [payload, query]);

  function chooseTheme(next: ThemeMode) {
    setTheme(next);
    applyTheme(next);

  }

  async function savePlatform(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/admin/platform", {
        method: "PUT",
        body: JSON.stringify({
          modelId,
          modelLabel,
          allowances: { free: Number(allowances.free), pro: Number(allowances.pro), team: Number(allowances.team) },
        }),
      });
      setNotice("Platform settings saved.");
      await load();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not save platform settings.");
    }
  }

  async function saveUser(user: AdminUser) {
    const draft = drafts[user.id];
    if (!draft) return;
    try {
      await api(`/api/admin/users/${user.id}/billing`, {
        method: "PATCH",
        body: JSON.stringify({ planId: draft.planId, creditBalance: Number(draft.credits) }),
      });
      setNotice(`Updated ${user.username}.`);
      await load();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not update that user.");
    }
  }

  async function suspend(user: AdminUser) {
    try {
      await api(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: user.suspended ? "active" : "disabled" }),
      });
      setNotice(user.suspended ? `${user.username} can sign in.` : `${user.username} is suspended.`);
      await load();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not change that account.");
    }
  }

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
  }

  if (pathname.startsWith("/login")) return children;

  if (!ready) {
    return <main className="mx-auto max-w-4xl px-6 py-6" aria-busy="true" data-testid="admin-boot" />;
  }

  const value: AdminContextValue = {
    payload,
    loading,
    error,
    notice,
    query,
    setQuery,
    users,
    drafts,
    setDrafts: setDraftsState,
    theme,
    chooseTheme,
    modelId,
    setModelId,
    modelLabel,
    setModelLabel,
    allowances,
    setAllowances,
    load,
    savePlatform,
    saveUser,
    suspend,
    signOut,
  };

  const links = [
    { href: "/", label: "Dashboard", exact: true },
    { href: "/users", label: "Users" },
    { href: "/ai-models", label: "AI models" },
    { href: "/speed", label: "Speed" },
    { href: "/settings", label: "Settings" },
  ];

  return (
    <AdminContext.Provider value={value}>
      <div data-testid="admin-app" className="flex min-h-dvh flex-col md:flex-row">
        <aside className="shrink-0 border-b border-border px-3 py-4 md:w-56 md:border-b-0 md:border-r">
          <h1 className="px-3 text-base font-semibold tracking-tight">Admin</h1>
          <nav data-testid="admin-nav" aria-label="Admin" className="mt-4 flex gap-1 overflow-x-auto md:flex-col">
            {links.map((link) => {
              const active = link.exact ? pathname === link.href : pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-[8px] px-3 text-sm ${active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </aside>
        <div className="min-w-0 flex-1">
          <header className="flex flex-wrap items-center justify-end gap-2 border-b border-border px-6 py-3">
            {themes.map((item) => (
              <button key={item} type="button" data-testid={`admin-theme-${item}`} className={`inline-flex min-h-11 items-center rounded-[6px] px-3 text-sm capitalize ${theme === item ? "bg-primary text-primary-foreground" : "border border-border"}`} onClick={() => chooseTheme(item)}>
                {item}
              </button>
            ))}
            <button type="button" className="inline-flex min-h-11 items-center rounded-[6px] border border-border px-3 text-sm" onClick={() => void signOut()}>
              Sign out
            </button>
          </header>
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-6">
            {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
            {loading && !payload ? <div data-testid="admin-skeleton" className="h-28 animate-pulse rounded-[12px] bg-muted" aria-busy="true" /> : null}
            {error ? (
              <div role="alert" data-testid="admin-error" className="rounded-[12px] border border-border bg-card px-4 py-4 shadow-(--shadow-card)">
                <p className="font-medium text-destructive">{error}</p>
                <div className="mt-3 flex justify-end">
                  <button type="button" className="inline-flex min-h-11 items-center rounded-[6px] border border-border px-3 text-sm" onClick={() => void load()}>
                    Try again
                  </button>
                </div>
              </div>
            ) : null}
            {children}
          </div>
        </div>
      </div>
    </AdminContext.Provider>
  );
}

export { plans };
