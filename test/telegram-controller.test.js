'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TelegramController, commandFromUpdate, normalizeWhatsappNumber } = require('../system/lib/telegram-controller');
const { TelegramControllerStore } = require('../system/lib/telegram-controllers');

test('Telegram command parsing accepts bot-command suffixes', () => {
  assert.deepEqual(commandFromUpdate({ message: { chat: { id: 4 }, from: { id: 5 }, text: '/pair@AnimeMdBot 923001234567' } }), {
    chatId: 4, senderId: 5, name: 'pair', args: ['923001234567'], text: '923001234567'
  });
  assert.equal(normalizeWhatsappNumber('+92 300 1234567'), '923001234567');
  assert.throws(() => normalizeWhatsappNumber('123'), /7-15 digit/);
});

test('Telegram controller allows bootstrap owners to pair and rejects strangers', async () => {
  const replies = [];
  const controller = new TelegramController({
    token: 'token', owners: ['10'], controllerStore: { has: async () => false, add: async () => [] },
    pairing: { requestPairing: async (number) => `code-${number}`, getStatus: async () => ({}), stopSession: async () => {} },
    fetchImpl: async (_url, init) => ({ ok: true, json: async () => ({ ok: true, result: JSON.parse(init.body) }) })
  });
  controller.reply = async (chatId, text) => replies.push({ chatId, text });
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/pair 923001234567' } });
  assert.match(replies.pop().text, /code-923001234567/);
  await controller.handleUpdate({ message: { chat: { id: 2 }, from: { id: 11 }, text: '/sessions' } });
  assert.match(replies.pop().text, /not authorized/);
});

test('Telegram controller reports status and can remove only persisted controllers', async () => {
  const replies = [];
  const removed = [];
  const controller = new TelegramController({
    token: 'token', owners: ['10'], controllerStore: { has: async () => false, add: async () => [], remove: async (id) => { removed.push(id); return true; } },
    pairing: { requestPairing: async () => 'code', getStatus: async () => ({ state: 'connected', connected: true, startedAt: Date.now() - 1_000 }), stopSession: async () => {} },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) })
  });
  controller.reply = async (_chatId, text) => replies.push(text);
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/status' } });
  assert.match(replies.pop(), /WhatsApp: connected/);
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/delowner 20' } });
  assert.deepEqual(removed, ['20']);
  controller.sensitiveRequests.clear();
  await controller.handleUpdate({ message: { chat: { id: 1 }, from: { id: 10 }, text: '/delowner 10' } });
  assert.match(replies.pop(), /cannot be removed/);
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
