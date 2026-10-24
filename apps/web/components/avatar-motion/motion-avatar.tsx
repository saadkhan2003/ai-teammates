"use client";

import { useEffect, useRef } from "react";
import { observeAvatarLook } from "@/components/avatar-motion/look";
import { resolveAvatarAppearance } from "@/lib/avatar-motion";

export function MotionAvatar({
  slot,
  variant,
  shape,
  color,
  botId,
  size = 40,
  label,
  hidden = false,
}: {
  slot: string;
  variant: "live" | "row";
  shape?: string;
  color?: string;
  botId?: string;
  size?: number;
  label?: string;
  hidden?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const live = variant === "live";
  const appearance = resolveAvatarAppearance(shape, color, botId);

  useEffect(() => {
    const node = rootRef.current;
    if (!live || !node) return undefined;
    return observeAvatarLook(node);
  }, [live]);

  const eyes = (
    <svg viewBox="0 0 100 100" aria-hidden>
      <ellipse cx="39" cy="47" rx="5.5" ry="9" fill="#171717" transform="rotate(-14 39 47)" />
      <ellipse cx="62" cy="47" rx="5.5" ry="9" fill="#171717" transform="rotate(-14 62 47)" />
    </svg>
  );

  return (
    <div
      ref={rootRef}
      data-testid={`motion-avatar-${slot}`}
      data-avatar-slot={slot}
      data-avatar-variant={variant}
      data-avatar-shape={appearance.shapeId}
      role={hidden ? undefined : "img"}
      aria-hidden={hidden || undefined}
      aria-label={hidden ? undefined : `${label || "Bot"} avatar`}
      className={live ? "avatar-motion avatar-motion-live" : "avatar-motion"}
      style={{ width: size, height: size, ["--avatar-unit" as string]: `${size / 100}px`, ["--avatar-fill" as string]: appearance.fill }}
    >
      {live ? (
        <>
          <div className="avatar-motion-spin" data-avatar-part="spin">
            <div className="avatar-motion-breathe" data-avatar-part="breathe">
              <svg viewBox="0 0 100 100" aria-hidden>
                <path className="avatar-shape" d={appearance.path} fill={appearance.fill} />
              </svg>
            </div>
          </div>
          <div className="avatar-motion-eyes" data-avatar-part="eyes">
            {eyes}
          </div>
        </>
      ) : (
        <div className="avatar-row-scaler" data-avatar-part="row">
          <svg viewBox="0 0 100 100" aria-hidden>
            <path className="avatar-shape" d={appearance.path} fill={appearance.fill} />
            <path className="avatar-shape-alt" d={appearance.altPath} fill={appearance.fill} />
          </svg>
          <div className="avatar-eyes-static">{eyes}</div>
        </div>
      )}
    </div>
  );
}
