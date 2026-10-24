"use client";

import dynamic from "next/dynamic";
import type { ChatMessage } from "@/lib/types";
import { StatusBadge } from "@/lib/status";
import { Approvals } from "@/components/approvals";
import { ChatPane } from "@/components/chat-pane";
import { PluginsPane } from "@/components/plugins-pane";

const ScreenGallery = dynamic(() => import("@/components/screen-gallery"), { ssr: false });

const messages: ChatMessage[] = [
  {
    id: "user-1",
    role: "user",
    content: "Explain the latest revision we made to the handbook.",
    createdAt: "2026-10-22T09:00:00Z",
  },
  {
    id: "assistant-1",
    role: "assistant",
    content: "Making sure I have the latest revision based on recent changes.",
    createdAt: "2026-10-22T09:00:08Z",
    reactions: [{ id: "react-1", emoji: "👍", actorType: "user" }],
  },
  {
    id: "question-1",
    role: "assistant",
    content: '```question\n{"prompt":"Which format should I use?","options":["Standup notes","Internal FAQ","Both"],"styles":["primary","primary","danger"]}\n```',
    createdAt: "2026-10-22T09:01:00Z",
  },
  {
    id: "question-2",
    role: "assistant",
    content:
      '{"type":"question","prompt":"Which Rakazo ideas should go in now?","options":[{"label":"Keep all for v0.3","style":"primary"},{"label":"Hold for later","style":"primary"},{"label":"Drop them","style":"danger"}],"answer":["Keep all for v0.3"]}',
    createdAt: "2026-10-22T09:01:20Z",
  },
  {
    id: "memory-1",
    role: "assistant",
    content: '{"type":"memory","action":"saved","content":"My favorite editor is Helix"}',
    createdAt: "2026-10-22T09:01:40Z",
  },
  {
    id: "form-1",
    role: "assistant",
    content: '```form\n{"title":"Mailbox key","fields":[{"name":"token","label":"API token","secret":true},{"name":"label","label":"Label"}]}\n```',
    createdAt: "2026-10-22T09:02:00Z",
  },
  {
    id: "file-1",
    role: "assistant",
    content: "The export is ready.\n[handbook.pdf](/favicon.svg)",
    createdAt: "2026-10-22T09:03:00Z",
  },
  {
    id: "image-1",
    role: "assistant",
    content: "Preview of the mark.\n![Mark](/favicon.svg)",
    createdAt: "2026-10-22T09:04:00Z",
  },
];

export default function ScreenGalleryPage() {
  return (
    <div data-testid="screen-gallery" className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
        <header>
          <h1 className="text-body-sm font-medium">Message gallery</h1>
          <p className="text-body-sm text-muted-foreground">Every card type, using the same components as a live chat.</p>
        </header>
        <div className="flex flex-wrap gap-2">
          <StatusBadge status="running" />
          <StatusBadge status="completed" />
          <StatusBadge status="failed" />
          <StatusBadge status="idle" />
        </div>
        <p className="flex items-center gap-2 text-body-sm text-muted-foreground">
          <img src="/favicon.svg" alt="" className="h-4 w-4 rounded-control" />
          Field clerk is working
        </p>
        <article data-testid="task-card" className="rounded-lg border border-border bg-card px-3 py-2 text-body-sm">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate font-medium">Summarise the Friday inbox</p>
            <StatusBadge status="running" />
          </div>
        </article>
        <article data-testid="secret-request-card" className="rounded-lg border border-border bg-card px-3 py-2 text-body-sm">
          <p className="font-medium">Secret request</p>
          <p className="text-muted-foreground">secret://vault/mailbox</p>
        </article>
        <article data-testid="artifact-card" className="rounded-lg border border-border bg-card px-3 py-2 text-body-sm">
          <p className="font-medium">handbook.pdf</p>
          <span className="text-brand">Download</span>
        </article>
        <Approvals
          approvals={[{ id: "approval-1", action: "browser_open", target: "https://example.com/faq", reason: "First visit to this host.", status: "pending" }]}
          onChanged={() => undefined}
        />
        <div className="flex h-[760px] flex-col overflow-hidden rounded-lg border border-border">
          <ChatPane conversationId={undefined} messages={messages} botName="Field clerk" onSent={() => undefined} />
        </div>
        <PluginsPane />
        <ScreenGallery />
      </div>
    </div>
  );
}
