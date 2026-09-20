'use strict';

// ════════════════════════════════════════════════════════════════════════════
//  HIDDEN VIDEO ENGINE — production fallback media execution engine
//  (!hvideo / !hv / !hvid — the hidden category, advertised through !h)
//
//  Production guarantees (the three pillars of the live deployment):
//
//   1. MEMORY LEAK PROTECTION — interactive selection sessions auto-expire
//      (hiddenVideo.sessionTimeoutMs), are swept on a background interval and
//      hard-capped with oldest-first eviction, so abandoned search lists can
//      never fill server RAM.
//
//   2. ROBUST ERROR HANDLING — oversized streams are detected with a HEAD
//      probe BEFORE Baileys buffers them; the user gets an alert with the
//      direct URL instead of a crashed bot. Every network, parse and delivery
//      failure degrades to a reply, never to a process crash.
//
//   3. PLATFORM-AGNOSTIC EXTRACTION — extractVideoUrl() drills through any
//      irregular or deeply nested vendor JSON (bounded depth + cycle guard,
//      own properties only) and securely pulls out titles and stream links.
// ════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const { config } = require('../system/config');

// ---------------------------------------------------------------------------
// Interactive selection sessions.
//
// Keyed by chat+sender so the same user never mixes selection lists between
// two chats. The Map is bounded three ways:
//   * lazy expiry on every access (takeSession),
//   * a 30s background sweep for users who never come back,
//   * a hard cap with oldest-first eviction as a last resort.
// ---------------------------------------------------------------------------

const sessions = new Map();
const MAX_SESSIONS = 5000;
const SWEEP_INTERVAL_MS = 30000;

function sessionKey(context) {
  return `${context.chatId}|${context.sender}`;
}

function sweepExpiredSessions(now = Date.now()) {
  const timeoutMs = config.hiddenVideo.sessionTimeoutMs;
  for (const [key, session] of sessions) {
    if (now - session.timestamp > timeoutMs) sessions.delete(key);
  }
}

// The sweeper must never keep the process alive on shutdown.
const sessionSweeper = setInterval(sweepExpiredSessions, SWEEP_INTERVAL_MS);
sessionSweeper.unref?.();

function storeSession(context, results) {
  if (sessions.size >= MAX_SESSIONS) {
    // Map iterates in insertion order, so the first key is the oldest.
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  sessions.set(sessionKey(context), { results, timestamp: Date.now() });
}

// Returns undefined (no session), { expired: true } or the live session.
function takeSession(context) {
  const key = sessionKey(context);
  const session = sessions.get(key);
  if (!session) return undefined;
  if (Date.now() - session.timestamp > config.hiddenVideo.sessionTimeoutMs) {
    sessions.delete(key);
    return { expired: true };
  }
  return session;
}

function dropSession(context) {
  sessions.delete(sessionKey(context));
}

// ---------------------------------------------------------------------------
// Universal structural parser (the fallback drill).
//
// Untrusted alternative vendors answer with wildly irregular JSON, so no fixed
// path (data.result.url) is ever relied on. The drill walks every own
// property of every layer with two safety rails against hostile payloads:
// a recursion depth limit and a cycle guard.
// ---------------------------------------------------------------------------

const MAX_PARSE_DEPTH = 10;
// Keys whose string values are treated as media-link candidates.
const LINK_KEY_HINTS = ['url', 'link', 'video', 'result', 'download', 'mp4', 'stream', 'source', 'src', 'file'];
// Markers a bare string URL must carry to count as a video stream.
const LINK_VALUE_HINTS = ['.mp4', 'video', 'stream', 'download'];
// Container keys that may hold a list of result items.
const LIST_CONTAINER_HINTS = ['result', 'results', 'data', 'videos', 'items', 'list'];

function isHttpUrl(value) {
  return typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'));
}

function looksLikeVideoLink(value) {
  const lower = value.toLowerCase();
  return LINK_VALUE_HINTS.some((hint) => lower.includes(hint));
}

function extractVideoUrl(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || depth > MAX_PARSE_DEPTH) return null;
  if (typeof value === 'string') {
    return isHttpUrl(value) && looksLikeVideoLink(value) ? value : null;
  }
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null; // cyclic vendor payload — never loop forever
  seen.add(value);

  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);

  // Pass 1: direct string candidates under link-flavoured keys (shallow wins).
  for (const [key, entry] of entries) {
    if (typeof entry === 'string' && isHttpUrl(entry)) {
      const lowerKey = key.toLowerCase();
      if (LINK_KEY_HINTS.some((hint) => lowerKey.includes(hint))) return entry;
    }
  }
  // Pass 2: bare video-looking string values anywhere on this layer.
  for (const [, entry] of entries) {
    if (typeof entry === 'string' && isHttpUrl(entry) && looksLikeVideoLink(entry)) return entry;
  }
  // Pass 3: drill into nested structures.
  for (const [, entry] of entries) {
    if (entry && typeof entry === 'object') {
      const found = extractVideoUrl(entry, depth + 1, seen);
      if (found) return found;
    }
  }
  return null;
}

function listItems(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of LIST_CONTAINER_HINTS) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return null;
}

// Vendor titles arrive as numbers, objects or missing entirely; the menu must
// never leak "undefined"/"[object Object]" into a chat message.
function safeTitle(item, fallback) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    for (const key of ['title', 'name', 'heading']) {
      const value = item[key];
      if (typeof value === 'string' && value.trim()) {
        return value.replace(/\s+/g, ' ').trim().slice(0, 120);
      }
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Delivery pipeline.
// ---------------------------------------------------------------------------

const REQUEST_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*'
});
// Vendor JSON payloads are metadata, never media: cap them so a hostile or
// misconfigured endpoint cannot flood the bot's RAM while parsing.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const HEAD_TIMEOUT_MS = 4000;

async function reply(socket, context, text) {
  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

async function deliverSelection(socket, context, chosen, choiceLabel) {
  await reply(socket, context, `📥 *Processing choice [${choiceLabel}]:* _${chosen.title}_\nDownloading stream directly to WhatsApp...`);

  // Re-extract through the drill at delivery time so a cached entry can never
  // smuggle a non-http payload into Baileys.
  const streamUrl = extractVideoUrl(chosen.url) || (isHttpUrl(chosen.url) ? chosen.url : null);
  if (!streamUrl) {
    await reply(socket, context, '❌ A valid video stream could not be safely resolved from the cached result. Please search again.');
    return;
  }

  // Network size verification BEFORE Baileys buffers anything.
  let sizeMb = null;
  let contentType = '';
  try {
    const head = await axios.head(streamUrl, { timeout: HEAD_TIMEOUT_MS, headers: REQUEST_HEADERS });
    const declared = Number(head?.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > 0) sizeMb = declared / (1024 * 1024);
    contentType = String(head?.headers?.['content-type'] || '').toLowerCase();
  } catch {
    // HEAD unsupported or blocked — fall through to direct delivery; the
    // delivery itself is still wrapped below.
  }

  if (sizeMb !== null && sizeMb > config.hiddenVideo.maxDownloadSizeMb) {
    await reply(socket, context, `⚠️ Video size (*${sizeMb.toFixed(1)}MB*) exceeds the ${config.hiddenVideo.maxDownloadSizeMb}MB live hosting limit.\nDirect URL:\n${streamUrl}`);
    return;
  }
  if (contentType.startsWith('text/html')) {
    await reply(socket, context, `⚠️ The stream resolved to a web page instead of a media file.\nDirect URL:\n${streamUrl}`);
    return;
  }

  try {
    await socket.sendMessage(context.chatId, {
      video: { url: streamUrl },
      caption: `✅ *Title:* ${chosen.title}\n🔒 *Category:* Hidden (!h)\n⚡ *Engine:* Active Buffer Stream`
    }, { quoted: context.raw });
  } catch (deliveryError) {
    console.warn('[hvideo] delivery failed:', deliveryError?.message || deliveryError);
    await reply(socket, context, `⚠️ Delivery failed while buffering the stream. Raw link:\n${streamUrl}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Command entry points.
// ---------------------------------------------------------------------------

async function handleHvideoCommand(socket, context, command) {
  const settings = config.hiddenVideo;
  const inputQuery = String(command?.text || '').trim();

  if (!settings.enabled) {
    await reply(socket, context, '⛔ The hidden video engine is disabled in the server configuration.');
    return;
  }

  // --- STAGE 1: interactive user choice handling ("!hvideo 2") --------------
  if (inputQuery && /^\d+$/.test(inputQuery)) {
    const session = takeSession(context);
    if (session?.expired) {
      await reply(socket, context, '⏰ Your search session expired due to inactivity. Please search again.');
      return;
    }
    if (session) {
      const selectedIndex = Number.parseInt(inputQuery, 10) - 1;
      if (selectedIndex < 0 || selectedIndex >= session.results.length) {
        await reply(socket, context, `❌ Invalid choice. Reply with a number between 1 and ${session.results.length}.`);
        return;
      }
      const chosen = session.results[selectedIndex];
      // Clear immediately: no double deliveries, no race conditions.
      dropSession(context);
      await deliverSelection(socket, context, chosen, inputQuery);
      return;
    }
    // No active session: the number is treated as a normal search query.
  }

  if (!inputQuery) {
    await reply(socket, context, [
      '❌ *Usage Matrix:*',
      `1. Keyword mode: \`!hvideo ${settings.apis[0]?.name || 'nexsus'}\` (target one node directly)`,
      '2. Engine search: `!hvideo <search query>`',
      'After a result list appears, reply with the option number to download.'
    ].join('\n'));
    return;
  }

  // --- STAGE 2: explicit keyword routing -------------------------------------
  const firstWord = inputQuery.split(/\s+/)[0].toLowerCase();
  const keywordApi = settings.apis.find((api) => api.name === firstWord);
  const targetApis = keywordApi ? [keywordApi] : settings.apis;
  const searchString = keywordApi ? inputQuery.slice(firstWord.length).trim() : inputQuery;

  if (!targetApis.length) {
    await reply(socket, context, '❌ No video platforms are configured (`hiddenVideo.apis` is empty).');
    return;
  }

  await reply(socket, context, '🛸 *Accessing secure network clusters... scanning alternative active platforms.* 🔄');

  // --- STAGE 3: fault-tolerant network routing -------------------------------
  const aggregated = [];
  for (const api of targetApis) {
    // Generic searches never query flat/direct-only vendors.
    if (!keywordApi && searchString && !api.supportSearch) continue;
    try {
      let endpoint = api.url;
      if (searchString) {
        const separator = endpoint.includes('?') ? '&' : '?';
        endpoint = `${endpoint}${separator}${keywordApi ? 'query' : 'search'}=${encodeURIComponent(searchString)}`;
      }
      const response = await axios.get(endpoint, {
        timeout: settings.requestTimeoutMs,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_RESPONSE_BYTES,
        headers: REQUEST_HEADERS
      });
      const data = response?.data;
      if (!data) continue;

      const items = listItems(data);
      if (items) {
        for (const item of items) {
          const link = extractVideoUrl(item);
          if (link) {
            aggregated.push({ title: safeTitle(item, `Selection ${aggregated.length + 1}`), url: link });
          }
          if (aggregated.length >= settings.maxResults) break; // anti-spam cap
        }
        if (aggregated.length) break; // first successful node wins
      } else {
        // Flat payload: direct layer bypass.
        const directUrl = extractVideoUrl(data);
        if (directUrl) {
          await socket.sendMessage(context.chatId, {
            video: { url: directUrl },
            caption: '🎥 *Status:* Direct Layer Bypass Connected.'
          }, { quoted: context.raw });
          return;
        }
      }
    } catch (networkError) {
      console.warn(`[hvideo] failover at node [${api.name}]: ${networkError?.message || networkError}`);
    }
  }

  // --- STAGE 4: selection menu renderer --------------------------------------
  if (aggregated.length) {
    storeSession(context, aggregated);
    const lines = aggregated.map((video, index) => `*${index + 1}.* ${video.title}`);
    await reply(socket, context, `🔍 *Search results managed successfully:*\n\n${lines.join('\n')}\n\n🔢 *Reply with just the option number* to download it to your device. (List expires in ${Math.round(settings.sessionTimeoutMs / 60000)} minutes.)`);
    return;
  }

  await reply(socket, context, '☣️ *All secure layers exhausted.* The video could not be fetched from any active node. Verify the query or the API status.');
}

// Bare numeric replies (no prefix) belong to an active !hvideo selection list
// before anything else may interpret them. Returns true when the reply was
// consumed so the caller stops processing.
async function handleHvideoSelectionReply(socket, context) {
  const text = String(context?.text || '').trim();
  if (!config.hiddenVideo.enabled || !/^\d{1,2}$/.test(text)) return false;
  const session = takeSession(context);
  if (!session) return false; // no active list — leave the reply to other handlers
  if (session.expired) {
    await reply(socket, context, '⏰ Your search session expired due to inactivity. Please search again.');
    return true;
  }
  const selectedIndex = Number.parseInt(text, 10) - 1;
  if (selectedIndex < 0 || selectedIndex >= session.results.length) {
    await reply(socket, context, `❌ Invalid choice. Reply with a number between 1 and ${session.results.length}.`);
    return true;
  }
  const chosen = session.results[selectedIndex];
  dropSession(context);
  await deliverSelection(socket, context, chosen, text);
  return true;
}

module.exports = {
  handleHvideoCommand,
  handleHvideoSelectionReply,
  extractVideoUrl,
  // Inspection/test hooks.
  _sessions: sessions,
  _sweepExpiredSessions: sweepExpiredSessions
};
