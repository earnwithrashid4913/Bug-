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

function makeController({ pairing = fakePairing(), owners = ['10'], fetchImpl } = {}) {
  const replies = [];
  const controller = new TelegramController({
    token: 'token',
    owners,
    controllerStore: { has: async () => false, add: async () => [], remove: async () => true },
    pairing,
    fetchImpl: fetchImpl || (async (_url, init) => ({ ok: true, json: async () => ({ ok: true, result: JSON.parse(init.body) }) })),
    log: { info: () => {}, warn: () => {}, error: () => {} }
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
  for (const command of ['/pair <number>', '/sessions', '/status <number>', '/stop <number>', '/restart <number>', '/addowner <telegram_id>', '/delowner <telegram_id>', '/help']) {
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
  assert.match(notification.caption, /🟢 Session is active/);
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
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), { controllers: ['123'] });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
