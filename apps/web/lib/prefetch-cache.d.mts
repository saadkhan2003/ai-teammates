export function get<T>(key: string, now?: number): T | undefined;
export function put<T>(key: string, value: T, ttlMs?: number, now?: number): void;
