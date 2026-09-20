'use strict';

// ════════════════════════════════════════════════════════════════════════════
//  HIDDEN VIDEO ENGINE — production, config-driven provider system
//  (!hvideo / !hv / !hvid — the hidden category, advertised through !h)
//
//  Flow: !hvideo <keyword> → keyword routing → configured provider(s) →
//  normalized results → selectable list (2-minute session) → numeric reply →
//  resolve + validate + download with live progress → WhatsApp media.
//
//  The whole engine is provider-driven from config.js (`hiddenVideo`):
//  adding a platform is a config edit, never a source-code change. No
//  provider URL, keyword list or JSON shape is hardcoded here.
//
//  Production guarantees (unchanged contract, extended):
//   1. MEMORY LEAK PROTECTION — selection sessions auto-expire
//      (hiddenVideo.sessionTimeoutMs), are swept on a background interval,
//      hard-capped with oldest-first eviction; downloads are bounded buffers
//      limited by hiddenVideo.maxDownloadBytes and per-user concurrency.
//   2. ROBUST ERROR HANDLING — oversized streams are refused BEFORE and
//      DURING download; every network, parse and delivery failure degrades to
//      a clean boxed reply, never a crash, never a stack trace, never a raw
//      URL when direct delivery is possible.
//   3. PLATFORM-AGNOSTIC EXTRACTION — bounded-depth, cycle-safe,
//      own-properties-only parsing, extended (never duplicated) by a
//      per-provider dot-path response mapping layer.
//   4. SECRET SAFETY — provider auth headers travel to the provider only;
//      they are never logged and never rendered into chat messages.
// ════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const { config } = require('../system/config');

function settings() {
  return config.hiddenVideo;
}

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
  const timeoutMs = settings().sessionTimeoutMs;
  for (const [key, session] of sessions) {
    if (now - session.timestamp > timeoutMs) sessions.delete(key);
  }
}

// The sweeper must never keep the process alive on shutdown.
const sessionSweeper = setInterval(sweepExpiredSessions, SWEEP_INTERVAL_MS);
sessionSweeper.unref?.();

function storeSession(context, results, query) {
  if (sessions.size >= MAX_SESSIONS) {
    // Map iterates in insertion order, so the first key is the oldest.
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  sessions.set(sessionKey(context), { results, query, timestamp: Date.now() });
}

// Returns undefined (no session), { expired: true, query } or the live session.
function takeSession(context) {
  const key = sessionKey(context);
  const session = sessions.get(key);
  if (!session) return undefined;
  if (Date.now() - session.timestamp > settings().sessionTimeoutMs) {
    sessions.delete(key);
    return { expired: true, query: session.query };
  }
  return session;
}

function dropSession(context) {
  sessions.delete(sessionKey(context));
}

// ---------------------------------------------------------------------------
// Concurrent download limiter (per chat+user).
// ---------------------------------------------------------------------------

const activeDownloads = new Map();

function acquireDownloadSlot(context) {
  const key = sessionKey(context);
  const limit = settings().maxConcurrentDownloads;
  const active = activeDownloads.get(key) || 0;
  if (active >= limit) return false;
  activeDownloads.set(key, active + 1);
  return true;
}

function releaseDownloadSlot(context) {
  const key = sessionKey(context);
  const active = (activeDownloads.get(key) || 0) - 1;
  if (active <= 0) activeDownloads.delete(key);
  else activeDownloads.set(key, active);
}

// ---------------------------------------------------------------------------
// Text safety + presentation.
// ---------------------------------------------------------------------------

const BOX_HEADER = { video: '𝐀𝐍𝐈𝐌𝐄 𝐌𝐃 • 𝐇𝐈𝐃𝐃𝐄𝐍 𝐕𝐈𝐃𝐄𝐎', download: '𝐀𝐍𝐈𝐌𝐄 𝐌𝐃 • 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃' };

function panel(kind, lines) {
  const header = `╭━━〔 ${BOX_HEADER[kind] || BOX_HEADER.video} 〕━━╮`;
  const body = lines.map((line) => `┃ ${line}`.trimEnd());
  return [header, ...body, '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯'].join('\n');
}

// Vendor text is untrusted: strip HTML-ish tags and control characters, keep
// WhatsApp markdown-safe plain text, capped so a list never balloons.
function sanitizeTitle(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function safeTitle(item, fallback) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    for (const key of ['title', 'name', 'heading']) {
      const cleaned = sanitizeTitle(item[key]);
      if (cleaned) return cleaned;
    }
  }
  return fallback;
}

// Provider-controlled names must never choose a filesystem path. Downloads
// are delivered from memory (never written to disk), and any outgoing file
// name is built from this fixed, traversal-proof slugger.
function safeFileName(title, extension = 'mp4') {
  const slug = sanitizeTitle(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video';
  const ext = String(extension).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'mp4';
  return `animemd-hidden-video-${slug}.${ext}`;
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

// Dot-path lookup for provider response mappings ("data.results"). Own
// properties only; the path itself bounds the walk, so no recursion exists.
function getByPath(value, path) {
  let current = value;
  for (const part of String(path || '').split('.').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function mappedValue(item, path) {
  if (!path) return undefined;
  const value = getByPath(item, path);
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

// ---------------------------------------------------------------------------
// Provider routing + response normalization.
// ---------------------------------------------------------------------------

function normalizeKeyword(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Route a normalized query to eligible providers:
//   1. exact keyword match (multi-provider allowed, results get deduplicated),
//   2. explicit provider id as the first word (query = the rest),
//   3. generic providers (empty keyword list) as the catch-all fallback.
function eligibleProviders(rawInput) {
  const input = normalizeKeyword(rawInput);
  const enabled = settings().providers.filter((provider) => provider.enabled);
  const byKeyword = enabled.filter((provider) => provider.keywords.includes(input));
  if (byKeyword.length) return { providers: byKeyword, query: input, mode: 'keyword' };
  const firstWord = input.split(' ')[0];
  const byId = enabled.find((provider) => provider.id === firstWord);
  if (byId) return { providers: [byId], query: input.slice(byId.id.length).trim(), mode: 'id' };
  const generic = enabled.filter((provider) => !provider.keywords.length);
  if (generic.length) return { providers: generic, query: input, mode: 'generic' };
  return { providers: [], query: input, mode: 'none' };
}

function appendSearchParam(baseUrl, param, value) {
  if (!value) return baseUrl;
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}${encodeURIComponent(param)}=${encodeURIComponent(value)}`;
}

const REQUEST_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*'
});

// Query one provider and normalize its payload into the internal result shape:
// { id, title, mediaUrl, thumbnail, duration, size, provider, sourceUrl }.
async function fetchProvider(provider, query) {
  const limits = settings();
  const options = {
    timeout: provider.timeoutMs,
    maxContentLength: limits.maxResponseBytes, // never let vendor JSON eat RAM
    maxBodyLength: limits.maxResponseBytes,
    // Provider headers may carry secrets: they go to the provider only and
    // are never logged or rendered anywhere user-visible.
    headers: { ...REQUEST_HEADERS, ...provider.headers }
  };
  const response = provider.method === 'POST'
    ? await axios.post(provider.url, { [provider.searchParam]: query }, options)
    : await axios.get(appendSearchParam(provider.url, provider.searchParam, query), options);
  const data = response?.data;
  if (!data) return [];
  return normalizeProviderResponse(provider, data);
}

function normalizeProviderResponse(provider, data) {
  const mapping = provider.response || {};
  let items = null;
  if (mapping.resultsPath) {
    const at = getByPath(data, mapping.resultsPath);
    if (Array.isArray(at)) items = at;
  }
  if (!items) items = listItems(data);

  const results = [];
  if (items) {
    for (const item of items) {
      const mediaUrl = mappedValue(item, mapping.mediaUrlPath) && isHttpUrl(mappedValue(item, mapping.mediaUrlPath))
        ? mappedValue(item, mapping.mediaUrlPath)
        : extractVideoUrl(item); // extend the existing drill, never duplicate it
      if (!mediaUrl || !isHttpUrl(mediaUrl)) continue;
      results.push({
        id: `${provider.id}#${results.length + 1}`,
        title: sanitizeTitle(mappedValue(item, mapping.titlePath)) || safeTitle(item, `Selection ${results.length + 1}`),
        mediaUrl,
        thumbnail: mappedValue(item, mapping.thumbnailPath) || '',
        duration: mappedValue(item, mapping.durationPath) || '',
        size: mappedValue(item, mapping.sizePath) || '',
        provider: provider.name,
        providerId: provider.id,
        sourceUrl: mappedValue(item, mapping.sourceUrlPath) || ''
      });
    }
    return results;
  }

  // Flat payload: direct media answer from the provider.
  const directUrl = extractVideoUrl(data);
  if (directUrl) {
    return [{
      id: `${provider.id}#direct`,
      title: `${provider.name} direct stream`,
      mediaUrl: directUrl,
      thumbnail: '', duration: '', size: '',
      provider: provider.name,
      providerId: provider.id,
      sourceUrl: ''
    }];
  }
  return [];
}

// Controlled multi-provider search: identical media (normalized URL) appears
// once; provider metadata stays on the surviving entry.
function normalizeMediaUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`;
  } catch {
    return String(value).trim();
  }
}

function dedupeResults(results) {
  const seen = new Set();
  const out = [];
  for (const result of results) {
    const key = normalizeMediaUrl(result.mediaUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Progress rendering.
// ---------------------------------------------------------------------------

const PROGRESS_BAR_WIDTH = 14;

function buildProgressCard(title, receivedBytes, totalBytes, { complete = false } = {}) {
  const hasTotal = Number.isFinite(totalBytes) && totalBytes > 0;
  const pct = hasTotal ? Math.min(100, Math.floor((receivedBytes / totalBytes) * 100)) : null;
  const filled = complete || pct === 100
    ? PROGRESS_BAR_WIDTH
    : pct === null
      ? Math.floor(PROGRESS_BAR_WIDTH / 2)
      : Math.round((pct / 100) * PROGRESS_BAR_WIDTH);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, PROGRESS_BAR_WIDTH - filled));
  const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (complete) {
    return panel('download', ['✅ Download complete', `🎬 ${title}`, '', '📤 Sending to WhatsApp...']);
  }
  const lines = [`🎬 ${title}`, '', '⬇️ Downloading...'];
  lines.push(pct === null ? bar : `${bar} ${pct}%`);
  lines.push(hasTotal ? `📦 ${mb(receivedBytes)} / ${mb(totalBytes)}` : `📦 ${mb(receivedBytes)}`);
  return panel('download', lines);
}

// Throttle rule: meaningful change (>=5 points) AND a quiet window (>=1s),
// except 100% which always renders. Keeps WhatsApp updates spam-free.
function shouldUpdateProgress(last, pct, now) {
  if (pct >= 100) return true;
  if (pct - (last?.pct ?? -1) < 5) return false;
  return now - (last?.at ?? 0) >= 1000;
}

// ---------------------------------------------------------------------------
// Bounded media download.
// ---------------------------------------------------------------------------

class MediaError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'MediaError';
    this.code = code;
  }
}

// Streams the media into a bounded buffer. Enforces maxBytes MID-STREAM (a
// lying/missing Content-Length can never trigger an unbounded allocation),
// aborts on the overall deadline, rejects HTML masquerading as media, and
// always destroys the stream + timer on every exit path.
async function downloadMedia(streamUrl, { timeoutMs, maxBytes, headers, onProgress }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let response;
  try {
    response = await axios.get(streamUrl, {
      responseType: 'stream',
      timeout: timeoutMs,
      signal: controller.signal,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      headers: { ...REQUEST_HEADERS, ...(headers || {}) }
    });
  } catch (error) {
    clearTimeout(timer);
    if (timedOut || axios.isCancel?.(error) || error?.code === 'ERR_CANCELED' || controller.signal.aborted) {
      throw new MediaError('timeout', 'download timed out');
    }
    throw error instanceof MediaError ? error : new MediaError('request', error?.message || 'download request failed');
  }

  // A stalled body must never hang the bot: abort/timeout destroys the stream
  // so the read loop below always settles.
  const isAbortError = () => timedOut || controller.signal.aborted;
  const onAbort = () => response?.data?.destroy?.(new Error('aborted'));
  controller.signal.addEventListener('abort', onAbort);

  const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
  if (contentType.startsWith('text/html')) {
    response.data?.destroy?.();
    controller.signal.removeEventListener('abort', onAbort);
    clearTimeout(timer);
    throw new MediaError('html-stream', 'stream resolved to a web page');
  }
  const declaredTotal = Number(response.headers?.['content-length']) || 0;

  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of response.data) {
      received += chunk.length;
      if (received > maxBytes) throw new MediaError('too-large', 'stream exceeded the size limit');
      chunks.push(chunk);
      try { await onProgress?.(received, declaredTotal); } catch { /* progress must never break a download */ }
    }
  } catch (error) {
    if (isAbortError() || error?.code === 'ERR_CANCELED') {
      throw new MediaError('timeout', 'download timed out');
    }
    throw error instanceof MediaError ? error : new MediaError('stream', error?.message || 'stream failed');
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    response.data?.destroy?.();
  }
  return { buffer: Buffer.concat(chunks), received, declaredTotal, contentType };
}

function mediaPayload(buffer, contentType, chosen) {
  const caption = [`✅ *Title:* ${chosen.title}`, `📦 *Provider:* ${chosen.provider}`, '🔒 *Category:* Hidden (!h)'].join('\n');
  if (contentType.startsWith('image/')) return { image: buffer, caption };
  if (contentType.startsWith('audio/')) {
    return { audio: buffer, mimetype: contentType.split(';')[0].trim() || 'audio/mpeg', ptt: false, fileName: safeFileName(chosen.title, 'mp3') };
  }
  return { video: buffer, mimetype: 'video/mp4', caption };
}

// ---------------------------------------------------------------------------
// Delivery pipeline (selection → validation → download → progress → send).
// ---------------------------------------------------------------------------

async function reply(socket, context, text) {
  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

async function editOrSkip(socket, context, messageKey, text) {
  if (!messageKey) return;
  try {
    await socket.sendMessage(context.chatId, { text, edit: messageKey }, { quoted: context.raw });
  } catch {
    // Edit unsupported on this transport: skip rather than spam new messages.
  }
}

function tooLargePanel(maxBytes) {
  return panel('download', [
    '⚠️ File is too large.',
    '',
    `📦 Maximum: ${Math.round(maxBytes / (1024 * 1024))} MB`,
    '',
    '❌ Download cancelled.'
  ]);
}

async function deliverSelection(socket, context, chosen, choiceLabel) {
  const limits = settings();

  if (!acquireDownloadSlot(context)) {
    await reply(socket, context, panel('download', ['⏳ Your previous video is still downloading.', 'Please wait.']));
    return;
  }

  try {
    // Re-validate through the drill at delivery time so a cached entry can
    // never smuggle a non-http payload into the downloader.
    const streamUrl = extractVideoUrl(chosen.mediaUrl) || (isHttpUrl(chosen.mediaUrl) ? chosen.mediaUrl : null);
    if (!streamUrl) {
      await reply(socket, context, panel('video', ['❌ This result has no playable media link.', '', 'Please select another result or search again.']));
      return;
    }

    // Size/type verification BEFORE any body is read.
    let declaredBytes = 0;
    let headType = '';
    try {
      const head = await axios.head(streamUrl, { timeout: limits.headTimeoutMs, headers: REQUEST_HEADERS });
      declaredBytes = Number(head?.headers?.['content-length']) || 0;
      headType = String(head?.headers?.['content-type'] || '').toLowerCase();
    } catch {
      // HEAD unsupported or blocked — the bounded streaming download below
      // still enforces every limit.
    }
    if (declaredBytes > limits.maxDownloadBytes) {
      await reply(socket, context, tooLargePanel(limits.maxDownloadBytes));
      return;
    }
    if (headType.startsWith('text/html')) {
      await reply(socket, context, panel('download', ['❌ Video download failed.', '', 'This result does not provide a direct media file.', 'Please select another result or search again.']));
      return;
    }

    let progressKey;
    let last = { pct: -1, at: 0 };
    try {
      const initial = await socket.sendMessage(context.chatId, { text: buildProgressCard(chosen.title, 0, declaredBytes) }, { quoted: context.raw });
      progressKey = initial?.key;

      const updateProgress = async (received, total) => {
        const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
        if (!shouldUpdateProgress(last, pct, Date.now())) return;
        last = { pct, at: Date.now() };
        await editOrSkip(socket, context, progressKey, buildProgressCard(chosen.title, received, total));
      };

      const { buffer, contentType } = await downloadMedia(streamUrl, {
        timeoutMs: limits.downloadTimeoutMs,
        maxBytes: limits.maxDownloadBytes,
        onProgress: updateProgress
      });

      await editOrSkip(socket, context, progressKey, buildProgressCard(chosen.title, buffer.length, buffer.length, { complete: true }));
      await socket.sendMessage(context.chatId, mediaPayload(buffer, contentType, chosen), { quoted: context.raw });
    } catch (error) {
      // Internal logging stays secret-safe: message only, never headers/keys.
      console.warn(`[hvideo] download failed (${chosen.providerId || 'provider'}): ${error?.code || ''} ${error?.message || error}`.trim());
      if (error instanceof MediaError && error.code === 'too-large') {
        await editOrSkip(socket, context, progressKey, tooLargePanel(limits.maxDownloadBytes));
        await reply(socket, context, tooLargePanel(limits.maxDownloadBytes)).catch(() => {});
        return;
      }
      await reply(socket, context, panel('download', ['❌ Video download failed.', '', 'Please select another result or search again.'])).catch(() => {});
    }
  } finally {
    releaseDownloadSlot(context);
  }
}

// ---------------------------------------------------------------------------
// Command entry points.
// ---------------------------------------------------------------------------

async function handleHvideoCommand(socket, context, command) {
  const limits = settings();
  const inputQuery = String(command?.text || '').trim();

  if (!limits.enabled) {
    await reply(socket, context, panel('video', ['⛔ The hidden video engine is disabled.', '', 'Ask the owner to enable hiddenVideo in the configuration.']));
    return;
  }

  // --- STAGE 1: interactive user choice handling ("!hvideo 2") --------------
  if (inputQuery && /^\d+$/.test(inputQuery)) {
    const session = takeSession(context);
    if (session?.expired) {
      await reply(socket, context, panel('video', ['⚠️ This video search session has expired.', '', `Use !hvideo ${session.query || '<keyword>'} to search again.`]));
      return;
    }
    if (session) {
      const selectedIndex = Number.parseInt(inputQuery, 10) - 1;
      if (selectedIndex < 0 || selectedIndex >= session.results.length) {
        await reply(socket, context, panel('video', [`❌ Invalid choice. Reply with a number between 1 and ${session.results.length}.`]));
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
    await reply(socket, context, panel('video', ['Usage:', '!hvideo <keyword>', '', 'Example:', '!hvideo naruto']));
    return;
  }

  // --- STAGE 2: config-driven keyword routing --------------------------------
  const query = normalizeKeyword(inputQuery);
  const { providers, query: providerQuery, mode } = eligibleProviders(query);
  if (!providers.length) {
    const known = [...new Set(limits.providers.filter((provider) => provider.enabled).flatMap((provider) => provider.keywords))].slice(0, 12);
    const lines = ['❌ No provider matches that keyword.', '', `🔎 Search: ${query}`];
    if (known.length) lines.push('', `Configured keywords: ${known.join(', ')}`);
    await reply(socket, context, panel('video', lines));
    return;
  }

  await reply(socket, context, panel('video', ['🛸 Scanning secure provider network...', `🔎 Search: ${query}`, '', mode === 'id' ? `📡 Node: ${providers[0].name}` : `📡 Nodes: ${providers.length}`]));

  // --- STAGE 3: fault-tolerant multi-provider search -------------------------
  let collected = [];
  let attempts = 0;
  let failures = 0;
  for (const provider of providers) {
    attempts += 1;
    try {
      const found = await fetchProvider(provider, providerQuery);
      collected = collected.concat(found);
    } catch (error) {
      failures += 1;
      // Secret-safe log: provider id + message only, never headers or keys.
      console.warn(`[hvideo] provider [${provider.id}] failed: ${error?.message || error}`);
    }
  }

  const aggregated = dedupeResults(collected).slice(0, limits.maxResults);

  // --- STAGE 4: result rendering ----------------------------------------------
  if (!aggregated.length) {
    if (failures === attempts) {
      await reply(socket, context, panel('video', ['⚠️ Video search is temporarily unavailable.', 'Please try again.']));
      return;
    }
    await reply(socket, context, panel('video', ['❌ No videos found.', '', `🔎 Search: ${query}`]));
    return;
  }

  storeSession(context, aggregated, query);
  const lines = [`🔎 Search: ${query}`, `📦 Results: ${aggregated.length}`, ''];
  aggregated.forEach((result, index) => lines.push(`${index + 1}. ${result.title}`));
  lines.push('', 'Reply with a number to download.', `⏱ Session: ${Math.round(limits.sessionTimeoutMs / 60000)} minutes`);
  await reply(socket, context, panel('video', lines));
}

// Bare numeric replies (no prefix) belong to an active !hvideo selection list
// before anything else may interpret them. Returns true when the reply was
// consumed so the caller stops processing.
async function handleHvideoSelectionReply(socket, context) {
  const text = String(context?.text || '').trim();
  if (!settings().enabled || !/^\d{1,2}$/.test(text)) return false;
  const session = takeSession(context);
  if (!session) return false; // no active list — leave the reply to other handlers
  if (session.expired) {
    await reply(socket, context, panel('video', ['⚠️ This video search session has expired.', '', `Use !hvideo ${session.query || '<keyword>'} to search again.`]));
    return true;
  }
  const selectedIndex = Number.parseInt(text, 10) - 1;
  if (selectedIndex < 0 || selectedIndex >= session.results.length) {
    await reply(socket, context, panel('video', [`❌ Invalid choice. Reply with a number between 1 and ${session.results.length}.`]));
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
  _storeSession: storeSession,
  _activeDownloads: activeDownloads,
  _sweepExpiredSessions: sweepExpiredSessions,
  _eligibleProviders: eligibleProviders,
  _fetchProvider: fetchProvider,
  _normalizeProviderResponse: normalizeProviderResponse,
  _dedupeResults: dedupeResults,
  _downloadMedia: downloadMedia,
  _buildProgressCard: buildProgressCard,
  _shouldUpdateProgress: shouldUpdateProgress,
  _safeFileName: safeFileName,
  _sanitizeTitle: sanitizeTitle,
  _getByPath: getByPath,
  _listItems: listItems,
  _MediaError: MediaError,
  _settings: settings
};
