'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { config } = require('../system/config');
const handleMessage = require('../system/handler');
const { commandFromText } = handleMessage;
const { extractText, resolveJid } = require('../system/lib/message');
const { PremiumStore, parseDuration } = require('../system/lib/premium');
const { IMAGE_SETS, selectImage, validateImageSets } = require('../system/images');

test('default ownership configuration is loaded', () => {
  assert.equal(config.ownerName, 'Only Fixa Dev');
  assert.equal(config.authorName, 'Rashid Hussain');
  assert.equal(config.ownerNumber, '923448170040');
  assert.equal(config.commandPrefix, '!');
  assert.equal(config.botName, 'Black Clover ♣️');
});

test('image configuration contains unique HTTPS 2K-or-higher image metadata', () => {
  assert.doesNotThrow(validateImageSets);
  const urls = Object.values(IMAGE_SETS).flat().map((image) => image.url);
  assert.equal(new Set(urls).size, urls.length);

  for (const [key, images] of Object.entries(IMAGE_SETS)) {
    const selected = selectImage(key);
    assert.ok(images.includes(selected));
    assert.equal(new URL(selected.url).protocol, 'https:');
    assert.ok(Math.max(selected.width, selected.height) >= 2048);
  }
});

test('command parser accepts only the configured prefix', () => {
  assert.deepEqual(commandFromText('!addprem 15551234567 30d'), {
    name: 'addprem',
    args: ['15551234567', '30d'],
    text: '15551234567 30d'
  });
  assert.equal(commandFromText('addprem 15551234567'), undefined);
});

test('message text extraction handles standard and interactive messages', () => {
  assert.equal(extractText({ conversation: '!ping' }), '!ping');
  assert.equal(
    extractText({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"!menu"}' } } }),
    '!menu'
  );
});

test('LID senders resolve to mapped phone-number JIDs when available', async () => {
  const socket = {
    decodeJid: (jid) => jid.replace(/:\d+@/, '@'),
    signalRepository: {
      lidMapping: {
        getPNForLID: async (jid) => (jid === '12345@lid' ? '15551234567@s.whatsapp.net' : null)
      }
    }
  };

  assert.equal(await resolveJid(socket, '12345@lid'), '15551234567@s.whatsapp.net');
});

test('command handler dispatches a menu response', async () => {
  const sent = [];
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => jid.replace(/:\d+@/, '@'),
    sendMessage: async (chatId, payload, options) => {
      sent.push({ chatId, payload, options });
      return { key: { id: 'test-message' } };
    }
  };
  const message = {
    key: {
      remoteJid: '15551234568@s.whatsapp.net',
      participant: '15551234568@s.whatsapp.net',
      fromMe: false
    },
    message: { conversation: '!menu' }
  };

  await handleMessage(socket, message);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, message.key.remoteJid);
  assert.match(sent[0].payload.caption, /General commands/);
  assert.ok(IMAGE_SETS.menu.some((image) => image.url === sent[0].payload.image.url));
});

test('menu falls back to text when an image upload fails', async () => {
  const sent = [];
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => jid.replace(/:\d+@/, '@'),
    sendMessage: async (chatId, payload, options) => {
      sent.push({ chatId, payload, options });
      if (payload.image) throw new Error('simulated remote image failure');
      return { key: { id: 'text-fallback' } };
    }
  };
  const originalWarn = console.warn;
  console.warn = () => undefined;

  try {
    await handleMessage(socket, {
      key: {
        remoteJid: '15551234568@s.whatsapp.net',
        participant: '15551234568@s.whatsapp.net',
        fromMe: false
      },
      message: { conversation: '!menu' }
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(sent.length, 2);
  assert.ok(sent[0].payload.image);
  assert.match(sent[1].payload.text, /General commands/);
});

test('ping sends one selected image response', async () => {
  const sent = [];
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => jid.replace(/:\d+@/, '@'),
    sendMessage: async (chatId, payload, options) => {
      sent.push({ chatId, payload, options });
      return { key: { id: 'test-message' } };
    }
  };

  await handleMessage(socket, {
    key: {
      remoteJid: '15551234568@s.whatsapp.net',
      participant: '15551234568@s.whatsapp.net',
      fromMe: false
    },
    message: { conversation: '!ping' }
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.caption, /^Pong: \d+ms$/);
  assert.ok(IMAGE_SETS.ping.some((image) => image.url === sent[0].payload.image.url));
});

test('premium duration parser validates supported units', () => {
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.throws(() => parseDuration('forever'), /Duration must use/);
});

test('premium store writes, lists, and removes an active record', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'only-fixa-premium-'));
  const databasePath = path.join(directory, 'premium.json');
  const store = new PremiumStore(databasePath);

  try {
    const record = await store.add('15551234567', '1d');
    assert.equal(record.id, '15551234567');
    assert.equal((await store.list()).length, 1);
    assert.equal(await store.remove('15551234567'), true);
    assert.deepEqual(await store.list(), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
