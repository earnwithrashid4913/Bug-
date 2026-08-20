'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { config } = require('../system/config');
const handleMessage = require('../system/handler');
const { commandFromText } = handleMessage;
const { extractText, getImageMessage, resolveJid } = require('../system/lib/message');
const { createImageSticker } = require('../system/lib/sticker');
const { PremiumStore, parseDuration } = require('../system/lib/premium');
const sharp = require('sharp');

test('default ownership configuration is loaded', () => {
  assert.equal(config.ownerName, 'Only Fixa Dev');
  assert.equal(config.authorName, 'Rashid Hussain');
  assert.equal(config.ownerNumber, '923448170040');
  assert.equal(config.commandPrefix, '!');
  assert.equal(config.botName, 'Black Clover ♣️');
  assert.equal(config.stickerPackname, 'Black Clover ♣️');
  assert.equal(config.stickerAuthor, 'Only Fixa Dev');
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

test('image messages can be found directly or in a quoted message', () => {
  const direct = { message: { imageMessage: { mimetype: 'image/png', url: 'direct' } } };
  const quoted = {
    message: {
      extendedTextMessage: {
        contextInfo: {
          quotedMessage: { imageMessage: { mimetype: 'image/jpeg', url: 'quoted' } }
        }
      }
    }
  };

  assert.equal(getImageMessage(direct).url, 'direct');
  assert.equal(getImageMessage(quoted).url, 'quoted');
});

test('image sticker converter emits a WebP sticker with pack metadata', async () => {
  const source = await sharp({
    create: { width: 32, height: 20, channels: 4, background: { r: 20, g: 120, b: 80, alpha: 1 } }
  }).png().toBuffer();
  const sticker = await createImageSticker(source, {
    packname: 'Black Clover ♣️',
    author: 'Only Fixa Dev'
  });

  assert.equal(sticker.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(sticker.subarray(8, 12).toString('ascii'), 'WEBP');
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
  assert.match(sent[0].payload.text, /General commands/);
});

test('sticker command provides usage text when no image is supplied', async () => {
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
    message: { conversation: '!sticker' }
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.text, /Reply to an image/);
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
