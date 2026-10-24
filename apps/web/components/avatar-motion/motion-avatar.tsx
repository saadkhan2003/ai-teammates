"use client";

import { useEffect, useId, useRef } from "react";
import { AvatarEyes, ContactShadow, GlossyBlob } from "@/components/avatar-motion/glossy-blob";
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
  const uid = useId().replace(/:/g, "");
  const live = variant === "live";
  const appearance = resolveAvatarAppearance(shape, color, botId);

  useEffect(() => {
    const node = rootRef.current;
    if (!live || !node) return undefined;
    return observeAvatarLook(node);
  }, [live]);

  const eyes = (
    <svg viewBox="0 0 100 100" aria-hidden>
      <AvatarEyes />
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
      data-bot-id={botId || undefined}
      data-avatar-fill={appearance.fill}
      data-avatar-gloss="3d"
      style={{ width: size, height: size, ["--avatar-unit" as string]: `${size / 100}px`, ["--avatar-fill" as string]: appearance.fill }}
    >
      {live ? (
        <>
          <svg className="avatar-contact" viewBox="0 0 100 100" aria-hidden>
            <ContactShadow idPrefix={`${uid}-ground`} />
          </svg>
          <div className="avatar-motion-spin" data-avatar-part="spin">
            <div className="avatar-motion-breathe" data-avatar-part="breathe">
              <svg viewBox="0 0 100 100" aria-hidden>
                <GlossyBlob className="avatar-shape" idPrefix={`${uid}-a`} path={appearance.path} fill={appearance.fill} />
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
            <ContactShadow idPrefix={`${uid}-ground`} />
            <GlossyBlob className="avatar-shape" idPrefix={`${uid}-a`} path={appearance.path} fill={appearance.fill} />
            <GlossyBlob className="avatar-shape-alt" idPrefix={`${uid}-b`} path={appearance.altPath} fill={appearance.fill} />
          </svg>
          <div className="avatar-eyes-static">{eyes}</div>
        </div>
      )}
    </div>
  );
}
