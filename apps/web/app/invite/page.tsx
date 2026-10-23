"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
      <Card className="w-full min-w-0 max-w-md">
        <CardHeader>
          <p className="text-xl font-medium tracking-tight">Teammates</p>
          <CardTitle className="text-xl">Accept an invitation</CardTitle>
          <p className="text-sm text-muted-foreground">Choose a username and password. The invitation token is shown once to the person who invited you.</p>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-token">Invitation token</Label>
              <Input id="invite-token" data-testid="invite-token" value={token} onChange={(event) => setToken(event.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-username">Username</Label>
              <Input id="invite-username" data-testid="invite-username" value={username} onChange={(event) => setUsername(event.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-password">Password</Label>
              <Input id="invite-password" data-testid="invite-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            </div>
            {error ? <p className="text-sm text-clay">{error}</p> : null}
            <Button data-testid="invite-submit" type="submit" disabled={pending}>
              {pending ? "Creating account…" : "Create account"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
