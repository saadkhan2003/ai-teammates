"use client";

import { useId } from "react";
import { AvatarEyes, ContactShadow, GlossyBlob } from "@/components/avatar-motion/glossy-blob";
import { resolveAvatarAppearance } from "@/lib/avatar-motion";

export function BotAvatar({ shape, color, size = 40, botId, className = "" }: {
  shape?: string; color?: string; size?: number; botId?: string; className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const appearance = resolveAvatarAppearance(shape, color, botId);
  return (
    <svg data-testid="bot-avatar" data-bot-id={botId || undefined} data-avatar-fill={appearance.fill} data-avatar-gloss="3d" className={className} width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Bot avatar">
      <ContactShadow idPrefix={uid} />
      <GlossyBlob idPrefix={uid} path={appearance.path} fill={appearance.fill} />
      <AvatarEyes />
    </svg>
  );
}
