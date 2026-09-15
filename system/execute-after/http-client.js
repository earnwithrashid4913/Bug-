'use strict';

// =============================================================================
// EXECUTEAFTER — SHARED HTTP LAYER
// =============================================================================
// One HTTP implementation for every provider adapter. It supports:
//   * timeout                (AbortController, always cleared)
//   * controlled retries     (hard ceiling, never infinite)
//   * exponential backoff    (with jitter and a maximum delay)
//   * 429 handling           (Retry-After honoured, capped)
//   * 5xx / 408 handling     (bounded retry)
//   * DNS and socket errors  (typed, bounded)
//   * malformed JSON         (typed, never crashes)
//   * empty responses        (typed)
//   * invalid status codes   (typed, mapped to a clean user message)
//   * response size limits   (streamed with a byte counter)
//   * polite per-host pacing (avoids rate-limit loops)
//
// There is no polling anywhere: one request, at most `maxAttempts` attempts.
// =============================================================================

const {
  ERROR_CODES,
  STATUS_MESSAGES,
  ExecuteAfterError,
  isExecuteAfterError,
  redactUrl,
  toExecuteAfterError
} = require('./errors');

const MAX_ATTEMPTS_CEILING = 5;
const DEFAULTS = Object.freeze({
  timeoutMs: 20000,
  maxAttempts: 3,
  baseDelayMs: 700,
  maxDelayMs: 8000,
  maxResponseBytes: 4 * 1024 * 1024,
  minHostIntervalMs: 250,
  respectRetryAfter: true,
  retryPost: false,
  maxRedirects: 5
});

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  ERROR_CODES.TIMEOUT,
  ERROR_CODES.DNS,
  ERROR_CODES.NETWORK,
  ERROR_CODES.RATE_LIMITED,
  ERROR_CODES.SERVER_ERROR
]);

// ---------------------------------------------------------------------------
// Per-host pacing. Bounded map (no timers left running, no unbounded growth).
// ---------------------------------------------------------------------------

const hostNextSlot = new Map();
const MAX_PACED_HOSTS = 64;

function delay(ms) {
  const safe = Math.max(0, Math.min(Number(ms) || 0, 60000));
  if (!safe) return Promise.resolve();
  return new Promise((resolve) => {
    // Bounded and always awaited by the caller (pacing / retry backoff), so it
    // must NOT be unref'd: an unref'd timer lets the event loop drain and the
    // process exit while a request is still in flight.
    setTimeout(resolve, safe);
  });
}

async function paceHost(host, minIntervalMs) {
  const interval = Math.max(0, Number(minIntervalMs) || 0);
  if (!host || !interval) return;
  const now = Date.now();
  const nextSlot = hostNextSlot.get(host) || 0;
  hostNextSlot.set(host, Math.max(now, nextSlot) + interval);
  if (hostNextSlot.size > MAX_PACED_HOSTS) {
    const oldest = [...hostNextSlot.entries()].sort((a, b) => a[1] - b[1]).slice(0, hostNextSlot.size - MAX_PACED_HOSTS);
    for (const [key] of oldest) hostNextSlot.delete(key);
  }
  if (nextSlot > now) await delay(Math.min(nextSlot - now, interval * 4));
}

// ---------------------------------------------------------------------------
// URL / parameter helpers
// ---------------------------------------------------------------------------

function buildUrl(endpoint, params = {}) {
  let url;
  try {
    url = new URL(String(endpoint));
  } catch {
    throw new ExecuteAfterError(ERROR_CODES.NOT_CONFIGURED, {
      technical: `Invalid endpoint configured: ${redactUrl(endpoint)}`,
      userMessage: 'This provider endpoint is not a valid URL.',
      hint: 'PUT YOUR PERMITTED API ENDPOINT HERE in execute-after.config.js.'
    });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ExecuteAfterError(ERROR_CODES.NOT_CONFIGURED, {
      technical: `Unsupported protocol ${url.protocol}`,
      userMessage: 'This provider endpoint must be an http or https URL.'
    });
  }
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) url.searchParams.append(key, String(entry));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

function applyAuth(url, headers, auth = {}) {
  const type = String(auth?.type || '').toLowerCase();
  const token = String(auth?.token || '');
  if (!type || !token) return;
  if (type === 'bearer') {
    headers[auth.header || 'Authorization'] = `Bearer ${token}`;
    return;
  }
  if (type === 'header') {
    headers[auth.header || 'Authorization'] = token;
    return;
  }
  if (type === 'query') {
    url.searchParams.set(auth.queryParam || 'apikey', token);
  }
}

// ---------------------------------------------------------------------------
// Body reading with a hard byte ceiling (never an oversized buffer)
// ---------------------------------------------------------------------------

async function readBodyLimited(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared && declared > maxBytes) {
    throw new ExecuteAfterError(ERROR_CODES.RESPONSE_TOO_LARGE, { technical: `content-length ${declared} > ${maxBytes}` });
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new ExecuteAfterError(ERROR_CODES.RESPONSE_TOO_LARGE, { technical: `body exceeds ${maxBytes} bytes` });
    return text;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new ExecuteAfterError(ERROR_CODES.RESPONSE_TOO_LARGE, { technical: `streamed body exceeded ${maxBytes} bytes` });
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function parseJsonPayload(text, { provider, mode, status, contentType }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new ExecuteAfterError(ERROR_CODES.EMPTY_RESPONSE, { provider, mode, status });
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new ExecuteAfterError(ERROR_CODES.INVALID_JSON, {
      provider,
      mode,
      status,
      technical: `content-type=${contentType || 'unknown'} first="${trimmed.slice(0, 80)}"`,
      cause: error
    });
  }
}

function retryAfterMs(response, { maxDelayMs, baseDelayMs, attempt }) {
  const header = response?.headers?.get?.('retry-after');
  const fallback = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  if (!header) return fallback;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxDelayMs, seconds * 1000 || fallback);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(maxDelayMs, Math.max(0, date - Date.now()) || fallback);
  return fallback;
}

function backoffMs({ attempt, baseDelayMs, maxDelayMs }) {
  const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.5 + Math.random() * 0.5; // 50%–100%, no thundering herd
  return Math.max(50, Math.round(raw * jitter));
}

// ---------------------------------------------------------------------------
// Single attempt
// ---------------------------------------------------------------------------

async function attemptRequest(url, { method, headers, body, timeoutMs, provider, mode }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const options = {
      method,
      headers,
      signal: controller.signal,
      redirect: 'manual'
    };
    if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }
    return await fetch(url, options);
  } catch (error) {
    throw toExecuteAfterError(error, { provider, mode });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public: requestJson
// ---------------------------------------------------------------------------

async function requestJson(endpoint, options = {}) {
  const settings = { ...DEFAULTS, ...(options.http || {}) };
  const provider = options.provider || '';
  const mode = options.mode || '';
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { accept: 'application/json', ...(options.headers || {}) };
  const params = { ...(options.params || {}) };
  const url = buildUrl(endpoint, params);
  applyAuth(url, headers, options.auth);
  const redirects = Math.max(0, Math.min(Number(settings.maxRedirects) || 0, 10));
  const maxAttempts = Math.max(1, Math.min(Number(settings.maxAttempts) || 1, MAX_ATTEMPTS_CEILING));
  const timeoutMs = Math.max(1000, Number(settings.timeoutMs) || DEFAULTS.timeoutMs);
  const maxResponseBytes = Math.max(1024, Number(settings.maxResponseBytes) || DEFAULTS.maxResponseBytes);
  const started = Date.now();
  let lastError;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    let current = url;
    let hops = 0;
    try {
      // Follow redirects manually so every hop is validated and counted.
      for (;;) {
        await paceHost(current.host, settings.minHostIntervalMs);
        const response = await attemptRequest(current, { method, headers, body: options.body, timeoutMs, provider, mode });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers?.get?.('location');
          if (!location) throw new ExecuteAfterError(ERROR_CODES.SERVER_ERROR, { provider, mode, status: response.status, technical: 'redirect without location' });
          if (hops >= redirects) throw new ExecuteAfterError(ERROR_CODES.BAD_REQUEST, { provider, mode, status: response.status, technical: `too many redirects (> ${redirects})` });
          hops += 1;
          current = new URL(location, current);
          if (!['http:', 'https:'].includes(current.protocol)) {
            throw new ExecuteAfterError(ERROR_CODES.BAD_REQUEST, { provider, mode, technical: `redirect protocol ${current.protocol}` });
          }
          continue;
        }

        if (!response.ok) {
          if (RETRYABLE_STATUS.has(response.status)) {
            const statusInfo = STATUS_MESSAGES[response.status];
            const error = new ExecuteAfterError(
              response.status === 429 ? ERROR_CODES.RATE_LIMITED : ERROR_CODES.SERVER_ERROR,
              {
                provider,
                mode,
                status: response.status,
                technical: `HTTP ${response.status} for ${redactUrl(current)}`,
                userMessage: statusInfo?.user
              }
            );
            error.retryDelayMs = response.status === 429 && settings.respectRetryAfter
              ? retryAfterMs(response, { maxDelayMs: settings.maxDelayMs, baseDelayMs: settings.baseDelayMs, attempt })
              : backoffMs({ attempt, baseDelayMs: settings.baseDelayMs, maxDelayMs: settings.maxDelayMs });
            throw error;
          }
          // 4xx (except 408/425/429) is a final answer: no retry.
          const mapped = toExecuteAfterError(new ExecuteAfterError(ERROR_CODES.BAD_REQUEST, { status: response.status }), { provider, mode });
          mapped.status = response.status;
          const fromStatus = STATUS_MESSAGES[response.status];
          if (fromStatus) {
            mapped.code = fromStatus.code;
            mapped.userMessage = fromStatus.user;
          }
          mapped.technical = `HTTP ${response.status} for ${redactUrl(current)}`;
          throw mapped;
        }

        const contentType = String(response.headers?.get?.('content-type') || '');
        const text = await readBodyLimited(response, maxResponseBytes);
        const data = parseJsonPayload(text, { provider, mode, status: response.status, contentType });
        return {
          attempts: attempt,
          data,
          durationMs: Date.now() - started,
          headers: response.headers,
          status: response.status,
          text,
          url: redactUrl(current)
        };
      }
    } catch (error) {
      lastError = isExecuteAfterError(error) ? error : toExecuteAfterError(error, { provider, mode });
      const retryable = RETRYABLE_CODES.has(lastError.code) && attempt < maxAttempts;
      const methodRetryable = method === 'GET' || method === 'HEAD' || settings.retryPost === true;
      if (!retryable || !methodRetryable) break;
      await delay(lastError.retryDelayMs || backoffMs({ attempt, baseDelayMs: settings.baseDelayMs, maxDelayMs: settings.maxDelayMs }));
    }
  }

  const finalError = toExecuteAfterError(lastError, { provider, mode });
  finalError.attempts = attempt;
  throw finalError;
}

// ---------------------------------------------------------------------------
// Public: openStream — one validated HTTP response for the media engine.
// The caller owns the body and must consume/abort it.
// ---------------------------------------------------------------------------

async function openStream(endpoint, {
  headers = {},
  method = 'GET',
  provider = '',
  mode = '',
  timeoutMs = DEFAULTS.timeoutMs,
  http = {},
  validateHop,
  maxRedirects
} = {}) {
  const settings = { ...DEFAULTS, ...(http || {}) };
  const url = buildUrl(endpoint, {});
  const redirects = Math.max(0, Math.min(Number(maxRedirects === undefined ? settings.maxRedirects : maxRedirects) || 0, 10));
  let current = url;
  let hops = 0;
  for (;;) {
    if (typeof validateHop === 'function') validateHop(current, { provider, mode });
    await paceHost(current.host, settings.minHostIntervalMs);
    const response = await attemptRequest(current, {
      method,
      headers: { accept: '*/*', ...headers },
      timeoutMs: Math.max(1000, Number(timeoutMs) || DEFAULTS.timeoutMs),
      provider,
      mode
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get?.('location');
      if (!location) throw new ExecuteAfterError(ERROR_CODES.SERVER_ERROR, { provider, mode, status: response.status, technical: 'redirect without location' });
      if (hops >= redirects) throw new ExecuteAfterError(ERROR_CODES.BAD_REQUEST, { provider, mode, status: response.status, technical: `too many redirects (> ${redirects})` });
      hops += 1;
      current = new URL(location, current);
      continue;
    }
    return { response, url: current, status: response.status, hops };
  }
}

module.exports = {
  DEFAULTS,
  MAX_ATTEMPTS_CEILING,
  RETRYABLE_STATUS,
  applyAuth,
  backoffMs,
  buildUrl,
  delay,
  openStream,
  readBodyLimited,
  requestJson
};
