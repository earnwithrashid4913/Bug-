'use strict';
// Source safeSend API, isolated by socket as AnimeMD can run several accounts.
const timestamps = new Map();
const sockets = new WeakMap();
let nextId = 0;
const MIN_DELAY = 2000;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function keyFor(socket, jid) {
  if (!sockets.has(socket)) sockets.set(socket, ++nextId);
  return `${sockets.get(socket)}:${jid}`;
}
async function safeSend(socket, jid, message, options = {}) {
  if (!socket || typeof socket.sendMessage !== 'function' || !jid) return null;
  const key = keyFor(socket, jid);
  const elapsed = Date.now() - (timestamps.get(key) || 0);
  if (elapsed < MIN_DELAY) await wait(MIN_DELAY - elapsed);
  try {
    const result = await socket.sendMessage(jid, message, options);
    timestamps.set(key, Date.now());
    return result;
  } catch (error) {
    if (/rate-overlimit|too many requests/i.test(error.message || '')) {
      await wait(10000);
      try {
        const result = await socket.sendMessage(jid, message, options);
        timestamps.set(key, Date.now());
        return result;
      } catch (retryError) { console.warn('[safeSend retry]', retryError.message); }
    } else if (!/not connected|closed|connection/i.test(error.message || '') && error.code !== 'ECONNRESET') console.warn('[safeSend]', error.message);
    return null;
  }
}
async function safeReact(socket, jid, msg, emoji) {
  if (!msg?.key) return false;
  return Boolean(await safeSend(socket, jid, { react: { text: emoji, key: msg.key } }));
}
async function safePresence(socket, jid, type) {
  if (!socket?.sendPresenceUpdate || !jid || !['composing', 'recording', 'paused'].includes(type)) return false;
  try { await socket.sendPresenceUpdate(type, jid); return true; }
  catch (error) { if (!/not connected|closed|connection|rate-overlimit|too many requests/i.test(error.message || '')) console.warn('[safePresence]', error.message); return false; }
}
function cleanupTimestamps() { for (const [key, time] of timestamps) if (Date.now() - time > 60000) timestamps.delete(key); }
let cleanupInterval;
function startCleanup() { stopCleanup(); cleanupInterval = setInterval(cleanupTimestamps, 60000); cleanupInterval.unref(); }
function stopCleanup() { clearInterval(cleanupInterval); cleanupInterval = null; }
function getRateLimitStats() { return { activeChats: timestamps.size, minDelay: MIN_DELAY, lastCleanup: Date.now() }; }
function resetChatTimestamps(jid) {
  for (const key of timestamps.keys()) if (!jid || key.endsWith(`:${jid}`)) timestamps.delete(key);
}
startCleanup();
module.exports = { safeSend, safeReact, safePresence, cleanupTimestamps, startCleanup, stopCleanup, getRateLimitStats, resetChatTimestamps };
