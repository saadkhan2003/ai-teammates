"use client";

import Link from "next/link";
import { cardClass, focusClass, pillClass } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";

export default function ResetPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div data-testid="reset-page" className={`${cardClass} w-full max-w-md p-4`}>
        <p className="text-body-sm font-medium">Teammates</p>
        <h1 className="mt-1 text-title">Reset password</h1>
        <p className="mt-2 text-body-sm leading-5 text-muted-foreground">
          An owner resets a password from the admin site. If you still have a session, change it from your profile.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" className={pillClass} asChild>
            <Link href="/login" className={focusClass}>
              Back to sign in
            </Link>
          </Button>
          <Button className={pillClass} asChild>
            <Link href="/account">Open profile</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
