/**
 * De-duplicates write requests that carry an Idempotency-Key header.
 *
 * Entries expire after a TTL so that a key can eventually be reused, and the
 * cache is capped so a hostile client cannot exhaust memory.
 */

export interface CacheEntry<T> {
  key: string;
  value: T;
  storedAt: number;
}

export class IdempotencyCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly maxEntries = 10_000,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      this.evictOldest();
    }
    this.entries.set(key, { key, value, storedAt: now });
  }

  /**
   * Runs `compute` only if the key has not been seen, otherwise returns the
   * stored result.
   */
  async once(key: string, compute: () => Promise<T>, now = Date.now()): Promise<T> {
    const existing = this.get(key, now);
    if (existing !== undefined) return existing;
    const value = await compute();
    this.set(key, value, now);
    return value;
  }

  purgeExpired(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now - entry.storedAt > this.ttlMs) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.storedAt < oldestAt) {
        oldestAt = entry.storedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }
}
