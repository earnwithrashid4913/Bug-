'use strict';

// ---------------------------------------------------------------------------
// Test-only stand-in for @whiskeysockets/baileys.
//
// It keeps the REAL DisconnectReason table and only replaces the three things a
// stability test has to control: socket construction, the auth-state reader and
// the version fetch. The fake socket reproduces the two behaviours that the
// lifecycle under test depends on:
//
//   * makeWASocket() starts the handshake synchronously and delivers its first
//     connection.update events asynchronously (setImmediate), exactly like the
//     real client — so a listener attached after an `await` would miss them,
//     which is the race that used to take the bot OFFLINE;
//   * while "open" it holds a ref'd handle, the way a real WebSocket does, so a
//     process-lifetime assertion actually means something.
// ---------------------------------------------------------------------------

const { EventEmitter } = require('node:events');
const real = require('@whiskeysockets/baileys');

const sockets = [];
let failAuthRead = false;

function makeSocket() {
  const ev = new EventEmitter();
  ev.setMaxListeners(100);

  const socket = {
    ev,
    ws: { isOpen: false, isClosed: false, close() { stopHandle(); socket.ws.isOpen = false; socket.ws.isClosed = true; } },
    user: { id: '923001234567:5@s.whatsapp.net', name: 'ANIME MD' },
    public: true,
    async sendMessage() { return { key: { id: 'STUB' } }; },
    async sendPresenceUpdate() {},
    async requestPairingCode() { return 'ABCD1234'; },
    async query() { return {}; },
    async logout() {},
    decodeJid: (jid) => jid
  };

  // Stands in for the WebSocket handle a live socket keeps in the event loop.
  //
  // Deliberately unref'd: a worker must stay alive because index.js keeps it
  // alive, not because a test artifact does. If the production keep-alive is
  // ever removed, the process-lifetime tests below fail immediately instead of
  // being masked by this handle. It also lets the test runner exit cleanly.
  let handle;
  function startHandle() { if (!handle) handle = setInterval(() => {}, 30_000).unref(); }
  function stopHandle() { if (handle) { clearInterval(handle); handle = undefined; } }

  sockets.push(socket);

  // The real client emits these after the handshake completes, never during
  // makeWASocket(). Delivering them on setImmediate reproduces the ordering
  // that exposed the listener-attachment race.
  setImmediate(() => {
    socket.ws.isOpen = true;
    startHandle();
    ev.emit('connection.update', { connection: 'connecting' });
    setImmediate(() => ev.emit('connection.update', { connection: 'open' }));
  });

  return socket;
}

async function readAuthState() {
  if (failAuthRead) {
    throw Object.assign(new Error('ENOENT: no such file or directory, open creds.json'), { code: 'ENOENT' });
  }
  return {
    state: {
      creds: { registered: true, me: { id: '923001234567:5@s.whatsapp.net' }, noiseKey: {}, signedIdentityKey: {}, signedPreKey: {}, registrationId: 1 },
      keys: {}
    },
    saveCreds: async () => {}
  };
}

const stub = Object.assign({}, real, {
  default: makeSocket,
  useMultiFileAuthState: readAuthState,
  fetchLatestBaileysVersion: async () => { throw new Error('ECONNRESET offline'); }
});

function install() {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === '@whiskeysockets/baileys') return stub;
    return originalLoad.call(this, request, ...rest);
  };
  return stub;
}

/** Emulates WhatsApp closing the newest socket with the given status code. */
function closeNewestSocket(statusCode, message) {
  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error('No socket has been created yet.');
  const { Boom } = require('@hapi/boom');
  socket.ws.close();
  socket.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: new Boom(message || 'closed by test', { statusCode }), date: new Date() }
  });
  return socket;
}

function reset() {
  sockets.length = 0;
  failAuthRead = false;
}

/**
 * Number of sockets whose transport is currently open.
 *
 * `sockets.length` only ever grows — it is a creation registry — so it counts
 * sockets ever made, which is the right measure for "did a reconnect storm
 * create extra sockets". This is the measure for "is more than one socket live
 * at a time", which must never happen for a single number.
 */
function liveSocketCount() {
  return sockets.filter((socket) => socket.ws.isOpen).length;
}

module.exports = { closeNewestSocket, install, liveSocketCount, reset, setFailAuthRead: (value) => { failAuthRead = value; }, sockets, stub };
