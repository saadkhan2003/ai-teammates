"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MotionAvatar } from "@/components/avatar-motion/motion-avatar";
import { resolveAvatarAppearance } from "@/lib/avatar-motion";
import { subscribeAvatarPreview } from "@/lib/avatar-preview";

export function HeroAvatar({
  botId,
  name,
  shape,
  color,
  size = 48,
  preview,
}: {
  botId?: string;
  name: string;
  shape?: string;
  color?: string;
  size?: number;
  preview?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [place, setPlace] = useState({ left: -9999, top: 0 });
  const [busPreview, setBusPreview] = useState("");
  const fill = resolveAvatarAppearance(shape, color, botId).fill;
  const shown = (preview ?? busPreview).trim();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (preview !== undefined || !botId) return undefined;
    return subscribeAvatarPreview(botId, setBusPreview);
  }, [botId, preview]);

  function show() {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) setPlace({ left: rect.right + 10, top: rect.top + rect.height / 2 });
    setOpen(true);
  }

  const card = (
    <div
      data-testid="avatar-hover-card"
      data-open={open ? "true" : "false"}
      aria-hidden={open ? undefined : true}
      className="avatar-hover-card"
      style={{ left: place.left, top: place.top, opacity: open ? 1 : 0 }}
    >
      <p data-testid="avatar-hover-name" className="avatar-hover-name">{name}</p>
      <p data-testid="avatar-hover-preview" className="avatar-hover-preview">{shown || "No messages yet"}</p>
    </div>
  );

  return (
    <div
      ref={rootRef}
      data-testid="avatar-hero"
      className="avatar-hero"
      style={{ ["--avatar-fill" as string]: fill }}
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
      onFocus={show}
      onBlur={() => setOpen(false)}
    >
      <span data-testid="avatar-hero-tint" className="avatar-hero-tint" />
      <MotionAvatar slot="hero" variant="live" botId={botId} shape={shape} color={color} size={size} label={name} hidden />
      {mounted ? createPortal(card, document.body) : null}
    </div>
  );
}
