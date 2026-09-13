'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { TelegramController } = require('../system/lib/telegram-controller');
const { TelegramControllerStore } = require('../system/lib/telegram-controllers');
const { authenticatedSelfJid, sendWelcomeVideo, welcomeCaption } = require('../system/lib/connection-welcome');
const quiet = { warn() {}, info() {}, log() {} };
const number = '923001234567';
const session = { number, numberDisplay: '+92 3001234567', connected: true, registered: true };
const animeEdit = { enabled: true, libraryApi: 'https://library.example/api/anime/random', apiKey: 'API_SECRET' };
const video = { id: 'unique-video-id', enabled: true, country: 'PK', gender: 'mixed', videoUrl: 'https://media.example/anime.mp4', label: '<Gojo> & Infinity' };
function controllerWith({ options = animeEdit, libraryFetch, telegramFetch, store } = {}) {
  const events = [];
  const controller = new TelegramController({
    token: 'TELEGRAM_SECRET', owners: ['10'], controllerStore: store, connectedImage: 'https://media.example/connected.jpg', animeEdit: options, log: quiet,
    fetchImpl: async (url, init) => {
      if (String(url).startsWith('https://library.example/')) {
        events.push({ type: 'library', url });
        return libraryFetch ? libraryFetch(url, init) : new Response(JSON.stringify(video));
      }
      const method = String(url).split('/').pop();
      const payload = JSON.parse(init.body);
      events.push({ type: method, payload });
      if (telegramFetch) return telegramFetch(method, payload);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }));
    }
  });
  controller.running = true;
  return { controller, events };
}
function useGroupFlow(controller) {
  const flow = { senderKey: '10', chatId: -100123, messageId: 12, number, public: true, publicDisplay: '+92 300••••567', actor: { username: 'paired_user' }, stopped: false, state: 'WAITING' };
  controller.pairingFlows.set('10', flow);
  controller.beginChatPairing(flow.chatId, flow.senderKey);
  return flow;
}

test('real success notification precedes optional media; premium UI and escaped API label retain existing buttons', async () => {
  const { controller, events } = controllerWith();
  await controller.notifySessionConnected('10', session);
  await controller.animeLibrary.queue;
  assert.deepEqual(events.map(event => event.type), ['sendPhoto', 'library', 'sendVideo']);
  const success = events[0].payload;
  assert.equal(success.chat_id, '10');
  assert.match(success.caption, /ANIME-MD/);
  assert.match(success.caption, /Pairing Completed Successfully/);
  assert.match(success.caption, /WhatsApp Connected/);
  assert.match(success.caption, /Secure Session/);
  assert.match(success.caption, /System Ready/);
  assert.ok(success.reply_markup.inline_keyboard.length);
  assert.equal(events[2].payload.caption, '&lt;Gojo&gt; &amp; Infinity');
  assert.equal(events[2].payload.video, video.videoUrl);
  assert.equal(events[2].payload.parse_mode, 'HTML');
  assert.doesNotMatch(JSON.stringify(events.map(event => event.payload)), /TELEGRAM_SECRET|API_SECRET|creds/);
  await controller.notifySessionConnected('10', session);
  await controller.animeLibrary.queue;
  assert.equal(events.filter(event => event.type === 'sendVideo').length, 1, 'reconnect does not repeat anime video');
});

test('OFF/empty endpoint keeps success working without any library or video request', async () => {
  for (const options of [{ ...animeEdit, enabled: false }, { ...animeEdit, libraryApi: '' }]) {
    const { controller, events } = controllerWith({ options });
    await controller.notifySessionConnected('10', session);
    assert.deepEqual(events.map(event => event.type), ['sendPhoto']);
    assert.equal(controller.animeNotifiedSessions.size, 0);
  }
});

test('public pairing edits the existing group message with masked number then sends a label-only video to that chat', async () => {
  const { controller, events } = controllerWith();
  const flow = useGroupFlow(controller);
  await controller.notifySessionConnected('10', session);
  await controller.animeLibrary.queue;
  assert.deepEqual(events.map(event => event.type), ['editMessageText', 'library', 'sendVideo']);
  assert.equal(events[0].payload.chat_id, flow.chatId);
  assert.equal(events[0].payload.message_id, flow.messageId);
  assert.ok(events[0].payload.text.includes(flow.publicDisplay));
  assert.doesNotMatch(events[0].payload.text, /923001234567|3001234567/);
  assert.equal(events[2].payload.chat_id, flow.chatId);
  assert.doesNotMatch(events[2].payload.caption, /923001234567|paired_user|API_SECRET/);
  assert.equal(controller.pairingFlows.size, 0);
  assert.equal(controller.chatFlowCount(flow.chatId), 0);
  assert.equal(flow.state, 'SUCCESS');
});

test('slow optional provider cannot hold up notifySessionConnected', async () => {
  let release;
  const { controller, events } = controllerWith({ libraryFetch: () => new Promise(resolve => { release = () => resolve(new Response(JSON.stringify(video))); }) });
  await controller.notifySessionConnected('10', session);
  assert.ok(release, 'library request has started separately');
  assert.equal(events.filter(event => event.type === 'sendVideo').length, 0);
  release();
  await controller.animeLibrary.queue;
  assert.equal(events.filter(event => event.type === 'sendVideo').length, 1);
});

test('Telegram success image error falls back to text before anime; total notification failure sends no anime', async () => {
  const { controller, events } = controllerWith({ telegramFetch: async method => new Response(JSON.stringify(method === 'sendPhoto' ? { ok: false, description: 'SECRET' } : { ok: true, result: {} })) });
  await controller.notifySessionConnected('10', session);
  await controller.animeLibrary.queue;
  assert.deepEqual(events.map(event => event.type), ['sendPhoto', 'sendMessage', 'library', 'sendVideo']);
  const failed = controllerWith({ telegramFetch: async () => { throw new Error('SECRET'); } });
  await failed.controller.notifySessionConnected('10', session);
  assert.deepEqual(failed.events.map(event => event.type), ['sendPhoto', 'sendMessage']);
  assert.equal(failed.controller.animeNotifiedSessions.size, 0);
});

test('library or Telegram video failure leaves real flow in SUCCESS with no pairing error', async () => {
  for (const failure of ['library', 'telegram']) {
    const { controller, events } = controllerWith({
      libraryFetch: async () => failure === 'library' ? new Response('AUTH_SECRET', { status: 500 }) : new Response(JSON.stringify(video)),
      telegramFetch: async method => new Response(JSON.stringify(method === 'sendVideo' ? { ok: false, description: 'SECRET' } : { ok: true, result: {} }))
    });
    const flow = useGroupFlow(controller);
    await controller.notifySessionConnected('10', session);
    await controller.animeLibrary.queue;
    assert.equal(flow.state, 'SUCCESS');
    const text = events.map(event => event.payload?.text || event.payload?.caption || '').join('');
    assert.match(text, /WhatsApp Connected/);
    assert.doesNotMatch(text, /Pairing could not|AUTH_SECRET|SECRET/);
    assert.equal(controller.animeLibrary.recentVideoIds.length, 0);
  }
});

test('real existing controller DB records only existing paired-number usage, not video metadata/history/messages', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-media-db-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const db = path.join(directory, 'telegram-controllers.json');
  const store = new TelegramControllerStore(db);
  const { controller } = controllerWith({ store });
  await controller.notifySessionConnected('10', session);
  await controller.animeLibrary.queue;
  const raw = await fs.readFile(db, 'utf8');
  assert.match(raw, /923001234567/);
  assert.doesNotMatch(raw, /unique-video-id|videoUrl|Gojo|recentVideo|anime|message_id|API_SECRET|TELEGRAM_SECRET/);
  assert.deepEqual(await fs.readdir(directory), ['telegram-controllers.json']);
});

async function indexWelcomeHarness({ menuFails = false, noticeFails = false } = {}) {
  const source = await fs.readFile(path.join(__dirname, '../index.js'), 'utf8');
  const sends = [], notices = [];
  const socket = { user: { id: `${number}:42@s.whatsapp.net`, name: 'Authenticated Own User' }, sendMessage: async (jid, payload) => { sends.push({ jid, payload }); } };
  const context = vm.createContext({
    authenticatedSelfJid, welcomeCaption,
    sendWelcomeVideo: (sock, options) => sendWelcomeVideo(sock, options, { log: quiet, fetchImpl: async () => new Response('mock MP4 bytes') }),
    config: { botName: 'ANIME MD', connectionWelcomeVideo: { enabled: true, source: 'url', url: 'https://media.example/welcome.mp4' }, connectionSuccessImage: 'https://media.example/image.jpg' },
    handleMessage: { getCommandPrefix: () => '!' },
    sendButtons: async (sock, jid, payload) => { sends.push({ jid, payload }); if (menuFails) throw new Error('menu failed'); },
    telegramController: { notifySessionConnected: async (...args) => { notices.push(args); if (noticeFails) throw new Error('Telegram unavailable'); } },
    telegramPairingManager: {}, pairedSelfWelcomeSent: new Set(), console: quiet,
    stopping: false, activeSocket: socket, connectionCardSent: false, reconnectAttempts: 0,
    setStatus() {}, configUnused: {}, chalk: { green: text => text, cyan: text => text },
    liveStatus: {}, setTimeout, clearTimeout
  });
  context.telegramController.notifyConnected = async () => {};
  const start = source.indexOf('async function sendConnectionSuccess(socket) {');
  const end = source.indexOf('\nasync function handleConnectionUpdate(', start);
  vm.runInContext(source.slice(start, end), context);
  const pairedStart = source.indexOf('telegramPairingManager.onConnected = async');
  const pairedEnd = source.indexOf('  telegramPairingManager.onDisconnected', pairedStart);
  vm.runInContext(source.slice(pairedStart, pairedEnd), context);
  const updateEnd = source.indexOf('\nfunction ', end + 1);
  assert.ok(updateEnd > end, 'primary connection function extraction');
  vm.runInContext(source.slice(end, updateEnd), context);
  return { socket, sends, notices, context, onConnected: context.telegramPairingManager.onConnected };
}

test('ACTUAL index paired callback sends welcome only to authenticated own JID, once despite duplicates and menu failure', async () => {
  const { socket, sends, onConnected } = await indexWelcomeHarness({ menuFails: true });
  await Promise.all([onConnected('10', session, socket), onConnected('10', session, socket)]);
  await onConnected('10', session, socket);
  assert.equal(sends.filter(send => send.payload.video).length, 1);
  assert.ok(sends.every(send => send.jid === `${number}@s.whatsapp.net`));
  assert.match(sends.find(send => send.payload.video).payload.caption, /Authenticated Own User/);
  assert.equal(sends.find(send => send.payload.buttons).payload.buttons[0].id, '!menu home');
  const other = { ...socket, user: { id: '919876543210:4@s.whatsapp.net', name: 'Other Own User' } };
  await onConnected('11', { ...session, number: '919876543210' }, other);
  assert.equal(sends.filter(send => send.payload.video).length, 2);
  assert.equal(sends.at(-1).jid, '919876543210@s.whatsapp.net');
});

test('ACTUAL index paired callback still sends own welcome when Telegram notification fails', async () => {
  const { socket, sends, onConnected } = await indexWelcomeHarness({ noticeFails: true });
  await onConnected('10', session, socket);
  assert.equal(sends.filter(send => send.payload.video).length, 1);
});

test('ACTUAL primary connection callback: no welcome before open; stale socket rejected; reconnect reuses existing flag', async () => {
  const { socket, sends, context } = await indexWelcomeHarness();
  const state = { registered: false };
  await context.handleConnectionUpdate(socket, { connection: 'connecting' }, state);
  await context.handleConnectionUpdate({ user: socket.user }, { connection: 'open' }, state);
  assert.equal(sends.length, 0);
  await context.handleConnectionUpdate(socket, { connection: 'open' }, state);
  await new Promise(resolve => setImmediate(resolve));
  await context.handleConnectionUpdate(socket, { connection: 'open' }, state);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends.filter(send => send.payload.video).length, 1);
  assert.equal(context.connectionCardSent, true);
  assert.equal(state.registered, true);
});

test('ACTUAL paired welcome falls back on missing video and cannot send to group/broadcast or missing identity', async () => {
  const { socket, sends, context, onConnected } = await indexWelcomeHarness();
  context.config.connectionWelcomeVideo = { enabled: true, source: 'local', path: '/not-present/welcome.mp4' };
  await onConnected('10', session, socket);
  await onConnected('10', session, socket);
  assert.equal(sends.filter(send => send.payload.video).length, 0);
  assert.equal(sends.filter(send => send.payload.image).length, 1);
  assert.equal(sends.filter(send => send.payload.buttons).length, 1);
  const before = sends.length;
  for (const id of ['123@g.us', 'status@broadcast', undefined]) {
    await onConnected('11', { number: '919876543210' }, { ...socket, user: { id } });
  }
  assert.equal(sends.length, before);
});
