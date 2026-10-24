"use client";

import { useEffect, useRef } from "react";
import { BOT_AVATARS, defaultBotAvatar } from "@/lib/avatars";
import { avatarFrame, lobePath, subscribeAvatar, type AvatarFrame } from "@/lib/avatar-motion";

const EYE_L = { x: 39, y: 47 };
const EYE_R = { x: 62, y: 47 };
const CENTER_Y = 52;

function eyeAttrs(frame: AvatarFrame["eye"], cx: number, cy: number) {
  return {
    x: cx + frame.dx - frame.w / 2, y: cy + frame.dy - frame.h / 2, width: frame.w, height: frame.h, rx: Math.min(frame.rx, frame.w / 2, frame.h / 2),
    transform: `rotate(${frame.rot.toFixed(1)} ${(cx + frame.dx).toFixed(2)} ${(cy + frame.dy).toFixed(2)})`,
  };
}

/** Bot avatar. With `animated` it joins the shared avatar clock (see lib/avatar-motion.ts): every animated copy is in sync. */
export function BotAvatar({ shape, color, size = 40, botId, className = "", animated = false, primary = false }: {
  shape?: string; color?: string; size?: number; botId?: string; className?: string; animated?: boolean; primary?: boolean;
}) {
  const fallback = defaultBotAvatar(botId ?? "new-bot");
  const selected = BOT_AVATARS.find(item => item.id === shape) ?? BOT_AVATARS.find(item => item.id === fallback.shape)!;
  const fill = /^#[0-9a-fA-F]{6}$/.test(color ?? "") ? color : fallback.color;
  const body = useRef<SVGGElement>(null);
  const path = useRef<SVGPathElement>(null);
  const eyeL = useRef<SVGRectElement>(null);
  const eyeR = useRef<SVGRectElement>(null);
  const morph = !!selected.morph;

  useEffect(() => {
    if (!animated) return;
    return subscribeAvatar(frame => {
      body.current?.setAttribute("transform", `translate(${(50 + frame.tx).toFixed(2)} ${CENTER_Y}) rotate(${frame.rot.toFixed(2)}) scale(${frame.sx.toFixed(4)} ${frame.sy.toFixed(4)}) translate(-50 -${CENTER_Y})`);
      if (morph) path.current?.setAttribute("d", lobePath(frame.lobeAmp, frame.lobePhase));
      for (const [node, cx] of [[eyeL.current, EYE_L.x], [eyeR.current, EYE_R.x]] as const) {
        if (!node) continue;
        const a = eyeAttrs(frame.eye, cx, EYE_L.y);
        for (const [key, value] of Object.entries(a)) node.setAttribute(key, typeof value === "number" ? value.toFixed(2) : value);
      }
    });
  }, [animated, morph]);

  const eye = (cx: number) => eyeAttrs(avatarFrame(0, "idle", true).eye, cx, EYE_L.y);
  const l = eye(EYE_L.x), r = eye(EYE_R.x);
  const svg = <svg data-testid="bot-avatar" data-animated={animated ? "true" : undefined} className={className} width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Bot avatar">
    <g ref={body}>
      <path ref={path} d={selected.path} fill={fill} />
      <rect ref={eyeL} {...l} fill="var(--computer-background)" />
      <rect ref={eyeR} {...r} fill="var(--computer-background)" />
    </g>
  </svg>;
  if (!primary) return svg;
  const badge = Math.max(10, Math.round(size * 0.36));
  return <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
    {svg}
    <span role="img" aria-label="Primary bot" title="Primary bot" data-testid="primary-badge" className="absolute -bottom-0.5 -right-0.5 grid place-items-center rounded-full bg-brand text-primary-foreground ring-2 ring-background" style={{ width: badge, height: badge }}>
      <svg aria-hidden viewBox="0 0 24 24" width={badge * 0.62} height={badge * 0.62} fill="currentColor"><path d="M12 2.8l2.7 5.9 6.4.7-4.8 4.3 1.4 6.3L12 16.7 6.3 20l1.4-6.3L2.9 9.4l6.4-.7z" /></svg>
    </span>
  </span>;
}
