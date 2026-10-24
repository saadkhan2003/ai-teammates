"use client";

import { Button } from "@/components/ui/button";
import { StatusScreen } from "@/components/status-screen";

export default function RootError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <StatusScreen
      testId="error-page"
      code="500"
      title="Something went wrong"
      detail="This screen hit an unexpected error. Try again, or return once the service is back."
      action={
        <Button type="button" className="rounded-full" onClick={() => reset()}>
          Try again
        </Button>
      }
    />
  );
}
