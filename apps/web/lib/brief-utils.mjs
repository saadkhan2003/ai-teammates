export function formatThought(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  if (!minutes) return `Thought ${total}s`;
  return `Thought ${minutes}m${remainder ? ` ${remainder}s` : ""}`;
}
