import { LOBE_STATIC_PATH } from "@/lib/avatar-shapes";

export const BOT_AVATARS = [
  { id: "blob1", path: LOBE_STATIC_PATH, morph: true },
  { id: "blob2", path: "M48 6C68 3 91 21 91 45c0 19-15 43-36 47C33 96 8 78 8 55 8 34 24 10 48 6Z" },
  { id: "blob3", path: "M24 12Q50 2 76 12L88 24Q98 50 88 76L76 88Q50 98 24 88L12 76Q2 50 12 24Z" },
  { id: "blob4", path: "M50 3C61 3 65 23 73 29c8 7 27 7 27 21s-19 14-27 21c-8 6-12 26-23 26S35 77 27 71C19 64 0 64 0 50s19-14 27-21C35 23 39 3 50 3Z" },
  { id: "blob5", path: "M50 5C66 5 78 17 89 31c10 13 8 34-5 48-12 13-31 18-48 12C17 85 5 67 5 49 5 27 27 5 50 5Z" },
  { id: "blob6", path: "M14 22C25 7 48 8 58 10c13 2 35 13 36 31 2 16-8 38-25 47-16 9-39 3-53-9C2 65 2 38 14 22Z" },
  { id: "blob7", path: "M50 4C70 4 95 28 91 53c-3 22-25 39-45 37C24 88 7 70 8 49 8 28 29 4 50 4Z" },
  { id: "blob8", path: "M50 3C61 3 67 18 73 26c7 9 23 11 24 24 1 13-13 20-22 27-8 7-12 20-25 20S31 84 22 77C12 70 1 62 3 49c2-12 17-16 25-25C35 16 39 3 50 3Z" },
  { id: "blob9", path: "M51 5C72 5 91 23 91 47c0 20-13 44-35 47C34 97 8 77 8 55 8 32 27 5 51 5Z" },
  { id: "blob10", path: "M17 13Q47 2 77 13Q94 20 90 49Q88 76 62 87Q32 98 12 76Q0 58 8 32Z" },
  { id: "blob11", path: "M50 4C68 4 77 18 91 35c12 14-2 34-13 47-11 13-26 18-43 9C18 83 4 68 6 49 8 30 28 4 50 4Z" },
  { id: "blob12", path: "M50 5C64 5 72 19 82 27c10 9 17 20 11 34-5 13-17 20-27 30-10 9-22 9-32 0C23 82 10 76 6 63 1 47 11 35 22 25 31 17 37 5 50 5Z" },
  { id: "blob13", path: "M50 4C61 4 63 19 73 25c10 7 24 4 28 17 4 12-8 21-15 31-7 10-10 23-23 24-13 1-19-11-29-18C23 72 8 67 7 54 6 41 20 35 29 26 37 18 38 4 50 4Z" },
  { id: "blob14", path: "M24 10Q50 0 76 10L90 27Q99 50 89 73L75 90Q50 100 25 90L10 74Q1 50 11 26Z" },
  { id: "blob15", path: "M50 4C70 4 94 22 92 44 90 64 67 95 47 94 28 93 7 70 8 50 9 29 29 4 50 4Z" },
] as { id: string; path: string; morph?: boolean }[];

export const BOT_COLORS = [
  { name: "White", hex: "#ffffff" }, { name: "Brown", hex: "#a66a38" }, { name: "Red", hex: "#ff3045" },
  { name: "Orange", hex: "#ff6a00" }, { name: "Amber", hex: "#f59e0b" }, { name: "Green", hex: "#10b981" },
  { name: "Teal", hex: "#14b8a6" }, { name: "Blue", hex: "#1687ff" }, { name: "Purple", hex: "#8b5cf6" },
  { name: "Pink", hex: "#ec2995" }, { name: "Grey", hex: "#858585" },
  { name: "Yellow", hex: "#facc15" }, { name: "Black", hex: "#111111" }, { name: "Indigo", hex: "#4f46e5" },
] as const;

export function defaultBotAvatar(id: string) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const index = (hash >>> 0) % (BOT_AVATARS.length * BOT_COLORS.length);
  return { shape: BOT_AVATARS[index % BOT_AVATARS.length].id, color: BOT_COLORS[Math.floor(index / BOT_AVATARS.length)].hex };
}
