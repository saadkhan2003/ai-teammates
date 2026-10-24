"use client";

import { useEffect } from "react";
import { startAvatarClock } from "@/components/avatar-motion/clock";
import "@/components/avatar-motion/avatar-motion.css";

export function AvatarClock() {
  useEffect(() => startAvatarClock(), []);
  return null;
}
