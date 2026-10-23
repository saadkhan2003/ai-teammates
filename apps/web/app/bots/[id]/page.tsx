"use client";

import { useParams } from "next/navigation";
import { Workspace } from "@/components/workspace";

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
