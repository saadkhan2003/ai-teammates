"use client";

import { BOT_AVATARS, defaultBotAvatar } from "@/lib/avatars";

export function BotAvatar({ shape, color, size = 40, botId, className = "" }: {
  shape?: string; color?: string; size?: number; botId?: string; className?: string;
}) {
  const fallback = defaultBotAvatar(botId ?? "new-bot");
  const selectedShape = BOT_AVATARS.find(item => item.id === shape)?.id ?? fallback.shape;
  const path = BOT_AVATARS.find(item => item.id === selectedShape)!.path;
  const fill = /^#[0-9a-fA-F]{6}$/.test(color ?? "") ? color : fallback.color;
  return <svg data-testid="bot-avatar" className={className} width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Bot avatar">
    <path d={path} fill={fill} />
    <ellipse cx="39" cy="47" rx="5.5" ry="9" fill="#171717" transform="rotate(-14 39 47)" />
    <ellipse cx="62" cy="47" rx="5.5" ry="9" fill="#171717" transform="rotate(-14 62 47)" />
  </svg>;
}
