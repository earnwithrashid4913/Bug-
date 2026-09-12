'use strict';

// ---------------------------------------------------------------------------
// Acceptance test for the /pair flow, wired exactly like index.js:
//
//   Telegram /pair <number>
//     → number validation/normalization
//     → TelegramPairingManager.requestPairing
//     → real Baileys socket.requestPairingCode(number)   (phone number only)
//     → the code WhatsApp returned is shown verbatim in Telegram
//     → connection.update === 'open'  →  "WhatsApp Connected"
//
// The Baileys layer is faked, but the TelegramController and the
// TelegramPairingManager under test are the real production modules.
// ---------------------------------------------------------------------------

const { displayAssert: assert, normalizeTelegramHeadings } = require('../test-support/telegram-display');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { TelegramPairingManager } = require('../system/lib/telegram-pairing-manager');
const { TelegramController } = require('../system/lib/telegram-controller');
const { config } = require('../system/config');

const OWNER_ID = '10';
const NUMBER = '92349494494';

// WhatsApp's pairing alphabet: 32 symbols, deliberately excluding 0, I, O, U.
const PAIRING_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTVWXYZ';

function whatsappStyleCode(number) {
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    const digit = Number(number[i % number.length] || 0);
    out += PAIRING_ALPHABET[(digit * 7 + i * 3) % PAIRING_ALPHABET.length];
  }
  return out;
}

function fakeBaileys() {
  const sockets = [];
  const pairingCalls = [];
  return {
    sockets,
    pairingCalls,
    makeWASocket: (socketConfig) => {
      const ev = new EventEmitter();
      const socket = {
        ev,
        authState: { creds: { registered: false } },
        requestedCreds: socketConfig?.auth?.creds,
        ws: { isOpen: false, close() {} },
        requestPairingCode: async (...args) => {
          pairingCalls.push({ number: args[0], argCount: args.length });
          if (args.length > 1) throw new Error('requestPairingCode must receive the phone number only');
          return whatsappStyleCode(args[0]);
        }
      };
      sockets.push(socket);
      // Real Baileys order: "connecting" first (WebSocket not yet open), then
      // the pair-device stanza that proves the handshake completed.
      queueMicrotask(() => {
        ev.emit('connection.update', { connection: 'connecting' });
        queueMicrotask(() => {
          socket.ws.isOpen = true;
          ev.emit('connection.update', { qr: 'qr-stanza' });
        });
      });
      return socket;
    },
    useMultiFileAuthState: async (dir) => {
      let registered = false;
      try {
        registered = JSON.parse(await fs.readFile(path.join(dir, 'creds.json'), 'utf8')).registered === true;
      } catch {
        registered = false;
      }
      return { state: { creds: { registered }, keys: {} }, saveCreds: async () => {} };
    },
    makeCacheableSignalKeyStore: () => ({})
  };
}

function makeStack({ fake = fakeBaileys() } = {}) {
  const authDir = path.join(os.tmpdir(), `anime-md-accept-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const manager = new TelegramPairingManager({
    authDir,
    baileys: fake,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    limits: { ownerCooldownMs: 0, reconnectBaseDelayMs: 5, reconnectMaxDelayMs: 10 }
  });

  // One array holds EVERY message the controller produces, in order: real
  // sends (`edited: false`) and in-place edits of the single pairing message
  // (`edited: true`). The pairing lifecycle is one message edited through
  // PREPARING → CODE → CONNECTED, so the acceptance checks must see the edits.
  const replies = [];
  let nextMessageId = 0;
  const controller = new TelegramController({
    token: 'token',
    owners: [OWNER_ID],
    controllerStore: { has: async () => false, add: async () => [], remove: async () => true },
    pairing: {
      requestPairing: (ownerId, number) => manager.requestPairing(ownerId, number),
      getStatus: (ownerId) => manager.snapshot(ownerId),
      statusOf: (ownerId, number, options) => manager.statusOf(ownerId, number, options),
      listSessions: (ownerId) => manager.listSessions(ownerId),
      listAllSessions: () => manager.listAllSessions(),
      stopSession: (ownerId, number, options) => manager.stopSession(ownerId, number, options),
      restartSession: (ownerId, number, options) => manager.restartSession(ownerId, number, options)
    },
    fetchImpl: async (_url, init) => ({ ok: true, json: async () => ({ ok: true, result: JSON.parse(init.body) }) }),
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  controller.reply = async (chatId, text, markup) => {
    nextMessageId += 1;
    replies.push({ chatId, messageId: nextMessageId, text, markup, edited: false });
    return { message_id: nextMessageId };
  };
  controller.replyPhoto = async (chatId, image, caption, markup) => {
    nextMessageId += 1;
    replies.push({ chatId, messageId: nextMessageId, text: caption, image, markup, edited: false });
    return { message_id: nextMessageId };
  };
  controller.editMessage = async (chatId, messageId, text, markup) => {
    replies.push({ chatId, messageId, text, markup, edited: true });
    return { message_id: messageId };
  };
  controller.running = true;
  controller.startedAt = Date.now();
  manager.onConnected = async (ownerId, session) => controller.notifySessionConnected(ownerId, session);
  manager.onDisconnected = async (ownerId, session, classification) => controller.notifySessionDisconnected(ownerId, session, classification);

  return { manager, controller, fake, replies };
}

function sendPair(controller, text) {
  // The 20s sensitive-operation cooldown protects production controllers; these
  // tests drive several flows back to back, so the gate is cleared per call.
  controller.sensitiveRequests.clear();
  controller.sensitiveLocks.clear();
  return controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: Number(OWNER_ID) }, text } });
}

function allText(replies) {
  return replies.map((entry) => entry.text || '').join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('ACCEPTANCE: /pair returns the real WhatsApp code and reports CONNECTED only after connection open', async () => {
  const { manager, controller, fake, replies } = makeStack();

  await sendPair(controller, `/pair ${NUMBER}`);

  // 1. ONE Telegram message: the acknowledgement is sent once, then that same
  //    message is edited to the code box. No second message is ever sent.
  const sends = replies.filter((entry) => !entry.edited);
  assert.equal(sends.length, 1, 'exactly one message is sent for the whole lifecycle');
  assert.match(sends[0].text, /Preparing WhatsApp pairing/);
  const codeEntry = replies.find((entry) => /ANIME MD • PAIRING CODE/.test(normalizeTelegramHeadings(entry.text || '')));
  assert.ok(codeEntry, 'the pairing code box is produced');
  assert.equal(codeEntry.edited, true, 'the code arrives as an edit, not a new message');
  assert.equal(codeEntry.messageId, sends[0].messageId, 'the same message is edited in place');

  // 2. The code came from the real Baileys API, called with the number only.
  assert.deepEqual(fake.pairingCalls, [{ number: NUMBER, argCount: 1 }]);
  const realCode = whatsappStyleCode(NUMBER);
  const displayed = codeEntry.text.match(/🔐 CODE: (\S+)/)[1];
  assert.equal(displayed, `${realCode.slice(0, 4)}-${realCode.slice(4)}`, 'Telegram shows the exact socket code');
  assert.equal(displayed.replace('-', ''), realCode, 'the dash is display-only');
  for (const character of realCode) {
    assert.ok(PAIRING_ALPHABET.includes(character), `${character} is not a WhatsApp pairing-alphabet symbol`);
  }
  assert.doesNotMatch(codeEntry.text, /GOAT/i, 'no custom/GOAT-MODS code anywhere in the reply');

  // 3. No connection is claimed before WhatsApp reports open.
  assert.doesNotMatch(allText(replies), /WhatsApp Connected/);

  // 4. The account holder enters the code on the SAME socket; WhatsApp marks
  //    the credentials registered and forces a restart (515).
  const session = manager.getSession(OWNER_ID, NUMBER);
  const originalSocket = session.socket;
  assert.ok(originalSocket, 'the pairing socket is live while the code is valid');
  originalSocket.authState.creds.registered = true;
  originalSocket.ev.emit('creds.update', { registered: true, me: { id: `${NUMBER}:1@s.whatsapp.net` } });
  await fs.mkdir(session.authDir, { recursive: true });
  await fs.writeFile(path.join(session.authDir, 'creds.json'), JSON.stringify({ registered: true }));
  originalSocket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await sleep(30);

  // Still not claimed as connected while the replacement socket reconnects.
  assert.doesNotMatch(allText(replies), /WhatsApp Connected/);

  // 5. connection.update === 'open' → the real CONNECTED notification.
  fake.sockets.at(-1).ev.emit('connection.update', { connection: 'open' });
  await sleep(20);
  const connected = allText(replies);
  assert.match(connected, /WhatsApp Connected/, 'CONNECTED is reported after connection open');
  assert.match(connected, /\+92 349 494494/, 'the connected notification names the paired number');
  assert.equal(manager.getSession(OWNER_ID, NUMBER).status, 'CONNECTED');

  await manager.shutdown();
});

test('ACCEPTANCE: /pair from a supergroup pairs with the real code visible in the group', async () => {
  const { manager, controller, fake, replies } = makeStack();

  // A real supergroup update: the command must be ACCEPTED, not rejected with
  // a private-chat-only notice, and the flow must STAY in the group.
  await controller.handleUpdate({ message: { chat: { id: -1001, type: 'supergroup' }, from: { id: Number(OWNER_ID) }, text: `/pair ${NUMBER}` } });

  const groupTexts = replies.filter((entry) => String(entry.chatId) === String(-1001)).map((entry) => entry.text || '');
  const privateTexts = replies.filter((entry) => String(entry.chatId) === OWNER_ID).map((entry) => entry.text || '');

  assert.ok(groupTexts.some((text) => /Pairing request received/.test(text)), 'the group visibly acknowledges the request');
  assert.ok(groupTexts.some((text) => /Preparing WhatsApp pairing/.test(text)), 'the group pairing flow ran');
  assert.ok(!groupTexts.some((text) => /only works in a private chat/i.test(text)), 'no private-chat-only rejection');
  assert.ok(!groupTexts.some((text) => /92349494494/.test(text)), 'the full number is never broadcast to the group');
  assert.ok(groupTexts.some((text) => /••••• 494/.test(text)), 'the group only ever sees the masked number');
  assert.deepEqual(privateTexts, [], 'nothing is silently redirected to a private chat');

  // The group itself receives the real socket code — the exact value the live
  // Baileys socket returned, formatted XXXX-XXXX.
  const realCode = whatsappStyleCode(NUMBER);
  assert.ok(
    groupTexts.some((text) => /ANIME MD • PAIRING CODE/.test(normalizeTelegramHeadings(text)) && text.includes(`${realCode.slice(0, 4)}-${realCode.slice(4)}`)),
    'the real WhatsApp code is shown in the group'
  );
  assert.equal(fake.pairingCalls.length, 1, 'exactly one real pairing code was generated');
  // No technical wording ever reaches a public chat.
  for (const text of groupTexts) {
    assert.doesNotMatch(text, /number format is invalid/i);
    assert.doesNotMatch(text, /Baileys|socket|creds|authDir|token/i);
  }

  // Complete the link on the real (fake) socket: creds registered, 515
  // restart, replacement socket open.
  const session = manager.getSession(OWNER_ID, NUMBER);
  const originalSocket = session.socket;
  originalSocket.authState.creds.registered = true;
  originalSocket.ev.emit('creds.update', { registered: true, me: { id: `${NUMBER}:1@s.whatsapp.net` } });
  await fs.mkdir(session.authDir, { recursive: true });
  await fs.writeFile(path.join(session.authDir, 'creds.json'), JSON.stringify({ registered: true }));
  originalSocket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await sleep(30);
  fake.sockets.at(-1).ev.emit('connection.update', { connection: 'open' });
  await sleep(20);

  assert.equal(manager.getSession(OWNER_ID, NUMBER).status, 'CONNECTED');
  // The group success is masked, and it is an EDIT of the same pairing message
  // — the connected state never claims a connection before connection open.
  const groupAfter = replies.filter((entry) => String(entry.chatId) === String(-1001)).map((entry) => entry.text || '');
  assert.ok(groupAfter.some((text) => /WhatsApp Connected/.test(text) && /••••• 494/.test(text)), 'the group shows a masked success');
  assert.ok(!groupAfter.some((text) => /92349494494/.test(text)), 'still no full number in the group after connecting');
  assert.deepEqual(
    replies.filter((entry) => String(entry.chatId) === OWNER_ID),
    [],
    'the whole lifecycle stayed inside the group'
  );
  assert.equal(fake.pairingCalls.length, 1, 'exactly one real pairing code was generated');

  await manager.shutdown();
});

test('ACCEPTANCE: an invalid number never opens a socket and reports the format problem', async () => {
  const { manager, controller, fake, replies } = makeStack();
  for (const bad of ['/pair 123', '/pair abcdefgh', '/pair']) {
    await sendPair(controller, bad);
  }
  assert.equal(fake.sockets.length, 0, 'no WhatsApp socket was created for invalid input');
  const text = allText(replies);
  assert.match(text, /PAIRING FAILED|Send your WhatsApp number/);
  assert.doesNotMatch(text, /WhatsApp Connected/);
  await manager.shutdown();
});

test('ACCEPTANCE: an already connected number is refused instead of issuing a second code', async () => {
  const { manager, controller, fake, replies } = makeStack();
  await sendPair(controller, `/pair ${NUMBER}`);
  const session = manager.getSession(OWNER_ID, NUMBER);
  session.socket.authState.creds.registered = true;
  session.socket.ev.emit('creds.update', { registered: true });
  session.socket.ev.emit('connection.update', { connection: 'open' });
  await sleep(10);

  const before = fake.pairingCalls.length;
  replies.length = 0;
  await sendPair(controller, `/pair ${NUMBER}`);
  assert.equal(fake.pairingCalls.length, before, 'no second pairing code was requested');
  assert.match(allText(replies), /already paired|already connected/i);
  await manager.shutdown();
});

test('ACCEPTANCE: a failed handshake reports failure and never claims a connection', async () => {
  const fake = fakeBaileys();
  fake.makeWASocket = ((original) => (socketConfig) => {
    const socket = original(socketConfig);
    // The socket dies before the pair-device stanza, so no code can be issued.
    queueMicrotask(() => {
      socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
    });
    return socket;
  })(fake.makeWASocket);

  const { manager, controller, replies } = makeStack({ fake });
  await sendPair(controller, `/pair ${NUMBER}`);
  const text = allText(replies);
  assert.match(text, /PAIRING FAILED/);
  assert.doesNotMatch(text, /WhatsApp Connected/);
  assert.doesNotMatch(text, /🔐 CODE:/, 'no code is shown when WhatsApp never issued one');
  await manager.shutdown();
});

test('ACCEPTANCE: every accepted number format normalizes to the same digits for Baileys', async () => {
  const forms = [`/pair +${NUMBER}`, `/pair 92 349 494494`, `/pair 92-349-494494`, `/pair (92) 349.494494`, `/pair ${NUMBER}`];
  for (const form of forms) {
    // One stack per form: sessions and locks are per number and per manager.
    const { manager, controller, fake } = makeStack();
    await sendPair(controller, form);
    assert.equal(fake.pairingCalls.length, 1, `exactly one pairing call for "${form}"`);
    const call = fake.pairingCalls[0];
    assert.equal(call.argCount, 1);
    assert.equal(call.number, NUMBER, `"${form}" normalizes to ${NUMBER}`);
    assert.match(call.number, /^\d{7,15}$/, 'only plain digits reach Baileys');
    assert.doesNotMatch(call.number, /[+\s().-]/, 'no separators are forwarded');
    assert.doesNotMatch(call.number, /^0/, 'no leading zero is added');
    await manager.shutdown();
  }
});

test('config.js keeps the WhatsApp/Baileys stack and version untouched', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.dependencies['@whiskeysockets/baileys'], '7.0.0-rc14', 'Baileys version preserved');
  assert.equal(config.authMethod, 'pairing');
  assert.equal('telegramPairingCode' in config, false, 'no custom pairing code in the runtime config');
});
