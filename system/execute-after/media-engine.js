'use strict';

// =============================================================================
// EXECUTEAFTER — STREAM / DOWNLOAD MEDIA ENGINE
// =============================================================================
// Reusable, bounded media handling for permitted video providers:
//
//   * URL validation         (http/https only, no credentials, no private hosts)
//   * redirect handling      (manual, every hop re-validated, maxRedirects)
//   * content-type validation(a webpage or a JSON error is never a video)
//   * timeout                (connect + total download deadline)
//   * file-size limits       (streamed byte counter, aborts on overflow)
//   * streaming downloads    (no unnecessary RAM buffering)
//   * temporary files        (always removed, with a crash-safe stale sweep)
//   * failed-download cleanup(partial file deleted, socket aborted)
//   * expired URLs           (401/403/410 mapped to a clean "link expired")
//   * bounded concurrency    (semaphore with a refusal limit, never a queue
//                             that grows without end)
//
// Large video files are NEVER cached permanently and never kept in memory
// beyond `bufferBelowBytes`.
// =============================================================================

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { ERROR_CODES, ExecuteAfterError, redactUrl, toExecuteAfterError } = require('./errors');
const { openStream } = require('./http-client');

const TEMP_PREFIX = 'execute-after-';
const STALE_TEMP_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const DEFAULT_MEDIA_SETTINGS = Object.freeze({
  enabled: true,
  maxBytes: 64 * 1024 * 1024,
  maxConcurrent: 2,
  queueLimit: 4,
  timeoutMs: 120000,
  probeTimeoutMs: 15000,
  maxRedirects: 5,
  allowedContentTypes: ['video/', 'audio/', 'image/', 'application/octet-stream', 'application/mp4'],
  deniedContentTypes: ['text/html', 'text/xml', 'application/json', 'application/xhtml+xml'],
  allowedHosts: [],
  allowPrivateHosts: false,
  tempDir: '',
  bufferBelowBytes: 12 * 1024 * 1024,
  deleteAfterSend: true,
  streamSettleMs: 2000
});

const activeTempFiles = new Set();
let lastSweepAt = 0;
let sweepInFlight = null;

// ---------------------------------------------------------------------------
// Bounded concurrency (no unbounded queue, no leaked timers)
// ---------------------------------------------------------------------------

function createGate({ maxConcurrent = 2, queueLimit = 4 } = {}) {
  const limit = Math.max(1, Number(maxConcurrent) || 1);
  const maxWaiting = Math.max(0, Number(queueLimit) || 0);
  let active = 0;
  const waiters = [];
  return {
    get active() { return active; },
    get waiting() { return waiters.length; },
    async acquire() {
      if (active < limit) {
        active += 1;
        return true;
      }
      if (waiters.length >= maxWaiting) return false;
      await new Promise((resolve) => waiters.push(resolve));
      active += 1;
      return true;
    },
    release() {
      active = Math.max(0, active - 1);
      const next = waiters.shift();
      if (next) next();
    }
  };
}

const gates = new Map();
function gateFor(settings) {
  const key = `${Math.max(1, settings.maxConcurrent)}:${Math.max(0, settings.queueLimit)}`;
  if (!gates.has(key)) gates.set(key, createGate({ maxConcurrent: settings.maxConcurrent, queueLimit: settings.queueLimit }));
  return gates.get(key);
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

const PRIVATE_IPV4 = [
  /^0\./, /^10\./, /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.0\.0\./, /^192\.168\./, /^198\.(18|19)\./, /^198\.51\.100\./, /^203\.0\.113\./, /^22[4-9]\./, /^23\d\./, /^24\d\./, /^255\./
];

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  if (PRIVATE_IPV4.some((pattern) => pattern.test(host))) return true;
  if (host.includes(':')) {
    if (host === '::1' || host === '::' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return true;
    if (host.startsWith('::ffff:')) return isPrivateHostname(host.slice(7));
  }
  return false;
}

function hostAllowed(hostname, allowedHosts = []) {
  if (!Array.isArray(allowedHosts) || !allowedHosts.length) return true;
  const host = String(hostname || '').toLowerCase();
  return allowedHosts.some((entry) => {
    const pattern = String(entry || '').trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith('*.')) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
    return host === pattern || host.endsWith(`.${pattern}`);
  });
}

/**
 * Validates a media URL before anything is fetched.
 * A page URL is never accepted as a media URL: the caller must have a direct
 * media link, and the content-type check below verifies it for real.
 */
function validateMediaUrl(rawUrl, { provider = '', mode = '', allowedHosts = [], allowPrivateHosts = false } = {}) {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) {
    throw new ExecuteAfterError(ERROR_CODES.MISSING_MEDIA_URL, { provider, mode });
  }
  if (raw.length > 2048) {
    throw new ExecuteAfterError(ERROR_CODES.INVALID_MEDIA_URL, { provider, mode, technical: 'url exceeds 2048 characters' });
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ExecuteAfterError(ERROR_CODES.INVALID_MEDIA_URL, { provider, mode, technical: `unparseable url "${raw.slice(0, 80)}"` });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ExecuteAfterError(ERROR_CODES.INVALID_MEDIA_URL, { provider, mode, technical: `protocol ${url.protocol}` });
  }
  if (url.username || url.password) {
    throw new ExecuteAfterError(ERROR_CODES.INVALID_MEDIA_URL, { provider, mode, technical: 'url contains credentials' });
  }
  if (!allowPrivateHosts && isPrivateHostname(url.hostname)) {
    throw new ExecuteAfterError(ERROR_CODES.INVALID_MEDIA_URL, { provider, mode, technical: `private/loopback host ${url.hostname}` });
  }
  if (!hostAllowed(url.hostname, allowedHosts)) {
    throw new ExecuteAfterError(ERROR_CODES.INVALID_MEDIA_URL, { provider, mode, technical: `host ${url.hostname} is not in media.allowedHosts` });
  }
  return url;
}

function classifyContentType(contentType, settings) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!type) return 'unknown';
  if (settings.deniedContentTypes.some((denied) => type === denied || type.startsWith(denied))) return 'denied';
  if (settings.allowedContentTypes.some((allowed) => (allowed.endsWith('/') ? type.startsWith(allowed) : type === allowed))) {
    if (type.startsWith('video/')) return 'video';
    if (type.startsWith('audio/')) return 'audio';
    if (type.startsWith('image/')) return 'image';
    return 'binary';
  }
  return 'unsupported';
}

function assertContentType(contentType, { provider, mode, settings }) {
  const kind = classifyContentType(contentType, settings);
  if (kind === 'denied') {
    throw new ExecuteAfterError(ERROR_CODES.INVALID_MEDIA_URL, {
      provider,
      mode,
      technical: `content-type "${contentType}" is a webpage/envelope, not media`
    });
  }
  if (kind === 'unsupported' || kind === 'unknown') {
    throw new ExecuteAfterError(ERROR_CODES.UNSUPPORTED_MEDIA, {
      provider,
      mode,
      technical: `content-type "${contentType || 'missing'}" not in media.allowedContentTypes`
    });
  }
  return kind;
}

function statusToError(status, { provider, mode }) {
  if (status === 401 || status === 403 || status === 410) return new ExecuteAfterError(ERROR_CODES.EXPIRED_MEDIA, { provider, mode, status });
  if (status === 404) {
    return new ExecuteAfterError(ERROR_CODES.INVALID_MEDIA_URL, {
      provider,
      mode,
      status,
      technical: 'HTTP 404 for the media URL',
      userMessage: 'The media URL returned 404 — the provider link is wrong or expired.'
    });
  }
  if (status === 408) return new ExecuteAfterError(ERROR_CODES.TIMEOUT, { provider, mode, status });
  if (status === 429) return new ExecuteAfterError(ERROR_CODES.RATE_LIMITED, { provider, mode, status });
  if (status >= 500) return new ExecuteAfterError(ERROR_CODES.SERVER_ERROR, { provider, mode, status });
  return new ExecuteAfterError(ERROR_CODES.INVALID_MEDIA_URL, { provider, mode, status, technical: `HTTP ${status} for the media URL` });
}

// ---------------------------------------------------------------------------
// Temp file handling + crash-safe stale sweep (no process listeners)
// ---------------------------------------------------------------------------

async function ensureTempDir(settings) {
  const base = settings.tempDir ? path.resolve(settings.tempDir) : path.join(os.tmpdir(), 'anime-md-execute-after');
  await fsp.mkdir(base, { recursive: true });
  return base;
}

async function sweepStaleTempFiles(settings, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastSweepAt < SWEEP_INTERVAL_MS) return 0;
  if (sweepInFlight) return sweepInFlight;
  lastSweepAt = now;
  sweepInFlight = (async () => {
    let removed = 0;
    try {
      const dir = settings.tempDir ? path.resolve(settings.tempDir) : path.join(os.tmpdir(), 'anime-md-execute-after');
      const entries = await fsp.readdir(dir).catch(() => []);
      for (const entry of entries) {
        if (!entry.startsWith(TEMP_PREFIX)) continue;
        const full = path.join(dir, entry);
        if (activeTempFiles.has(full)) continue;
        const stat = await fsp.stat(full).catch(() => null);
        if (!stat || !stat.isFile()) continue;
        if (now - stat.mtimeMs < STALE_TEMP_MS) continue;
        await fsp.unlink(full).then(() => { removed += 1; }).catch(() => {});
      }
    } catch { /* the sweep must never throw */ } finally {
      sweepInFlight = null;
    }
    if (removed) console.info(`[execute-after:media] swept ${removed} orphaned temp file(s).`);
    return removed;
  })();
  return sweepInFlight;
}

async function cleanupTempFile(filePath) {
  if (!filePath) return;
  activeTempFiles.delete(filePath);
  await fsp.unlink(filePath).catch((error) => {
    if (error?.code !== 'ENOENT') console.warn(`[execute-after:media] temp cleanup failed: ${error.message}`);
  });
}

function toNodeStream(body) {
  if (!body) return null;
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  if (typeof body[Symbol.asyncIterator] === 'function') return Readable.from(body);
  return null;
}

// ---------------------------------------------------------------------------
// Probe (verify a URL really is media before it is used)
// ---------------------------------------------------------------------------

async function probeMedia(rawUrl, {
  provider = '',
  mode = '',
  settings: override = {},
  validateHop
} = {}) {
  const settings = { ...DEFAULT_MEDIA_SETTINGS, ...(override || {}) };
  const validated = validateMediaUrl(rawUrl, { provider, mode, allowPrivateHosts: settings.allowPrivateHosts, allowedHosts: settings.allowedHosts });
  const { response, url } = await openStream(validated, {
    provider,
    mode,
    timeoutMs: settings.probeTimeoutMs,
    http: { maxRedirects: settings.maxRedirects },
    headers: { range: 'bytes=0-0' },
    validateHop: (hop) => {
      validateMediaUrl(hop, { provider, mode, allowPrivateHosts: settings.allowPrivateHosts, allowedHosts: settings.allowedHosts });
      if (typeof validateHop === 'function') validateHop(hop);
    }
  });
  try {
    if (!response.ok && response.status !== 206) throw statusToError(response.status, { provider, mode });
    const contentType = String(response.headers?.get?.('content-type') || '');
    const kind = assertContentType(contentType, { provider, mode, settings });
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    return {
      contentLength: Number.isFinite(contentLength) ? contentLength : 0,
      contentType: contentType.split(';')[0].trim().toLowerCase(),
      kind,
      url: url.toString()
    };
  } finally {
    // Never leave a probing connection open.
    try { await response.body?.cancel?.(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Download to a temporary file (streamed)
// ---------------------------------------------------------------------------

async function readAll(nodeStream, limit, { provider, mode }) {
  const chunks = [];
  let size = 0;
  for await (const chunk of nodeStream) {
    size += chunk.length;
    if (size > limit) {
      throw new ExecuteAfterError(ERROR_CODES.MEDIA_TOO_LARGE, { provider, mode, technical: `streamed ${size} > limit ${limit}` });
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

async function downloadToTemp(rawUrl, {
  provider = '',
  mode = '',
  settings: override = {},
  maxBytes,
  timeoutMs,
  label = ''
} = {}) {
  const settings = { ...DEFAULT_MEDIA_SETTINGS, ...(override || {}) };
  const limit = Math.max(1, Number(maxBytes) || settings.maxBytes);
  const totalTimeout = Math.max(1000, Number(timeoutMs) || settings.timeoutMs);
  const memoryCap = Math.min(limit, Math.max(0, Number(settings.bufferBelowBytes) || 0));
  const gate = gateFor(settings);
  const acquired = await gate.acquire();
  if (!acquired) {
    throw new ExecuteAfterError(ERROR_CODES.BUSY, {
      provider,
      mode,
      technical: `download concurrency limit reached (max ${settings.maxConcurrent}, queue ${settings.queueLimit})`,
      userMessage: 'Too many downloads are running right now. Please try again in a moment.'
    });
  }

  const validated = validateMediaUrl(rawUrl, { provider, mode, allowPrivateHosts: settings.allowPrivateHosts, allowedHosts: settings.allowedHosts });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), totalTimeout);
  // Ref'd on purpose: the deadline must fire even if nothing else is pending,
  // and it is always cleared in the finally block below.
  let target = null;
  let lastKind = 'binary';
  let lastUrl = '';
  let lastContentType = '';

  const finish = async ({ buffer }) => {
    const bytes = buffer ? buffer.length : await fsp.stat(target).then((stat) => stat.size).catch(() => 0);
    return {
      buffer: buffer || null,
      bytes,
      cleanup: async () => { if (target) await cleanupTempFile(target); },
      contentType: lastContentType,
      kind: lastKind,
      label,
      path: buffer ? null : target,
      url: lastUrl
    };
  };

  try {
    await sweepStaleTempFiles(settings).catch(() => {});
    const { response, url } = await openStream(validated, {
      provider,
      mode,
      timeoutMs: Math.min(totalTimeout, Math.max(5000, settings.probeTimeoutMs)),
      http: { maxRedirects: settings.maxRedirects },
      validateHop: (hop) => validateMediaUrl(hop, { provider, mode, allowPrivateHosts: settings.allowPrivateHosts, allowedHosts: settings.allowedHosts })
    });
    lastUrl = url.toString();
    if (!response.ok) throw statusToError(response.status, { provider, mode });

    const contentType = String(response.headers?.get?.('content-type') || '');
    const kind = assertContentType(contentType, { provider, mode, settings });
    lastKind = kind;
    lastContentType = contentType.split(';')[0].trim().toLowerCase();
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (declared && declared > limit) {
      throw new ExecuteAfterError(ERROR_CODES.MEDIA_TOO_LARGE, { provider, mode, technical: `content-length ${declared} > limit ${limit}` });
    }

    const body = toNodeStream(response.body);
    if (!body) throw new ExecuteAfterError(ERROR_CODES.EMPTY_RESPONSE, { provider, mode, technical: 'media response had no body' });

    if (declared > 0 && declared <= memoryCap) {
      return await finish({ buffer: await readAll(body, limit, { provider, mode }) });
    }

    const dir = await ensureTempDir(settings);
    target = path.join(dir, `${TEMP_PREFIX}${provider || 'provider'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    activeTempFiles.add(target);
    let size = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > limit) {
          callback(new ExecuteAfterError(ERROR_CODES.MEDIA_TOO_LARGE, { provider, mode, technical: `streamed ${size} > limit ${limit}` }));
          return;
        }
        callback(null, chunk);
      }
    });
    try {
      await pipeline(body, limiter, fs.createWriteStream(target));
      return await finish({ buffer: null });
    } catch (error) {
      await cleanupTempFile(target).catch(() => {});
      target = null;
      const code = String(error?.code || '');
      // Temporary-file fallback: the disk is unusable but the file fits in memory.
      if (['EACCES', 'EROFS', 'ENOSPC', 'ENOENT', 'EPERM'].includes(code) && declared > 0 && declared <= memoryCap) {
        console.warn(`[execute-after:media] temp file unavailable (${code}); using the bounded memory fallback (${Math.round(declared / 1024)}KB)`);
        const retry = await downloadToMemory(validated, { provider, mode, limit, timeoutMs: totalTimeout, settings });
        return await finish({ buffer: retry.buffer });
      }
      throw toExecuteAfterError(error, { provider, mode });
    }
  } catch (error) {
    if (target) await cleanupTempFile(target).catch(() => {});
    throw toExecuteAfterError(error, { provider, mode });
  } finally {
    clearTimeout(deadline);
    gate.release();
  }
}

async function downloadToMemory(validatedUrl, { provider, mode, limit, timeoutMs, settings }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetch(validatedUrl, { signal: controller.signal, redirect: 'follow', headers: { accept: '*/*' } });
    if (!response.ok) throw statusToError(response.status, { provider, mode });
    assertContentType(String(response.headers?.get?.('content-type') || ''), { provider, mode, settings });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > limit) throw new ExecuteAfterError(ERROR_CODES.MEDIA_TOO_LARGE, { provider, mode, technical: `memory fallback exceeded ${limit} bytes` });
      chunks.push(Buffer.from(chunk));
    }
    return { buffer: Buffer.concat(chunks, size) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Delivery through the existing AnimeMD socket
// ---------------------------------------------------------------------------

function mediaPayload(kind, source, { mimetype, fileName, caption }) {
  const payload = {};
  if (kind === 'document') {
    payload.document = source;
    payload.mimetype = /^[a-z]+\/[a-z0-9.+-]+$/i.test(mimetype) ? mimetype : 'application/octet-stream';
    payload.fileName = fileName || 'media';
  } else if (kind === 'audio') {
    payload.audio = source;
    payload.mimetype = mimetype.startsWith('audio/') ? mimetype : 'audio/mpeg';
    payload.ptt = false;
    if (fileName) payload.fileName = fileName;
  } else if (kind === 'image') {
    payload.image = source;
    payload.mimetype = mimetype.startsWith('image/') ? mimetype : 'image/jpeg';
  } else if (kind === 'video') {
    payload.video = source;
    payload.mimetype = mimetype.startsWith('video/') ? mimetype : 'video/mp4';
    if (fileName) payload.fileName = fileName;
  } else {
    // Unknown/octet-stream media is sent as a document instead of being forced
    // into a video payload the client cannot play.
    payload.document = source;
    payload.mimetype = /^[a-z]+\/[a-z0-9.+-]+$/i.test(mimetype) ? mimetype : 'application/octet-stream';
    payload.fileName = fileName || 'media';
  }
  if (caption) payload.caption = String(caption).slice(0, 1024);
  return payload;
}

// A read stream that is never consumed must never crash the process: a late
// failure (for example the temp file already being gone) is a handled warning.
function guardedStream(filePath) {
  const stream = fs.createReadStream(filePath);
  stream.on('error', (error) => console.warn(`[execute-after:media] temp stream issue: ${error.message}`));
  return stream;
}

// Waits (bounded) until the consumer is done with the stream before the temp
// file is removed, so a slow upload can never read a deleted path.
async function settleStream(stream, timeoutMs) {
  if (!stream || typeof stream.once !== 'function') return;
  if (stream.destroyed || stream.readableEnded) return;
  await new Promise((resolve) => {
    // Awaited by deliverMedia before the temp file is removed: keep the timer
    // ref'd so the wait is never cut short by an empty event loop.
    const timer = setTimeout(resolve, Math.max(0, Number(timeoutMs) || 0));
    const done = () => { clearTimeout(timer); resolve(); };
    stream.once('close', done);
    stream.once('end', done);
    stream.once('error', done);
  });
}

/**
 * Verified delivery: probe → download (streamed, bounded) → send through the
 * existing socket → always clean up the temporary file.
 */
async function deliverMedia({ socket, chatId, rawUrl, kind = 'video', caption = '', quoted, fileName = '', provider = '', mode = '', settings: override = {} } = {}) {
  const settings = { ...DEFAULT_MEDIA_SETTINGS, ...(override || {}) };
  if (settings.enabled === false) {
    throw new ExecuteAfterError(ERROR_CODES.UNSUPPORTED_MEDIA, { provider, mode, technical: 'media engine disabled in framework.media.enabled' });
  }
  if (!socket || typeof socket.sendMessage !== 'function') {
    throw new ExecuteAfterError(ERROR_CODES.UNKNOWN, { provider, mode, technical: 'no socket available for media delivery' });
  }
  validateMediaUrl(rawUrl, { provider, mode, allowPrivateHosts: settings.allowPrivateHosts, allowedHosts: settings.allowedHosts });
  let downloaded = null;
  let sourceStream = null;
  try {
    downloaded = await downloadToTemp(rawUrl, { provider, mode, settings, label: caption });
    // 'auto' trusts the VERIFIED content-type instead of guessing from the URL.
    const effectiveKind = kind === 'auto' ? downloaded.kind : kind;
    const source = downloaded.buffer || guardedStream(downloaded.path);
    sourceStream = Buffer.isBuffer(source) ? null : source;
    const payload = mediaPayload(effectiveKind, source, { mimetype: downloaded.contentType, fileName: fileName || path.basename(downloaded.path || 'media'), caption });
    const sent = await socket.sendMessage(chatId, payload, { quoted });
    return { bytes: downloaded.bytes, contentType: downloaded.contentType, kind: downloaded.kind, message: sent, payloadKind: kind === 'auto' ? downloaded.kind : kind };
  } catch (error) {
    throw toExecuteAfterError(error, { provider, mode });
  } finally {
    if (downloaded && !downloaded.buffer) await settleStream(sourceStream, settings.streamSettleMs);
    if (downloaded?.cleanup) await downloaded.cleanup().catch(() => {});
  }
}

async function withTempFile(rawUrl, options, handler) {
  const downloaded = await downloadToTemp(rawUrl, options);
  try {
    return await handler(downloaded);
  } finally {
    await downloaded.cleanup().catch(() => {});
  }
}

function stats() {
  return { activeTempFiles: activeTempFiles.size, gates: [...gates.values()].map((gate) => ({ active: gate.active, waiting: gate.waiting })) };
}

async function cleanupAllTempFiles() {
  const files = [...activeTempFiles];
  await Promise.all(files.map((file) => cleanupTempFile(file)));
  return files.length;
}

module.exports = {
  DEFAULT_MEDIA_SETTINGS,
  TEMP_PREFIX,
  assertContentType,
  classifyContentType,
  cleanupAllTempFiles,
  cleanupTempFile,
  createGate,
  deliverMedia,
  downloadToTemp,
  ensureTempDir,
  hostAllowed,
  isPrivateHostname,
  probeMedia,
  stats,
  statusToError,
  sweepStaleTempFiles,
  validateMediaUrl,
  withTempFile
};
