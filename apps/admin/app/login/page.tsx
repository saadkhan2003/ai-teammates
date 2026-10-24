"use client";

import { type FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api, staffRole } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void api<{ role?: string }>("/api/auth/me")
      .then((me) => {
        if (staffRole(me.role)) router.replace("/");
      })
      .catch(() => undefined);
  }, [router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      const me = await api<{ role?: string }>("/api/auth/me");
      if (!staffRole(me.role)) {
        await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        setError("This sign-in is for owners and admins.");
        return;
      }
      router.replace("/");
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) setError("That username or password was not accepted.");
      else setError(caught instanceof Error ? caught.message : "The server could not sign you in.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-(--space-page)">
      <form data-testid="admin-login" onSubmit={(event) => void onSubmit(event)} className="w-full max-w-md rounded-[12px] border border-border bg-card p-4 shadow-(--shadow-card)">
        <p className="text-sm font-medium">Teammates Admin</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">Owners and admins only. This site is separate from the user app.</p>
        <label className="mt-4 grid gap-2 text-sm font-medium" htmlFor="admin-username">
          Username
          <input id="admin-username" data-testid="admin-username" className="min-h-11 rounded-[8px] border border-input bg-card px-3 text-sm font-normal" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
        </label>
        <label className="mt-4 grid gap-2 text-sm font-medium" htmlFor="admin-password">
          Password
          <input id="admin-password" data-testid="admin-password" type="password" className="min-h-11 rounded-[8px] border border-input bg-card px-3 text-sm font-normal" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </label>
        {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
        <div className="mt-4 flex justify-end">
          <button data-testid="admin-submit" type="submit" className="inline-flex min-h-11 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}
