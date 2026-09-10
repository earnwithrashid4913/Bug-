'use strict';

// ---------------------------------------------------------------------------
// PUBLIC TELEGRAM GROUP PAIRING + ANIME MD PAGE UPGRADE.
//
// Covers the behaviour a public group/supergroup must have:
//   * /pair is accepted and stays VISIBLE in the group (never silently
//     redirected to a private chat),
//   * one message carries the whole lifecycle by being edited,
//   * the real WhatsApp code is shown there with the number masked,
//   * failures render one short clean line and never technical detail,
//   * nothing secret ever reaches a public chat,
//   * multi-user pairing inside one group stays isolated,
//   * duplicate / per-chat pacing protection,
//   * the new ALL MENU / OWNER MENU / DEVELOPER / THANKS TO / BUY ACCESS
//     dashboard pages, and the plain-text (non-garbled) ANIME MD style.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CANONICAL_IDENTITY
} = require('../system/security');
const { categoriesWithCommands } = require('../system/lib/menu');
const {
  GROUP_PAIRING_COOLDOWN_MS,
  MAX_GROUP_PAIRING_FLOWS,
  NORMAL_PAIRING_LIMIT,
  PREMIUM_PAIRING_LIMIT,
  TelegramController,
  allMenuBox,
  allMenuMarkup,
  developerBox,
  menuCategoryBox,
  publicPairingFailureBox,
  thanksBox
} = require('../system/lib/telegram-controller');

const GROUP_ID = -1001234567890;

// ---------------------------------------------------------------------------
// Fixtures: an in-memory user store and a Telegram API recorder, mirroring the
// real shapes so the controller's access layer and message layer are exercised
// for real.
// ---------------------------------------------------------------------------

function memoryUserStore({ verified = new Set() } = {}) {
  const premium = [];
  return {
    has: async () => false,
    add: async () => [],
    remove: async () => true,
    getSettings: async () => ({}),
    setSetting: async (key, value) => value,
    getUser: async (id) => (verified.has(String(id)) ? { verified: true, pairedNumbers: [] } : undefined),
    updateUser: async (id, patch) => {
      if (patch.verified === true) verified.add(String(id));
      return { verified: verified.has(String(id)) };
    },
    hasPremium: async () => ({ premium: false }),
    addPremium: async (id) => { const record = { id: String(id), expiresAt: Date.now() + 86_400_000 }; premium.push(record); return record; },
    removePremium: async () => true,
    listPremium: async () => [...premium],
    vipStatus: async () => ({ vip: false }),
    isVerified: async (id) => verified.has(String(id)),
    markVerified: async (id) => verified.add(String(id)),
    blockStatus: async () => ({ blocked: false }),
    pairedNumbersOf: async () => [],
    addPairedNumber: async () => {},
    removePairedNumber: async () => {},
    users: async () => ({})
  };
}

// Records every Telegram API call with a realistic message_id per chat.
function recordApi() {
  const calls = [];
  let nextId = 9000;
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    const payload = JSON.parse(init.body || '{}');
    let result = payload;
    if (method === 'getMe') result = { username: 'AnimeMdBot' };
    if (method === 'answerCallbackQuery') result = true;
    if (method === 'getChatMember') result = { status: 'member' };
    if (method === 'sendMessage' || method === 'sendPhoto') { nextId += 1; result = { message_id: nextId }; }
    if (method === 'editMessageText') result = { message_id: payload.message_id };
    calls.push({ method, payload, result });
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
  return { calls, fetchImpl };
}

// A pairing manager double that mimics the real one: one code per request,
// numbered, with a real-looking expiry.
function fakePairing(overrides = {}) {
  let counter = 0;
  const requests = [];
  return {
    requests,
    requestPairing: async (ownerId, number) => {
      counter += 1;
      requests.push({ ownerId: String(ownerId), number });
      return {
        code: `KJ4MNP${counter}X`,
        displayCode: `KJ4M-NP${counter}X`,
        brand: 'WhatsApp-generated',
        number,
        numberDisplay: `+${number}`,
        expiresAt: Date.now() + 300_000
      };
    },
    cancelPairing: async () => ({ cancelled: true }),
    listSessions: async () => [],
    listAllSessions: async () => [],
    statusOf: async () => ({}),
    stopSession: async () => ({}),
    restartSession: async () => ({}),
    ...overrides
  };
}

function makeStack({ pairing = fakePairing(), store = memoryUserStore({ verified: new Set(['10', '11', '12']) }), identity, commandPrefix } = {}) {
  const { calls, fetchImpl } = recordApi();
  const controller = new TelegramController({
    token: 'TEST-BOT-TOKEN',
    owners: ['10'],
    controllerStore: store,
    pairing,
    publicMode: true,
    fetchImpl,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...(identity ? { identity } : {}),
    ...(commandPrefix ? { commandPrefix } : {})
  });
  controller.running = true;
  return { calls, controller, pairing };
}

const textsIn = (calls, chatId, from = 0) => calls
  .slice(from)
  .filter((call) => (call.method === 'sendMessage' || call.method === 'editMessageText') && Number(call.payload.chat_id) === chatId)
  .map((call) => call.payload.text || '');

const pairIn = (controller, chat, senderId, text, type = 'supergroup') => controller.handleUpdate({
  message: { chat: { id: chat, type }, from: { id: senderId }, text }
});

// Clears the per-user sensitive-operation gate so back-to-back requests in one
// test are evaluated on their own merits (production keeps the 20s gate).
function clearUserGate(controller) {
  controller.sensitiveRequests.clear();
  controller.sensitiveLocks.clear();
}

// Lets the per-chat spacing window elapse. The window itself is covered by its
// own test; these tests exercise the flows that follow it.
function letChatWindowElapse(controller) {
  controller.chatPairingCooldowns.clear();
}

// ---------------------------------------------------------------------------
// 1. Public group flow: visible, single message, real code, masked number.
// ---------------------------------------------------------------------------

test('a public supergroup pairing is visible, edits ONE message, and shows the real code', async () => {
  const { calls, controller, pairing } = makeStack();

  await pairIn(controller, GROUP_ID, 11, '/pair 923001234567');

  const groupCalls = calls.filter((call) => Number(call.payload.chat_id) === GROUP_ID);
  const texts = groupCalls.map((call) => call.payload.text || '');

  // The request, the preparing state and the code are all visible in the group.
  assert.match(texts[0], /ANIME MD • PAIRING/);
  assert.match(texts[0], /Pairing request received/);
  assert.ok(texts.some((text) => /Preparing WhatsApp pairing/.test(text)), 'the group shows the preparing state');
  const codeText = texts.find((text) => /ANIME MD • PAIRING CODE/.test(text));
  assert.ok(codeText, 'the group shows the pairing code state');
  assert.match(codeText, /🔐 CODE: KJ4M-NP1X/);

  // Exactly one message is sent; every later state is an EDIT of it.
  assert.equal(groupCalls.filter((call) => call.method === 'sendMessage').length, 1, 'one message for the whole lifecycle');
  const messageId = groupCalls.find((call) => call.method === 'sendMessage').result.message_id;
  for (const call of groupCalls.filter((entry) => entry.method === 'editMessageText')) {
    assert.equal(call.payload.message_id, messageId, 'the same message is edited in place');
  }

  // The code really came from the pairing engine, once, for this user/number.
  assert.deepEqual(pairing.requests, [{ ownerId: '11', number: '923001234567' }]);

  // The number is masked in public; the code box warns it is single use.
  assert.ok(!texts.some((text) => /923001234567/.test(text)), 'the full number is never posted to the group');
  assert.ok(texts.some((text) => /••••• 567/.test(text)), 'the group sees the masked number');
  assert.match(codeText, /Single use/);

  // Nothing was redirected to a private chat.
  assert.deepEqual(calls.filter((call) => Number(call.payload.chat_id) === 11), [], 'no private message is sent');
});

test('a public group failure shows one short clean line and never technical detail', async () => {
  const { calls, controller } = makeStack({
    pairing: fakePairing({
      requestPairing: async () => {
        throw Object.assign(new Error('sendRawMessage failed: Connection Closed (428)'), { code: 'CONNECTION_CLOSED', status: 502 });
      }
    })
  });

  await pairIn(controller, GROUP_ID, 11, '/pair 923001234567');

  const texts = textsIn(calls, GROUP_ID);
  const failure = texts.at(-1);
  assert.match(failure, /ANIME MD • PAIRING/);
  assert.match(failure, /Pairing request could not be started/);
  assert.match(failure, /Please check the number and try again/);
  // The old technical wording must never appear in a public chat.
  for (const text of texts) {
    assert.doesNotMatch(text, /PAIRING FAILED/);
    assert.doesNotMatch(text, /number format is invalid/i);
    assert.doesNotMatch(text, /full international number/i);
    assert.doesNotMatch(text, /Connection Closed|428|sendRawMessage/);
  }
});

test('an invalid number in a public group never opens a socket and never explains validation', async () => {
  const { calls, controller, pairing } = makeStack();

  for (const bad of ['/pair 123', '/pair abcdefgh']) {
    clearUserGate(controller);
    await pairIn(controller, GROUP_ID, 11, bad);
  }

  assert.deepEqual(pairing.requests, [], 'no pairing was requested for invalid input');
  const texts = textsIn(calls, GROUP_ID);
  assert.equal(texts.length, 2, 'one short notice per invalid request');
  for (const text of texts) {
    assert.equal(text, publicPairingFailureBox(), 'the public notice is the clean box');
    assert.doesNotMatch(text, /7-15 digit|country code|format/i);
  }
  // A private chat still gets the actionable detail.
  clearUserGate(controller);
  await controller.handleUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 11 }, text: '/pair 123' } });
  assert.match(textsIn(calls, 1).at(-1), /number format is invalid/i);
});

// ---------------------------------------------------------------------------
// 2. Multi-user isolation + abuse protection inside one group.
// ---------------------------------------------------------------------------

test('two users pairing different numbers in one group do not affect each other', async () => {
  const { calls, controller, pairing } = makeStack();

  await pairIn(controller, GROUP_ID, 11, '/pair 923001234567');
  const afterFirst = calls.length;
  clearUserGate(controller);
  letChatWindowElapse(controller);
  await pairIn(controller, GROUP_ID, 12, '/pair 12025550123');

  const groupTexts = textsIn(calls, GROUP_ID);
  assert.deepEqual(pairing.requests, [
    { ownerId: '11', number: '923001234567' },
    { ownerId: '12', number: '12025550123' }
  ]);
  assert.match(groupTexts.find((text) => /KJ4M-NP1X/.test(text)) || '', /••••• 567/);
  assert.match(textsIn(calls, GROUP_ID, afterFirst).find((text) => /KJ4M-NP2X/.test(text)) || '', /••••• 123/);
  // Still exactly one message per flow.
  assert.equal(calls.filter((call) => call.method === 'sendMessage' && Number(call.payload.chat_id) === GROUP_ID).length, 2);
});

test('the same number twice in one group is acknowledged instead of opening a second flow', async () => {
  const { calls, controller, pairing } = makeStack();

  await pairIn(controller, GROUP_ID, 11, '/pair 923001234567');
  const before = calls.length;
  clearUserGate(controller);
  letChatWindowElapse(controller);
  await pairIn(controller, GROUP_ID, 12, '/pair 923001234567');

  assert.equal(pairing.requests.length, 1, 'the pairing engine is only asked once');
  const notice = textsIn(calls, GROUP_ID, before).at(-1);
  assert.match(notice, /already running here/);
  // The duplicate gets a short acknowledgement; it never owns a second flow.
  const sends = calls
    .filter((call) => call.method === 'sendMessage' && Number(call.payload.chat_id) === GROUP_ID)
    .map((call) => call.payload.text || '');
  assert.equal(sends.filter((text) => /Pairing request received/.test(text)).length, 1, 'only one pairing flow was started');
  const all = textsIn(calls, GROUP_ID);
  assert.equal(all.filter((text) => /ANIME MD • PAIRING CODE/.test(text)).length, 1, 'only one code was ever shown');
});

test('a group is paced: a second pairing inside the cooldown window is refused without a socket', async () => {
  const { calls, controller, pairing } = makeStack();

  await pairIn(controller, GROUP_ID, 11, '/pair 923001234567');
  const before = calls.length;
  clearUserGate(controller);
  await pairIn(controller, GROUP_ID, 12, '/pair 12025550123');

  assert.equal(pairing.requests.length, 1, 'no second pairing socket is created');
  const notice = textsIn(calls, GROUP_ID, before).at(-1);
  assert.match(notice, /One pairing at a time here/);
  assert.doesNotMatch(notice, /GROUP_PAIRING_COOLDOWN_MS|rate limit/i, 'the internals of the limiter are not exposed');
  assert.ok(GROUP_PAIRING_COOLDOWN_MS > 0 && MAX_GROUP_PAIRING_FLOWS > 0, 'the pacing limits are configured');
  assert.equal(controller.chatFlowCount(GROUP_ID), 1, 'the running flow is tracked for this chat');

  // Once the flow finishes the chat slot is released again.
  controller.endChatPairing(GROUP_ID, '11');
  assert.equal(controller.chatFlowCount(GROUP_ID), 0);
});

test('a chat at the concurrent-pairing cap is told to wait, and stale entries are pruned', async () => {
  const { controller } = makeStack();
  // Simulate the maximum number of live flows in this chat.
  for (let index = 0; index < MAX_GROUP_PAIRING_FLOWS; index += 1) {
    const senderKey = String(200 + index);
    controller.pairingFlows.set(senderKey, { senderKey, chatId: GROUP_ID, number: `9230000000${index}`, state: 'WAITING', stopped: false });
    controller.beginChatPairing(GROUP_ID, senderKey);
  }
  assert.equal(controller.chatFlowCount(GROUP_ID), MAX_GROUP_PAIRING_FLOWS);

  const pace = controller.checkChatPairingPace(GROUP_ID);
  assert.equal(pace.allowed, false);
  assert.equal(pace.reason, 'busy');

  // prunePendingState drops entries whose flow is gone, so the maps stay bounded.
  controller.pairingFlows.clear();
  controller.prunePendingState();
  assert.equal(controller.chatFlowCount(GROUP_ID), 0);
  assert.equal(controller.chatPairingFlows.size, 0);
});

// ---------------------------------------------------------------------------
// 3. Public chats never leak secrets.
// ---------------------------------------------------------------------------

test('no secret ever reaches a public chat', async () => {
  const { calls, controller } = makeStack({
    identity: { owner: 'Rashid Hussain', developer: 'F!xa Dev', channel: 'https://whatsapp.com/channel/example' }
  });

  await pairIn(controller, GROUP_ID, 11, '/pair 923001234567');
  clearUserGate(controller);
  await pairIn(controller, GROUP_ID, 11, '/pair 999');
  for (const action of ['nav:status', 'nav:sessions', 'nav:account', 'nav:settings', 'nav:help', 'nav:guide', 'nav:allmenu', 'nav:developer', 'nav:thanks']) {
    await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 11 }, data: action, message: { chat: { id: GROUP_ID, type: 'supergroup' }, message_id: 5 } } });
  }

  const publicText = calls
    .filter((call) => Number(call.payload.chat_id) === GROUP_ID)
    .map((call) => call.payload.text || call.payload.caption || '')
    .join('\n');

  for (const secret of ['TEST-BOT-TOKEN', 'token', 'telegram-pairings', 'creds.json', 'authDir', './session', './data', 'YOUR_TELEGRAM_OWNER_ID']) {
    assert.ok(!publicText.toLowerCase().includes(secret.toLowerCase()), `"${secret}" must never appear in a public chat`);
  }
  assert.doesNotMatch(publicText, /at [A-Za-z0-9_/.-]+\.js:\d+:\d+/, 'no stack trace in a public chat');
  // The user's own number is masked in every pairing message. (The literal
  // 923001234567 in /help and /guide is the documented FORMAT example, not a
  // user's number.)
  const pairingText = calls
    .filter((call) => Number(call.payload.chat_id) === GROUP_ID
      && /ANIME MD • (PAIRING|PAIRING CODE|CODE EXPIRED) 〕/.test(call.payload.text || '')
      && !/PAIRING GUIDE/.test(call.payload.text || ''))
    .map((call) => call.payload.text || '')
    .join('\n');
  assert.ok(pairingText.length > 0, 'pairing messages were produced');
  assert.doesNotMatch(pairingText, /923001234567/, 'the full number is never posted publicly');
  assert.match(pairingText, /••••• 567/);
});

// ---------------------------------------------------------------------------
// 4. ANIME MD page upgrade: ALL MENU / DEVELOPER / THANKS TO / BUY ACCESS.
// ---------------------------------------------------------------------------

test('ALL MENU lists only commands the project really registers', () => {
  const prefix = '!';
  const categories = categoriesWithCommands();
  const text = allMenuBox(prefix);
  assert.match(text, /ANIME MD • ALL MENU/);
  const total = categories.reduce((sum, category) => sum + category.commands.length, 0);
  assert.match(text, new RegExp(`🧩 Commands: ${total}`));
  for (const category of categories) {
    assert.match(text, new RegExp(`${category.label} — ${category.commands.length}`), `${category.label} is listed with its real count`);
  }
  // Every category button is a real category with a real handler payload.
  const ids = allMenuMarkup().inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  const categoryIds = categories.map((category) => `menu:cat:${category.id}`);
  assert.deepEqual(ids.filter((id) => id.startsWith('menu:cat:')).sort(), categoryIds.sort());
  assert.ok(ids.includes('home'), 'the ALL MENU page has a way home');
  // A category page renders only that category's real commands.
  const sample = categories[0];
  const categoryText = menuCategoryBox(sample, prefix);
  for (const command of sample.commands) {
    assert.ok(categoryText.includes(`${prefix}${command.name}`), `${prefix}${command.name} is documented`);
  }
  assert.doesNotMatch(categoryText, /undefined|NaN/);
});

test('DEVELOPER and THANKS TO use the canonical project identity, never a copied one', () => {
  const developerText = developerBox({ owner: 'Rashid Hussain', developer: 'F!xa Dev', channel: 'https://whatsapp.com/channel/example' });
  assert.match(developerText, /ANIME MD • DEVELOPER/);
  assert.match(developerText, /👑 Global Owner/);
  assert.match(developerText, /Rashid Hussain/);
  assert.match(developerText, /🛠 Developer/);
  assert.match(developerText, /F!xa Dev/);
  assert.match(developerText, new RegExp(`📦 Project: ${CANONICAL_IDENTITY.projectName}`));

  const thanksText = thanksBox({ owner: 'Rashid Hussain', developer: 'F!xa Dev' });
  assert.match(thanksText, /ANIME MD • THANKS TO/);
  assert.match(thanksText, /Rashid Hussain & F!xa Dev/);
  // No phone number, Telegram ID or path belongs on these pages.
  for (const text of [developerText, thanksText]) {
    assert.doesNotMatch(text, /\+\d{7,15}/);
    assert.doesNotMatch(text, /\/session|creds|\.json/);
  }
});

test('BUY ACCESS renders the real access-model limits and the caller’s own tier', async () => {
  const { calls, controller } = makeStack();
  await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 11 }, data: 'nav:premium', message: { chat: { id: 1 }, message_id: 7 } } });
  const text = calls.filter((call) => call.method === 'editMessageText').at(-1).payload.text;
  assert.match(text, /ANIME MD • PREMIUM/);
  assert.match(text, new RegExp(`• ${NORMAL_PAIRING_LIMIT} pairing session`));
  assert.match(text, new RegExp(`• ${PREMIUM_PAIRING_LIMIT} pairing sessions`));
  assert.match(text, /✦ VIP Premium/);
  assert.match(text, /Your tier:/);
  assert.match(text, /Your sessions: 0\/1/);
  assert.doesNotMatch(text, /PKR|Rs\.|\$\d/, 'no invented pricing');
});

test('OWNER MENU stays owner-only and the new pages are reachable from the main menu', async () => {
  const { calls, controller } = makeStack();
  const buttonsFor = (data, senderId) => controller.handleUpdate({
    callback_query: { id: 'cb', from: { id: senderId }, data, message: { chat: { id: 1 }, message_id: 7 } }
  }).then(() => calls.filter((call) => call.method === 'editMessageText').at(-1));

  const ownerHome = await buttonsFor('home', 10);
  const ownerButtons = ownerHome.payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  for (const expected of ['pair:new', 'nav:sessions', 'nav:allmenu', 'nav:status', 'nav:account', 'nav:premium', 'nav:developer', 'nav:thanks', 'nav:guide', 'nav:help', 'nav:settings', 'nav:admin', 'nav:owner']) {
    assert.ok(ownerButtons.includes(expected), `the owner main menu includes ${expected}`);
  }

  // Every button on the owner main menu resolves to a real handler that edits
  // the message — no dead buttons.
  for (const data of ownerButtons) {
    const before = calls.filter((call) => call.method === 'editMessageText' || call.method === 'sendMessage').length;
    await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 10 }, data, message: { chat: { id: 1 }, message_id: 7 } } });
    assert.ok(
      calls.filter((call) => call.method === 'editMessageText' || call.method === 'sendMessage').length > before,
      `${data} produced a view (no dead button)`
    );
  }

  // A normal user never sees the owner menu.
  const userHome = await buttonsFor('home', 11);
  const userButtons = userHome.payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(!userButtons.includes('nav:owner'));
  assert.ok(!userButtons.includes('nav:admin'));
  assert.ok(userButtons.includes('nav:allmenu'), 'ALL MENU is available to everyone');

  // OWNER MENU content is the owner control center.
  const ownerPanel = await buttonsFor('nav:owner', 10);
  assert.match(ownerPanel.payload.text, /ANIME MD • OWNER PANEL/);
});

test('an unknown category id falls back safely instead of rendering an empty page', async () => {
  const { calls, controller } = makeStack();
  await controller.handleUpdate({ callback_query: { id: 'cb', from: { id: 11 }, data: 'menu:cat:nosuchcategory', message: { chat: { id: 1 }, message_id: 7 } } });
  const text = calls.map((call) => call.payload.text || '').join('\n');
  assert.match(text, /ANIME MD • ERROR/);
  assert.match(text, /Unknown command category/);
  assert.doesNotMatch(text, /ANIME MD • undefined/);
});

// ---------------------------------------------------------------------------
// 5. Text style: plain, readable, never mirrored/garbled.
// ---------------------------------------------------------------------------

test('no ANIME MD surface uses fancy-font Unicode that renders mirrored or as boxes', () => {
  const samples = [
    allMenuBox('!'),
    developerBox({ owner: 'Rashid Hussain', developer: 'F!xa Dev', channel: '' }),
    thanksBox({ owner: 'Rashid Hussain', developer: 'F!xa Dev' }),
    publicPairingFailureBox(),
    menuCategoryBox(categoriesWithCommands()[0], '!')
  ];
  for (const text of samples) {
    // MATHEMATICAL ALPHANUMERIC SYMBOLS (𝐀-𝟿) are the "fancy font" glyphs that
    // clients without a matching font draw mirrored, inverted or as tofu.
    assert.ok(!/[\u{1D400}-\u{1D7FF}]/u.test(text), 'plain text only');
    // Right-to-left / bidi override controls would flip the reading order.
    assert.ok(!/[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200E}\u{200F}]/u.test(text), 'no bidi override characters');
    assert.doesNotMatch(text, /undefined|NaN|\[object Object\]/);
  }
});

// ---------------------------------------------------------------------------
// 6. Error paths in a public chat.
// ---------------------------------------------------------------------------

test('a failing button in a public group renders the clean public line, never the technical reason', async () => {
  const { calls, controller } = makeStack({
    pairing: fakePairing({
      // A session-management failure with a classified, but technical, reason.
      stopSession: async () => {
        throw Object.assign(new Error('This number already has an active session on another controller.'), { code: 'LOCKED', status: 409 });
      }
    })
  });

  await controller.handleUpdate({
    callback_query: { id: 'cb', from: { id: 11 }, data: 'ses:stopok:923001234567', message: { chat: { id: GROUP_ID, type: 'supergroup' }, message_id: 5 } }
  });

  const publicText = calls
    .filter((call) => Number(call.payload.chat_id) === GROUP_ID)
    .map((call) => call.payload.text || '')
    .join('\n');
  assert.match(publicText, /Pairing request could not be started/);
  assert.doesNotMatch(publicText, /another controller|LOCKED|409/);
  assert.doesNotMatch(publicText, /923001234567/);

  // The same failure in a private chat still explains what to do. (The 20s
  // per-user gate for /stop is cleared so this second call is evaluated.)
  clearUserGate(controller);
  await controller.handleUpdate({
    callback_query: { id: 'cb', from: { id: 11 }, data: 'ses:stopok:923001234567', message: { chat: { id: 1, type: 'private' }, message_id: 5 } }
  });
  assert.match(textsIn(calls, 1).join('\n'), /another controller/);
});

test('a command that fails in a public group never prints internal wording', async () => {
  const { calls, controller } = makeStack({
    pairing: fakePairing({
      statusOf: async () => { throw new Error('ENOENT: no such file or directory, open ./session/telegram-pairings/11/creds.json'); }
    })
  });

  await controller.handleUpdate({ message: { chat: { id: GROUP_ID, type: 'supergroup' }, from: { id: 11 }, text: '/status 923001234567' } });

  const publicText = textsIn(calls, GROUP_ID).join('\n');
  assert.match(publicText, /That request could not be completed/);
  assert.doesNotMatch(publicText, /ENOENT|creds\.json|telegram-pairings|\.\//);
});

test('if the code message cannot be delivered the pairing is cancelled instead of orphaned', async () => {
  const { calls, controller, pairing } = makeStack();
  let cancelled;
  pairing.cancelPairing = async (_ownerId, number) => { cancelled = number; return { cancelled: true }; };
  // Both the edit and the send fallback fail (message deleted + API error).
  controller.editMessage = async () => { throw Object.assign(new Error('message to edit not found'), { httpStatus: 400 }); };

  await pairIn(controller, GROUP_ID, 11, '/pair 923001234567');

  assert.equal(cancelled, '923001234567', 'the undeliverable pairing is cancelled — no orphan session');
  assert.equal(controller.pairingFlows.size, 0, 'the flow is cleaned up');
  const texts = textsIn(calls, GROUP_ID);
  assert.match(texts.join('\n'), /Pairing request received/, 'the request was still visibly acknowledged');
  assert.ok(!texts.some((text) => /message to edit not found/.test(text)), 'the Telegram API error is not shown to users');
});
