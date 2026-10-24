"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { KeyRound, Link2, SlidersHorizontal, Trash2, UserRound } from "lucide-react";
import { cardClass, controlClass, focusClass, FormActions, PageError, PageHeader, PageSkeleton, pillClass, SectionTitle } from "@/components/account/chrome";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ApiError, api } from "@/lib/api";
import { type AccountProfile, initials } from "@/lib/account";
import { errorMessage } from "@/lib/utils";

export default function AccountPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [updates, setUpdates] = useState(false);
  const [saving, setSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busyMethod, setBusyMethod] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<AccountProfile>("/api/account");
      setProfile(next);
      setName(next.displayName);
      setEmail(next.email);
      setAvatarUrl(next.avatarUrl);
      setUpdates(next.productUpdates);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load the account."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function onAvatar(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Choose an image.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      if (value.length > 180_000) {
        toast.error("That image is too large.");
        return;
      }
      setAvatarUrl(value);
    };
    reader.readAsDataURL(file);
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const next = await api<AccountProfile>("/api/account", {
        method: "PATCH",
        body: JSON.stringify({ displayName: name, email, avatarUrl, productUpdates: updates }),
      });
      setProfile(next);
      window.dispatchEvent(new Event("teammates-profile-changed"));
      toast.success("Profile saved.");
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not save the profile."));
    } finally {
      setSaving(false);
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    setPasswordError(null);
    try {
      await api("/api/account/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      toast.success("Password updated.");
    } catch (caught) {
      setPasswordError(errorMessage(caught, "Could not update the password."));
    }
  }

  async function toggleMethod(identityProvider: string, connected: boolean) {
    setBusyMethod(identityProvider);
    try {
      const next = connected
        ? await api<AccountProfile>(`/api/account/identities/${identityProvider}`, { method: "DELETE" })
        : await api<AccountProfile>("/api/account/identities", { method: "POST", body: JSON.stringify({ provider: identityProvider }) });
      setProfile(next);
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not update that sign-in method."));
    } finally {
      setBusyMethod(null);
    }
  }

  async function removeAccount(event: FormEvent) {
    event.preventDefault();
    setDeleteError(null);
    try {
      await api("/api/account", { method: "DELETE", body: JSON.stringify({ password: deletePassword, confirm }) });
      router.push("/login");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setDeleteError("The only owner cannot delete this account.");
      else setDeleteError(errorMessage(caught, "Could not delete the account."));
    }
  }

  return (
    <div data-testid="account-page" className="flex flex-col gap-[var(--space-section)]">
      <PageHeader title="Account" subtitle="Name, email, avatar, and the ways you sign in." />
      {loading ? <PageSkeleton /> : null}
      {error ? <PageError title="Could not load the account." detail={error} onRetry={() => void load()} /> : null}
      {profile ? (
        <>
          <form data-testid="profile-form" onSubmit={(event) => void saveProfile(event)} className={`${cardClass} p-[var(--space-inset)]`}>
            <SectionTitle icon={<UserRound className="size-4" aria-hidden="true" />}>Profile</SectionTitle>
            <div className="mt-4 flex items-center gap-3">
              <Avatar className="h-12 w-12">
                {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
                <AvatarFallback>{initials(name || profile.username)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-body-sm font-medium">{name || profile.username}</p>
                <p className="text-meta text-muted-foreground">{profile.role}</p>
              </div>
              <label className="ml-auto">
                <input data-testid="avatar-file" className="sr-only" type="file" accept="image/*" onChange={(event) => onAvatar(event.target.files?.[0])} />
                <span className={`${pillClass} ${focusClass} inline-flex min-h-11 cursor-pointer items-center border border-border px-3 text-body-sm transition-colors hover:bg-accent`}>Change photo</span>
              </label>
            </div>
            <div className="mt-4 grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="display-name">Name</Label>
                <Input id="display-name" data-testid="profile-name" className={`${controlClass} min-h-11`} value={name} onChange={(event) => setName(event.target.value)} required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" data-testid="profile-email" className={`${controlClass} min-h-11`} type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
              </div>
            </div>
            <FormActions>
              <Button data-testid="profile-save" type="submit" className={pillClass} disabled={saving}>
                Save profile
              </Button>
            </FormActions>
          </form>

          <form data-testid="preferences-form" className={`${cardClass} p-[var(--space-inset)]`} onSubmit={(event) => void saveProfile(event)}>
            <SectionTitle icon={<SlidersHorizontal className="size-4" aria-hidden="true" />}>Preferences</SectionTitle>
            <div className={`${controlClass} mt-3 flex min-h-11 items-center justify-between gap-3 border border-border px-3`}>
              <div>
                <p className="text-body-sm">Product updates</p>
                <p className="text-meta text-muted-foreground">Notes about credits and product changes.</p>
              </div>
              <Switch data-testid="product-updates" className={pillClass} checked={updates} onCheckedChange={setUpdates} aria-label="Product updates" />
            </div>
            <FormActions>
              <Button type="submit" className={pillClass} disabled={saving}>
                Save preferences
              </Button>
            </FormActions>
          </form>

          <form data-testid="password-form" onSubmit={(event) => void savePassword(event)} className={`${cardClass} p-[var(--space-inset)]`}>
            <SectionTitle icon={<KeyRound className="size-4" aria-hidden="true" />}>Password</SectionTitle>
            <p className="mt-1 text-body-sm text-muted-foreground">At least 8 characters. The current password has to match.</p>
            <div className="mt-4 grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="current-password">Current password</Label>
                <Input id="current-password" data-testid="current-password" className={`${controlClass} min-h-11`} type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="new-password">New password</Label>
                <Input id="new-password" data-testid="new-password" className={`${controlClass} min-h-11`} type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
              </div>
            </div>
            {passwordError ? <p className="mt-3 text-body-sm text-destructive">{passwordError}</p> : null}
            <FormActions>
              <Button data-testid="password-save" type="submit" className={pillClass}>
                Update password
              </Button>
            </FormActions>
          </form>

          <section className={`${cardClass} p-[var(--space-inset)]`}>
            <SectionTitle icon={<Link2 className="size-4" aria-hidden="true" />}>Sign-in methods</SectionTitle>
            <p className="mt-1 text-body-sm text-muted-foreground">Password stays on this account. Google and GitHub can be connected beside it.</p>
            <ul className="mt-3 flex flex-col gap-2">
              {profile.identities.map((method) => (
                <li key={method.provider} data-testid={`identity-${method.provider}`} className={`${controlClass} flex min-h-11 items-center justify-between gap-3 border border-border px-3 py-2 transition-colors hover:bg-accent/40`}>
                  <div className="min-w-0">
                    <p className="text-body-sm font-medium">{method.label}</p>
                    <p className="text-meta text-muted-foreground">{method.detail}</p>
                  </div>
                  {method.provider === "password" ? (
                    <span className="text-meta text-muted-foreground">Connected</span>
                  ) : (
                    <Button type="button" variant="outline" className={pillClass} disabled={busyMethod === method.provider} onClick={() => void toggleMethod(method.provider, method.connected)}>
                      {method.connected ? "Disconnect" : "Connect"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <form data-testid="danger-card" onSubmit={(event) => void removeAccount(event)} className="rounded-card border border-destructive/40 bg-card p-[var(--space-inset)]">
            <SectionTitle className="text-destructive" icon={<Trash2 className="size-4" aria-hidden="true" />}>Delete account</SectionTitle>
            <p className="mt-1 text-body-sm text-muted-foreground">
              {profile.canDelete ? "This removes the account, its bots, and its credits." : "The only owner cannot delete this account."}
            </p>
            <div className="mt-4 grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="delete-password">Password</Label>
                <Input id="delete-password" data-testid="delete-password" className={`${controlClass} min-h-11`} type="password" value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} autoComplete="current-password" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="delete-confirm">Type DELETE</Label>
                <Input id="delete-confirm" data-testid="delete-confirm" className={`${controlClass} min-h-11`} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
              </div>
            </div>
            {deleteError ? <p data-testid="delete-error" className="mt-3 text-body-sm text-destructive">{deleteError}</p> : null}
            <FormActions>
              <Button data-testid="delete-account" type="submit" variant="destructive" className={pillClass} disabled={!profile.canDelete}>
                Delete account
              </Button>
            </FormActions>
          </form>
        </>
      ) : null}
    </div>
  );
}
