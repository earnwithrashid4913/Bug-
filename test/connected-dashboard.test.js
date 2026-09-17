'use strict';

// ---------------------------------------------------------------------------
// Targeted coverage for the connected experience:
//
//   * the connected dashboard — real state, real (unmasked) number, real
//     timestamps, uptime, reconnects, last event/update, per-session isolation,
//   * the optional welcome video on a successful connection — on / off /
//     fallback, bounded caption, never able to break the connection,
//   * `!menu` — case-insensitive, prefix/alias preserving,
//   * the menu itself — rendered by the ONE real command registry, complete,
//     duplicate-free, hidden-free and executable through the one dispatcher.
//
// Every assertion drives the production modules directly: no second renderer,
// no second registry and no invented session state.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  OFFLINE_UPTIME,
  SESSION_STATES,
  UNKNOWN_VALUE,
  canonicalSessionState,
  createSessionStatus,
  formatDuration,
  formatSessionNumber,
  formatTimestamp,
  resolveSessionView,
  safeSessionNumber,
  sessionDashboard,
  sessionDigits,
  snapshotSessionStatus,
  stateEventLabel,
  transitionSessionStatus
} = require('../system/lib/session-status');
const {
  MAX_MEDIA_CAPTION_LENGTH,
  connectionCardCaption,
  safeMediaCaption,
  sendWelcomeVideo,
  welcomeCaption
} = require('../system/lib/connection-welcome');
const { COMMANDS, STATIC_COMMANDS, allAliases, categoriesWithCommands, helpText, resolveCommand } = require('../system/lib/menu');
const handler = require('../system/handler');
const { audit, inspect } = require('../scripts/command-registry-check');

const OWN_JID = '923001234567:12@s.whatsapp.net';
const OTHER_JID = '6281234567890:3@s.whatsapp.net';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function socketFor(jid, { status } = {}) {
  const socket = { user: jid === undefined ? {} : { id: jid, name: 'Anime MD' }, sends: [] };
  socket.sendMessage = async (target, payload) => { socket.sends.push({ target, payload }); return { key: { id: 'sent' } }; };
  if (status) socket.animeSessionStatus = status;
  return socket;
}

function connectedStatus(number, { id = 'primary', ago = 0 } = {}) {
  const status = createSessionStatus(id);
  status.safeNumber = sessionDigits(number);
  status.sessionLabel = 'paired';
  transitionSessionStatus(status, SESSION_STATES.CONNECTED);
  if (ago) status.connectedAt = Date.now() - ago;
  return status;
}

// ---------------------------------------------------------------------------
// 1. The number on the dashboard.
// ---------------------------------------------------------------------------

test('the connected dashboard shows the ACTUAL session number, unmasked', () => {
  const socket = socketFor(OWN_JID);
  const status = connectedStatus(OWN_JID);
  const dashboard = sessionDashboard(status, { socket });

  assert.match(dashboard, /📱 Session: \+923001234567/);
  assert.doesNotMatch(dashboard, /📱[^\n]*•/, 'a private dashboard never masks the number');
  assert.doesNotMatch(dashboard, new RegExp(escapeRegExp(UNKNOWN_VALUE)));

  // Not hardcoded: a different authenticated session renders its own number.
  const other = sessionDashboard(connectedStatus(OTHER_JID, { id: 'paired-2' }), { socket: socketFor(OTHER_JID) });
  assert.match(other, /📱 Session: \+6281234567890/);
  assert.notEqual(dashboard, other);

  // Identity comes from the session's own authenticated JID, device suffix and
  // formatting included, and a value that is not a phone number is never
  // presented as one.
  assert.equal(sessionDigits('923001234567:5@s.whatsapp.net'), '923001234567');
  assert.equal(sessionDigits('+92 300 1234567'), '923001234567');
  assert.equal(sessionDigits('123456789@lid'), '', 'a LID identity is not a phone number');
  assert.equal(sessionDigits('123456789-1234@g.us'), '', 'a group JID is not a phone number');
  assert.equal(formatSessionNumber('+92 300 1234567'), '+923001234567');
  assert.match(
    sessionDashboard(connectedStatus('123456789@lid', { id: 'lid' }), { socket: socketFor('123456789@lid') }),
    new RegExp(`📱 Session: ${escapeRegExp(UNKNOWN_VALUE)}`)
  );

  // Public/group surfaces keep masking, and a display that is already masked is
  // rendered verbatim instead of being re-derived into a different number.
  const publicDashboard = sessionDashboard(status, { socket, maskNumber: true });
  assert.match(publicDashboard, /📱 Session: [^\n]*•/);
  assert.doesNotMatch(publicDashboard, /\+923001234567/);
  assert.equal(formatSessionNumber('+92 300••••567'), '+92 300••••567');
  assert.equal(formatSessionNumber('+92 300••••567', { masked: true }), '+92 300••••567');
  assert.equal(formatSessionNumber('+923001234567', { masked: true }), safeSessionNumber('923001234567'));
  assert.equal(safeSessionNumber('not-a-number'), UNKNOWN_VALUE);

  // Nothing in the connection path hardcodes a number.
  for (const file of ['../index.js', '../system/lib/connection-welcome.js']) {
    const source = fsSync.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotMatch(source, /92300\d{7}|923001234567/, `${file} hardcodes a session number`);
  }
});

// ---------------------------------------------------------------------------
// 2. Connection states.
// ---------------------------------------------------------------------------

test('CONNECTED comes only from a real connection open and every state is distinct', () => {
  const status = createSessionStatus('primary');
  assert.equal(status.connected, false);
  assert.match(sessionDashboard(status), /🟡 Status: STARTING/);

  // Creating a socket, generating a pairing code or restoring a session folder
  // never marks a session CONNECTED and never fakes a connection time.
  for (const state of [SESSION_STATES.STARTING, SESSION_STATES.CONNECTING, SESSION_STATES.PAIRING, SESSION_STATES.TELEGRAM_PAIRING, SESSION_STATES.RECONNECTING, SESSION_STATES.DISCONNECTED]) {
    transitionSessionStatus(status, state);
    assert.equal(status.connected, false, `${state} must not claim a connection`);
    assert.equal(status.connectedAt, null, `${state} must not fake a connection time`);
    assert.doesNotMatch(sessionDashboard(status), /🟢 Status: CONNECTED/);
  }

  transitionSessionStatus(status, SESSION_STATES.CONNECTED);
  assert.equal(status.connected, true);
  assert.match(sessionDashboard(status), /🟢 Status: CONNECTED/);

  // CONNECTING / CONNECTED / DISCONNECTED / RECONNECTING / LOGGED_OUT / FAILED
  // are all distinguishable on the dashboard.
  const labels = new Map();
  for (const state of Object.values(SESSION_STATES)) {
    const probe = createSessionStatus('probe');
    transitionSessionStatus(probe, SESSION_STATES.CONNECTED);
    transitionSessionStatus(probe, state);
    labels.set(state, sessionDashboard(probe).split('\n')[0]);
  }
  assert.equal(labels.size, new Set(labels.values()).size, 'two states must never render the same line');
  assert.match(labels.get(SESSION_STATES.CONNECTING), /^🟡 Status: CONNECTING$/);
  assert.match(labels.get(SESSION_STATES.CONNECTED), /^🟢 Status: CONNECTED$/);
  assert.match(labels.get(SESSION_STATES.DISCONNECTED), /^🔴 Status: DISCONNECTED$/);
  assert.match(labels.get(SESSION_STATES.RECONNECTING), /^🔵 Status: RECONNECTING$/);
  assert.match(labels.get(SESSION_STATES.LOGGED_OUT), /^⚪ Status: LOGGED_OUT$/);
  assert.match(labels.get(SESSION_STATES.ERROR), /^⚠️ Status: FAILED$/);

  // The pairing manager's own lifecycle vocabulary is canonicalised instead of
  // being forced into a false FAILED.
  const snapshotState = (word, extra = {}) => sessionDashboard({ id: 'snap', state: word, lastUpdate: Date.now(), ...extra }).split('\n')[0];
  assert.equal(snapshotState('offline'), '🔴 Status: DISCONNECTED');
  assert.equal(snapshotState('ready'), '🟣 Status: PAIRING');
  assert.equal(snapshotState('received'), '🟡 Status: CONNECTING');
  assert.equal(snapshotState('initializing'), '🟡 Status: STARTING');
  assert.equal(snapshotState('cleanup'), '🔴 Status: DISCONNECTED');
  assert.equal(snapshotState('failed'), '⚠️ Status: FAILED');
  assert.equal(snapshotState('garbage'), '⚠️ Status: FAILED', 'a state nobody can explain is reported as a failure');
  assert.equal(snapshotState('garbage', { connected: false }), '🔴 Status: DISCONNECTED', 'the session\'s own connected flag wins');
  assert.equal(canonicalSessionState('garbage', { strict: true }), SESSION_STATES.ERROR);
});

// ---------------------------------------------------------------------------
// 3. Timestamps.
// ---------------------------------------------------------------------------

test('Connected Since and Last Update are real timestamps, never stale or hardcoded', () => {
  const status = createSessionStatus('primary');
  const before = Date.now();
  transitionSessionStatus(status, SESSION_STATES.CONNECTED);
  const after = Date.now();

  assert.ok(status.connectedAt >= before && status.connectedAt <= after, 'connectedAt is the real transition time');
  const dashboard = sessionDashboard(status);
  assert.match(dashboard, new RegExp(`📅 Connected Since: ${escapeRegExp(formatTimestamp(status.connectedAt))}`));
  assert.match(dashboard, new RegExp(`🕐 Last Update: ${escapeRegExp(formatTimestamp(status.lastUpdate))}`));
  assert.doesNotMatch(dashboard, /NaN|Invalid Date|1970|undefined/);

  // A duplicate open never resets the connection clock.
  const firstConnect = status.connectedAt;
  transitionSessionStatus(status, SESSION_STATES.CONNECTED);
  assert.equal(status.connectedAt, firstConnect);

  // Disconnecting stops the clock; the old connection time is never reused.
  transitionSessionStatus(status, SESSION_STATES.DISCONNECTED);
  assert.equal(status.connected, false);
  assert.match(sessionDashboard(status), new RegExp(`📅 Connected Since: ${escapeRegExp(UNKNOWN_VALUE)}`));
  assert.equal(snapshotSessionStatus(status).connectedSince, UNKNOWN_VALUE);

  // Reconnecting writes a NEW real timestamp.
  transitionSessionStatus(status, SESSION_STATES.CONNECTED);
  assert.ok(status.connectedAt >= firstConnect);
  assert.match(sessionDashboard(status), /📅 Connected Since: \d{2} [A-Za-z]{3,4} \d{4} • \d{2}:\d{2}:\d{2} UTC/);

  // A terminal logout drops the identity and the clock, so a NEW session can
  // never inherit either.
  status.safeNumber = '923001234567';
  transitionSessionStatus(status, SESSION_STATES.LOGGED_OUT);
  assert.equal(status.connectedAt, null);
  assert.equal(status.safeNumber, null);
  assert.match(sessionDashboard(status), /⚪ Status: LOGGED_OUT/);
  assert.match(sessionDashboard(status), new RegExp(`📱 Session: ${escapeRegExp(UNKNOWN_VALUE)}`));

  // No hardcoded dates in the renderer.
  const source = fsSync.readFileSync(path.join(__dirname, '../system/lib/session-status.js'), 'utf8');
  assert.doesNotMatch(source, /new Date\(\s*['"\d]/);
  assert.doesNotMatch(source, /20\d{2}-\d{2}-\d{2}/);
});

// ---------------------------------------------------------------------------
// 4. Uptime.
// ---------------------------------------------------------------------------

test('uptime comes from the real connection clock and is never negative or NaN', () => {
  const connected = connectedStatus(OWN_JID, { ago: (1 * 3600 + 2 * 60 + 5) * 1000 });
  assert.match(sessionDashboard(connected), /⏱️ Uptime: 01h 02m 0[45]s/);

  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(Number.NaN), null);
  assert.equal(formatDuration('not-a-time'), null);
  assert.equal(formatDuration(Date.now() + 60_000), null, 'a future clock never renders a negative duration');

  const broken = createSessionStatus('broken');
  transitionSessionStatus(broken, SESSION_STATES.CONNECTED);
  broken.connectedAt = Number.NaN;
  const brokenText = sessionDashboard(broken);
  assert.doesNotMatch(brokenText, /NaN|Invalid|-\d/);
  assert.match(brokenText, /⏱️ Uptime: \d{2}h \d{2}m \d{2}s/);

  // A live session that is not connected has no running connection clock.
  const offline = createSessionStatus('offline');
  transitionSessionStatus(offline, SESSION_STATES.CONNECTED);
  transitionSessionStatus(offline, SESSION_STATES.DISCONNECTED);
  assert.match(sessionDashboard(offline), new RegExp(`⏱️ Uptime: ${OFFLINE_UPTIME}`));

  // With no live mirror at all the dashboard derives from the real process
  // runtime instead of printing placeholders — and a closed transport is never
  // reported as connected.
  const derived = sessionDashboard(null, { socket: socketFor(OWN_JID) });
  assert.match(derived, /🟢 Status: CONNECTED/);
  assert.match(derived, /⏱️ Uptime: \d{2}h \d{2}m \d{2}s/);
  assert.match(derived, /📱 Session: \+923001234567/);
  const closed = sessionDashboard(null, { socket: { user: { id: OWN_JID }, ws: { isOpen: false } } });
  assert.match(closed, /🔴 Status: DISCONNECTED/);
  assert.doesNotMatch(closed, /🟢/);
});

// ---------------------------------------------------------------------------
// 5. Reconnects.
// ---------------------------------------------------------------------------

test('reconnects count real re-established connections only', () => {
  const status = createSessionStatus('primary');
  transitionSessionStatus(status, SESSION_STATES.CONNECTED);
  assert.equal(status.reconnects, 0, 'the first connect of a session is not a reconnect');

  // Duplicate open events add nothing.
  transitionSessionStatus(status, SESSION_STATES.CONNECTED);
  transitionSessionStatus(status, SESSION_STATES.CONNECTED);
  assert.equal(status.reconnects, 0);
  assert.match(sessionDashboard(status), /🔄 Reconnects: 0/);

  // Offline noise is not a reconnect either.
  transitionSessionStatus(status, SESSION_STATES.DISCONNECTED);
  transitionSessionStatus(status, SESSION_STATES.RECONNECTING);
  transitionSessionStatus(status, SESSION_STATES.DISCONNECTED);
  assert.equal(status.reconnects, 0);

  transitionSessionStatus(status, SESSION_STATES.CONNECTED);
  assert.equal(status.reconnects, 1);
  transitionSessionStatus(status, SESSION_STATES.DISCONNECTED);
  transitionSessionStatus(status, SESSION_STATES.CONNECTED);
  assert.equal(status.reconnects, 2);
  assert.match(sessionDashboard(status), /🔄 Reconnects: 2/);
  assert.equal(snapshotSessionStatus(status).reconnects, 2);

  // Rendering is read-only: it can never inflate the counter.
  for (let render = 0; render < 5; render += 1) sessionDashboard(status);
  assert.equal(status.reconnects, 2);

  // A brand new session object starts clean.
  assert.equal(createSessionStatus('primary').reconnects, 0);
  // A corrupted counter can never render as a negative or NaN value.
  const corrupted = connectedStatus(OWN_JID);
  corrupted.reconnects = Number.NaN;
  assert.match(sessionDashboard(corrupted), /🔄 Reconnects: 0/);
  corrupted.reconnects = -4;
  assert.match(sessionDashboard(corrupted), /🔄 Reconnects: 0/);
});

// ---------------------------------------------------------------------------
// 6. Last event / last update.
// ---------------------------------------------------------------------------

test('Last Event and Last Update report the actual lifecycle transition', () => {
  const status = createSessionStatus('primary');
  const events = [];
  for (const state of [SESSION_STATES.CONNECTING, SESSION_STATES.CONNECTED, SESSION_STATES.RECONNECTING, SESSION_STATES.CONNECTED, SESSION_STATES.DISCONNECTED, SESSION_STATES.LOGGED_OUT]) {
    const before = Date.now();
    transitionSessionStatus(status, state);
    assert.ok(status.lastUpdate >= before && status.lastUpdate <= Date.now(), 'lastUpdate is the real update time');
    events.push(status.lastEvent);
    assert.match(sessionDashboard(status), new RegExp(`⚡ Last Event: ${escapeRegExp(status.lastEvent)}`));
    assert.match(sessionDashboard(status), new RegExp(`🕐 Last Update: ${escapeRegExp(formatTimestamp(status.lastUpdate))}`));
  }
  assert.deepEqual(events, ['CONNECTING', 'CONNECTED', 'RECONNECTING', 'CONNECTED', 'DISCONNECTED', 'LOGGED_OUT']);

  assert.equal(stateEventLabel('telegram_pairing'), 'TELEGRAM_PAIRING');
  assert.equal(stateEventLabel(''), 'STARTING');

  // A human sentence stays a log message: it is never reported as an event.
  const prose = createSessionStatus('prose');
  transitionSessionStatus(prose, SESSION_STATES.CONNECTED);
  prose.message = 'WhatsApp connected successfully';
  const dashboard = sessionDashboard(prose);
  assert.match(dashboard, /⚡ Last Event: CONNECTED/);
  assert.doesNotMatch(dashboard, /successfully/);
});

// ---------------------------------------------------------------------------
// 7. Session association and isolation.
// ---------------------------------------------------------------------------

test('sessions are isolated: one lifecycle never touches another session', () => {
  const primary = connectedStatus(OWN_JID, { id: 'primary' });
  const paired = createSessionStatus('923009999999');
  paired.safeNumber = '923009999999';
  transitionSessionStatus(paired, SESSION_STATES.CONNECTING);
  const untouched = JSON.parse(JSON.stringify(paired));

  // The primary session drops, reconnects and logs out.
  transitionSessionStatus(primary, SESSION_STATES.DISCONNECTED);
  transitionSessionStatus(primary, SESSION_STATES.CONNECTED);
  transitionSessionStatus(primary, SESSION_STATES.LOGGED_OUT);

  assert.deepEqual(JSON.parse(JSON.stringify(paired)), untouched, 'the paired session is untouched');
  assert.match(sessionDashboard(paired), /🟡 Status: CONNECTING/);
  assert.match(sessionDashboard(paired), /📱 Session: \+923009999999/);
  assert.match(sessionDashboard(primary), new RegExp(`📱 Session: ${escapeRegExp(UNKNOWN_VALUE)}`), 'a logged-out session keeps no stale number');

  // A stale socket can never overwrite the identity of the session rendered.
  assert.equal(resolveSessionView(socketFor(OTHER_JID), paired).number, '923009999999');
  assert.match(sessionDashboard(paired, { socket: socketFor(OTHER_JID) }), /📱 Session: \+923009999999/);

  // Each session's own snapshot carries its own values.
  const primarySnapshot = snapshotSessionStatus(connectedStatus(OWN_JID, { id: 'primary' }), undefined, { socket: socketFor(OWN_JID) });
  const pairedSnapshot = snapshotSessionStatus(paired, undefined, { socket: socketFor('923009999999@s.whatsapp.net') });
  assert.equal(primarySnapshot.session, '+923001234567');
  assert.equal(pairedSnapshot.session, '+923009999999');
  assert.equal(primarySnapshot.connected, true);
  assert.equal(pairedSnapshot.connected, false);
});

// ---------------------------------------------------------------------------
// 8. The welcome video on a successful connection.
// ---------------------------------------------------------------------------

test('the welcome video is optional, bounded and can never break the connection', async () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'anime-dashboard-'));
  const video = path.join(dir, 'welcome.mp4');
  fsSync.writeFileSync(video, Buffer.alloc(4096, 7));
  const warnings = [];
  const log = { warn: (message) => warnings.push(String(message)), info() {}, error() {} };

  try {
    // OFF: nothing is read, fetched or sent.
    const off = socketFor(OWN_JID, { status: connectedStatus(OWN_JID) });
    assert.deepEqual(await sendWelcomeVideo(off, { enabled: false, source: 'local', path: video }, { log }), { status: 'off' });
    assert.equal(off.sends.length, 0);
    assert.deepEqual(warnings, []);

    // ON: the real connected dashboard travels with the video as its caption,
    // to the authenticated own chat only.
    const status = connectedStatus(OWN_JID);
    const socket = socketFor(OWN_JID, { status });
    assert.deepEqual(await sendWelcomeVideo(socket, { enabled: true, source: 'local', path: video }, { log }), { status: 'sent' });
    assert.equal(socket.sends.length, 1);
    const { target, payload } = socket.sends[0];
    assert.equal(target, '923001234567@s.whatsapp.net', 'the video goes to the authenticated own chat only');
    assert.ok(payload.video, 'a video payload is sent');
    assert.equal(payload.mimetype, 'video/mp4');
    assert.ok(payload.caption.length <= MAX_MEDIA_CAPTION_LENGTH, `the caption stays inside the WhatsApp media limit (${payload.caption.length})`);
    assert.match(payload.caption, /🟢 Status: CONNECTED/);
    assert.match(payload.caption, /📱 Session: \+923001234567/);
    assert.match(payload.caption, /⏱️ Uptime: \d{2}h \d{2}m \d{2}s/);
    assert.match(payload.caption.normalize('NFKC'), /📱 NUMBER : \+923001234567/);
    assert.doesNotMatch(payload.caption, /📱[^\n]*•/, 'the welcome caption never masks the number');

    // A configured remote video is fetched into a bounded buffer and sent.
    const remote = socketFor(OWN_JID, { status: connectedStatus(OWN_JID) });
    const remoteResult = await sendWelcomeVideo(remote, { enabled: true, source: 'url', url: 'https://cdn.example/welcome.mp4', timeoutMs: 1000 }, {
      log,
      fetchImpl: async () => new Response(Buffer.alloc(2048, 3), { headers: { 'content-type': 'video/mp4', 'content-length': '2048' } })
    });
    assert.equal(remoteResult.status, 'sent');
    assert.ok(Buffer.isBuffer(remote.sends[0].payload.video), 'a remote video is sent as a bounded buffer, not a URL');

    // Every failure falls back cleanly: no throw, no send, and the dashboard
    // card the caller renders next is unaffected.
    const missing = socketFor(OWN_JID);
    assert.deepEqual(await sendWelcomeVideo(missing, { enabled: true, source: 'local', path: path.join(dir, 'absent.mp4') }, { log }), { status: 'failed' });
    assert.equal(missing.sends.length, 0);

    const refusing = socketFor(OWN_JID);
    refusing.sendMessage = async () => { throw new Error('463 media upload failed'); };
    assert.deepEqual(await sendWelcomeVideo(refusing, { enabled: true, source: 'local', path: video }, { log }), { status: 'failed' });

    const offline = socketFor(OWN_JID);
    assert.deepEqual(await sendWelcomeVideo(offline, { enabled: true, source: 'url', url: 'https://cdn.example/welcome.mp4', timeoutMs: 500 }, {
      log,
      fetchImpl: async () => { throw new Error('ENOTFOUND cdn.example'); }
    }), { status: 'failed' });
    assert.equal(offline.sends.length, 0);

    // A group, a broadcast or a missing identity is never a destination.
    for (const jid of ['123456789-1234@g.us', 'status@broadcast', 'owner', undefined]) {
      const guarded = socketFor(jid);
      assert.deepEqual(await sendWelcomeVideo(guarded, { enabled: true, source: 'local', path: video }, { log }), { status: 'failed' });
      assert.equal(guarded.sends.length, 0);
    }

    // A LID is a real WhatsApp identity, so the own-chat welcome is delivered to
    // it — but a LID is not a phone number and must never be shown as one.
    const lid = socketFor('123456789@lid', { status: connectedStatus('123456789@lid', { id: 'lid' }) });
    assert.deepEqual(await sendWelcomeVideo(lid, { enabled: true, source: 'local', path: video }, { log }), { status: 'sent' });
    assert.equal(lid.sends[0].target, '123456789@lid');
    assert.match(lid.sends[0].payload.caption.normalize('NFKC'), new RegExp(`NUMBER : ${escapeRegExp(UNKNOWN_VALUE)}`));
    assert.match(lid.sends[0].payload.caption, new RegExp(`📱 Session: ${escapeRegExp(UNKNOWN_VALUE)}`));
    assert.doesNotMatch(lid.sends[0].payload.caption, /\+\d{7,15}/);

    // Only the bounded stage token is logged: no path, URL, JID or credential.
    assert.ok(warnings.length >= 4, 'each skip is logged once');
    for (const line of warnings) {
      assert.match(line, /^\[connection-welcome\] Video skipped \([A-Z_]+\)\.$/);
      assert.doesNotMatch(line, /welcome\.mp4|absent\.mp4|cdn\.example|@s\.whatsapp\.net|@g\.us|@lid|@broadcast|ENOTFOUND|463/);
    }
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test('the welcome caption carries the real dashboard inside the media caption limit', () => {
  const status = connectedStatus(OWN_JID);
  const socket = socketFor(OWN_JID, { status });
  const compact = welcomeCaption(socket, status);
  const full = connectionCardCaption(socket, status);

  assert.ok(compact.length <= MAX_MEDIA_CAPTION_LENGTH, `the video caption must fit a media caption (${compact.length})`);
  assert.equal(safeMediaCaption(compact), compact);
  assert.match(compact, /🟢 Status: CONNECTED/);
  assert.match(compact, /📱 Session: \+923001234567/);
  assert.doesNotMatch(compact, /🔄 Reconnects:/, 'the compact dashboard keeps the media caption bounded');

  // The text card carries the complete dashboard.
  assert.match(full, /🔄 Reconnects: 0/);
  assert.match(full, /⚡ Last Event: CONNECTED/);
  assert.match(full, /🕐 Last Update: \d{2} [A-Za-z]{3,4} \d{4} • \d{2}:\d{2}:\d{2} UTC/);
  assert.ok(full.length > compact.length);
  const bounded = safeMediaCaption(full);
  assert.ok(bounded.length <= MAX_MEDIA_CAPTION_LENGTH);
  assert.match(bounded, /…$/);

  // Without a live mirror the caption is still honest: derived from the socket.
  const bare = welcomeCaption(socketFor(OWN_JID));
  assert.match(bare, /🟢 Status: CONNECTED/);
  assert.match(bare, /📱 Session: \+923001234567/);
  assert.ok(bare.length <= MAX_MEDIA_CAPTION_LENGTH);
});

// ---------------------------------------------------------------------------
// 9. !menu.
// ---------------------------------------------------------------------------

test('!menu is case-insensitive and keeps prefix and alias behaviour', () => {
  const prefix = handler.getCommandPrefix();
  assert.ok(prefix, 'the configured prefix is used');
  const menu = resolveCommand('menu');
  assert.ok(menu, 'the menu command exists in the registry');

  for (const variant of ['menu', 'Menu', 'MENU', 'mEnU', 'MeNu']) {
    const parsed = handler.commandFromText(`${prefix}${variant}`);
    assert.ok(parsed, `${prefix}${variant} is parsed`);
    assert.equal(parsed.name, 'menu', `${prefix}${variant} resolves to the menu command`);
    assert.equal(resolveCommand(parsed.name), menu);
    assert.equal(resolveCommand(variant), menu, 'registry lookup is case-insensitive too');
    assert.deepEqual(parsed.args, []);
  }

  // A category argument survives the case folding, with its capitalization.
  const withCategory = handler.commandFromText(`${prefix}MENU Downloader`);
  assert.equal(withCategory.name, 'menu');
  assert.equal(withCategory.text, 'Downloader');
  assert.deepEqual(withCategory.args, ['Downloader']);

  // Every alias of the menu command behaves the same way.
  for (const alias of menu.aliases) {
    assert.equal(resolveCommand(alias), menu);
    assert.equal(handler.commandFromText(`${prefix}${alias.toUpperCase()}`).name, alias);
  }

  // The prefix is still required, and the parse never invents a command.
  assert.equal(handler.commandFromText('menu'), undefined);
  assert.equal(handler.commandFromText(`${prefix}`), undefined);
  assert.equal(resolveCommand('notacommand'), undefined);
  for (const dangerous of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(resolveCommand(dangerous), undefined);
});

// ---------------------------------------------------------------------------
// 10. The menu is the real registry.
// ---------------------------------------------------------------------------

test('the menu is rendered from the real registry with no fake, duplicate or stale entries', () => {
  const result = audit();
  const hidden = result.hidden;
  assert.ok(hidden.length > 0, 'manual-only triggers stay out of the public registry');
  assert.equal(COMMANDS.length, STATIC_COMMANDS.length, 'no command is filtered out of the public registry');

  const declared = new Map();
  for (const command of COMMANDS) for (const name of [command.name, ...command.aliases]) {
    assert.ok(!declared.has(name), `duplicate execute name: ${name}`);
    declared.set(name, command);
  }
  assert.equal(declared.size, allAliases().length, 'the alias table and the registry agree');

  const categories = categoriesWithCommands();
  assert.equal(categories.length, result.categories.length);
  const covered = new Set();

  for (const category of categories) {
    const text = helpText('!', category.id);
    assert.match(text, /^Type !menu for all categories\.$/m, 'every category menu points back at the real root menu');
    const listing = text.split('\n').filter((line) => !/^Type !menu\b/.test(line.trim())).join('\n');
    const tokens = [...new Set([...listing.matchAll(/(?:^|[\s(,])!([a-z][a-z0-9]*)\b/gm)].map((match) => match[1]))];
    assert.ok(tokens.length > 0, `the ${category.id} menu is empty`);

    // Every rendered token is a real, executable command of THIS category.
    for (const token of tokens) {
      const command = resolveCommand(token);
      assert.ok(command, `the menu lists an unknown command: !${token}`);
      assert.equal(command.category, category.id, `!${token} is listed under the wrong category`);
      assert.ok(!hidden.includes(token), `a manual-only trigger leaked into the menu: !${token}`);
    }

    // Every public command of the category is listed with all of its aliases.
    for (const command of category.commands) {
      covered.add(command.name);
      for (const name of [command.name, ...command.aliases]) {
        assert.ok(tokens.includes(name), `!${name} is missing from the ${category.id} menu`);
        assert.equal(resolveCommand(name), command, `!${name} does not resolve to !${command.name}`);
      }
    }
    assert.doesNotMatch(text, /undefined|NaN|\[object Object\]/);
  }

  assert.equal(covered.size, COMMANDS.length, 'every public command appears in a category menu');

  // Manual-only triggers stay hidden everywhere.
  for (const trigger of hidden) {
    assert.equal(resolveCommand(trigger), undefined);
    assert.ok(!COMMANDS.some((command) => command.name === trigger || command.aliases.includes(trigger)));
    // Word-boundary match: a single-letter trigger such as !h must not be
    // "found" inside a real public command such as !help.
    const leaked = new RegExp(`!${trigger}\\b`);
    for (const category of categories) assert.doesNotMatch(helpText('!', category.id), leaked, `!${trigger} leaked into the ${category.id} menu`);
    assert.doesNotMatch(helpText('!'), leaked);
  }

  // The root menu lists the real categories and nothing else.
  const root = helpText('!');
  for (const category of categories) assert.match(root, new RegExp(`!menu ${category.id}`));
  assert.equal((root.match(/^\d+\. /gm) || []).length, categories.length, 'one root menu row per real category');
});

test('every command the menu lists is executable through the one dispatcher', () => {
  const { routes } = inspect();
  const byName = new Map(routes.map((route) => [route.name, route]));
  assert.equal(routes.length, allAliases().length, 'the dispatcher serves exactly the registry');

  for (const command of COMMANDS) {
    const canonical = byName.get(command.name);
    assert.ok(canonical, `!${command.name} has no dispatcher route`);
    assert.ok(canonical.body.trim().length > 0, `!${command.name} has an empty dispatcher branch`);
    assert.ok(canonical.targets.length > 0, `!${command.name} never reaches a handler`);
    for (const alias of command.aliases) {
      const route = byName.get(alias);
      assert.ok(route, `!${alias} is listed in the menu but has no dispatcher route`);
      assert.equal(route.body, canonical.body, `!${alias} reaches a different branch than !${command.name}`);
    }
  }
});
