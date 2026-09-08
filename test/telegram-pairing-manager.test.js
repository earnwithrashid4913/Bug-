'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { STATUS, TelegramPairingManager, classifyDisconnect } = require('../system/lib/telegram-pairing-manager');
const { DisconnectReason } = require('@whiskeysockets/baileys');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A fake Baileys whose auth state derives from the real files on disk, so
// credential persistence flows (pair → link → restart → restore) behave like
// the production implementation.
function fakeBaileys({ failHandshake = false } = {}) {
  const sockets = [];
  const pairingCalls = [];
  return {
    sockets,
    pairingCalls,
    makeWASocket: () => {
      const ev = new EventEmitter();
      const socket = {
        ev,
        authState: { creds: { registered: false } },
        requestPairingCode: async (number, custom) => {
          pairingCalls.push({ number, custom });
          return custom ?? `code-${number}`;
        },
        ws: { close() {} }
      };
      sockets.push(socket);
      queueMicrotask(() => {
        if (failHandshake) {
          ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
        } else {
          ev.emit('connection.update', { connection: 'connecting' });
        }
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

function makeManager({ fake = fakeBaileys(), limits = {}, customPairingCode } = {}) {
  const authDir = path.join(os.tmpdir(), `anime-md-pairing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const manager = new TelegramPairingManager({
    authDir,
    baileys: fake,
    customPairingCode,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    limits: { ownerCooldownMs: 0, reconnectBaseDelayMs: 5, reconnectMaxDelayMs: 10, ...limits }
  });
  return { manager, fake, authDir };
}

// Simulates the account holder entering the code. This mirrors the real
// Baileys sequence: the link completes on the SAME socket (creds.update with
// registered=true, credentials persisted), then the server forces a restart
// (close 515), and the replacement socket finally reaches connection open.
async function linkSession(manager, fake, ownerId, number) {
  const session = manager.getSession(ownerId, number);
  assert.ok(session, 'session exists before linking');
  assert.ok(session.socket, 'socket exists before linking');
  const originalSocket = session.socket;
  const creds = { registered: true, me: { id: `${number}:1@s.whatsapp.net` } };
  originalSocket.authState.creds.registered = true;
  originalSocket.ev.emit('creds.update', creds);
  await fs.mkdir(session.authDir, { recursive: true });
  await fs.writeFile(path.join(session.authDir, 'creds.json'), JSON.stringify(creds));
  originalSocket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await sleep(25);
  const replacement = fake.sockets.at(-1);
  assert.notEqual(replacement, originalSocket, 'a replacement socket was created for the restart');
  replacement.ev.emit('connection.update', { connection: 'open' });
  await sleep(5);
  assert.equal(manager.getSession(ownerId, number).status, STATUS.CONNECTED);
  return manager.getSession(ownerId, number);
}

test('the custom GOATMODS pairing code is issued through the real Baileys flow', async () => {
  const { manager, fake } = makeManager({ customPairingCode: 'GOATMODS' });
  const result = await manager.requestPairing('10', '923001234567');
  assert.equal(result.code, 'GOATMODS');
  assert.equal(result.displayCode, 'GOAT-MODS');
  assert.equal(result.brand, 'GOAT-MODS');
  assert.equal(result.number, '923001234567');
  assert.equal(result.numberDisplay, '+92 300 1234567');
  assert.deepEqual(fake.pairingCalls, [{ number: '923001234567', custom: 'GOATMODS' }]);
  assert.equal(manager.getSession('10', '923001234567').status, STATUS.WAITING_FOR_LINK);
  await manager.shutdown();
});

test('a custom pairing code that is not exactly 8 characters falls back to a WhatsApp-generated code', async () => {
  const { manager, fake } = makeManager({ customPairingCode: 'GOAT-MODS-2025' });
  assert.equal(manager.customPairingCode, undefined, '11 characters cannot be a real code');
  assert.equal(manager.brandLabel, 'GOAT-MODS-2025');
  const result = await manager.requestPairing('10', '923001234567');
  assert.equal(result.code, 'code-923001234567');
  assert.equal(result.custom, false);
  assert.equal(fake.pairingCalls[0].custom, undefined);
  await manager.shutdown();
});

test('sessions are isolated per controller and per WhatsApp number', async () => {
  const { manager, fake } = makeManager();
  const first = await manager.requestPairing('10', '923001234567');
  const second = await manager.requestPairing('10', '12025550123');
  assert.notEqual(first.code, second.code);
  assert.equal(fake.sockets.length, 2);
  const sessions = manager.listSessions('10');
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((entry) => entry.number).sort(), ['12025550123', '923001234567']);
  // Another controller sees only its own sessions.
  assert.equal(manager.listSessions('20').length, 0);
  assert.throws(() => manager.statusOf('20', '923001234567'), /No session found/);
  await manager.shutdown();
});

test('duplicate pairing requests share one flow and never create a second socket', async () => {
  const { manager, fake } = makeManager();
  const [a, b] = await Promise.all([
    manager.requestPairing('10', '923001234567'),
    manager.requestPairing('10', '923001234567')
  ]);
  assert.deepEqual(a, b);
  assert.equal(fake.sockets.length, 1);
  // A repeat request inside the TTL returns the same code without a new socket.
  const again = await manager.requestPairing('10', '923001234567');
  assert.equal(again.code, a.code);
  assert.equal(fake.sockets.length, 1);
  await manager.shutdown();
});

test('the same number cannot pair on two controllers at once', async () => {
  const { manager } = makeManager();
  await manager.requestPairing('10', '923001234567');
  await assert.rejects(manager.requestPairing('20', '923001234567'), (error) => {
    assert.equal(error.code, 'LOCKED');
    assert.match(error.message, /another controller/);
    return true;
  });
  await manager.shutdown();
});

test('a controller cannot exceed its session limit', async () => {
  const { manager } = makeManager({ limits: { maxSessionsPerController: 1 } });
  await manager.requestPairing('10', '923001234567');
  await assert.rejects(manager.requestPairing('10', '12025550123'), (error) => {
    assert.equal(error.code, 'LIMIT');
    return true;
  });
  await manager.shutdown();
});

test('invalid numbers are rejected before any socket is created', async () => {
  const { manager, fake } = makeManager();
  await assert.rejects(manager.requestPairing('10', '123'), (error) => {
    assert.equal(error.code, 'INVALID_NUMBER');
    return true;
  });
  await assert.rejects(manager.requestPairing('10', '03001234567'), /country code/);
  await assert.rejects(manager.requestPairing('10', '92-300-1234567-xx'), /digits/);
  assert.equal(fake.sockets.length, 0);
  assert.equal(manager.listSessions('10').length, 0);
  await manager.shutdown();
});

test('pairing queue applies backpressure and drains when a slot frees', async () => {
  const { manager, fake } = makeManager({ limits: { maxConcurrentPairings: 1 } });
  const first = manager.requestPairing('10', '923001234567');
  const firstResult = await first;
  assert.equal(fake.sockets.length, 1);
  // The first session still holds the pairing slot while waiting for the link.
  const second = manager.requestPairing('10', '12025550123');
  await sleep(20);
  assert.equal(fake.sockets.length, 1, 'the queued request waits for a slot');
  // Ending the first attempt (close before link) frees the slot.
  fake.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  const secondResult = await second;
  assert.equal(secondResult.number, '12025550123');
  assert.equal(fake.sockets.length, 2);
  assert.equal(manager.getSession('10', '923001234567'), undefined, 'failed pairing is cleaned up');
  await manager.shutdown();
});

test('a full pairing queue rejects new requests instead of growing without bound', async () => {
  const { manager } = makeManager({ limits: { maxConcurrentPairings: 1, pairingQueueLimit: 0 } });
  await manager.requestPairing('10', '923001234567');
  await assert.rejects(manager.requestPairing('10', '12025550123'), (error) => {
    assert.equal(error.code, 'BUSY');
    return true;
  });
  await manager.shutdown();
});

test('a socket that closes before linking fails fast with a friendly reason', async () => {
  const fake = fakeBaileys({ failHandshake: true });
  const { manager } = makeManager({ fake });
  await assert.rejects(manager.requestPairing('10', '923001234567'), (error) => {
    assert.equal(error.code, 'CONNECTION_CLOSED');
    return true;
  });
  assert.equal(manager.listSessions('10').length, 0, 'the failed session is cleaned up');
  await manager.shutdown();
});

test('an expired pairing code cleans up its socket and credentials', async () => {
  const { manager, fake } = makeManager({ limits: { pairingCodeTtlMs: 25 } });
  const result = await manager.requestPairing('10', '923001234567');
  assert.ok(result.expiresAt > Date.now());
  const session = manager.getSession('10', '923001234567');
  const authDir = session.authDir;
  await sleep(60);
  assert.equal(manager.getSession('10', '923001234567'), undefined, 'expired session is removed');
  await assert.rejects(fs.access(authDir), 'expired credentials are deleted');
  await manager.shutdown();
});

test('a linked session reconnects with backoff after a transient disconnect', async () => {
  const { manager, fake } = makeManager();
  await manager.requestPairing('10', '923001234567');
  await linkSession(manager, fake, '10', '923001234567');
  assert.equal(manager.getSession('10', '923001234567').status, STATUS.CONNECTED);
  const linkedSocket = fake.sockets.at(-1);

  linkedSocket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  assert.equal(manager.getSession('10', '923001234567').status, STATUS.RECONNECTING);
  await sleep(20);
  assert.ok(fake.sockets.length >= 3, 'a replacement socket was created');
  fake.sockets.at(-1).ev.emit('connection.update', { connection: 'open' });
  await sleep(5);
  assert.equal(manager.getSession('10', '923001234567').status, STATUS.CONNECTED);
  // The stale socket's late close event is ignored (socket identity check).
  linkedSocket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await sleep(10);
  assert.equal(manager.getSession('10', '923001234567').status, STATUS.CONNECTED);
  await manager.shutdown();
});

test('a logged-out session is terminal: no reconnect, credentials removed, owner notified', async () => {
  const { manager, fake } = makeManager();
  const disconnected = [];
  manager.onDisconnected = (ownerId, session, classification) => disconnected.push({ ownerId, session, classification });
  await manager.requestPairing('10', '923001234567');
  await linkSession(manager, fake, '10', '923001234567');
  fake.sockets.at(-1).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await sleep(10);
  assert.equal(manager.getSession('10', '923001234567'), undefined, 'session is cleaned up after logout');
  assert.equal(disconnected.length, 1);
  assert.equal(disconnected[0].ownerId, '10');
  assert.equal(disconnected[0].classification.type, 'LOGGED_OUT');
  await assert.rejects(fs.access(path.join(manager.root, '10', '923001234567')));
  await manager.shutdown();
});

test('the post-link restartRequired close never destroys the just-linked session', async () => {
  const { manager, fake } = makeManager();
  const codes = await manager.requestPairing('10', '923001234567');
  assert.equal(codes.code, 'code-923001234567');
  const session = manager.getSession('10', '923001234567');
  // The link completes: credentials become registered, then WhatsApp forces a
  // connection restart — on the SAME socket, before any connection open.
  session.socket.authState.creds.registered = true;
  session.socket.ev.emit('creds.update', { registered: true, me: { id: '923001234567:1@s.whatsapp.net' } });
  await fs.mkdir(session.authDir, { recursive: true });
  await fs.writeFile(path.join(session.authDir, 'creds.json'), JSON.stringify({ registered: true }));
  session.socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await sleep(25);
  const revived = manager.getSession('10', '923001234567');
  assert.ok(revived, 'the session survived the post-link restart');
  assert.ok([STATUS.CONNECTING, STATUS.RECONNECTING].includes(revived.status), `unexpected status ${revived.status}`);
  fake.sockets.at(-1).ev.emit('connection.update', { connection: 'open' });
  await sleep(5);
  assert.equal(manager.getSession('10', '923001234567').status, STATUS.CONNECTED);
  await manager.shutdown();
});

test('restartSession brings a paired session back online from persisted credentials', async () => {
  const { manager, fake } = makeManager();
  await manager.requestPairing('10', '923001234567');
  await linkSession(manager, fake, '10', '923001234567');
  const beforeRestart = fake.sockets.length;
  const snapshot = await manager.restartSession('10', '923001234567');
  assert.equal(snapshot.status, STATUS.CONNECTING);
  assert.equal(fake.sockets.length, beforeRestart + 1, 'a fresh socket was created');
  fake.sockets.at(-1).ev.emit('connection.update', { connection: 'open' });
  await sleep(5);
  assert.equal(manager.statusOf('10', '923001234567').status, STATUS.CONNECTED);
  await manager.shutdown();
});

test('restartSession without stored credentials explains that pairing is required', async () => {
  const { manager } = makeManager();
  await assert.rejects(manager.restartSession('10', '923001234567'), (error) => {
    assert.equal(error.code, 'NOT_FOUND');
    return true;
  });
  await manager.shutdown();
});

test('requestPairing on an already paired number is refused without a new code', async () => {
  const { manager, fake } = makeManager();
  await manager.requestPairing('10', '923001234567');
  await linkSession(manager, fake, '10', '923001234567');
  await assert.rejects(manager.requestPairing('10', '923001234567'), (error) => {
    assert.equal(error.code, 'ALREADY_PAIRED');
    return true;
  });
  assert.equal(fake.pairingCalls.length, 1, 'no second code was requested');
  await manager.shutdown();
});

test('stopSession removes an unpaired session and its credentials', async () => {
  const { manager } = makeManager();
  await manager.requestPairing('10', '923001234567');
  await manager.stopSession('10', '923001234567');
  assert.equal(manager.listSessions('10').length, 0);
  await assert.rejects(manager.stopSession('10', '923001234567'), /No session found/);
  await manager.shutdown();
});

test('stopSession refuses to remove a connected session', async () => {
  const { manager, fake } = makeManager();
  await manager.requestPairing('10', '923001234567');
  await linkSession(manager, fake, '10', '923001234567');
  await assert.rejects(manager.stopSession('10', '923001234567'), (error) => {
    assert.equal(error.code, 'CONNECTED');
    assert.match(error.message, /Linked Devices/);
    return true;
  });
  await manager.shutdown();
});

test('paired sessions survive a full bot restart through restore()', async () => {
  const { manager, fake, authDir } = makeManager();
  await manager.requestPairing('10', '923001234567');
  await linkSession(manager, fake, '10', '923001234567');
  await manager.shutdown();

  const fakeTwo = fakeBaileys();
  const revived = new TelegramPairingManager({
    authDir,
    baileys: fakeTwo,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    limits: { ownerCooldownMs: 0, reconnectBaseDelayMs: 5, reconnectMaxDelayMs: 10 }
  });
  await revived.restore();
  assert.equal(revived.listSessions('10').length, 1);
  assert.equal(revived.statusOf('10', '923001234567').status, STATUS.CONNECTING);
  assert.equal(fakeTwo.sockets.length, 1);
  fakeTwo.sockets[0].ev.emit('connection.update', { connection: 'open' });
  await sleep(5);
  assert.equal(revived.statusOf('10', '923001234567').status, STATUS.CONNECTED);
  await revived.shutdown();
});

test('restore migrates the legacy per-controller session layout', async () => {
  const { manager, authDir } = makeManager();
  const legacyDir = path.join(authDir, 'telegram-pairings', '30');
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, 'creds.json'), JSON.stringify({ registered: true, me: { id: '923001234567:5@s.whatsapp.net' } }));
  await fs.writeFile(path.join(legacyDir, 'keys.json'), '{}');
  await manager.restore();
  assert.equal(await fs.access(path.join(legacyDir, 'creds.json')).then(() => true, () => false), false, 'legacy creds moved');
  assert.equal(await fs.access(path.join(legacyDir, '923001234567', 'creds.json')).then(() => true, () => false), true, 'per-number creds exist');
  const sessions = manager.listSessions('30');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].number, '923001234567');
  await manager.shutdown();
});

test('restore drops stale unpaired credential directories', async () => {
  const { manager, authDir } = makeManager({ limits: { staleUnregisteredDirMs: 0 } });
  const staleDir = path.join(authDir, 'telegram-pairings', '10', '15550001234');
  await fs.mkdir(staleDir, { recursive: true });
  await fs.writeFile(path.join(staleDir, 'creds.json'), JSON.stringify({ registered: false }));
  await manager.restore();
  assert.equal(await fs.access(staleDir).then(() => true, () => false), false, 'stale directory removed');
  await manager.shutdown();
});

test('disconnect classifications map Baileys reasons to safe types', () => {
  const cases = [
    [DisconnectReason.loggedOut, 'LOGGED_OUT'],
    [DisconnectReason.badSession, 'BAD_AUTH'],
    [DisconnectReason.connectionReplaced, 'REPLACED'],
    [DisconnectReason.timedOut, 'TIMEOUT'],
    [DisconnectReason.connectionClosed, 'CONNECTION_LOST'],
    [DisconnectReason.unavailableService, 'NETWORK_ERROR'],
    [DisconnectReason.restartRequired, 'RESTART_REQUIRED']
  ];
  for (const [reason, type] of cases) {
    const classification = classifyDisconnect({ error: { output: { statusCode: reason } } });
    assert.equal(classification.type, type);
  }
  assert.equal(classifyDisconnect({ error: { output: { statusCode: 418 } } }).type, 'UNKNOWN');
  assert.equal(classifyDisconnect(undefined).type, 'UNKNOWN');
  // Terminal classifications are the only ones allowed to delete credentials.
  for (const [reason] of cases) {
    const classification = classifyDisconnect({ error: { output: { statusCode: reason } } });
    if (classification.terminal) assert.equal(classification.deleteCreds, true);
    else assert.equal(classification.deleteCreds, undefined);
  }
});

test('the socket budget keeps restore bounded and records the rest as offline', async () => {
  const { manager, authDir } = makeManager({ limits: { maxActiveSockets: 1 } });
  const root = path.join(authDir, 'telegram-pairings', '10');
  for (const number of ['923001234567', '12025550123']) {
    const dir = path.join(root, number);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'creds.json'), JSON.stringify({ registered: true, me: { id: `${number}:1@s.whatsapp.net` } }));
  }
  await manager.restore();
  const sessions = manager.listSessions('10');
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter((entry) => entry.status === STATUS.CONNECTING).length, 1);
  assert.equal(sessions.filter((entry) => entry.status === STATUS.OFFLINE).length, 1);
  await manager.shutdown();
});


// ---------------------------------------------------------------------------
// Admin operations and offline-credential removal.
// ---------------------------------------------------------------------------

test('listAllSessions returns every controller session for bootstrap owners', async () => {
  const { manager } = makeManager();
  await manager.requestPairing('10', '923001234567');
  await manager.requestPairing('20', '12025550123');
  const all = manager.listAllSessions();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((entry) => entry.number).sort(), ['12025550123', '923001234567']);
  // Regular controllers still only ever see their own sessions.
  assert.equal(manager.listSessions('10').length, 1);
  await manager.shutdown();
});

test('a bootstrap owner can stop another controller session through the admin override', async () => {
  const { manager, fake } = makeManager();
  await manager.requestPairing('20', '923001234567');
  // The owning controller cannot be found for a stranger.
  await assert.rejects(manager.stopSession('99', '923001234567'), (error) => error.code === 'NOT_FOUND');
  // The admin override removes it anyway.
  const snapshot = await manager.stopSession('1', '923001234567', { admin: true });
  assert.equal(snapshot.number, '923001234567');
  assert.equal(manager.listSessions('20').length, 0);
  assert.equal(manager.socketCount(), 0, 'the socket reservation was released');
  await manager.shutdown();
});

test('stopSession removes stored offline credentials without a live session', async () => {
  const { manager, authDir } = makeManager();
  // Simulate a paired session left on disk by an earlier process.
  const dir = path.join(authDir, 'telegram-pairings', '10', '923001234567');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'creds.json'), JSON.stringify({ registered: true, me: { id: '923001234567:1@s.whatsapp.net' } }));

  // The owning controller deletes it (delpair semantics).
  const snapshot = await manager.stopSession('10', '923001234567');
  assert.equal(snapshot.number, '923001234567');
  await assert.rejects(fs.access(dir), 'credentials were removed from disk');

  // Another controller cannot delete someone else's stored credentials.
  const otherDir = path.join(authDir, 'telegram-pairings', '20', '12025550123');
  await fs.mkdir(otherDir, { recursive: true });
  await fs.writeFile(path.join(otherDir, 'creds.json'), JSON.stringify({ registered: true }));
  await assert.rejects(manager.stopSession('10', '12025550123'), (error) => error.code === 'NOT_FOUND');
  await assert.doesNotReject(fs.access(otherDir), 'other credentials stay untouched');
  // An admin override may remove them.
  await manager.stopSession('1', '12025550123', { admin: true });
  await assert.rejects(fs.access(otherDir));
  await manager.shutdown();
});

test('restartSession with the admin override revives another controller session', async () => {
  const { manager, fake, authDir } = makeManager();
  await manager.requestPairing('20', '923001234567');
  await linkSession(manager, fake, '20', '923001234567');
  await manager.shutdown();

  const fakeTwo = fakeBaileys();
  const revived = new TelegramPairingManager({
    authDir,
    baileys: fakeTwo,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    limits: { ownerCooldownMs: 0, reconnectBaseDelayMs: 5, reconnectMaxDelayMs: 10 }
  });
  await revived.restore();
  const snapshot = await revived.restartSession('1', '923001234567', { admin: true });
  assert.equal(snapshot.number, '923001234567');
  assert.equal(snapshot.ownerId, '20');
  fakeTwo.sockets.at(-1).ev.emit('connection.update', { connection: 'open' });
  await sleep(5);
  assert.equal(revived.statusOf('1', '923001234567', { admin: true }).status, STATUS.CONNECTED);
  // Without the override the same lookup stays owner-scoped.
  assert.throws(() => revived.statusOf('1', '923001234567'), /No session found/);
  await revived.shutdown();
});


test('a stored session under another controller blocks a fresh pairing (LOCKED)', async () => {
  const { manager, authDir } = makeManager();
  // Credentials from an earlier process exist on disk, but no in-memory
  // session does: the fresh pairing attempt must detect the conflict.
  const dir = path.join(authDir, 'telegram-pairings', '20', '923001234567');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'creds.json'), JSON.stringify({ registered: true, me: { id: '923001234567:1@s.whatsapp.net' } }));
  await assert.rejects(manager.requestPairing('10', '923001234567'), (error) => {
    assert.equal(error.code, 'LOCKED');
    return true;
  });
  await manager.shutdown();
});
