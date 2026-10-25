"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cardClass, controlClass, focusClass, pillClass } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [totpRequired, setTotpRequired] = useState(false);
  const [code, setCode] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await api<{ totpRequired?: boolean }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      if (result.totpRequired) { setTotpRequired(true); return; }
      router.push("/");
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 400 || caught.status === 403)) {
        setError("That username or password was not accepted.");
      } else {
        setError(errorMessage(caught, "The server could not sign you in."));
      }
    } finally {
      setPending(false);
    }
  }

  async function onTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(null);
    try {
      await api("/api/auth/login/totp", { method: "POST", body: JSON.stringify({ code }) });
      router.push("/"); router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) setError("That code was not accepted.");
      else setError(errorMessage(caught, "The server could not verify that code."));
    } finally { setPending(false); }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div data-testid="login-card" className={`${cardClass} w-full min-w-0 max-w-md p-4`}>
        <p className="text-body-sm font-medium">Teammates</p>
        <h1 className="mt-1 text-title">{totpRequired ? "Verify your sign-in" : "Sign in"}</h1>
        <p className="mt-1 text-body-sm text-muted-foreground">{totpRequired ? "Enter an authenticator code or a recovery code." : "Sign in with the owner account, or the username from your invitation."}</p>
        <form className="mt-4 flex flex-col gap-4" onSubmit={totpRequired ? onTotp : onSubmit}>
          {totpRequired ? <div className="flex flex-col gap-2"><Label htmlFor="login-totp-code">Authenticator or recovery code</Label><Input id="login-totp-code" data-testid="login-totp-code" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required /></div> : <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="login-username">Username</Label>
            <Input
              id="login-username"
              data-testid="login-username"
              name="username"
              autoComplete="username"
              placeholder="saad"
              className={`${controlClass} min-h-11`}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              data-testid="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              className={`${controlClass} min-h-11`}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          </>}
          {error ? (
            <p role="alert" className="text-body-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <Link href="/login/reset" className={`${focusClass} text-body-sm text-muted-foreground underline`}>
              Forgot password
            </Link>
            <Button data-testid="login-submit" type="submit" className={pillClass} disabled={pending}>
              {pending ? "Verifying…" : totpRequired ? "Verify" : "Sign in"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
