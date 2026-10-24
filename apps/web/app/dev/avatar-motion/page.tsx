"use client";

import { useState } from "react";
import { ComposerPresence, WORKING_STATUS } from "@/components/avatar-motion/composer-presence";
import { HeroAvatar } from "@/components/avatar-motion/hero-avatar";
import { MotionAvatar } from "@/components/avatar-motion/motion-avatar";

const PREVIEW = "You're right, the white composer in dark mode is a bug.";

export default function AvatarMotionFixturePage() {
  const [status, setStatus] = useState<string | null>(WORKING_STATUS);
  return (
    <div data-testid="avatar-motion-stage" className="flex h-full flex-col gap-8 overflow-auto bg-background p-8 text-foreground">
      <div className="flex items-center justify-between">
        <HeroAvatar botId="atlas" name="ATLAS" shape="blob6" color="#ff3045" size={96} preview={PREVIEW} />
        <ComposerPresence botId="atlas" name="ATLAS" shape="blob6" color="#ff3045" status={status} size={64} />
      </div>
      <div data-testid="avatar-motion-row" className="avatar-motion-row flex w-fit items-center gap-2 rounded-lg px-2 py-2">
        <MotionAvatar slot="pulse" variant="row" botId="pulse" shape="blob1" color="#8b5cf6" size={32} label="PULSE" />
        <span className="text-sm font-medium">PULSE</span>
      </div>
      <button
        type="button"
        data-testid="toggle-status"
        className="w-fit rounded-md border border-border px-3 py-1 text-sm"
        onClick={() => setStatus((current) => (current ? null : WORKING_STATUS))}
      >
        Toggle status
      </button>
    </div>
  );
}
