'use strict';

// ---------------------------------------------------------------------------
// BOUNDED MESSAGE DEDUPLICATION (anti duplicate-reply / anti-spam safety)
//
// WhatsApp (and Baileys on reconnect) can deliver the SAME message more than
// once. Without deduplication every duplicate event becomes a duplicate reply,
// a duplicate download and a duplicate provider request — exactly the kind of
// traffic that makes an account look like a spammer.
//
// This cache is deliberately bounded and memory-conscious: at most MAX_ENTRIES
// message IDs, each expiring after TTL_MS. Insertion order doubles as LRU
// order, so the oldest entries are evicted first. One cache per socket, keyed
// through a WeakMap, so sockets that go away take their state with them.
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 2000;
const TTL_MS = 10 * 60 * 1000;

const caches = new WeakMap();

function cacheFor(socket) {
  let cache = caches.get(socket);
  if (!cache) {
    cache = new Map();
    caches.set(socket, cache);
  }
  return cache;
}

function sweep(cache, now) {
  for (const [key, seenAt] of cache) {
    if (now - seenAt <= TTL_MS) break; // insertion order: first fresh entry stops the sweep
    cache.delete(key);
  }
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

// Returns true when this message was already processed (and must be ignored).
// Chat id + message id: the same id in a different chat is a different message.
function isDuplicate(socket, chatId, messageId) {
  if (!messageId) return false; // no id: nothing reliable to deduplicate on
  const cache = cacheFor(socket);
  const now = Date.now();
  sweep(cache, now);
  const key = `${chatId || ''}:${messageId}`;
  if (cache.has(key)) {
    // Refresh recency so an actively re-delivered id is not evicted mid-storm.
    cache.set(key, now);
    return true;
  }
  cache.set(key, now);
  // Enforce the cap AFTER the insert too, so the cache never exceeds it.
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return false;
}

function size(socket) {
  return socket ? (caches.get(socket)?.size || 0) : 0;
}

function clear(socket) {
  if (socket) caches.delete(socket);
}

module.exports = { isDuplicate, size, clear, MAX_ENTRIES, TTL_MS };
