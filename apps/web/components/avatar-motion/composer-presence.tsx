"use client";

import { MotionAvatar } from "@/components/avatar-motion/motion-avatar";

export const WORKING_STATUS = "Getting it done";

export function ComposerPresence({
  botId,
  name,
  shape,
  color,
  status,
  size = 20,
}: {
  botId?: string;
  name: string;
  shape?: string;
  color?: string;
  status?: string | null;
  size?: number;
}) {
  return (
    <div data-testid="composer-presence" className="avatar-composer-presence">
      <MotionAvatar slot="composer" variant="live" botId={botId} shape={shape} color={color} size={size} label={name} />
      {status ? (
        <p key={status} data-testid="avatar-status" role="status" aria-label={`${name} is working`} className="avatar-status-line">
          <span data-testid="avatar-status-shimmer" className="avatar-status-shimmer">{status}</span>
        </p>
      ) : null}
    </div>
  );
}
