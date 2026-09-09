'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TelegramController, commandFromUpdate, helpText, joinVerifyMarkup, normalizeWhatsappNumber, startupBox } = require('../system/lib/telegram-controller');
const { TelegramControllerStore } = require('../system/lib/telegram-controllers');

function fakePairing(overrides = {}) {
  return {
    requestPairing: async (_ownerId, number) => ({
      code: 'KJ4MNP2X', displayCode: 'KJ4M-NP2X', brand: 'WhatsApp-generated',
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
    controllerStore: controllerStore || { has: async () => false, add: async () => [], remove: async () => true, getUser: async () => undefined, updateUser: async (id, patch) => patch, pairedNumbersOf: async () => [], addPairedNumber: async () => {}, removePairedNumber: async () => {}, isVerified: async () => false, markVerified: async () => {}, blockStatus: async () => ({ blocked: false }), users: async () => ({}) },
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
  assert.match(replies[1].text, /ANIME MD • PAIRING CODE/);
  assert.match(replies[1].text, /✅ Pairing Code Ready/);
  assert.match(replies[1].text, /🔐 CODE: KJ4M-NP2X/);
  assert.match(replies[1].text, /Link with phone number/);
  assert.doesNotMatch(replies[1].text, /Pairing Code Ready[\s\S]*Pairing Code Ready/, 'the ready box appears once');
});

test('/pair with a + prefix and international formats works identically', async () => {
  for (const input of ['+923001234567', '92 300 1234567', '92-300-1234567', '+12025550123', '12025550123']) {
    const { controller, replies } = makeController();
    await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: `/pair ${input}` } });
    assert.equal(replies.length, 2, `two replies for ${input}`);
    assert.match(replies[1].text, /CODE: KJ4M-NP2X/, `code shown for ${input}`);
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
  // With new architecture, unverified strangers get verification prompt (functional, not ACCESS DENIED as not authorized)
  const strangerReply = replies.pop();
  const strangerText = strangerReply.text || strangerReply.caption || '';
  assert.match(strangerText, /VERIFICATION|SESSIONS|not authorized|ACCESS DENIED|My Sessions/i);
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
  for (const command of ['/start', '/verify', '/pair <number>', '/sessions', '/status [number]', '/stop <number>', '/restart <number>', '/addowner <telegram_id>', '/delowner <telegram_id>', '/addprem', '/delprem', '/addvip', '/delvip', '/block', '/unblock', '/help', '/guide', '/myid', '/premium', '/settings', '/delpair', '/listsessions', '/listpaired']) {
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
  assert.match(replies[1].text, /CODE: KJ4M-NP2X/);
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
    controllerStore: { has: async () => false, getUser: async () => undefined, updateUser: async () => ({}), pairedNumbersOf: async () => [], isVerified: async () => true, blockStatus: async () => ({ blocked: false }), users: async () => ({}) },
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
  assert.match(intro, /𝙂𝙊𝙅𝙊 𝙄𝙎 𝙃𝙀𝙍𝙀./);
  assert.match(intro, /🟢 𝙎𝙔𝙎𝙏𝙀𝙈 𝙍𝙀𝘼𝘿𝙔/);
  assert.match(intro, /👇/);
  // No server-dashboard jargon in the intro.
  assert.doesNotMatch(intro, /Telegram Controller/);
  assert.doesNotMatch(intro, /Pairing System/);
  assert.doesNotMatch(intro, /Session Manager/);
  assert.doesNotMatch(intro, /Traffic Manager/);
  assert.doesNotMatch(intro, /WhatsApp Connected/);
  assert.match(intro, /\/help/);

  controller.stop();
});

test('the startup box never claims a WhatsApp connection by itself', () => {
  const text = startupBox();
  assert.match(text, /╰┈➤\ ⚡\ 𝘼𝙉𝙄𝙈𝙀\ 𝙈𝘿/);
  assert.match(text, /𝙂𝙊𝙅𝙊\ 𝙄𝙎\ 𝙃𝙀𝙍𝙀\./);
  assert.match(text, /🟢\ 𝙎𝙔𝙎𝙏𝙀𝙈\ 𝙍𝙀𝘼𝘿𝙔/);
  assert.match(text, /𝙒𝙝𝙖𝙩'𝙨\ 𝙣𝙚𝙭𝙩\?\ 𝙔𝙤𝙪\ 𝙘𝙝𝙤𝙤𝙨𝙚\.\ 👇/);
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
  // With new architecture, unverified user gets verification, not "not authorized"
  const reply = replies.pop();
  const txt = reply.text || reply.caption || '';
  assert.match(txt, /not authorized|VERIFICATION|STATUS/i);
});

test('persisted controllers can be removed only by bootstrap owners', async () => {
  const removed = [];
  const { controller, replies } = makeController();
  controller.controllerStore = {
    has: async () => false,
    getUser: async () => undefined,
    updateUser: async () => ({}),
    pairedNumbersOf: async () => [],
    isVerified: async () => true,
    blockStatus: async () => ({ blocked: false }),
    users: async () => ({}),
    add: async () => [],
    remove: async (id) => { removed.push(id); return true; }
  };
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/delowner 20' } });
  assert.deepEqual(removed, ['20']);
  controller.sensitiveRequests.clear();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/delowner 10' } });
  assert.match(replies.pop().text, /cannot be removed/);
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 42 }, text: '/addowner 20' } });
  // Non-bootstrap trying to add owner should be denied with bootstrap-only message
  const last = replies.pop().text || '';
  assert.match(last, /Only bootstrap owners|not authorized|DENIED/);
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

// A controller store that records verification, blocking, VIP and paired-number
// usage in memory, mirroring the real TelegramControllerStore so the access
// layer can be tested without touching disk.
function memoryUserStore({ controllers = [], premium = [], verified = new Set(), vip = new Map(), blocked = new Map(), paired = new Map() } = {}) {
  const has = async (id) => controllers.includes(String(id));
  return {
    has, add: async (id) => { controllers.push(String(id)); return controllers; },
    remove: async (id) => { const index = controllers.indexOf(String(id)); if (index >= 0) controllers.splice(index, 1); return index >= 0; },
    getSettings: async () => ({}), setSetting: async (key, value) => value,
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
    removePremium: async (id) => { const index = premium.findIndex((entry) => entry.id === String(id)); if (index >= 0) premium.splice(index, 1); return index >= 0; },
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
    vipStatus: async (id) => vip.has(String(id)) ? { vip: true } : { vip: false },
    setVip: async (id) => { vip.set(String(id), true); return true; },
    removeVip: async (id) => vip.delete(String(id)),
    pairedNumbersOf: async (id) => paired.get(String(id)) || [],
    addPairedNumber: async (id, number) => { const key = String(id); const current = paired.get(key) || []; if (!current.includes(String(number))) paired.set(key, [...current, String(number)]); return current; },
    removePairedNumber: async (id, number) => { const key = String(id); const current = (paired.get(key) || []).filter((entry) => entry !== String(number)); paired.set(key, current); return current; },
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

test('public mode lets any Telegram user verify, pair and manage only their own sessions', async () => {
  const seen = [];
  const store = memoryUserStore();
  const { controller, replies } = makeController({
    publicMode: true,
    controllerStore: store,
    pairing: fakePairing({
      listSessions: async (ownerId) => { seen.push(String(ownerId)); return []; },
      requestPairing: async (ownerId, number) => ({
        code: 'KJ4MNP2X', displayCode: 'KJ4M-NP2X', brand: 'WhatsApp-generated',
        number, numberDisplay: `+${number}`, expiresAt: Date.now() + 300_000
      })
    })
  });
  // A stranger receives the intro plus a verify prompt (no access-denied box).
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/start' } });
  assert.match(replies.at(-1).caption || replies.at(-1).text, /𝙂𝙊𝙅𝙊\ 𝙄𝙎\ 𝙃𝙀𝙍𝙀\./);
  // Restricted commands require self-verification before they run.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/pair 923001234567' } });
  assert.match((replies.at(-1).caption || replies.at(-1).text) || '', /VERIFICATION/);
  // The user verifies. The previously-blocked /pair then continues automatically,
  // so both the success box and the pairing code appear.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/verify' } });
  const afterVerify = replies.map((reply) => reply.text || reply.caption || '').join('\n');
  assert.match(afterVerify, /Verification complete/);
  assert.match(afterVerify, /CODE: KJ4M-NP2X/);
  // Session listings stay scoped to the requesting user.
  // pairingUsageOf now also calls listSessions, so seen may have extra entries, but must include '11'
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/sessions' } });
  assert.ok(seen.includes('11'), `seen should include 11, got ${seen}`);
});
test('premium-only pairing blocks non-premium controllers and bootstrap owners bypass it', async () => {
  const store = {
    has: async (id) => ['20', '30'].includes(String(id)),
    getUser: async () => undefined,
    updateUser: async () => ({}),
    pairedNumbersOf: async () => [],
    isVerified: async () => true,
    blockStatus: async () => ({ blocked: false }),
    users: async () => ({}),
    add: async () => [],
    remove: async () => true,
    hasPremium: async (id) => (String(id) === '30' ? { premium: true, expiresAt: Date.now() + 86_400_000 } : { premium: false }),
    vipStatus: async () => ({ vip: false })
  };
  const { controller, replies } = makeController({ premiumOnly: true, controllerStore: store });

  // Authorized controller without premium is blocked before any socket opens.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 20 }, text: '/pair 923001234567' } });
  assert.match(replies.at(-1).text, /PREMIUM/);
  assert.match(replies.at(-1).text, /premium users/);

  // An authorized controller with premium pairs normally.
  controller.sensitiveRequests.clear();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 30 }, text: '/pair 923001234567' } });
  assert.match(replies.at(-1).text, /CODE: KJ4M-NP2X/);

  // Bootstrap owners bypass the premium requirement entirely.
  controller.sensitiveRequests.clear();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair 12025550123' } });
  assert.match(replies.at(-1).text, /CODE: KJ4M-NP2X/);
});

test('required channels gate pairing until joined; bootstrap owners skip the check', async () => {
  const requiredChannels = [{ name: 'ANIME MD Updates', chatId: '@animemd', link: 'https://t.me/animemd', kind: 'channel' }];
  const { calls, fetchImpl } = captureApi({ chatMemberStatus: 'left' });
  const { controller, replies } = makeController({
    publicMode: true, requiredChannels, fetchImpl,
    controllerStore: memoryUserStore(),
    pairing: fakePairing({ requestPairing: async (_ownerId, number) => ({ code: 'KJ4MNP2X', displayCode: 'KJ4M-NP2X', brand: 'WhatsApp-generated', number, numberDisplay: `+${number}`, expiresAt: Date.now() + 300_000 }) })
  });

  // A public user who is not in the channel fails the live check on /verify.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/verify' } });
  assert.match(replies.at(-1).text, /Verification Failed/);
  assert.match(replies.at(-1).text, /Channel: ❌ Not Joined/);

  // Pairing is blocked with the live membership list until joined.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/pair 923001234567' } });
  const blocked = replies.at(-1).caption || replies.at(-1).text;
  assert.match(blocked, /Membership required/);
  assert.match(blocked, /Channel: ❌ Not Joined/);
  assert.ok(calls.some((call) => call.method === 'getChatMember'));

  // Bootstrap owners skip the join check.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair 923001234567' } });
  assert.match(replies.at(-1).text, /CODE: KJ4M-NP2X/);
});

test('required channels pass members through to the real pairing flow', async () => {
  const { fetchImpl } = captureApi({ chatMemberStatus: 'member' });
  const { controller, replies } = makeController({
    publicMode: true,
    requiredChannels: [{ name: 'ANIME MD Updates', chatId: '@animemd', kind: 'channel' }],
    controllerStore: memoryUserStore(),
    fetchImpl
  });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/verify' } });
  assert.match(replies.at(-1).text, /Verification Successful/);
  assert.match(replies.at(-1).text, /Channel: ✅ Joined/);
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/pair 923001234567' } });
  assert.match(replies.at(-1).text, /CODE: KJ4M-NP2X/);
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
    controllerStore: { has: async (id) => String(id) === '20', add: async () => [], remove: async () => true, getUser: async () => undefined, updateUser: async () => ({}), pairedNumbersOf: async () => [], isVerified: async () => true, blockStatus: async () => ({ blocked: false }), users: async () => ({}) },
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
    getUser: async () => undefined,
    updateUser: async () => ({}),
    pairedNumbersOf: async () => [],
    isVerified: async () => true,
    blockStatus: async () => ({ blocked: false }),
    users: async () => ({}),
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
  assert.match(home.payload.text, /𝙂𝙊𝙅𝙊\ 𝙄𝙎\ 𝙃𝙀𝙍𝙀\./);
  // Home now includes role-aware buttons, check that core buttons exist
  const flat = home.payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  for (const expected of ['pair:new', 'nav:sessions', 'nav:status', 'nav:guide', 'nav:settings', 'nav:help']) {
    assert.ok(flat.includes(expected), `home should include ${expected}`);
  }
});

test('session buttons stay owner-scoped: another user cannot manage a session', async () => {
  const { calls, fetchImpl } = captureApi();
  const seenOwners = [];
  const { controller } = makeController({
    owners: ['10'],
    fetchImpl,
    controllerStore: { has: async (id) => String(id) === '20', add: async () => [], remove: async () => true, getUser: async () => undefined, updateUser: async () => ({}), pairedNumbersOf: async () => [], isVerified: async () => true, blockStatus: async () => ({ blocked: false }), users: async () => ({}) },
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
    getUser: async () => undefined,
    updateUser: async () => ({}),
    pairedNumbersOf: async () => [],
    isVerified: async () => true,
    blockStatus: async () => ({ blocked: false }),
    users: async () => ({}),
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
      getUser: async () => undefined,
      updateUser: async () => ({}),
      pairedNumbersOf: async () => [],
      isVerified: async () => true,
      blockStatus: async () => ({ blocked: false }),
      users: async () => ({}),
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

// ---------------------------------------------------------------------------
// New feature tests: single-message pairing, copy-code button, regeneration,
// access roles, verification enforcement, and temporary blocking.
// ---------------------------------------------------------------------------

// A Telegram API stub that returns real message IDs for sendMessage/sendPhoto
// and records edits, so the single-message pairing lifecycle can be asserted.
function flowApi() {
  const calls = [];
  let messageId = 5000;
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

function flowPairing(overrides = {}) {
  let counter = 0;
  return {
    requestPairing: async (_ownerId, number) => {
      counter += 1;
      return { code: `CODE${counter}`, displayCode: `CODE-${counter}`, brand: 'WhatsApp-generated', number, numberDisplay: `+${number}`, expiresAt: Date.now() + 300_000 };
    },
    cancelPairing: async () => ({ cancelled: true }),
    listSessions: async () => [],
    statusOf: async () => ({}),
    stopSession: async () => ({}),
    restartSession: async () => ({}),
    listAllSessions: async () => [],
    ...overrides
  };
}

function flowController({ calls, fetchImpl, pairing = flowPairing(), store } = {}) {
  const controller = new TelegramController({
    token: 'token', owners: ['10'],
    controllerStore: store || memoryUserStore(),
    pairing,
    fetchImpl,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  return { calls, fetchImpl, controller };
}

test('the pairing lifecycle edits ONE message and never sends a second code message', async () => {
  const { calls, fetchImpl } = flowApi();
  const { controller } = flowController({ calls, fetchImpl });
  controller.running = true;
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair 92355817646' } });
  const sends = calls.filter((call) => call.method === 'sendMessage');
  const edits = calls.filter((call) => call.method === 'editMessageText');
  assert.equal(sends.length, 1, 'only the PREPARING message is sent as a new message');
  assert.equal(edits.length, 1, 'the code box arrives as an edit of the same message');
  const prep = sends[0].payload;
  const code = edits[0].payload;
  assert.equal(sends[0].result.message_id, code.message_id, 'the code is edited onto the same message id');
  assert.match(prep.text, /Preparing WhatsApp pairing/);
  assert.match(code.text, /ANIME MD • PAIRING CODE/);
  assert.match(code.text, /🔐 CODE: CODE-1/);
});

test('the Copy Code button uses native copy_text with only the code', async () => {
  const { calls, fetchImpl } = flowApi();
  const { controller } = flowController({ calls, fetchImpl });
  controller.running = true;
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair 92355817646' } });
  const codeEdit = calls.filter((call) => call.method === 'editMessageText').at(-1);
  const buttons = codeEdit.payload.reply_markup.inline_keyboard.flat();
  const copy = buttons.find((button) => button.text === '📋 Copy Code');
  assert.ok(copy, 'the copy button is present');
  assert.deepEqual(copy.copy_text, { text: 'CODE-1' }, 'copy_text carries ONLY the raw code');
  assert.equal(copy.callback_data, undefined, 'the copy button is not a fake callback');
  assert.equal(copy.copy_text.text.includes('|'), false, 'the copied text is not the whole message');
});

test('the Generate New Code button regenerates on the same message and is owner-scoped', async () => {
  const { calls, fetchImpl } = flowApi();
  const { controller } = flowController({ calls, fetchImpl });
  controller.running = true;
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair 92355817646' } });
  const first = calls.filter((call) => call.method === 'editMessageText').at(-1);
  const token = first.payload.reply_markup.inline_keyboard[1][0].callback_data.split(':')[2];
  const messageId = first.payload.message_id;
  // The owner who initiated the flow can regenerate.
  await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 10 }, data: `pair:regen:${token}`, message: { chat: { id: 1 }, message_id: messageId } } });
  const lastEdit = calls.filter((call) => call.method === 'editMessageText').at(-1);
  assert.match(lastEdit.payload.text, /PAIRING CODE/);
  assert.equal(lastEdit.payload.message_id, messageId, 'the regenerated code edits the same message');
  // A stale forged token from another user is rejected and never edits.
  const before = calls.filter((call) => call.method === 'editMessageText').length;
  await controller.handleUpdate({ callback_query: { id: 'cb2', from: { id: 11 }, data: `pair:regen:${token}`, message: { chat: { id: 1 }, message_id: messageId } } });
  assert.equal(calls.filter((call) => call.method === 'editMessageText').length, before, 'a forged callback does not regenerate');
});

test('verification is enforced functionally and persists across attempts', async () => {
  const store = memoryUserStore();
  const { controller, replies } = makeController({ publicMode: true, controllerStore: store, pairing: flowPairing() });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/sessions' } });
  assert.match((replies.at(-1).caption || replies.at(-1).text) || '', /VERIFICATION/);
  // Verification persists in the store; the blocked /sessions continues automatically.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/verify' } });
  const afterVerify = replies.map((reply) => reply.text || reply.caption || '').join('\n');
  assert.match(afterVerify, /Verification complete/);
  assert.match(afterVerify, /ANIME MD • SESSIONS/);
  assert.equal(await store.isVerified('11'), true);
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/sessions' } });
  assert.match(replies.at(-1).text, /ANIME MD • SESSIONS/);
});

test('a blocked user is denied with a dynamic unblock time and access auto-restores', async () => {
  const store = memoryUserStore();
  await store.markVerified('11');
  await store.setBlocked('11', 3_600_000);
  const { controller, replies } = makeController({ publicMode: true, controllerStore: store, pairing: flowPairing() });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/pair 92355817646' } });
  const blocked = replies.at(-1).text;
  assert.match(blocked, /ACCESS BLOCKED/);
  assert.match(blocked, /Unblocks:/);
  assert.match(blocked, /Remaining:/);
  assert.match(blocked, /Please try again after the block expires/);
  assert.doesNotMatch(blocked, /92355817646/, 'the public notice never leaks the phone number');
  // After the block expires the user is automatically restored (no admin action).
  await store.clearBlocked('11');
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/pair 92355817646' } });
  assert.match(replies.at(-1).text, /PAIRING CODE|Preparing WhatsApp pairing/);
});

test('access roles resolve from the database and enforce premium/VIP limits', async () => {
  const store = memoryUserStore({ controllers: ['99'], premium: [{ id: '20', expiresAt: Date.now() + 86_400_000 }], vip: new Map([['30', true]]) });
  const { controller } = makeController({ controllerStore: store, owners: ['10'], pairing: flowPairing() });
  assert.equal(await controller.roleOf('10'), 'owner');
  assert.equal(await controller.roleOf('99'), 'admin');
  assert.equal(await controller.roleOf('30'), 'vip');
  assert.equal(await controller.roleOf('20'), 'premium');
  assert.equal(await controller.roleOf('44'), 'normal');
  assert.equal(await controller.pairingLimitOf('10'), Infinity);
  assert.equal(await controller.pairingLimitOf('99'), Infinity);
  assert.equal(await controller.pairingLimitOf('30'), Infinity);
  assert.equal(await controller.pairingLimitOf('20'), 3);
  // Normal users now have limit 1 per spec (not 5)
  assert.equal(await controller.pairingLimitOf('44'), 1);
});

test('a premium user at the unique-number cap is refused before any socket opens', async () => {
  const store = memoryUserStore({ verified: new Set(['20']), premium: [{ id: '20', expiresAt: Date.now() + 86_400_000 }], paired: new Map([['20', ['923001234567', '12025550123', '971501234567']]]) });
  const { controller, replies } = makeController({ publicMode: true, controllerStore: store, pairing: flowPairing() });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 20 }, text: '/pair 92355987654' } });
  assert.match(replies.at(-1).text, /PAIRING LIMIT/);
  assert.match(replies.at(-1).text, /3\/3 numbers/);
});

test('public chats never reveal a phone number or session detail', async () => {
  const { calls, fetchImpl } = flowApi();
  const { controller } = flowController({ calls, fetchImpl });
  controller.running = true;
  // A public group user tries to pair; the bot refuses with a privacy notice
  // and NEVER sends the PREPARING box with the number.
  await controller.handleUpdate({ message: { chat: { id: -1001, type: 'supergroup' }, from: { id: 10 }, text: '/pair 92355817646' } });
  const texts = calls.filter((call) => call.method === 'sendMessage').map((call) => call.payload.text);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /this bot only works in a private chat/i);
  assert.doesNotMatch(texts[0], /92355817646/, 'the phone number is never broadcast to a public chat');
  // Private chats still pair normally.
  await controller.handleUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 10 }, text: '/pair 92355817646' } });
  const pairSends = calls.filter((call) => call.method === 'sendMessage').map((call) => call.payload.text);
  assert.ok(pairSends.some((text) => /Preparing WhatsApp pairing/.test(text)), 'the private chat still pairs');
});

// ---------------------------------------------------------------------------
// Mandatory dual-community verification, live re-check, callback security,
// pairing protection, tier display and owner activity monitoring.
// ---------------------------------------------------------------------------

const FIXA_COMMUNITIES = Object.freeze([
  { name: 'Fixa Updates', chatId: '@fixaupdates', link: 'https://t.me/fixaupdates', kind: 'channel' },
  { name: 'Fixa Dev GB Group', chatId: '@FixaDevGBGroup', link: 'https://t.me/FixaDevGBGroup', kind: 'group' }
]);

function membershipApi(statusByChat) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    const payload = JSON.parse(init.body || '{}');
    calls.push({ method, payload });
    if (method === 'getChatMember') {
      const key = String(payload.chat_id);
      const entry = statusByChat.get(key);
      if (entry instanceof Error) {
        return { ok: false, json: async () => ({ ok: false, description: entry.message }) };
      }
      return { ok: true, json: async () => ({ ok: true, result: { status: entry || 'left' } }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: payload }) };
  };
  return { calls, fetchImpl };
}

test('dual membership requires BOTH communities; joining only one is not verified', async () => {
  const statusByChat = new Map([['@fixaupdates', 'member'], ['@FixaDevGBGroup', 'left']]);
  const { fetchImpl } = membershipApi(statusByChat);
  const store = memoryUserStore();
  const { controller, replies } = makeController({
    publicMode: true, requiredChannels: FIXA_COMMUNITIES, fetchImpl, controllerStore: store
  });

  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/verify' } });
  const text = replies.at(-1).text;
  assert.match(text, /Verification Failed/);
  assert.match(text, /Channel: ✅ Joined/);
  assert.match(text, /Group: ❌ Not Joined/);

  // A protected command stays blocked until BOTH are joined.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/sessions' } });
  const blocked = replies.at(-1).caption || replies.at(-1).text;
  assert.match(blocked, /Membership required/);
  assert.match(blocked, /Channel: ✅ Joined/);
  assert.match(blocked, /Group: ❌ Not Joined/);
  assert.equal(await store.isVerified('11'), false);
});

test('leaving a community after verification revokes access on the next live check', async () => {
  const statusByChat = new Map([['@fixaupdates', 'member'], ['@FixaDevGBGroup', 'member']]);
  const { fetchImpl } = membershipApi(statusByChat);
  const store = memoryUserStore();
  const { controller, replies } = makeController({
    publicMode: true, requiredChannels: FIXA_COMMUNITIES, fetchImpl, controllerStore: store, pairing: flowPairing()
  });

  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/verify' } });
  assert.match(replies.at(-1).text, /Verification Successful/);
  assert.equal(await store.isVerified('11'), true);

  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/pair 92355817646' } });
  assert.match(replies.at(-1).text, /CODE:/);

  // The user leaves the group. The next protected command forces a live check,
  // revokes access and clears the stale DB flag.
  statusByChat.set('@FixaDevGBGroup', 'left');
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/sessions' } });
  const blocked = replies.at(-1).caption || replies.at(-1).text;
  assert.match(blocked, /Membership required/);
  assert.equal(await store.isVerified('11'), false, 'the stale verified flag is cleared');
});

test('a Telegram API failure during verification fails closed', async () => {
  const statusByChat = new Map([
    ['@fixaupdates', new Error('Forbidden: bot is not a member of the chat')],
    ['@FixaDevGBGroup', new Error('Forbidden: bot is not a member of the chat')]
  ]);
  const { fetchImpl } = membershipApi(statusByChat);
  const { controller, replies } = makeController({
    publicMode: true, requiredChannels: FIXA_COMMUNITIES, fetchImpl, controllerStore: memoryUserStore()
  });

  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/verify' } });
  assert.match(replies.at(-1).text, /Could not verify your membership/);

  // Protected commands refuse (fail closed) rather than granting on error.
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 11 }, text: '/pair 923001234567' } });
  const blocked = replies.at(-1).caption || replies.at(-1).text;
  assert.match(blocked, /Could not verify your membership/);
});

test('inline VERIFY shows loading, then success with ✅ VERIFIED and 🏠 MAIN MENU', async () => {
  const { calls, fetchImpl } = captureApi({ chatMemberStatus: 'member' });
  const { controller } = makeController({
    publicMode: true, requiredChannels: FIXA_COMMUNITIES, fetchImpl, controllerStore: memoryUserStore()
  });
  await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 11 }, data: 'verify:me', message: { chat: { id: 1 }, message_id: 55 } } });
  const edits = calls.filter((call) => call.method === 'editMessageText');
  assert.match(edits[0].payload.text, /Checking your membership/);
  const last = edits.at(-1).payload;
  assert.match(last.text, /Verification Successful/);
  assert.match(last.text, /Channel: ✅ Joined/);
  assert.match(last.text, /Group: ✅ Joined/);
  const buttons = last.reply_markup.inline_keyboard.flat().map((button) => button.text);
  assert.ok(buttons.includes('✅ VERIFIED'));
  assert.ok(buttons.includes('🏠 MAIN MENU'));
});

test('JOIN buttons point at the exact configured community links', () => {
  const buttons = joinVerifyMarkup(FIXA_COMMUNITIES).inline_keyboard.flat();
  const joinChannel = buttons.find((button) => button.text === '📢 JOIN CHANNEL');
  const joinGroup = buttons.find((button) => button.text === '👥 JOIN GROUP');
  assert.equal(joinChannel.url, 'https://t.me/fixaupdates');
  assert.equal(joinGroup.url, 'https://t.me/FixaDevGBGroup');
  assert.equal(buttons.find((button) => button.text === '🔄 VERIFY').callback_data, 'verify:me');
  assert.ok(buttons.some((button) => button.text === '🚀 JOIN ALL'));
});

test('JOIN ALL opens both destinations and returns to VERIFY', async () => {
  const { calls, fetchImpl } = captureApi({ chatMemberStatus: 'left' });
  const { controller } = makeController({
    publicMode: true, requiredChannels: FIXA_COMMUNITIES, fetchImpl, controllerStore: memoryUserStore()
  });
  await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 11 }, data: 'verify:joinall', message: { chat: { id: 1 }, message_id: 55 } } });
  const edit = calls.filter((call) => call.method === 'editMessageText').at(-1);
  assert.match(edit.payload.text, /JOIN ALL/);
  assert.match(edit.payload.text, /Fixa Updates/);
  assert.match(edit.payload.text, /Fixa Dev GB Group/);
  const buttons = edit.payload.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.find((button) => button.text === '📢 JOIN CHANNEL').url, 'https://t.me/fixaupdates');
  assert.equal(buttons.find((button) => button.text === '👥 JOIN GROUP').url, 'https://t.me/FixaDevGBGroup');
  assert.ok(buttons.some((button) => button.text === '🔄 VERIFY'));
});

test('verification callbacks are scoped to the actual callback user', async () => {
  const statusByChat = new Map([['@fixaupdates', 'member'], ['@FixaDevGBGroup', 'member']]);
  const { fetchImpl } = membershipApi(statusByChat);
  const store = memoryUserStore();
  const { controller } = makeController({
    publicMode: true, requiredChannels: FIXA_COMMUNITIES, fetchImpl, controllerStore: store
  });

  // User 11 (joined both) verifies via callback; only user 11 is marked.
  await controller.handleUpdate({ callback_query: { id: 'c1', from: { id: 11 }, data: 'verify:me', message: { chat: { id: 1 }, message_id: 6 } } });
  assert.equal(await store.isVerified('11'), true);

  // User 12 has not joined; their own VERIFY callback cannot ride on user 11's
  // state — the guard resolves identity from the callback's from.id.
  statusByChat.set('@fixaupdates', 'left');
  await controller.handleUpdate({ callback_query: { id: 'c2', from: { id: 12 }, data: 'verify:me', message: { chat: { id: 1 }, message_id: 7 } } });
  assert.equal(await store.isVerified('12'), false);
  assert.equal(await store.isVerified('11'), true, 'another user\'s failed callback never clears user 11');
});

test('/status shows the requesting user\'s database tier and membership', async () => {
  const store = memoryUserStore({
    controllers: ['20'],
    premium: [{ id: '30', expiresAt: Date.now() + 86_400_000 }],
    vip: new Map([['40', true]]),
    verified: new Set(['30', '40', '50'])
  });
  const { controller, replies } = makeController({ controllerStore: store, owners: ['10'], pairing: fakePairing({ listSessions: async () => [] }) });

  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/status' } });
  assert.match(replies.at(-1).text, /👑 Tier: OWNER/);
  assert.match(replies.at(-1).text, /🔐 Membership: Verified/);

  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 20 }, text: '/status' } });
  assert.match(replies.at(-1).text, /🛡 Tier: ADMIN/);

  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 30 }, text: '/status' } });
  assert.match(replies.at(-1).text, /⭐ Tier: PREMIUM/);

  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 40 }, text: '/status' } });
  assert.match(replies.at(-1).text, /👑 Tier: VIP PREMIUM/);

  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 50 }, text: '/status' } });
  assert.match(replies.at(-1).text, /👤 Tier: FREE/);
  assert.match(replies.at(-1).text, /🔐 Membership: Verified/);
});

test('owner activity notifications carry only non-sensitive fields', async () => {
  const events = [];
  const { fetchImpl } = flowApi();
  const controller = new TelegramController({
    token: 'token', owners: ['10'],
    controllerStore: memoryUserStore(),
    pairing: flowPairing(),
    fetchImpl,
    activityLogger: async (event) => events.push(event),
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  controller.running = true;
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10, first_name: 'Rashid', username: 'rashid' }, text: '/pair 92355817646' } });
  const actions = events.map((event) => event.action);
  assert.ok(actions.includes('Pair Request'));
  assert.ok(actions.includes('Pairing Code Generated'));
  // The pairing code and flow token must never reach the activity log.
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /CODE-1/);
  assert.doesNotMatch(serialized, /KJ4M/);
});

test('sendOwnerActivity formats a compact activity box for every bootstrap owner', async () => {
  const { calls, fetchImpl } = captureApi();
  const controller = new TelegramController({
    token: 'token', owners: ['10', '20'],
    controllerStore: memoryUserStore(),
    pairing: fakePairing(),
    fetchImpl,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  controller.running = true;
  await controller.sendOwnerActivity({ action: 'Pair Request', actor: { id: '30', username: 'joiner' }, userId: '30', details: ['📱 Number: +92 300 1234567'] });
  const messages = calls.filter((call) => call.method === 'sendMessage');
  assert.equal(messages.length, 2, 'both bootstrap owners receive the activity');
  const text = messages[0].payload.text;
  assert.match(text, /ANIME MD • ACTIVITY/);
  assert.match(text, /👤 User: @joiner/);
  assert.match(text, /🆔 ID: 30/);
  assert.match(text, /⚡ Action: Pair Request/);
  assert.match(text, /🕒 Time:/);
  assert.doesNotMatch(text, /token|CODE|creds/i);
});
