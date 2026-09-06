'use strict';

// The dashboard is exercised end to end against the real server module and the
// real connection/pairing handlers exported by index.js (loaded in dry-run mode
// so no WhatsApp socket is opened).

process.env.BOT_DRY_RUN = 'true';
process.env.OWNER_NAME = 'F!xa Dev';
process.env.BOT_NUMBER = '923001234567';
process.env.THEME = 'gojo';

const assert = require('node:assert/strict');
const test = require('node:test');
const { after, before } = require('node:test');

const { config } = require('../system/config');
const { listThemes } = require('../system/theme');
const { createWebServer } = require('../system/web');
const app = require('../index');

let server;
let origin;
let requestCounter = 0;

async function call(path, { method = 'GET', body, forwardFor = `203.0.113.${(requestCounter += 1)}` } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'x-forwarded-for': forwardFor
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, headers: response.headers, payload };
}

before(async () => {
  server = createWebServer({
    config,
    themes: listThemes(),
    getActiveThemeId: app.getActiveThemeId,
    setActiveTheme: app.setActiveTheme,
    getStatus: () => ({ ...app.liveStatus, uptimeMs: Date.now() - app.liveStatus.startedAt }),
    requestPairing: app.handlePairingRequest
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('dashboard reports real configuration, themes and connection state', async () => {
  const { status, payload, headers } = await call('/api/bootstrap');
  assert.equal(status, 200);
  assert.equal(payload.developer, 'Goats Mods');
  assert.equal(payload.ownerName, 'F!xa Dev');
  assert.equal(payload.botNumber, '923001234567');
  assert.equal(payload.activeThemeId, 'gojo');
  assert.equal(payload.rotationIntervalMs, 5_000);
  assert.deepEqual(payload.themes.map((theme) => theme.id), ['makima', 'nami', 'nezuko', 'shinobu', 'gojo', 'sukuna', 'asta']);
  assert.deepEqual(payload.themes.find((theme) => theme.id === 'gojo').images[0], 'https://files.catbox.moe/lar8xz.jpg');

  // A dry-run process has no socket, so it must not claim to be connected.
  assert.equal(payload.connection.connected, false);
  assert.notEqual(payload.connection.state, 'connected');
  assert.ok(headers.get('content-security-policy').includes('files.catbox.moe'));
});

test('dashboard markup ships the developer credit and the number guidance', async () => {
  const { status, headers, payload } = await call('/');
  assert.equal(status, 200);
  assert.match(headers.get('content-type'), /text\/html/);
  assert.match(payload, /Developed By: Goats Mods/);
  assert.match(payload, /Enter your WhatsApp number with country code, without \+\./);
  assert.doesNotMatch(payload, /<select/i, 'the dashboard must not offer a country selector');
  assert.doesNotMatch(payload, /\bQR\b/, 'the dashboard must not offer QR pairing');
});

test('theme assets are served and cannot escape the public directory', async () => {
  const styles = await call('/styles.css');
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get('content-type'), /text\/css/);

  const script = await call('/app.js');
  assert.equal(script.status, 200);

  const traversal = await call('/../system/config.js');
  assert.ok([400, 404].includes(traversal.status), `expected 400/404, got ${traversal.status}`);
  assert.doesNotMatch(String(traversal.payload), /GROQ_API_KEY|groqApiKey/);

  const encoded = await call('/%2e%2e%2fsystem%2fconfig.js');
  assert.ok([400, 404].includes(encoded.status));
});

test('pairing rejects a number that includes a plus sign', async () => {
  const { status, payload } = await call('/api/pairing', { method: 'POST', body: { phoneNumber: '+923001234567' } });
  assert.equal(status, 400);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /without \+/);
});

test('pairing reports the real socket state instead of inventing a code', async () => {
  const { status, payload } = await call('/api/pairing', { method: 'POST', body: { phoneNumber: '923001234567' } });
  assert.equal(status, 503);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, undefined);
  assert.match(payload.error, /still connecting/);

  assert.equal(app.liveStatus.connected, false);
  assert.equal(app.liveStatus.pairingCode, null);
});

test('pairing is refused once WhatsApp is actually connected', async () => {
  const previous = { ...app.liveStatus };
  app.liveStatus.connected = true;

  try {
    const { status, payload } = await call('/api/pairing', {
      method: 'POST',
      body: { phoneNumber: '923001234567' },
      forwardFor: '198.51.100.99'
    });
    assert.equal(status, 409);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, undefined);
    assert.match(payload.error, /already connected/);
  } finally {
    Object.assign(app.liveStatus, previous);
  }
});

test('pairing requests are rate limited', async () => {
  const first = await call('/api/pairing', { method: 'POST', body: { phoneNumber: '923001234567' }, forwardFor: '198.51.100.7' });
  assert.equal(first.status, 503);

  const second = await call('/api/pairing', { method: 'POST', body: { phoneNumber: '923001234567' }, forwardFor: '198.51.100.7' });
  assert.equal(second.status, 429);
});

test('theme endpoint accepts anime themes and rejects a generic default', async () => {
  const rejected = await call('/api/theme', { method: 'POST', body: { themeId: 'default' } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.payload.error, /Unknown theme/);

  const accepted = await call('/api/theme', { method: 'POST', body: { themeId: 'sukuna' } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.payload.activeThemeId, 'sukuna');
  assert.equal(app.getActiveThemeId(), 'sukuna');

  const bootstrap = await call('/api/bootstrap');
  assert.equal(bootstrap.payload.activeThemeId, 'sukuna');
});

test('status endpoint mirrors the live connection object', async () => {
  const { status, payload } = await call('/api/status');
  assert.equal(status, 200);
  assert.equal(typeof payload.state, 'string');
  assert.equal(payload.connected, false);
  assert.equal(typeof payload.uptimeMs, 'number');

  const health = await call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.payload.ok, true);
});

// --- session export gating -------------------------------------------------

test('never exports the session unless it is explicitly enabled', async () => {
  const denied = await call('/api/session');
  assert.equal(denied.status, 403);
  assert.equal(denied.payload.ok, false);
  assert.match(denied.payload.error, /EXPOSE_SESSION_ID/);
});

test('exports the paired session as a portable SESSION_ID when enabled', async () => {
  const { once } = require('node:events');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-session-'));
  const creds = {
    registrationId: 7,
    noiseKey: { private: { type: 'Buffer', data: [1] }, public: { type: 'Buffer', data: [2] } },
    me: { id: '923001234567:1@s.whatsapp.net', name: 'Owner' }
  };
  fs.writeFileSync(path.join(authDir, 'creds.json'), JSON.stringify(creds), 'utf8');

  const unlocked = createWebServer({
    config: { ...config, authDir, exposeSessionId: true },
    themes: listThemes(),
    getActiveThemeId: app.getActiveThemeId,
    setActiveTheme: app.setActiveTheme,
    getStatus: () => ({ ...app.liveStatus }),
    requestPairing: app.handlePairingRequest
  });

  await new Promise((resolve) => unlocked.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${unlocked.address().port}`;

  try {
    const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
    assert.equal(bootstrap.session.exportEnabled, true);

    const response = await fetch(`${base}/api/session`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(JSON.parse(body.sessionId).registrationId, 7);

    // No credentials in the locked dashboard's bootstrap payload.
    const lockedBootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
    assert.equal(lockedBootstrap.session.exportEnabled, false);
    assert.equal(JSON.stringify(lockedBootstrap).includes('noiseKey'), false);
  } finally {
    unlocked.close();
    await once(unlocked, 'close');
  }
});

test('reports 404 for a session export before pairing', async () => {
  const { once } = require('node:events');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-session-empty-'));
  const unlocked = createWebServer({
    config: { ...config, authDir: emptyDir, exposeSessionId: true },
    themes: listThemes(),
    getActiveThemeId: app.getActiveThemeId,
    setActiveTheme: app.setActiveTheme,
    getStatus: () => ({ ...app.liveStatus }),
    requestPairing: app.handlePairingRequest
  });

  await new Promise((resolve) => unlocked.listen(0, '127.0.0.1', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${unlocked.address().port}/api/session`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).ok, false);
  } finally {
    unlocked.close();
    await once(unlocked, 'close');
  }
});
