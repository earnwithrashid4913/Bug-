'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { DEVELOPER_NAME, assertBotNumber } = require('./config');
const { readSessionId } = require('./session');
const { ROTATION_INTERVAL_MS } = require('./theme');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2'
});

// One pairing request per window is plenty: WhatsApp itself throttles codes.
const PAIRING_COOLDOWN_MS = 20_000;
const MAX_BODY_BYTES = 4_096;

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' https://files.catbox.moe data:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'"
  ].join('; ')
});

function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, status, message) {
  const body = Buffer.from(message, 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length
  });
  res.end(body);
}

// Resolves a request path inside PUBLIC_DIR and refuses anything that escapes it.
function resolveStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes('\0')) return undefined;

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  const rootWithSeparator = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : `${PUBLIC_DIR}${path.sep}`;

  if (target !== PUBLIC_DIR && !target.startsWith(rootWithSeparator)) return undefined;
  return target;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const target = resolveStaticPath(pathname);
  if (!target) {
    sendText(res, 400, 'Bad request.');
    return;
  }

  fs.stat(target, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendText(res, 404, 'Not found.');
      return;
    }

    const extension = path.extname(target).toLowerCase();
    const isHtml = extension === '.html';
    const stream = fs.createReadStream(target);

    stream.on('error', () => {
      if (!res.headersSent) sendText(res, 500, 'Could not read the requested file.');
      else res.destroy();
    });

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300'
    });
    stream.pipe(res);
  });
}

/**
 * Creates the dashboard HTTP server.
 *
 * The server is presentation and pairing only: it never reads the auth
 * directory, never exposes credentials, and reports connection state exactly as
 * the WhatsApp socket reported it.
 */
function createWebServer({
  config,
  getActiveThemeId,
  setActiveTheme,
  getStatus,
  requestPairing,
  themes
}) {
  const cooldowns = new Map();

  function pruneCooldowns(now) {
    for (const [key, timestamp] of cooldowns) {
      if (now - timestamp > PAIRING_COOLDOWN_MS) cooldowns.delete(key);
    }
  }

  function clientKey(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || req.socket.remoteAddress || 'unknown';
  }

  async function handlePairingRequest(req, res) {
    const now = Date.now();
    pruneCooldowns(now);

    const key = clientKey(req);
    const lastRequest = cooldowns.get(key);
    if (lastRequest && now - lastRequest < PAIRING_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((PAIRING_COOLDOWN_MS - (now - lastRequest)) / 1_000);
      sendJson(res, 429, { ok: false, error: `Please wait ${waitSeconds}s before requesting another code.` });
      return;
    }

    let payload = {};
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch (error) {
      if (error.status === 413) {
        sendJson(res, 413, { ok: false, error: error.message });
        return;
      }
      sendJson(res, 400, { ok: false, error: 'Send a JSON body, for example {"phoneNumber":"923001234567"}.' });
      return;
    }

    let number;
    try {
      const supplied = typeof payload.phoneNumber === 'string' ? payload.phoneNumber : '';
      number = assertBotNumber(supplied.trim() || config.botNumber, 'Phone number');
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
      return;
    }

    cooldowns.set(key, now);

    try {
      const code = await requestPairing(number);
      sendJson(res, 200, { ok: true, code, number });
    } catch (error) {
      sendJson(res, error.status || 502, { ok: false, error: error.message });
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/health' || pathname === '/api/health') {
      sendJson(res, 200, { ok: true, bot: config.botName, developer: DEVELOPER_NAME });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
      sendText(res, 405, 'Method not allowed.');
      return;
    }

    // Bootstrap: everything the UI needs in one request. Theme values come from
    // system/theme.js so the browser never duplicates the registry.
    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      sendJson(res, 200, {
        botName: config.botName,
        ownerName: config.ownerName,
        botNumber: config.botNumber,
        developer: DEVELOPER_NAME,
        rotationIntervalMs: ROTATION_INTERVAL_MS,
        activeThemeId: getActiveThemeId(),
        session: {
          // Whether a SESSION_ID can be copied out of this dashboard.
          exportEnabled: Boolean(config.exposeSessionId),
          configured: Boolean(config.sessionId)
        },
        themes: themes.map((theme) => ({
          id: theme.id,
          name: theme.name,
          character: theme.character,
          series: theme.series,
          icon: theme.icon,
          vibe: theme.vibe,
          tagline: theme.tagline,
          quote: theme.quote,
          images: [...theme.images],
          colors: { ...theme.colors },
          animation: { ...theme.animation },
          particles: { ...theme.particles }
        })),
        connection: getStatus()
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      sendJson(res, 200, getStatus());
      return;
    }

    // Credentials export. Disabled unless EXPOSE_SESSION_ID=true: a SESSION_ID
    // is a full WhatsApp login, so it is opt-in and never logged.
    if (req.method === 'GET' && pathname === '/api/session') {
      if (!config.exposeSessionId) {
        sendJson(res, 403, {
          ok: false,
          error: 'Session export is disabled. Set EXPOSE_SESSION_ID=true on a private deployment to enable it.'
        });
        return;
      }

      const sessionId = readSessionId(config.authDir);
      if (!sessionId) {
        sendJson(res, 404, { ok: false, error: 'No session is stored yet. Pair WhatsApp first.' });
        return;
      }

      sendJson(res, 200, { ok: true, sessionId });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pairing') {
      void handlePairingRequest(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/theme') {
      void (async () => {
        let payload = {};
        try {
          payload = JSON.parse((await readBody(req)) || '{}');
        } catch {
          sendJson(res, 400, { ok: false, error: 'Send a JSON body, for example {"themeId":"gojo"}.' });
          return;
        }

        const themeId = typeof payload.themeId === 'string' ? payload.themeId.toLowerCase() : '';
        try {
          const theme = setActiveTheme(themeId);
          sendJson(res, 200, { ok: true, activeThemeId: theme.id });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
        }
      })();
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendText(res, 404, 'Not found.');
      return;
    }

    serveStatic(req, res, pathname);
  });

  return server;
}

module.exports = {
  PAIRING_COOLDOWN_MS,
  PUBLIC_DIR,
  createWebServer
};
