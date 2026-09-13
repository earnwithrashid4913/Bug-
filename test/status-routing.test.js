'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Use isolated stores and the real dispatcher/AutoStatus implementation. Only
// socket IO is substituted. Do not launch index.js's supervisor or auth flow.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-status-route-'));
const settings = require('../config');
settings.database.dataDir = path.join(directory, 'data');
const handler = require('../system/handler');
const { config } = require('../system/config');
const { AutomationStore } = require('../system/lib/automation');
const store = new AutomationStore(config.automationDbPath);
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const author = '15551234568@s.whatsapp.net';
function status(id) {
  return { key: { id, participant: author, remoteJid: 'status@broadcast', fromMe: false }, message: { conversation: 'A status update' } };
}
function makeSocket() {
  const reads = [], sends = [];
  let complete;
  const delivered = new Promise(resolve => { complete = resolve; });
  return {
    reads, sends, delivered, ev: new EventEmitter(), user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: jid => jid,
    readMessages: async keys => { reads.push(...keys); },
    sendMessage: async (jid, payload, options) => {
      sends.push({ jid, payload, options });
      if (payload.react) complete();
      return { key: { id: 'sent' } };
    }
  };
}
async function configured() {
  await store.setGlobal('autostatus', true);
  await store.setGlobal('statusReact', true);
  await store.update(data => { data.global.statusEmoji = '✨'; });
}
function bounded(promise) {
  let timeout;
  return Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The existing route did not deliver the status')), 5000); })]).finally(() => clearTimeout(timeout));
}
test.after(async () => { await fsp.rm(directory, { recursive: true, force: true }); });

test('primary index.js route forwards status notify events to the real AutoStatus dispatcher', async () => {
  await configured();
  const socket = makeSocket();
  const start = source.indexOf('async function handleMessages(socket, upsert) {');
  const end = source.indexOf('\nfunction bootstrapSession()', start);
  assert.ok(start >= 0 && end > start);
  const route = vm.runInNewContext(`(${source.slice(start, end).trim()})`, { activeSocket: socket, handleMessage: handler, console });
  await route(socket, { type: 'append', messages: [status('historical')] });
  await route({}, { type: 'notify', messages: [status('wrong-socket')] });
  assert.equal(socket.reads.length, 0, 'existing notify and active-socket gates preserved');
  await route(socket, { type: 'notify', messages: [{ key: {} }, status('primary')] });
  assert.deepEqual(socket.reads.map(key => key.id), ['primary']);
  assert.equal(socket.sends.length, 1);
  assert.equal(socket.sends[0].payload.react.text, '✨');
  assert.equal(socket.sends[0].jid, 'status@broadcast');
  assert.deepEqual(socket.sends[0].options.statusJidList, [author]);
  await store.setGlobal('autostatus', false);
  await store.setGlobal('statusReact', false);
  await route(socket, { type: 'notify', messages: [status('disabled')] });
  assert.equal(socket.reads.length, 1, 'disabled settings remain respected');
});

test('Telegram-paired onSocket uses its single existing listener to dispatch statuses', async () => {
  await configured();
  const socket = makeSocket();
  const start = source.indexOf('onSocket: async (socket) => {');
  const end = source.indexOf('\n    }\n  });', start);
  assert.ok(start >= 0 && end > start);
  const callback = source.slice(start + 'onSocket: '.length, end) + '\n    }';
  const onSocket = vm.runInNewContext(`(${callback})`, {
    decodeJid: jid => jid, handleMessage: handler,
    handleGroupParticipantsUpdate: async () => {}, console
  });
  await onSocket(socket);
  assert.equal(socket.ev.listenerCount('messages.upsert'), 1);
  assert.equal(socket.ev.listenerCount('group-participants.update'), 1);
  socket.ev.emit('messages.upsert', { type: 'append', messages: [status('historical')] });
  assert.equal(socket.reads.length, 0);
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: {} }, status('paired')] });
  await bounded(socket.delivered);
  assert.deepEqual(socket.reads.map(key => key.id), ['paired']);
  assert.equal(socket.sends.length, 1, 'one reaction, not duplicated by a second listener');
  assert.equal(socket.sends[0].payload.react.key.id, 'paired');
  assert.equal(socket.ev.listenerCount('messages.upsert'), 1);
});
