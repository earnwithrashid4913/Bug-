'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { config } = require('../system/config');
const handleMessage = require('../system/handler');
const { commandFromText } = handleMessage;
const { extractText } = require('../system/lib/message');
const { PremiumStore, parseDuration } = require('../system/lib/premium');

test('default ownership configuration is loaded', () => {
  assert.equal(config.ownerName, 'Only Fixa Dev');
  assert.equal(config.authorName, 'Rashid Hussain');
  assert.equal(config.ownerNumber, '923448170040');
  assert.equal(config.commandPrefix, '.');
});

test('command parser accepts only the configured prefix', () => {
  assert.deepEqual(commandFromText('.addprem 923448170040 30d'), {
    name: 'addprem',
    args: ['923448170040', '30d'],
    text: '923448170040 30d'
  });
  assert.equal(commandFromText('addprem 923448170040'), undefined);
});

test('message text extraction handles standard and interactive messages', () => {
  assert.equal(extractText({ conversation: '.ping' }), '.ping');
  assert.equal(
    extractText({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":".menu"}' } } }),
    '.menu'
  );
});

test('command handler dispatches a menu response', async () => {
  const sent = [];
  const socket = {
    user: { id: '923448170040@s.whatsapp.net' },
    decodeJid: (jid) => jid.replace(/:\d+@/, '@'),
    sendMessage: async (chatId, payload, options) => {
      sent.push({ chatId, payload, options });
      return { key: { id: 'test-message' } };
    }
  };
  const message = {
    key: {
      remoteJid: '923448170041@s.whatsapp.net',
      participant: '923448170041@s.whatsapp.net',
      fromMe: false
    },
    message: { conversation: '.menu' }
  };

  await handleMessage(socket, message);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, message.key.remoteJid);
  assert.match(sent[0].payload.text, /General commands/);
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
    const record = await store.add('923448170040', '1d');
    assert.equal(record.id, '923448170040');
    assert.equal((await store.list()).length, 1);
    assert.equal(await store.remove('923448170040'), true);
    assert.deepEqual(await store.list(), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
