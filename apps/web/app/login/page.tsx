"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
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

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))]">
      <Card data-testid="login-card" className="w-full min-w-0 max-w-md">
        <CardHeader className="space-y-1 p-4">
          <p className="text-sm font-medium">Teammates</p>
          <CardTitle className="text-base">Sign in</CardTitle>
          <p className="text-sm text-muted-foreground">Sign in with the owner account, or the username from your invitation.</p>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="login-username">Username</Label>
              <Input
                id="login-username"
                data-testid="login-username"
                name="username"
                autoComplete="username"
                placeholder="saad"
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
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-clay">
                {error}
              </p>
            ) : null}
            <Button data-testid="login-submit" type="submit" className="self-end" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
