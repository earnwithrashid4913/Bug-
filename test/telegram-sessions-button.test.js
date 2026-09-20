'use strict';

// ---------------------------------------------------------------------------
// Regression coverage for the Telegram SESSIONS button (admin:sessions /
// owner:sessions / /listpaired).
//
// The button used to fail with
//   "this.pairing.listAllSessions(...).catch is not a function"
// because the controller treated a synchronous return value as a Promise.
// These tests drive the REAL TelegramController with the pairing binding wired
// exactly like index.js does, and cover the states the button has to survive:
//   * a synchronous listAllSessions() implementation (the historical binding),
//   * an async one,
//   * 0 / 1 / many sessions,
//   * stale or invalid session entries,
//   * reconnecting / disconnected / offline sessions,
//   * a genuine read failure (clean card, never raw JavaScript),
//   * the role-aware number rule (Admin/Owner full, group masked).
// ---------------------------------------------------------------------------

const { displayAssert: assert, normalizeTelegramText } = require('../test-support/telegram-display');
const test = require('node:test');
const { TelegramController, VIEWER, displayNumber, viewerRoleFromAccess } = require('../system/lib/telegram-controller');

function memoryStore({ controllers = [], verified = new Set() } = {}) {
  return {
    has: async (id) => controllers.includes(String(id)),
    add: async (id) => { controllers.push(String(id)); return controllers; },
    remove: async () => true,
    read: async () => [...controllers],
    getSettings: async () => ({}),
    setSetting: async (_k, v) => v,
    getUser: async (id) => (verified.has(String(id)) ? { verified: true } : undefined),
    updateUser: async (id, patch) => {
      if (patch.verified === true) verified.add(String(id));
      return { verified: verified.has(String(id)) };
    },
    listPremium: async () => [],
    pairedNumbersOf: async () => [],
    addPairedNumber: async () => {},
    removePairedNumber: async () => {},
    isVerified: async (id) => verified.has(String(id)),
    markVerified: async () => {},
    blockStatus: async () => ({ blocked: false }),
    users: async () => ({})
  };
}

// Exactly the shape index.js passes to the controller: plain functions bound to
// the pairing manager. `listAllSessions` here is SYNCHRONOUS on purpose — that
// is the binding that used to break the Sessions button.
function pairingWith(sessions, { sync = true, fail = false } = {}) {
  const list = () => {
    if (fail) throw new TypeError('this.pairing.listAllSessions(...).catch is not a function');
    return sessions;
  };
  return {
    requestPairing: async (_ownerId, number) => ({ code: 'KJ4MNP2X', displayCode: 'KJ4M-NP2X', brand: 'WhatsApp-generated', number, numberDisplay: `+${number}`, expiresAt: Date.now() + 300_000 }),
    listSessions: async () => sessions,
    listAllSessions: sync ? list : async () => list(),
    queuedPairingCount: () => 0,
    statusOf: async (_ownerId, number) => sessions.find((session) => session.number === number) || {},
    stopSession: async () => ({}),
    restartSession: async () => ({})
  };
}

function makeController({ pairing, owners = ['10'], controllers = [], verified = new Set(['10']) } = {}) {
  const calls = [];
  const controller = new TelegramController({
    token: 'token',
    owners,
    controllerStore: memoryStore({ controllers, verified }),
    pairing,
    fetchImpl: async (_url, init) => ({ ok: true, json: async () => ({ ok: true, result: JSON.parse(init.body) }) }),
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  controller.running = true;
  return { controller, calls };
}

async function clickSessions(controller, { data = 'admin:sessions', from = 10, chat = { id: 1 } } = {}) {
  const sent = [];
  controller.reply = async (chatId, text, markup) => sent.push({ chatId, text, markup });
  controller.present = async (chatId, messageId, text, markup) => {
    sent.push({ chatId, text, markup, edited: true });
    return {};
  };
  await controller.handleUpdate({
    callback_query: { id: 'cb', from: { id: from }, data, message: { chat, message_id: 7 } }
  });
  return sent.at(-1) || {};
}

const CONNECTED = { number: '923001234567', numberDisplay: '+92 300 1234567', status: 'CONNECTED', connected: true, ownerId: '42' };
const RECONNECTING = { number: '12025550123', numberDisplay: '+1 202 555 0123', status: 'RECONNECTING', connected: false, ownerId: '43' };
const OFFLINE = { number: '919876543061', numberDisplay: '+91 987 6543061', status: 'OFFLINE', connected: false, ownerId: '44' };

test('the Sessions button works with the synchronous pairing binding index.js uses', async () => {
  const { controller } = makeController({ pairing: pairingWith([CONNECTED, RECONNECTING], { sync: true }) });
  const reply = await clickSessions(controller);
  const text = normalizeTelegramText(reply.text || '');
  assert.match(text, /ANIME MD • ALL SESSIONS/);
  assert.doesNotMatch(text, /is not a function|TypeError|ANIME MD • ERROR/);
  assert.match(text, /🟢 \+92 300 1234567 — CONNECTED \(user 42\)/);
  assert.match(text, /🟠 \+1 202 555 0123 — RECONNECTING \(user 43\)/);
  assert.match(text, /Total: 2 sessions/);
});

test('the Sessions button works with an async pairing binding too', async () => {
  const { controller } = makeController({ pairing: pairingWith([CONNECTED], { sync: false }) });
  const text = normalizeTelegramText((await clickSessions(controller)).text || '');
  assert.match(text, /🟢 \+92 300 1234567 — CONNECTED/);
  assert.match(text, /Total: 1 session\n/);
});

test('the Sessions button renders the empty state for zero sessions', async () => {
  const { controller } = makeController({ pairing: pairingWith([], { sync: true }) });
  const text = normalizeTelegramText((await clickSessions(controller)).text || '');
  assert.match(text, /ANIME MD • ALL SESSIONS/);
  assert.match(text, /No paired sessions on this bot/);
  assert.doesNotMatch(text, /Total: 0/);
  assert.doesNotMatch(text, /ERROR/);
});

test('the Sessions button skips stale/invalid entries instead of rendering blank rows', async () => {
  const stale = [CONNECTED, null, undefined, {}, { status: 'OFFLINE' }, { numberDisplay: '+44 770 0900123', status: 'OFFLINE', ownerId: '45' }];
  const { controller } = makeController({ pairing: pairingWith(stale, { sync: true }) });
  const text = normalizeTelegramText((await clickSessions(controller)).text || '');
  assert.match(text, /Total: 2 sessions/);
  assert.match(text, /\+92 300 1234567/);
  assert.match(text, /\+44 770 0900123/);
  assert.doesNotMatch(text, /undefined|NaN|\[object Object\]/);
});

test('the Sessions button shows disconnected/reconnecting/offline states from the real snapshot', async () => {
  const { controller } = makeController({ pairing: pairingWith([CONNECTED, RECONNECTING, OFFLINE], { sync: true }) });
  const text = normalizeTelegramText((await clickSessions(controller)).text || '');
  assert.match(text, /🟢 .*CONNECTED/);
  assert.match(text, /🟠 .*RECONNECTING/);
  assert.match(text, /🔴 .*OFFLINE/);
  assert.match(text, /Total: 3 sessions/);
});

test('a genuine session-read failure renders a clean card, never raw JavaScript', async () => {
  const { controller } = makeController({ pairing: pairingWith([], { fail: true }) });
  const reply = await clickSessions(controller);
  const text = normalizeTelegramText(reply.text || '');
  assert.match(text, /ANIME MD • ERROR/);
  assert.match(text, /Something went wrong on our side/);
  assert.doesNotMatch(text, /is not a function/);
  assert.doesNotMatch(text, /TypeError/);
  assert.doesNotMatch(text, /at TelegramController|node:internal/);
});

test('the owner Sessions button lists every controller session with the full numbers', async () => {
  const { controller } = makeController({ pairing: pairingWith([CONNECTED, OFFLINE], { sync: true }) });
  const text = normalizeTelegramText((await clickSessions(controller, { data: 'owner:sessions', from: 10 })).text || '');
  assert.match(text, /\+92 300 1234567/);
  assert.match(text, /\+91 987 6543061/);
  assert.doesNotMatch(text, /•••••/);
});

test('a group never receives a full number from the Sessions button, even for an owner', async () => {
  const { controller } = makeController({ pairing: pairingWith([CONNECTED, OFFLINE], { sync: true }) });
  const text = normalizeTelegramText((await clickSessions(controller, { data: 'owner:sessions', from: 10, chat: { id: -1001, type: 'supergroup' } })).text || '');
  assert.match(text, /\+92 ••••• 567/);
  assert.match(text, /\+91 ••••• 061/);
  assert.doesNotMatch(text, /923001234567|919876543061/);
});

test('a non-admin cannot reach the global session list at all', async () => {
  const { controller } = makeController({ pairing: pairingWith([CONNECTED], { sync: true }), verified: new Set(['10', '77']) });
  const text = normalizeTelegramText((await clickSessions(controller, { from: 77 })).text || '');
  assert.doesNotMatch(text, /923001234567|••••• 567/);
  assert.match(text, /VERIFICATION|not authorized|Admin|ERROR|REQUEST/i);
});

test('number visibility is decided by role and chat type in one place', () => {
  const session = { number: '919876543061', numberDisplay: '+91 987 6543061' };
  assert.equal(displayNumber(session, false, VIEWER.OWNER), '+91 987 6543061');
  assert.equal(displayNumber(session, false, VIEWER.ADMIN), '+91 987 6543061');
  assert.equal(displayNumber(session, false, VIEWER.USER), '+91 ••••• 061');
  assert.equal(displayNumber(session, false, VIEWER.PUBLIC), '+91 ••••• 061');
  assert.equal(displayNumber(session, true, VIEWER.OWNER), '+91 ••••• 061');
  // The default is the safest role: an unwired call site stays masked.
  assert.equal(displayNumber(session), '+91 ••••• 061');
  // A value that is not a phone number is never turned into one.
  assert.equal(displayNumber({ numberDisplay: 'Session A' }, false, VIEWER.OWNER), 'Session A');
  assert.equal(viewerRoleFromAccess('bootstrap'), VIEWER.OWNER);
  assert.equal(viewerRoleFromAccess('controller'), VIEWER.ADMIN);
  assert.equal(viewerRoleFromAccess('public'), VIEWER.USER);
  assert.equal(viewerRoleFromAccess('bootstrap', true), VIEWER.PUBLIC);
});

// ---------------------------------------------------------------------------
// Counters on the admin/owner/system cards. A value that could not be read is
// reported as Unavailable — never coerced to a fake 0 — while a real read
// renders its real number.
// ---------------------------------------------------------------------------

function captureCard(controller, method, { from = 10, options = {} } = {}) {
  const sent = [];
  controller.reply = async (chatId, text) => sent.push({ chatId, text });
  controller.present = async (chatId, _messageId, text) => { sent.push({ chatId, text }); return {}; };
  return controller[method](String(from), String(from), options).then(() => normalizeTelegramText(sent.at(-1)?.text || ''));
}

test('the admin panels render real counts and never invent a 0 for an unreadable counter', async () => {
  const { controller } = makeController({ pairing: pairingWith([CONNECTED], { sync: true }) });
  controller.controllerStore.users = async () => ({ 10: {}, 11: { blockedUntil: Date.now() + 9e9 }, 12: {} });
  controller.controllerStore.read = async () => [{ id: '99' }, { id: '98' }];
  controller.controllerStore.listPremium = async () => [{ id: '10' }];

  const owner = await captureCard(controller, 'sendOwnerPanelView');
  assert.match(owner, /OWNER PANEL/);
  assert.match(owner, /Total Users: 3/);
  assert.match(owner, /Controllers: 2/);
  assert.match(owner, /Premium Users: 1/);
  assert.match(owner, /Blocked: 1/);
  assert.match(owner, /Active Sessions: 1/);

  // Now every store read fails: the card must say Unavailable, not 0.
  const boom = async () => { throw new Error('db gone'); };
  controller.controllerStore.users = boom;
  controller.controllerStore.read = boom;
  controller.controllerStore.listPremium = boom;
  controller.pairing.listAllSessions = async () => { throw new Error('no db'); };
  controller.pairing.listSessions = async () => { throw new Error('no db'); };

  const admin = await captureCard(controller, 'sendAdminPanelView');
  assert.match(admin, /ADMIN PANEL/);
  assert.match(admin, /Total Users: Unavailable/);
  assert.match(admin, /Controllers: Unavailable/);
  assert.match(admin, /Premium Users: Unavailable/);
  assert.match(admin, /Blocked: Unavailable/);
  assert.match(admin, /Active Sessions: Unavailable/);
  assert.doesNotMatch(admin, /Total Users: 0|Active Sessions: 0/);
  assert.doesNotMatch(admin, /db gone|Error:/);
});

test('the system card reports live state and degrades honestly when a read fails', async () => {
  const { controller } = makeController({ pairing: pairingWith([CONNECTED, RECONNECTING], { sync: true }) });
  controller.pairing.queuedPairingCount = async () => 4;
  controller.startedAt = Date.now() - 5000;

  const healthy = await captureCard(controller, 'sendSystemStatusView', { from: 10, options: { owner: true } });
  assert.match(healthy, /BOT: ONLINE/);
  assert.match(healthy, /PAIRING: READY/);
  assert.match(healthy, /Active Sessions: 2/);
  assert.match(healthy, /Queued: 4/);
  assert.match(healthy, /CONFIGURATION/);
  assert.match(healthy, /SYSTEM OPERATIONAL/);
  // The three duplicate lines that used to restate one process as three are gone.
  assert.doesNotMatch(healthy, /Telegram Bot:/);
  assert.doesNotMatch(healthy, /Controller:/);
  assert.doesNotMatch(healthy, /Pairing Service:/);

  controller.pairing.listAllSessions = async () => { throw new Error('no db'); };
  controller.pairing.listSessions = async () => { throw new Error('no db'); };
  const degraded = await captureCard(controller, 'sendSystemStatusView', { from: 10, options: { owner: true } });
  assert.match(degraded, /PAIRING: UNAVAILABLE/);
  assert.match(degraded, /Active Sessions: Unavailable/);
  assert.doesNotMatch(degraded, /Active Sessions: 0/);
  assert.match(degraded, /SYSTEM DEGRADED/);
  assert.doesNotMatch(degraded, /no db|Error:|at TelegramController/);
});
