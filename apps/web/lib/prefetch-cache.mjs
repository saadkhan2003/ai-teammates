const entries = new Map();
const DEFAULT_TTL_MS = 30_000;
const MAX_ENTRIES = 64;

/** Read a still-fresh prefetched value. Expired entries are removed on access. */
export function get(key, now = Date.now()) {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    entries.delete(key);
    return undefined;
  }
  return entry.value;
}

/** Store a value for a short time so the destination view can reuse its warm data. */
export function put(key, value, ttlMs = DEFAULT_TTL_MS, now = Date.now()) {
  if (!key || ttlMs <= 0) {
    entries.delete(key);
    return;
  }
  entries.delete(key);
  while (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  entries.set(key, { value, expiresAt: now + ttlMs });
}
