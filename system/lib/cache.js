'use strict';

// Minimal in-memory cache with the interface Baileys expects for
// `msgRetryCounterCache` / `userDevicesCache` (get / set / del / flushAll).
//
// The reference bot uses the `node-cache` package for this; the same behaviour
// is provided here without adding a dependency.

class MemoryCache {
  constructor({ stdTtlMs = 0, maxEntries = 500 } = {}) {
    this.stdTtlMs = stdTtlMs;
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  #evictIfNeeded() {
    if (this.store.size <= this.maxEntries) return;
    const overflow = this.store.size - this.maxEntries;
    let removed = 0;
    for (const key of this.store.keys()) {
      if (removed >= overflow) break;
      this.store.delete(key);
      removed += 1;
    }
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key, value, ttlMs = this.stdTtlMs) {
    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
    this.store.delete(key);
    this.store.set(key, { value, expiresAt });
    this.#evictIfNeeded();
    return true;
  }

  del(key) {
    return this.store.delete(key);
  }

  flushAll() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}

module.exports = { MemoryCache };
