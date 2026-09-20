'use strict';

// ---------------------------------------------------------------------------
// Public-chat identity rule: when a session is paired, a group/supergroup shows
// the MASKED number but the pairer's real Telegram @username, so the session is
// still identifiable without disclosing the number.
//
// Driven through the real TelegramController: notifySessionConnected() (the
// pairing manager's genuine connection event), notifySessionDisconnected() and
// the admin/owner ALL SESSIONS card.
// ---------------------------------------------------------------------------

const { displayAssert: assert, normalizeTelegramText } = require('../test-support/telegram-display');
const test = require('node:test');
const { TelegramController } = require('../system/lib/telegram-controller');

const OWNER = '10';
const USER = '30';
const SESSION = { number: '919876543061', numberDisplay: '+91 987 6543061', status: 'CONNECTED', connected: true, registered: true, ownerId: USER };

function pairingWith(sessions = [SESSION]) {
  return {
    requestPairing: async (_ownerId, number) => ({ code: 'KJ4MNP2X', displayCode: 'KJ4M-NP2X', brand: 'WhatsApp-generated', number, numberDisplay: `+${number}`, expiresAt: Date.now() + 300_000 }),
    listSessions: async () => sessions,
    listAllSessions: async () => sessions,
    queuedPairingCount: async () => 0,
    statusOf: async () => sessions[0] || {},
    stopSession: async () => ({}),
    restartSession: async () => ({})
  };
}

function makeController(pairing = pairingWith()) {
  const replies = [];
  const controller = new TelegramController({
    token: 'token',
    owners: [OWNER],
    controllerStore: { has: async () => false, users: async () => ({}), read: async () => [], listPremium: async () => [] },
    pairing,
    fetchImpl: async (_url, init) => ({ ok: true, json: async () => ({ ok: true, result: JSON.parse(init.body) }) }),
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  controller.running = true;
  controller.startedAt = Date.now() - 3_600_000;
  controller.reply = async (chatId, text) => replies.push({ chatId, text });
  controller.replyPhoto = async (chatId, _image, caption) => replies.push({ chatId, text: caption });
  controller.editMessage = async (chatId, _messageId, text) => { replies.push({ chatId, text }); return {}; };
  return { controller, replies, last: () => normalizeTelegramText(replies.at(-1)?.text || '') };
}

function flow(overrides = {}) {
  return {
    senderKey: USER, chatId: -100123, messageId: 55, number: SESSION.number,
    numberDisplay: SESSION.numberDisplay, publicDisplay: '+91 ••••• 061',
    public: true, actor: { id: USER, username: 'rashid_dev' }, state: 'WAITING',
    ...overrides
  };
}

test('a public pairing success masks the number but shows the Telegram username', async () => {
  const { controller, last } = makeController();
  controller.pairingFlows.set(USER, flow());
  await controller.notifySessionConnected(USER, SESSION);

  const text = last();
  assert.match(text, /CONNECTED/);
  assert.match(text, /User: @rashid_dev/);
  assert.match(text, /\+91 ••••• 061/);
  assert.doesNotMatch(text, /919876543061|\+91 987 6543061/);
});

test('the username survives when the actor cache is the only source (no live flow)', async () => {
  const { controller, last } = makeController();
  // A reconnect: no flow object exists, only the actor seen on earlier updates.
  controller.actors.set(OWNER, { id: OWNER, username: 'anime_md_owner' });
  await controller.notifySessionConnected(OWNER, { ...SESSION, ownerId: OWNER });

  const text = last();
  assert.match(text, /User: @anime_md_owner/);
  // The owner is an authorized viewer in a private chat, so the number is full.
  assert.match(text, /\+91 987 6543061/);
});

test('a normal user in a private chat still never receives the full number', async () => {
  const { controller, last } = makeController();
  controller.pairingFlows.set(USER, flow({ chatId: USER, public: false, publicDisplay: undefined }));
  await controller.notifySessionConnected(USER, SESSION);

  const text = last();
  assert.match(text, /User: @rashid_dev/);
  assert.match(text, /\+91 ••••• 061/);
  assert.doesNotMatch(text, /919876543061|\+91 987 6543061/);
});

test('the session-ended card follows the same rule and carries the username', async () => {
  const { controller, last } = makeController();
  controller.actors.set(USER, { id: USER, username: 'rashid_dev' });
  await controller.notifySessionDisconnected(USER, SESSION, { type: 'LOGOUT', userMessage: 'The session was logged out.' });

  const text = last();
  assert.match(text, /User: @rashid_dev/);
  assert.match(text, /\+91 ••••• 061/);
  assert.doesNotMatch(text, /919876543061|\+91 987 6543061/);
  assert.match(text, /logged out/);
});

test('a group session list identifies rows by @username instead of leaking numbers', async () => {
  const sessions = [SESSION, { number: '2348012345737', numberDisplay: '+234 801 2345737', status: 'RECONNECTING', ownerId: '42' }];
  const { controller, replies, last } = makeController(pairingWith(sessions));
  controller.actors.set(USER, { id: USER, username: 'rashid_dev' });
  controller.actors.set('42', { id: '42', username: 'bilal_x' });
  await controller.sendAllSessionsView(-100123, OWNER, { publicChat: true, owner: true });

  const text = last();
  assert.match(text, /\+91 ••••• 061 — CONNECTED \(@rashid_dev\)/);
  assert.match(text, /\+234 ••••• 737 — RECONNECTING \(@bilal_x\)/);
  assert.doesNotMatch(text, /919876543061|2348012345737/);
  assert.equal(replies.length, 1);

  // The same card in a private owner chat keeps the full numbers, and the raw
  // user id stays the identifier there (no need to swap in a handle).
  const privateView = makeController(pairingWith(sessions));
  await privateView.controller.sendAllSessionsView(OWNER, OWNER, { publicChat: false, owner: true });
  const privateText = normalizeTelegramText(privateView.replies.at(-1).text);
  assert.match(privateText, /\+91 987 6543061 — CONNECTED \(user 30\)/);
});
