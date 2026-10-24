"use client";

import { useEffect, useState } from "react";
import { BOT_AVATARS, defaultBotAvatar } from "@/lib/avatars";

export type BotLook = { shape: string; color: string };

const published = new Map<string, BotLook>();
const listeners = new Set<() => void>();

export function resolveBotAppearance(id: string, shape?: string, color?: string): BotLook {
  const fallback = defaultBotAvatar(id || "bot");
  const known = BOT_AVATARS.some((item) => item.id === shape);
  const valid = /^#[0-9a-fA-F]{6}$/.test(color ?? "");
  return { shape: known && shape ? shape : fallback.shape, color: valid ? (color as string) : fallback.color };
}

export function publishBotAppearance(id: string, shape?: string, color?: string) {
  if (!id) return;
  const next = resolveBotAppearance(id, shape, color);
  const prev = published.get(id);
  if (prev && prev.shape === next.shape && prev.color === next.color) return;
  published.set(id, next);
  listeners.forEach((listener) => listener());
}

export function useBotAppearance(id: string, shape?: string, color?: string): BotLook {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return published.get(id) ?? resolveBotAppearance(id, shape, color);
}
