"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusScreen } from "@/components/status-screen";

export default function OfflinePage() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  return (
    <StatusScreen
      testId="offline-page"
      code="Offline"
      title={online ? "You are back online" : "You are offline"}
      detail={online ? "The connection is available again. Reload to pick up the latest screen." : "Teammates needs a network connection for chat, settings, and billing."}
      action={
        <Button type="button" className="rounded-full" onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    />
  );
}
