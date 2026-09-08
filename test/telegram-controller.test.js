'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TelegramController, commandFromUpdate, helpText, normalizeWhatsappNumber, startupBox } = require('../system/lib/telegram-controller');
const { TelegramControllerStore } = require('../system/lib/telegram-controllers');

function fakePairing(overrides = {}) {
  return {
    requestPairing: async (_ownerId, number) => ({
      code: 'GOATMODS', displayCode: 'GOAT-MODS', brand: 'GOAT-MODS', custom: true,
      number, numberDisplay: `+${number}`, expiresAt: Date.now() + 300_000
    }),
    listSessions: async () => [],
    statusOf: async () => ({}),
    stopSession: async () => ({}),
    restartSession: async () => ({}),
    getStatus: async () => ({}),
    ...overrides
  };
}

function makeController({ pairing = fakePairing(), owners = ['10'], fetchImpl, controllerStore, ...options } = {}) {
  const replies = [];
  const controller = new TelegramController({
    token: 'token',
    owners,
    controllerStore: controllerStore || { has: async () => false, add: async () => [], remove: async () => true },
    pairing,
    fetchImpl: fetchImpl || (async (_url, init) => ({ ok: true, json: async () => ({ ok: true, result: JSON.parse(init.body) }) })),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...options
  });
  controller.reply = async (chatId, text, markup) => replies.push({ chatId, text, markup });
  controller.replyPhoto = async (chatId, image, caption) => replies.push({ chatId, image, caption });
  return { controller, replies };
}

test('Telegram command parsing accepts bot-command suffixes and all number formats', () => {
  assert.deepEqual(commandFromUpdate({ message: { chat: { id: 4 }, from: { id: 5 }, text: '/pair@AnimeMdBot 923001234567' } }), {
    chatId: 4, senderId: 5, name: 'pair', args: ['923001234567'], text: '923001234567'
  });
  assert.equal(normalizeWhatsappNumber('+92 300 1234567'), '923001234567');
  assert.equal(normalizeWhatsappNumber('92-300-1234567'), '923001234567');
  assert.equal(normalizeWhatsappNumber('12025550123'), '12025550123');
  assert.throws(() => normalizeWhatsappNumber('123'), /7-15 digit/);
});

test('/pair acknowledges first and shows the code only after the real flow returns it', async () => {
  const { controller, replies } = makeController();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair 923001234567' } });
  assert.equal(replies.length, 2);
  assert.match(replies[0].text, /ANIME MD • PAIRING/);
  assert.match(replies[0].text, /📱 Number: \+92 300 1234567/);
  assert.match(replies[0].text, /⏳ Preparing WhatsApp pairing/);
  assert.match(replies[1].text, /ANIME MD • GOAT-MODS/);
  assert.match(replies[1].text, /✅ Pairing Code Ready/);
  assert.match(replies[1].text, /🔐 CODE: GOAT-MODS/);
  assert.match(replies[1].text, /Link with phone number/);
  assert.doesNotMatch(replies[1].text, /Pairing Code Ready[\s\S]*Pairing Code Ready/, 'the ready box appears once');
});

test('/pair with a + prefix and international formats works identically', async () => {
  for (const input of ['+923001234567', '92 300 1234567', '92-300-1234567', '+12025550123', '12025550123']) {
    const { controller, replies } = makeController();
    await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: `/pair ${input}` } });
    assert.equal(replies.length, 2, `two replies for ${input}`);
    assert.match(replies[1].text, /CODE: GOAT-MODS/, `code shown for ${input}`);
  }
});

test('/pair rejects malformed numbers with a friendly box and no socket words leak', async () => {
  const { controller, replies } = makeController();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair 123' } });
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /PAIRING FAILED/);
  assert.match(replies[0].text, /number format is invalid/);
  assert.match(replies[0].text, /923001234567/);
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair 03001234567' } });
  assert.match(replies.at(-1).text, /country code/);
});

test('raw internal errors never reach Telegram users', async () => {
  const { controller, replies } = makeController({
    pairing: fakePairing({
      requestPairing: async () => { throw new Error('Connection Closed'); }
    })
  });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair 923001234567' } });
  const failure = replies.at(-1).text;
  assert.match(failure, /PAIRING FAILED/);
  assert.doesNotMatch(failure, /Connection Closed/);
  assert.match(failure, /Pairing could not be completed/);
});

test('a classified ALREADY_PAIRED error explains the next step without a retry footer', async () => {
  const { controller, replies } = makeController({
    pairing: fakePairing({
      requestPairing: async () => {
        throw Object.assign(new Error('Your WhatsApp session is already connected.'), { code: 'ALREADY_PAIRED' });
      }
    })
  });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair 923001234567' } });
  const failure = replies.at(-1).text;
  assert.match(failure, /already paired/);
  assert.match(failure, /\/status <number>|\/restart <number>/);
  assert.doesNotMatch(failure, /Please try \/pair again/);
});

test('strangers are denied and owners can list their sessions with status badges', async () => {
  const { controller, replies } = makeController({
    pairing: fakePairing({
      listSessions: async () => [
        { number: '923001234567', numberDisplay: '+92 300 1234567', status: 'CONNECTED', connected: true },
        { number: '12025550123', numberDisplay: '+1 202 555 0123', status: 'WAITING_FOR_LINK', connected: false }
      ],
      getStatus: async () => ({ state: 'connected', connected: true, startedAt: Date.now() - 1000 })
    })
  });
  await controller.handleUpdate({ message: { chat: { id: 2 }, from: { id: 11 }, text: '/sessions' } });
  assert.match(replies.pop().text, /not authorized/);
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/sessions' } });
  const sessions = replies.pop().text;
  assert.match(sessions, /ANIME MD • SESSIONS/);
  assert.match(sessions, /🟢 \+92 300 1234567 — CONNECTED/);
  assert.match(sessions, /🟡 \+1 202 555 0123 — PAIRING/);
  assert.match(sessions, /Total: 2 sessions/);
});

test('/status without arguments never claims WhatsApp is connected', async () => {
  const { controller, replies } = makeController({
    pairing: fakePairing({ listSessions: async () => [] })
  });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/status' } });
  const status = replies.pop().text;
  assert.match(status, /ANIME MD • STATUS/);
  assert.match(status, /Controller: Online/);
  assert.match(status, /WhatsApp sessions: 0/);
  assert.match(status, /Telegram online ≠ WhatsApp connected/);
});

test('/status <number> shows one session and /restart asks for a number', async () => {
  const seen = [];
  const { controller, replies } = makeController({
    pairing: fakePairing({
      statusOf: async (_ownerId, number) => {
        seen.push(number);
        return { number, numberDisplay: '+92 300 1234567', status: 'RECONNECTING', connected: false, registered: true, reconnects: 2 };
      },
      restartSession: async (_ownerId, number) => {
        seen.push(`restart:${number}`);
        return { number, numberDisplay: '+92 300 1234567', status: 'CONNECTING', connected: false };
      }
    })
  });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/status 923001234567' } });
  const status = replies.pop().text;
  assert.match(status, /ANIME MD • SESSION STATUS/);
  assert.match(status, /📱 Number: \+92 300 1234567/);
  assert.match(status, /Status: RECONNECTING/);
  assert.deepEqual(seen, ['923001234567']);

  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/restart' } });
  assert.match(replies.pop().text, /Usage: \/restart <number>/);

  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/restart 923001234567' } });
  const restart = replies.pop().text;
  assert.match(restart, /ANIME MD • RESTARTING/);
  assert.match(restart, /\+92 300 1234567/);
  assert.match(restart, /CONNECTED confirmation arrives/);
  assert.deepEqual(seen, ['923001234567', 'restart:923001234567']);
});

test('/stop confirms the removal and /help documents every command', async () => {
  const { controller, replies } = makeController({
    pairing: fakePairing({ stopSession: async (_ownerId, number) => ({ number, numberDisplay: `+${number}` }) })
  });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/stop 923001234567' } });
  assert.match(replies.pop().text, /SESSION REMOVED/);
  for (const command of ['/pair <number>', '/sessions', '/status [number]', '/stop <number>', '/restart <number>', '/addowner <telegram_id>', '/delowner <telegram_id>', '/help', '/guide', '/myid', '/premium', '/settings', '/delpair', '/listsessions', '/listpaired', '/addprem', '/delprem']) {
    assert.ok(helpText().includes(command), `help mentions ${command}`);
  }
});

test('the pending number reply flow (force reply button) pairs like /pair', async () => {
  const { controller, replies } = makeController();
  await controller.handleUpdate({ callback_query: { id: 'cb1', from: { id: 10 }, data: 'pair_help', message: { chat: { id: 1 } } } });
  const prompt = replies.pop();
  assert.match(prompt.text, /Do not include a plus sign/);
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '923001234567' } });
  assert.equal(replies.length, 2);
  assert.match(replies[1].text, /CODE: GOAT-MODS/);
});

test('connected notifications use the connected box and are never sent early', async () => {
  const { controller, replies } = makeController();
  controller.running = true;
  await controller.notifySessionConnected('10', { number: '923001234567', numberDisplay: '+92 300 1234567' });
  const notification = replies.pop();
  assert.match(notification.caption, /ANIME MD • CONNECTED/);
  assert.match(notification.caption, /✅ WhatsApp Connected/);
  assert.match(notification.caption, /📱 \+92 300 1234567/);
  assert.match(notification.caption, /🟢 Session: ACTIVE/);
  assert.match(notification.caption, /Roman Urdu/);
  // Before the controller runs, notifications are suppressed.
  controller.running = false;
  await controller.notifySessionConnected('10', { number: '923001234567' });
  assert.equal(replies.length, 0);
});

test('Telegram startup shows the Gojo intro, verifies the token, and starts one poller', async () => {
  const methods = [];
  const captions = [];
  const controller = new TelegramController({
    token: 'token',
    owners: ['10'],
    controllerStore: { has: async () => false },
    pairing: fakePairing(),
    startImage: '',
    fetchImpl: async (url, init) => {
      const method = url.split('/').pop();
      methods.push(method);
      const payload = JSON.parse(init.body);
      if (method === 'getMe') return { ok: true, json: async () => ({ ok: true, result: { username: 'AnimeMdBot' } }) };
      if (method === 'getUpdates') return { ok: true, json: async () => ({ ok: true, result: [] }) };
      if (method === 'sendMessage') captions.push(payload.text);
      return { ok: true, json: async () => ({ ok: true, result: payload }) };
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  assert.equal(await controller.start(), true);
  assert.deepEqual(methods.slice(0, 2), ['getMe', 'deleteWebhook']);
  assert.equal(await controller.start(), false, 'a second listener is never started');
  const intro = captions[0];
  assert.match(intro, /⚡ GOJO MODE ONLINE/);
  assert.match(intro, /🟢 Telegram Controller/);
  assert.match(intro, /🟢 Pairing System/);
  assert.match(intro, /「 THE STRONGEST IS ONLINE 」/);
  assert.doesNotMatch(intro, /WhatsApp Connected/);
  assert.match(intro, /\/help/);
  controller.stop();
});

test('the startup box never claims a WhatsApp connection by itself', () => {
  const text = startupBox();
  assert.match(text, /ANIME MD/);
  assert.match(text, /GOJO MODE ONLINE/);
  assert.doesNotMatch(text, /WhatsApp Connected/);
  assert.doesNotMatch(text, /Session is active/);
});

test('Telegram callbacks stay authorized and route status through owner-scoped sessions', async () => {
  const seenOwners = [];
  const { controller, replies } = makeController({
    pairing: fakePairing({
      listSessions: async (ownerId) => {
        seenOwners.push(String(ownerId));
        return [];
      }
    })
  });
  await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 10 }, data: 'status', message: { chat: { id: 1 } } } });
  assert.deepEqual(seenOwners, ['10']);
  await controller.handleUpdate({ callback_query: { id: 'cb2', from: { id: 11 }, data: 'status', message: { chat: { id: 1 } } } });
  assert.match(replies.pop().text, /not authorized/);
});

test('persisted controllers can be removed only by bootstrap owners', async () => {
  const removed = [];
  const { controller, replies } = makeController();
  controller.controllerStore = {
    has: async () => false,
    add: async () => [],
    remove: async (id) => { removed.push(id); return true; }
  };
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/delowner 20' } });
  assert.deepEqual(removed, ['20']);
  controller.sensitiveRequests.clear();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/delowner 10' } });
  assert.match(replies.pop().text, /cannot be removed/);
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 42 }, text: '/addowner 20' } });
  assert.match(replies.pop().text, /not authorized/);
});

test('Telegram controller store persists authorized IDs with private JSON data', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-controllers-'));
  const filePath = path.join(directory, 'controllers.json');
  try {
    const store = new TelegramControllerStore(filePath);
    await store.add('123');
    assert.equal(await store.has('123'), true);
    assert.equal(await new TelegramControllerStore(filePath).has('999'), false);
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), { controllers: ['123'], premium: [], settings: {} });
    // Runtime settings and premium users persist through the same private file.
    await store.setSetting('publicMode', true);
    await store.addPremium('456', '30d');
    assert.deepEqual(await store.getSettings(), { publicMode: true });
    assert.equal((await store.listPremium()).length, 1);
    assert.deepEqual(await new TelegramControllerStore(filePath).getSettings(), { publicMode: true });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Public multi-user architecture, premium gating, channel verification.
// ---------------------------------------------------------------------------

function captureApi({ chatMemberStatus = 'member' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    const payload = JSON.parse(init.body || '{}');
    calls.push({ method, payload });
    let result = payload;
    if (method === 'getMe') result = { username: 'AnimeMdBot' };
    if (method === 'getChatMember') result = { status: chatMemberStatus };
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
  return { calls, fetchImpl };
}

test('public mode lets any Telegram user pair and manage only their own sessions', async () => {
  const seen = [];
  const { controller, replies } = makeController({
    publicMode: true,
    pairing: fakePairing({
      listSessions: async (ownerId) => { seen.push(String(ownerId)); return []; },
      requestPairing: async (ownerId, number) => ({
        code: 'GOATMODS', displayCode: 'GOAT-MODS', brand: 'GOAT-MODS', custom: true,
        number, numberDisplay: `+${number}`, expiresAt: Date.now() + 300_000
      })
    })
  });
  // A stranger receives the dashboard instead of an access-denied box.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/start' } });
  assert.match(replies.at(-1).caption || replies.at(-1).text, /GOJO MODE ONLINE/);
  // A stranger can pair their own number through the real flow.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/pair 923001234567' } });
  assert.match(replies.at(-1).text, /CODE: GOAT-MODS/);
  // Session listings stay scoped to the requesting user.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/sessions' } });
  assert.deepEqual(seen, ['11']);
});

test('premium-only pairing blocks non-premium controllers and bootstrap owners bypass it', async () => {
  const store = {
    has: async (id) => ['20', '30'].includes(String(id)),
    add: async () => [],
    remove: async () => true,
    hasPremium: async (id) => (String(id) === '30' ? { premium: true, expiresAt: Date.now() + 86_400_000 } : { premium: false })
  };
  const { controller, replies } = makeController({ premiumOnly: true, controllerStore: store });

  // Authorized controller without premium is blocked before any socket opens.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 20 }, text: '/pair 923001234567' } });
  assert.match(replies.at(-1).text, /PREMIUM/);
  assert.match(replies.at(-1).text, /premium users/);

  // An authorized controller with premium pairs normally.
  controller.sensitiveRequests.clear();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 30 }, text: '/pair 923001234567' } });
  assert.match(replies.at(-1).text, /CODE: GOAT-MODS/);

  // Bootstrap owners bypass the premium requirement entirely.
  controller.sensitiveRequests.clear();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair 12025550123' } });
  assert.match(replies.at(-1).text, /CODE: GOAT-MODS/);
});

test('required channels gate pairing until joined; bootstrap owners skip the check', async () => {
  const requiredChannels = [{ name: 'ANIME MD Updates', chatId: '@animemd' }];
  const { calls, fetchImpl } = captureApi({ chatMemberStatus: 'left' });
  const { controller, replies } = makeController({
    publicMode: true, requiredChannels, fetchImpl,
    pairing: fakePairing({ requestPairing: async (_ownerId, number) => ({ code: 'GOATMODS', displayCode: 'GOAT-MODS', brand: 'GOAT-MODS', custom: true, number, numberDisplay: `+${number}`, expiresAt: Date.now() + 300_000 }) })
  });

  // A public user who has not joined is blocked with the channel list.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/pair 923001234567' } });
  const blocked = replies.at(-1).text;
  assert.match(blocked, /JOIN REQUIRED/);
  assert.match(blocked, /@animemd/);
  assert.ok(calls.some((call) => call.method === 'getChatMember'));

  // Bootstrap owners skip the join check.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair 923001234567' } });
  assert.match(replies.at(-1).text, /CODE: GOAT-MODS/);
});

test('required channels pass members through to the real pairing flow', async () => {
  const { fetchImpl } = captureApi({ chatMemberStatus: 'member' });
  const { controller, replies } = makeController({
    publicMode: true,
    requiredChannels: [{ name: 'ANIME MD Updates', chatId: '@animemd' }],
    fetchImpl
  });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/pair 923001234567' } });
  assert.match(replies.at(-1).text, /CODE: GOAT-MODS/);
});

test('/myid is open to everyone and shows the numeric Telegram ID', async () => {
  const { controller, replies } = makeController();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 42 }, text: '/myid' } });
  const text = replies.at(-1).text;
  assert.match(text, /ANIME MD • MY ID/);
  assert.match(text, /Telegram ID: 42/);
  assert.match(text, /Owner: No/);
});

test('/listpaired is bootstrap-only and lists sessions of every controller', async () => {
  const { controller, replies } = makeController({
    owners: ['10'],
    controllerStore: { has: async (id) => String(id) === '20', add: async () => [], remove: async () => true },
    pairing: fakePairing({
      listAllSessions: async () => [
        { number: '923001234567', numberDisplay: '+92 300 1234567', status: 'CONNECTED', connected: true, ownerId: '20' },
        { number: '12025550123', numberDisplay: '+1 202 555 0123', status: 'OFFLINE', connected: false, ownerId: '10' }
      ]
    })
  });
  // An authorized controller cannot list every session.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 20 }, text: '/listpaired' } });
  assert.match(replies.at(-1).text, /Only bootstrap owners/);
  // The bootstrap owner sees all sessions with their owners.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/listpaired' } });
  const text = replies.at(-1).text;
  assert.match(text, /ALL SESSIONS/);
  assert.match(text, /\+92 300 1234567/);
  assert.match(text, /user 20/);
  assert.match(text, /Total: 2 sessions/);
});

test('/addprem grants and /delprem revokes premium access (bootstrap only)', async () => {
  const premium = [];
  const store = {
    has: async () => false, add: async () => [], remove: async () => true,
    addPremium: async (id, duration) => { premium.push({ id, duration }); return { id, expiresAt: Date.now() + 2_592_000_000 }; },
    removePremium: async (id) => premium.splice(premium.findIndex((entry) => entry.id === id), 1).length > 0
  };
  const { controller, replies } = makeController({ controllerStore: store });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/addprem 77 30d' } });
  assert.deepEqual(premium, [{ id: '77', duration: '30d' }]);
  assert.match(replies.at(-1).text, /PREMIUM GRANTED/);
  controller.sensitiveRequests.clear();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/delprem 77' } });
  assert.deepEqual(premium, []);
  assert.match(replies.at(-1).text, /PREMIUM REMOVED/);
});

test('the pairing guide matches the implemented flow in English and Roman Urdu', () => {
  const { guideBox } = require('../system/lib/telegram-controller');
  const text = guideBox();
  assert.match(text, /PAIRING GUIDE/);
  assert.match(text, /\/pair <your number>/);
  assert.match(text, /Linked Devices/);
  assert.match(text, /Link a Device/);
  assert.match(text, /Link with phone number/);
  assert.match(text, /WhatsApp Connected/);
  assert.match(text, /── Roman Urdu ──/);
  assert.match(text, /Link a Device\" par tap karein/);
  assert.doesNotMatch(text, /[\u0600-\u06FF]/, 'Roman Urdu uses English characters only');
});

test('/pair without arguments opens the interactive number prompt', async () => {
  const { controller, replies } = makeController();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair' } });
  const prompt = replies.at(-1);
  assert.match(prompt.text, /Do not include a plus sign/);
  assert.equal(prompt.markup.force_reply, true);
  assert.equal(controller.pendingPairNumbers.has('10'), true);
});

test('/delpair and /listsessions behave as aliases of /stop and /sessions', async () => {
  const stopped = [];
  const listed = [];
  const { controller, replies } = makeController({
    pairing: fakePairing({
      stopSession: async (_ownerId, number) => { stopped.push(number); return { number, numberDisplay: `+${number}` }; },
      listSessions: async () => { listed.push(true); return []; }
    })
  });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/delpair 923001234567' } });
  assert.deepEqual(stopped, ['923001234567']);
  assert.match(replies.at(-1).text, /SESSION REMOVED/);
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/listsessions' } });
  assert.deepEqual(listed, [true]);
});

// ---------------------------------------------------------------------------
// Interactive callbacks: dashboard, session controls, settings.
// ---------------------------------------------------------------------------

test('dashboard callbacks edit the message and every button has a handler', async () => {
  const { calls, fetchImpl } = captureApi();
  const { controller } = makeController({ fetchImpl });
  const callback = (data) => controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 10 }, data, message: { chat: { id: 1 }, message_id: 55 } } });
  for (const data of ['home', 'nav:guide', 'nav:help', 'nav:status', 'nav:sessions', 'nav:settings']) {
    await callback(data);
    const edit = calls.filter((call) => call.method === 'editMessageText').at(-1);
    assert.ok(edit, `an edit was issued for ${data}`);
    assert.equal(edit.payload.message_id, 55);
  }
  // The home view is the dashboard with its navigation buttons.
  await callback('home');
  const home = calls.filter((call) => call.method === 'editMessageText').at(-1);
  assert.match(home.payload.text, /GOJO MODE ONLINE/);
  assert.deepEqual(home.payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data), [
    'pair:new', 'nav:sessions', 'nav:status', 'nav:guide', 'nav:settings', 'nav:help'
  ]);
});

test('session buttons stay owner-scoped: another user cannot manage a session', async () => {
  const { calls, fetchImpl } = captureApi();
  const seenOwners = [];
  const { controller } = makeController({
    owners: ['10'],
    fetchImpl,
    controllerStore: { has: async (id) => String(id) === '20', add: async () => [], remove: async () => true },
    pairing: fakePairing({
      statusOf: async (ownerId, number, options) => {
        seenOwners.push({ ownerId: String(ownerId), number, options });
        if (String(ownerId) !== '10') throw Object.assign(new Error('No session found for that number on this controller.'), { code: 'NOT_FOUND' });
        return { number, numberDisplay: '+92 300 1234567', status: 'OFFLINE', connected: false, registered: true, reconnects: 0, ownerId: '10' };
      }
    })
  });
  // The owner opens the manage view.
  await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 10 }, data: 'ses:menu:923001234567', message: { chat: { id: 1 }, message_id: 5 } } });
  const ownerView = calls.filter((call) => call.method === 'editMessageText').at(-1);
  assert.match(ownerView.payload.text, /SESSION STATUS/);
  // Another authorized controller taps the same button and only sees a
  // friendly not-found box — the manager resolves ownership server-side.
  await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 20 }, data: 'ses:menu:923001234567', message: { chat: { id: 1 }, message_id: 6 } } });
  const strangerView = calls.filter((call) => call.method === 'editMessageText').at(-1);
  assert.match(strangerView.payload.text, /No session found for that number/);
  assert.deepEqual(seenOwners.map((entry) => entry.ownerId), ['10', '20']);
});

test('the stop button asks for confirmation before credentials are deleted', async () => {
  const { calls, fetchImpl } = captureApi();
  const stopped = [];
  const { controller } = makeController({
    fetchImpl,
    pairing: fakePairing({
      statusOf: async (_ownerId, number) => ({ number, numberDisplay: '+92 300 1234567', status: 'OFFLINE', connected: false, registered: true, reconnects: 0, ownerId: '10' }),
      stopSession: async (_ownerId, number, options) => { stopped.push({ number, options }); return { number, numberDisplay: '+92 300 1234567', status: 'CLEANUP' }; }
    })
  });
  await controller.handleUpdate({ callback_query: { id: 'cb1', from: { id: 10 }, data: 'ses:stop:923001234567', message: { chat: { id: 1 }, message_id: 5 } } });
  const confirm = calls.filter((call) => call.method === 'editMessageText').at(-1);
  assert.match(confirm.payload.text, /REMOVE SESSION/);
  assert.match(confirm.payload.text, /Remove it\?/);
  assert.deepEqual(stopped, [], 'nothing is deleted before the confirmation button');
  await controller.handleUpdate({ callback_query: { id: 'cb2', from: { id: 10 }, data: 'ses:stopok:923001234567', message: { chat: { id: 1 }, message_id: 5 } } });
  const done = calls.filter((call) => call.method === 'editMessageText').at(-1);
  assert.match(done.payload.text, /SESSION REMOVED/);
  assert.deepEqual(stopped, [{ number: '923001234567', options: { admin: true } }], 'the bootstrap owner may stop any session');
});

test('settings toggles are bootstrap-only and persist through the controller store', async () => {
  const settings = [];
  const { calls, fetchImpl } = captureApi();
  const store = {
    has: async (id) => String(id) === '20', add: async () => [], remove: async () => true,
    setSetting: async (key, value) => { settings.push({ key, value }); return value; },
    getSettings: async () => ({})
  };
  const { controller, replies } = makeController({ fetchImpl, controllerStore: store });
  // A regular controller cannot toggle settings.
  await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 20 }, data: 'set:public:on', message: { chat: { id: 1 }, message_id: 5 } } });
  assert.match(replies.at(-1).text, /don't have permission/);
  assert.deepEqual(settings, []);
  // The bootstrap owner toggles public pairing on.
  await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 10 }, data: 'set:public:on', message: { chat: { id: 1 }, message_id: 5 } } });
  assert.deepEqual(settings, [{ key: 'publicMode', value: true }]);
  const view = calls.filter((call) => call.method === 'editMessageText').at(-1);
  assert.match(view.payload.text, /Public pairing: ON/);
  assert.equal(controller.publicMode, true);
});

test('persisted runtime settings load on start and override the config defaults', async () => {
  const { calls, fetchImpl } = captureApi();
  const { controller } = makeController({
    fetchImpl,
    publicMode: false,
    controllerStore: {
      has: async () => false, add: async () => [], remove: async () => true,
      getSettings: async () => ({ publicMode: true, premiumOnly: true })
    }
  });
  await controller.start();
  controller.stop();
  assert.equal(controller.publicMode, true, 'persisted publicMode wins over the constructor default');
  assert.equal(controller.premiumOnly, true, 'persisted premiumOnly wins over the constructor default');
});

test('an invalid or unknown callback shows a friendly fallback, never a raw error', async () => {
  const { calls, fetchImpl } = captureApi();
  const { controller, replies } = makeController({ fetchImpl });
  await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 10 }, data: 'bogus:action', message: { chat: { id: 1 }, message_id: 5 } } });
  assert.match(replies.at(-1).text, /no longer valid/);
  // An invalid number in the callback data fails validation before any lookup.
  await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 10 }, data: 'ses:menu:notanumber', message: { chat: { id: 1 }, message_id: 5 } } });
  const invalid = calls.filter((call) => call.method === 'editMessageText').at(-1);
  assert.match(invalid.payload.text, /PAIRING FAILED/);
  assert.match(invalid.payload.text, /number format is invalid/);
});
