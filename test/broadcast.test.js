'use strict';

// ---------------------------------------------------------------------------
// Broadcast + known-chat registry.
//
// The old !broadcast replied "Broadcast sent." while only echoing the message
// back to the sender — a hardcoded success. These tests pin the real
// behaviour: real destinations, real per-chat delivery, and real counts.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BROADCASTABLE_SUFFIXES, ChatStore } = require('../system/lib/chats');
const handler = require('../system/handler');

function tempFile(name) {
  return path.join(os.tmpdir(), `anime-md-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('the registry only tracks real conversations and ignores server JIDs', async () => {
  const store = new ChatStore(tempFile('chats'));
  assert.equal(await store.track('15551234568@s.whatsapp.net'), true, 'a private chat is new');
  assert.equal(await store.track('15551234568@s.whatsapp.net'), false, 'the same chat is not new twice');
  assert.equal(await store.track('120363000000000000@g.us'), true, 'a group is new');
  assert.equal(await store.track('15551234568@lid'), true, 'a LID chat is new');
  assert.equal(await store.track('status@broadcast'), false, 'status broadcasts are never a target');
  assert.equal(await store.track('server@s.whatsapp.net'), true);
  assert.equal(await store.track(undefined), false);
  assert.equal(await store.track(''), false);
  for (const suffix of BROADCASTABLE_SUFFIXES) assert.equal(store.isBroadcastable(`x${suffix}`), true);
  assert.equal(store.isBroadcastable('status@broadcast'), false);
});

test('the registry survives a restart and stays bounded', async () => {
  const file = tempFile('chats');
  const first = new ChatStore(file);
  await first.track('15551234568@s.whatsapp.net');
  await first.track('120363000000000000@g.us');

  const reloaded = new ChatStore(file);
  assert.deepEqual((await reloaded.list()).sort(), ['120363000000000000@g.us', '15551234568@s.whatsapp.net']);

  const many = new ChatStore(tempFile('chats-many'));
  for (let index = 0; index < 5_050; index += 1) await many.track(`${index}@s.whatsapp.net`);
  assert.ok((await many.list()).length <= 5_000, 'the registry is bounded');

  // A corrupt registry must not break the message pipeline.
  const corruptPath = tempFile('chats-corrupt');
  await fs.writeFile(corruptPath, '{ not json');
  const corrupt = new ChatStore(corruptPath);
  assert.deepEqual(await corrupt.list(), []);
});

// The owner is the socket's own account, so !broadcast is authorized for it.
function ownerSocket(sent, { failFor = [] } = {}) {
  return {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => String(jid).replace(/:\d+@/, '@'),
    public: true,
    sendMessage: async (chatId, payload) => {
      if (failFor.includes(chatId)) throw new Error('blocked');
      sent.push({ chatId, payload });
      return { key: { id: 'broadcast-message' } };
    }
  };
}

function ownerMessage(text) {
  return {
    key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: true },
    message: { conversation: text }
  };
}

test('!broadcast reports the real delivery count instead of a fake success', async () => {
  // Teach the registry two chats by delivering a message in each of them.
  const learner = ownerSocket([]);
  await handler(learner, {
    key: { remoteJid: '15551234999@s.whatsapp.net', participant: '15551234999@s.whatsapp.net', fromMe: false },
    message: { conversation: 'hello' }
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const sent = [];
  await handler(ownerSocket(sent), ownerMessage('!broadcast Maintenance tonight'));

  const reply = sent.find((entry) => /BROADCAST FINISHED/.test(entry.payload.text || ''));
  assert.ok(reply, `the owner got a real report: ${JSON.stringify(sent.map((entry) => entry.payload.text))}`);
  assert.match(reply.payload.text, /\*Delivered:\* \d+/);
  assert.match(reply.payload.text, /\*Failed:\* \d+/);
  const delivered = Number(reply.payload.text.match(/\*Delivered:\* (\d+)/)[1]);
  const echoed = sent.filter((entry) => /Announcement/.test(entry.payload.text || '')).length;
  assert.equal(delivered, echoed, 'the reported count matches what was actually sent');
  // The owner never receives their own broadcast twice.
  assert.ok(!sent.some((entry) => entry.chatId === '15551234567@s.whatsapp.net' && /Announcement/.test(entry.payload.text || '')));
});

test('!broadcast without a message shows the usage, not a fake confirmation', async () => {
  const sent = [];
  await handler(ownerSocket(sent), ownerMessage('!broadcast'));
  const text = sent.map((entry) => entry.payload.text || '').join('\n');
  assert.match(text, /USAGE/);
  assert.doesNotMatch(text, /BROADCAST FINISHED/);
});

test('!broadcast is owner-only', async () => {
  const sent = [];
  await handler(ownerSocket(sent), {
    key: { remoteJid: '15551234568@s.whatsapp.net', participant: '15551234568@s.whatsapp.net', fromMe: false },
    message: { conversation: '!broadcast spam everyone' }
  });
  const text = sent.map((entry) => entry.payload.text || '').join('\n');
  assert.doesNotMatch(text, /BROADCAST FINISHED/);
});
