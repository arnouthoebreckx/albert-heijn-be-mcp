/** Entries kept at most; the oldest are evicted first. */
const MAX_ENTRIES = 1000;

/** In-memory cache with a fixed TTL. */
export class TtlCache<V> {
  readonly #ttlMs: number;
  /** Insertion order is expiry order: every entry has the same TTL and set() re-inserts. */
  readonly #entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  /** undefined if missing or expired; use has() to detect a cached undefined. */
  get(key: string): V | undefined {
    return this.has(key) ? this.#entries.get(key)?.value : undefined;
  }

  has(key: string): boolean {
    const e = this.#entries.get(key);
    if (!e) return false;
    if (Date.now() > e.expiresAt) {
      this.#entries.delete(key);
      return false;
    }
    return true;
  }

  set(key: string, value: V): void {
    const now = Date.now();
    this.#entries.delete(key);
    for (const [k, e] of this.#entries) {
      if (now <= e.expiresAt && this.#entries.size < MAX_ENTRIES) break;
      this.#entries.delete(k);
    }
    this.#entries.set(key, { value, expiresAt: now + this.#ttlMs });
  }

  /** The cached value, or load()'s result, which is then cached. */
  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    if (this.has(key)) return this.get(key) as V;
    const value = await load();
    this.set(key, value);
    return value;
  }
}
