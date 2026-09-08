'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { TelegramPairingManager } = require('../system/lib/telegram-pairing-manager');

function fakeBaileys() {
  const sockets = [];
  return {
    sockets,
    makeWASocket: () => {
      const ev = new EventEmitter();
      const socket = { ev, requestPairingCode: async (number) => `code-${number}`, ws: { close() {} } };
      sockets.push(socket);
      queueMicrotask(() => ev.emit('connection.update', { connection: 'connecting' }));
      return socket;
    },
    useMultiFileAuthState: async () => ({ state: { creds: { registered: false }, keys: {} }, saveCreds: async () => {} }),
    makeCacheableSignalKeyStore: () => ({})
  };
}

test('Telegram pairing sessions are isolated by Telegram owner', async () => {
  const fake = fakeBaileys();
  const initialized = [];
  const manager = new TelegramPairingManager({ authDir: path.join(os.tmpdir(), `anime-md-${Date.now()}`), onSocket: async (_socket, ownerId) => initialized.push(ownerId), baileys: fake });
  assert.equal(await manager.requestPairing('10', '923001234567'), 'code-923001234567');
  assert.equal(await manager.requestPairing('20', '923009876543'), 'code-923009876543');
  assert.equal(fake.sockets.length, 2);
  assert.deepEqual(initialized, ['10', '20']);
  assert.equal(manager.snapshot('10').pairingNumber, '923001234567');
  assert.equal(manager.snapshot('20').pairingNumber, '923009876543');
  await assert.rejects(manager.stopSession('10', '923009876543'), /does not belong/);
  await manager.shutdown();
});

test('stopping a pairing session cancels a pending reconnect', async () => {
  const fake = fakeBaileys();
  const manager = new TelegramPairingManager({ authDir: path.join(os.tmpdir(), `anime-md-${Date.now()}`), baileys: fake });
  const entry = manager.entry('10');
  entry.socket = { ws: { close() {} } };
  entry.number = '923001234567';
  manager.connectionUpdate(entry, { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  assert.ok(entry.reconnectTimer, 'a transient disconnect schedules a reconnect');
  await manager.stopSession('10', '923001234567');
  assert.equal(manager.sessions.has('10'), false);
});
