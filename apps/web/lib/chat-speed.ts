/** Per-tab cache. Values never leave this browser context. */
export class Lru<K, V> {
  private values = new Map<K, V>();
  constructor(private capacity = 10) {}
  get(key: K): V | undefined {
    const value = this.values.get(key);
    if (value !== undefined) { this.values.delete(key); this.values.set(key, value); }
    return value;
  }
  set(key: K, value: V) {
    this.values.delete(key); this.values.set(key, value);
    while (this.values.size > this.capacity) this.values.delete(this.values.keys().next().value!);
  }
  clear() { this.values.clear(); }
}
export function mergeOptimistic<T extends { id: string; clientId?: string | null }>(stored: T[], pending: T[]): T[] {
  const ids = new Set(stored.flatMap(m => [m.id, m.clientId].filter(Boolean)));
  return [...stored, ...pending.filter(m => !ids.has(m.clientId ?? m.id))];
}
