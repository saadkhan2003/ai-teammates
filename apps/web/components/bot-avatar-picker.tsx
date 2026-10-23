"use client";

import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { BOT_AVATARS, BOT_COLORS } from "@/lib/avatars";

export function BotAvatarPicker({ shape, color, botId, onChange }: {
  shape: string; color: string; botId?: string; onChange: (shape: string, color: string) => void;
}) {
  return <div className="grid justify-items-center gap-4" data-testid="avatar-picker">
    <div data-testid="avatar-preview" className="grid h-24 w-24 place-items-center"><BotAvatar shape={shape} color={color} botId={botId} size={88} /></div>
    <div className="grid grid-cols-5 gap-2" role="group" aria-label="Avatar shape">
      {BOT_AVATARS.map(item => <Button key={item.id} type="button" variant="ghost" data-testid={`avatar-shape-${item.id}`} aria-label={`Shape ${item.id}`} aria-pressed={shape === item.id} className={`h-12 w-12 rounded-md p-1 ${shape === item.id ? "ring-2 ring-foreground" : ""}`} onClick={() => onChange(item.id, color)}><BotAvatar shape={item.id} color={color} size={38} /></Button>)}
    </div>
    <div className="flex max-w-[340px] flex-wrap justify-center gap-2" role="group" aria-label="Avatar colour">
      {BOT_COLORS.map(item => <Button key={item.hex} type="button" variant="ghost" data-testid={`avatar-color-${item.name.toLowerCase()}`} aria-label={`${item.name} colour`} aria-pressed={color.toLowerCase() === item.hex.toLowerCase()} className={`h-8 w-8 rounded-md p-0 ${color.toLowerCase() === item.hex.toLowerCase() ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : ""}`} onClick={() => onChange(shape, item.hex)}><span className="h-6 w-6 rounded-full border border-black/10" style={{ backgroundColor: item.hex }} /></Button>)}
    </div>
  </div>;
}
