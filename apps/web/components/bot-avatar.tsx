"use client";

import { useId, useEffect, useRef } from "react";
import { Star } from "lucide-react";
import { AvatarEyes, ContactShadow, GlossyBlob } from "@/components/avatar-motion/glossy-blob";
import { lobePath, subscribeAvatar, resolveAvatarAppearance, type AvatarFrame } from "@/lib/avatar-motion";

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
  const uid = useId().replace(/:/g, "");
  const appearance = resolveAvatarAppearance(shape, color, botId);
  const body = useRef<SVGGElement>(null);
  const blob = useRef<SVGGElement>(null);
  const eyes = useRef<SVGGElement>(null);
  useEffect(() => {
    if (!animated) return;
    return subscribeAvatar(frame => {
      body.current?.setAttribute("transform", `translate(${50 + frame.tx} 50) rotate(${frame.rot}) scale(${frame.sx} ${frame.sy}) translate(-50 -50)`);
      if (appearance.shapeId === "blob1") for (const path of blob.current?.querySelectorAll("path") ?? []) path.setAttribute("d", lobePath(frame.lobeAmp, frame.lobePhase));
      for (const ellipse of eyes.current?.querySelectorAll("ellipse") ?? []) {
        const cx = Number(ellipse.getAttribute("cx")), cy = Number(ellipse.getAttribute("cy"));
        ellipse.setAttribute("rx", String(frame.eye.w / 2)); ellipse.setAttribute("ry", String(frame.eye.h / 2));
        ellipse.setAttribute("transform", `translate(${frame.eye.dx} ${frame.eye.dy}) rotate(${frame.eye.rot} ${cx} ${cy})`);
      }
    });
  }, [animated, appearance.shapeId]);
  const svg = (
    <svg data-testid="bot-avatar" data-bot-id={botId || undefined} data-avatar-fill={appearance.fill} data-avatar-gloss="3d" data-animated={animated ? "true" : undefined} className={className} width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Bot avatar">
      <ContactShadow idPrefix={uid} />
      <g ref={body}>
      <g ref={blob}><GlossyBlob idPrefix={uid} path={appearance.path} fill={appearance.fill} /></g>
      <g ref={eyes}><AvatarEyes /></g>
      </g>
    </svg>
  );
  if (!primary) return svg;
  return <span className="relative inline-flex shrink-0">{svg}<span data-testid="primary-badge" role="img" aria-label="Primary bot" title="Primary bot" className="absolute bottom-0 right-0 text-xs"><Star aria-hidden className="h-3 w-3 fill-current" /></span></span>;
}
