"use client";

import { useParams } from "next/navigation";
import dynamic from "next/dynamic";

const Workspace = dynamic(() => import("@/components/workspace").then((module) => module.Workspace), {
  loading: () => <div aria-hidden="true" className="h-full min-h-0 animate-pulse bg-primary/5" />,
});

export default function BotPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  if (!id) return <p>This bot link is missing an id.</p>;
  return (
    <div className="h-full min-h-0">
      <Workspace botId={id} />
    </div>
  );
}
