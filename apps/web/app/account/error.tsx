"use client";

import { PageError } from "@/components/account/chrome";

export default function AccountError({ reset }: { error: Error; reset: () => void }) {
  return <PageError title="This page failed to load." detail="The view hit an unexpected error." onRetry={reset} />;
}
