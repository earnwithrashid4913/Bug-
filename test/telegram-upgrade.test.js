'use strict';

// Regression tests for the Telegram system repair + upgrade:
// permission split (owner vs admin), owner panel, premium view, global admin
// sessions, role-filtered help, centralized permission helpers, uptime
// formatting, and the owner-ID type fix behind /listpaired.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ADMIN_COMMANDS,
  NORMAL_PAIRING_LIMIT,
  OWNER_COMMANDS,
  PREMIUM_PAIRING_LIMIT,
  TelegramController,
  accessDeniedBox,
  connectedMarkup,
  formatUptime,
  helpTextForRole,
  roleHomeMarkup
} = require('../system/lib/telegram-controller');
const { TelegramPairingManager } = require('../system/lib/telegram-pairing-manager');

function fakePairing(overrides = {}) {
  return {
    requestPairing: async (_ownerId, number) => ({
      code: 'KJ4MNP2X', displayCode: 'KJ4M-NP2X', brand: 'WhatsApp-generated',
      number, numberDisplay: `+${number}`, expiresAt: Date.now() + 300_000
    }),
    listSessions: async () => [],
    listAllSessions: async () => [],
    queuedPairingCount: async () => 0,
    statusOf: async () => ({}),
    stopSession: async () => ({}),
    restartSession: async () => ({}),
    ...overrides
  };
}

function memoryStore({ controllers = [], premium = [], verified = new Set(), vip = new Map(), blocked = new Map(), paired = new Map() } = {}) {
  return {
    has: async (id) => controllers.includes(String(id)),
    add: async (id) => { controllers.push(String(id)); return controllers; },
    remove: async (id) => { const i = controllers.indexOf(String(id)); if (i >= 0) controllers.splice(i, 1); return i >= 0; },
    read: async () => [...controllers],
    getSettings: async () => ({}),
    setSetting: async (_k, v) => v,
    getUser: async (id) => {
      const key = String(id);
      if (verified.has(key) || paired.has(key) || blocked.has(key) || vip.has(key) || premium.some((p) => p.id === key)) {
        return { verified: verified.has(key), pairedNumbers: paired.get(key) || [] };
      }
      return undefined;
    },
    updateUser: async (id, patch) => {
      const key = String(id);
      if (patch.verified === true) verified.add(key);
      else if (patch.verified === false) verified.delete(key);
      if (patch.pairedNumbers) paired.set(key, patch.pairedNumbers);
      return { verified: verified.has(key) };
    },
    hasPremium: async (id) => {
      const record = premium.find((entry) => entry.id === String(id) && entry.expiresAt > Date.now());
      return record ? { premium: true, expiresAt: record.expiresAt } : { premium: false };
    },
    addPremium: async (id) => { const record = { id: String(id), expiresAt: Date.now() + 2_592_000_000 }; premium.push(record); return record; },
    removePremium: async (id) => { const i = premium.findIndex((e) => e.id === String(id)); if (i >= 0) premium.splice(i, 1); return i >= 0; },
    listPremium: async () => [...premium],
    isVerified: async (id) => verified.has(String(id)),
    markVerified: async (id) => verified.add(String(id)),
    blockStatus: async (id) => {
      const entry = blocked.get(String(id));
      if (!entry) return { blocked: false };
      if (entry.blockedUntil <= Date.now()) { blocked.delete(String(id)); return { blocked: false }; }
      return { blocked: true, blockedAt: entry.blockedAt, blockedUntil: entry.blockedUntil, remainingMs: entry.blockedUntil - Date.now() };
    },
    setBlocked: async (id, durationMs) => { const now = Date.now(); blocked.set(String(id), { blockedAt: now, blockedUntil: now + durationMs }); return true; },
    clearBlocked: async (id) => blocked.delete(String(id)),
    vipStatus: async (id) => (vip.has(String(id)) ? { vip: true } : { vip: false }),
    setVip: async (id) => { vip.set(String(id), true); return true; },
    removeVip: async (id) => vip.delete(String(id)),
    pairedNumbersOf: async (id) => paired.get(String(id)) || [],
    addPairedNumber: async (id, number) => { const k = String(id); const cur = paired.get(k) || []; if (!cur.includes(String(number))) paired.set(k, [...cur, String(number)]); return cur; },
    removePairedNumber: async (id, number) => { const k = String(id); paired.set(k, (paired.get(k) || []).filter((e) => e !== String(number))); return paired.get(k); },
    users: async () => {
      const result = {};
      for (const vid of verified) result[vid] = { verified: true, pairedNumbers: paired.get(vid) || [] };
      for (const [k, v] of paired) if (!result[k]) result[k] = { pairedNumbers: v, verified: verified.has(k) };
      for (const [k, v] of blocked) { result[k] = result[k] || {}; result[k].blockedUntil = v.blockedUntil; result[k].blockedAt = v.blockedAt; }
      for (const [k] of vip) { result[k] = result[k] || {}; result[k].vip = true; }
      return result;
    }
  };
}

function makeController({ pairing = fakePairing(), owners = ['10'], store, fetchImpl, options = {} } = {}) {
  const replies = [];
  const controller = new TelegramController({
    token: 'token',
    owners,
    controllerStore: store || memoryStore(),
    pairing,
    fetchImpl: fetchImpl || (async (_url, init) => ({ ok: true, json: async () => ({ ok: true, result: JSON.parse(init.body) }) })),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...options
  });
  controller.reply = async (chatId, text, markup) => replies.push({ chatId, text, markup });
  controller.replyPhoto = async (chatId, image, caption, markup) => replies.push({ chatId, image, caption, markup });
  return { controller, replies };
}

function flowApi() {
  const calls = [];
  let messageId = 7000;
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    const payload = JSON.parse(init.body || '{}');
    let result = payload;
    if (method === 'getMe') result = { username: 'AnimeMdBot' };
    if (method === 'answerCallbackQuery') result = true;
    if (method === 'sendMessage' || method === 'sendPhoto') { messageId += 1; result = { message_id: messageId }; }
    if (method === 'editMessageText') result = { message_id: payload.message_id };
    calls.push({ method, payload, result });
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
  return { calls, fetchImpl };
}

// ---------------------------------------------------------------------------
// Permission split: owner-only vs admin-level commands.
// ---------------------------------------------------------------------------

test('admin commands are split from owner commands', () => {
  assert.deepEqual([...OWNER_COMMANDS].sort(), ['addowner', 'delowner', 'listpaired']);
  assert.deepEqual([...ADMIN_COMMANDS].sort(), ['addprem', 'addvip', 'block', 'delprem', 'delvip', 'unblock']);
});

test('controllers (admins) can run admin commands but not owner commands', async () => {
  const premium = [];
  const store = memoryStore({ controllers: ['99'] });
  store.addPremium = async (id) => { premium.push(id); return { id, expiresAt: Date.now() + 1000 }; };
  const { controller, replies } = makeController({ store });

  // Admin grants premium — allowed.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 99 }, text: '/addprem 77 30d' } });
  assert.deepEqual(premium, ['77']);
  assert.match(replies.at(-1).text, /PREMIUM GRANTED/);

  // Admin blocks a user — allowed.
  controller.sensitiveRequests.clear();
  controller.sensitiveLocks.clear();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 99 }, text: '/block 55 24h' } });
  assert.match(replies.at(-1).text, /USER BLOCKED/);

  // Admin attempts an owner-only command — denied with the OWNER box.
  controller.sensitiveRequests.clear();
  controller.sensitiveLocks.clear();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 99 }, text: '/addowner 55' } });
  const denied = replies.at(-1).text;
  assert.match(denied, /ACCESS DENIED/);
  assert.match(denied, /requires OWNER access/);
  assert.match(denied, /Only bootstrap owners/);

  // Admin attempts /listpaired — still owner-only.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 99 }, text: '/listpaired' } });
  assert.match(replies.at(-1).text, /ACCESS DENIED/);
});

test('normal users are denied on admin commands with the ADMIN box', async () => {
  const store = memoryStore({ verified: new Set(['42']) });
  const { controller, replies } = makeController({ store });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 42 }, text: '/addprem 77' } });
  const denied = replies.at(-1).text;
  assert.match(denied, /ACCESS DENIED/);
  assert.match(denied, /requires ADMIN access/);
});

test('/listpaired works for the real owner whether the ID is a number or string (Phase 4)', async () => {
  const pairing = fakePairing({
    listAllSessions: async () => [
      { number: '923001234567', numberDisplay: '+92 300 1234567', status: 'CONNECTED', connected: true, ownerId: '10' }
    ]
  });
  // Owner ID stored as a STRING in config; Telegram delivers a NUMBER.
  const { controller, replies } = makeController({ pairing, owners: ['10'] });
  assert.equal(controller.isBootstrapOwner(10), true, 'numeric Telegram id matches string config');
  assert.equal(controller.isBootstrapOwner('10'), true, 'string id still matches');
  assert.equal(controller.isOwner(10), true);
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/listpaired' } });
  const text = replies.at(-1).text;
  assert.match(text, /ALL SESSIONS/);
  assert.match(text, /\+92 300 1234567/);
  assert.doesNotMatch(text, /ACCESS DENIED/);
});

// ---------------------------------------------------------------------------
// Centralized permission helpers.
// ---------------------------------------------------------------------------

test('centralized permission helpers delegate to the single access model', async () => {
  const store = memoryStore({
    controllers: ['99'],
    premium: [{ id: '20', expiresAt: Date.now() + 86_400_000 }],
    vip: new Map([['30', true]]),
    verified: new Set(['20', '30'])
  });
  const { controller } = makeController({ store, owners: ['10'] });
  assert.equal(controller.isOwner('10'), true);
  assert.equal(controller.isOwner(10), true);
  assert.equal(controller.isOwner('99'), false);
  assert.equal(await controller.isAdmin('10'), true);
  assert.equal(await controller.isAdmin('99'), true);
  assert.equal(await controller.isAdmin('42'), false);
  assert.equal(await controller.isVip('30'), true);
  assert.equal(await controller.isVip('20'), false);
  assert.equal(await controller.isPremium('20'), true);
  assert.equal(await controller.isPremium('42'), false);
  // Premium is NOT admin: no privilege escalation through tier.
  assert.equal(await controller.isAdmin('20'), false);
  assert.equal(await controller.isAdmin('30'), false);

  const blocked = await controller.isBlocked('42');
  assert.equal(blocked.blocked, false);
  await store.setBlocked('42', 3_600_000);
  assert.equal((await controller.isBlocked('42')).blocked, true);

  const vipPair = await controller.canPair('30');
  assert.equal(vipPair.allowed, true);
  const normalPair = await controller.canPair('42');
  assert.equal(normalPair.allowed, true);
  assert.equal(normalPair.limit, 1);
  assert.equal(normalPair.used, 0);
});

test('canPair denies a premium user at the unique-number cap', async () => {
  const store = memoryStore({
    verified: new Set(['20']),
    premium: [{ id: '20', expiresAt: Date.now() + 86_400_000 }],
    paired: new Map([['20', ['923001234567', '12025550123', '971501234567']]])
  });
  const { controller } = makeController({ store });
  const result = await controller.canPair('20');
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'limit');
  assert.equal(result.limit, 3);
  assert.equal(result.used, 3);
});

// ---------------------------------------------------------------------------
// Owner panel, premium view, admin global sessions.
// ---------------------------------------------------------------------------

test('owner panel opens for owners and is denied for admins and users', async () => {
  const { calls, fetchImpl } = flowApi();
  const store = memoryStore({ controllers: ['99'], verified: new Set(['99', '42']) });
  const { controller } = makeController({ store, fetchImpl });
  const lastEdit = () => calls.filter((c) => c.method === 'editMessageText').at(-1);

  await controller.handleUpdate({ callback_query: { id: 'c1', from: { id: 10 }, data: 'nav:owner', message: { chat: { id: 1 }, message_id: 11 } } });
  const ownerView = lastEdit();
  assert.match(ownerView.payload.text, /OWNER PANEL/);
  const buttons = ownerView.payload.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  for (const expected of ['owner:users', 'owner:owners', 'owner:admins', 'owner:premium', 'owner:vip', 'owner:sessions', 'owner:blocks', 'owner:system', 'owner:config', 'home']) {
    assert.ok(buttons.includes(expected), `owner panel includes ${expected}`);
  }

  // Every owner verb has a working handler.
  for (const verb of ['users', 'owners', 'admins', 'premium', 'vip', 'sessions', 'blocks', 'system', 'config']) {
    await controller.handleUpdate({ callback_query: { id: `c-${verb}`, from: { id: 10 }, data: `owner:${verb}`, message: { chat: { id: 1 }, message_id: 11 } } });
    assert.ok(lastEdit(), `owner:${verb} produced a view`);
  }

  // An admin cannot open the owner panel.
  const before = calls.filter((c) => c.method === 'editMessageText').length;
  await controller.handleUpdate({ callback_query: { id: 'c2', from: { id: 99 }, data: 'nav:owner', message: { chat: { id: 1 }, message_id: 12 } } });
  assert.equal(calls.filter((c) => c.method === 'editMessageText').length, before, 'admin does not get the owner panel');
});

test('premium view shows tier info and the user status', async () => {
  const { calls, fetchImpl } = flowApi();
  const store = memoryStore({ verified: new Set(['42']) });
  const { controller } = makeController({ store, fetchImpl });
  await controller.handleUpdate({ callback_query: { id: 'c1', from: { id: 42 }, data: 'nav:premium', message: { chat: { id: 1 }, message_id: 21 } } });
  const edit = calls.filter((c) => c.method === 'editMessageText').at(-1);
  assert.match(edit.payload.text, /ANIME MD • PREMIUM/);
  // The limits are rendered from the access-model constants, and the caller's
  // own tier/usage from the user database — nothing is hardcoded in the page.
  assert.match(edit.payload.text, new RegExp(`• ${NORMAL_PAIRING_LIMIT} pairing session`));
  assert.match(edit.payload.text, new RegExp(`• ${PREMIUM_PAIRING_LIMIT} pairing sessions`));
  assert.match(edit.payload.text, /✦ VIP Premium/);
  assert.match(edit.payload.text, /👤 Your tier: FREE/);
  assert.match(edit.payload.text, /📱 Your sessions: 0\/1/);
  // Every button on the page is handled.
  const buttons = edit.payload.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ['nav:account', 'home']);
});

test('admin sessions view lists every session globally (admin/owner only)', async () => {
  const { calls, fetchImpl } = flowApi();
  const pairing = fakePairing({
    listAllSessions: async () => [
      { number: '923001234567', numberDisplay: '+92 300 1234567', status: 'CONNECTED', connected: true, ownerId: '42' },
      { number: '12025550123', numberDisplay: '+1 202 555 0123', status: 'OFFLINE', connected: false, ownerId: '43' }
    ]
  });
  const store = memoryStore({ controllers: ['99'], verified: new Set(['99', '42']) });
  const { controller } = makeController({ pairing, store, fetchImpl });
  const lastEdit = () => calls.filter((c) => c.method === 'editMessageText').at(-1);

  // Admin global view.
  await controller.handleUpdate({ callback_query: { id: 'c1', from: { id: 99 }, data: 'admin:sessions', message: { chat: { id: 1 }, message_id: 31 } } });
  const view = lastEdit();
  assert.match(view.payload.text, /ALL SESSIONS/);
  assert.match(view.payload.text, /user 42/);
  assert.match(view.payload.text, /Total: 2 sessions/);

  // Owner global view via the owner panel.
  await controller.handleUpdate({ callback_query: { id: 'c2', from: { id: 10 }, data: 'owner:sessions', message: { chat: { id: 1 }, message_id: 31 } } });
  assert.match(lastEdit().payload.text, /ALL SESSIONS/);

  // A normal user is denied.
  const before = calls.filter((c) => c.method === 'editMessageText').length;
  await controller.handleUpdate({ callback_query: { id: 'c3', from: { id: 42 }, data: 'admin:sessions', message: { chat: { id: 1 }, message_id: 32 } } });
  assert.equal(calls.filter((c) => c.method === 'editMessageText').length, before, 'normal user never sees the global list');
});

// ---------------------------------------------------------------------------
// Help filtering, menus, formatting.
// ---------------------------------------------------------------------------

test('help is role-filtered: users never see management commands', () => {
  const user = helpTextForRole('normal');
  assert.match(user, /\/pair <number>/);
  assert.match(user, /\/myaccount/);
  assert.doesNotMatch(user, /\/addprem/);
  assert.doesNotMatch(user, /\/addowner/);
  assert.doesNotMatch(user, /\/listpaired/);
  const admin = helpTextForRole('admin');
  assert.match(admin, /\/addprem/);
  assert.match(admin, /\/block/);
  assert.doesNotMatch(admin, /\/addowner/);
  const owner = helpTextForRole('owner');
  assert.match(owner, /\/addowner/);
  assert.match(owner, /\/listpaired/);
  assert.match(owner, /\/addprem/);
});

test('/help command serves the role-filtered list', async () => {
  const store = memoryStore({ verified: new Set(['42']) });
  const { controller, replies } = makeController({ store });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 42 }, text: '/help' } });
  assert.match(replies.at(-1).text, /PAIRING/);
  assert.doesNotMatch(replies.at(-1).text, /\/addprem/);
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/help' } });
  assert.match(replies.at(-1).text, /\/listpaired/);
});

test('main menu carries premium plus role-conditional admin/owner panels', () => {
  const userButtons = roleHomeMarkup('normal').inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(userButtons.includes('nav:premium'));
  assert.ok(!userButtons.includes('nav:admin'));
  assert.ok(!userButtons.includes('nav:owner'));
  const adminButtons = roleHomeMarkup('admin').inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(adminButtons.includes('nav:admin'));
  assert.ok(!adminButtons.includes('nav:owner'));
  const ownerButtons = roleHomeMarkup('owner').inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(ownerButtons.includes('nav:admin'));
  assert.ok(ownerButtons.includes('nav:owner'));
});

test('connected screen offers pair-another, sessions and a way home (no dead end)', () => {
  const buttons = connectedMarkup().inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ['pair:new', 'nav:sessions', 'home']);
});

test('access denied box names the required role', () => {
  assert.match(accessDeniedBox('OWNER'), /requires OWNER access/);
  assert.match(accessDeniedBox('OWNER'), /Only bootstrap owners/);
  assert.match(accessDeniedBox('ADMIN'), /requires ADMIN access/);
});

test('uptime formats seconds, minutes, hours and days', () => {
  assert.equal(formatUptime(5), '5 seconds');
  assert.equal(formatUptime(1), '1 second');
  assert.equal(formatUptime(125), '2 minutes 5 seconds');
  assert.equal(formatUptime(3700), '1h 1m 40s');
  assert.equal(formatUptime(90000), '1d 1h 0m');
});

test('system status reports real session and queue counts', async () => {
  const { calls, fetchImpl } = flowApi();
  const pairing = fakePairing({
    listAllSessions: async () => [{ number: '1', numberDisplay: '+1', status: 'CONNECTED', connected: true, ownerId: '10' }],
    queuedPairingCount: async () => 2
  });
  const { controller } = makeController({ pairing, fetchImpl });
  controller.startedAt = Date.now() - 125_000;
  await controller.handleUpdate({ callback_query: { id: 'c1', from: { id: 10 }, data: 'admin:system', message: { chat: { id: 1 }, message_id: 41 } } });
  const edit = calls.filter((c) => c.method === 'editMessageText').at(-1);
  assert.match(edit.payload.text, /Telegram Bot: 🟢 ONLINE/);
  assert.match(edit.payload.text, /Pairing Service: 🟢 READY/);
  assert.match(edit.payload.text, /Active Sessions: 1/);
  assert.match(edit.payload.text, /Queued Pairings: 2/);
  assert.match(edit.payload.text, /Uptime: 2 minutes 5 seconds/);
});

test('pairing manager exposes the real queued-pairing count', async () => {
  const os = require('node:os');
  const path = require('node:path');
  const authDir = path.join(os.tmpdir(), `anime-md-queue-${Date.now()}`);
  const { EventEmitter } = require('node:events');
  const fake = {
    makeWASocket: () => ({ ev: new EventEmitter(), ws: { isOpen: true, close() {} }, requestPairingCode: async () => 'ABCD1234' }),
    useMultiFileAuthState: async () => ({ state: { creds: { registered: false }, keys: {} }, saveCreds: async () => {} }),
    makeCacheableSignalKeyStore: () => ({})
  };
  const manager = new TelegramPairingManager({
    authDir,
    baileys: fake,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    limits: { ownerCooldownMs: 0 }
  });
  assert.equal(manager.queuedPairingCount(), 0);
  await manager.shutdown();
});
