"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cardClass, controlClass, focusClass, pillClass } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

export default function InvitePage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token, username, password }),
      });
      router.push("/");
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught, "That invitation could not be accepted."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div data-testid="invite-card" className={`${cardClass} w-full min-w-0 max-w-md p-4`}>
        <p className="text-sm font-medium">Teammates</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Accept an invitation</h1>
        <p className="mt-1 text-sm text-muted-foreground">Choose a username and password. The invitation token is shown once to the person who invited you.</p>
        <form className="mt-4 flex flex-col gap-4" onSubmit={onSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-token">Invitation token</Label>
            <Input id="invite-token" data-testid="invite-token" className={`${controlClass} min-h-11`} value={token} onChange={(event) => setToken(event.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-username">Username</Label>
            <Input id="invite-username" data-testid="invite-username" className={`${controlClass} min-h-11`} value={username} onChange={(event) => setUsername(event.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-password">Password</Label>
            <Input id="invite-password" data-testid="invite-password" className={`${controlClass} min-h-11`} type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex items-center justify-between gap-3">
            <Link href="/login" className={`${focusClass} text-sm text-muted-foreground underline`}>
              Already have an account
            </Link>
            <Button data-testid="invite-submit" type="submit" className={pillClass} disabled={pending}>
              {pending ? "Creating account…" : "Create account"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
