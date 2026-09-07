'use strict';

// Isolated WhatsApp pairing sessions for Telegram controllers.  The main bot
// socket is deliberately not reused here: a Telegram operator owns only the
// directory named after their Telegram ID and can never observe or stop
// another operator's session.
const fs = require('node:fs/promises');
const path = require('node:path');
const pino = require('pino');
const {
  default: makeWASocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const { normalizeTelegramId, normalizeWhatsappNumber } = require('./telegram-controller');

const PAIRING_READY_TIMEOUT_MS = 45_000;
const PAIRING_CODE_TTL_MS = 5 * 60_000;
const MAX_RECONNECT_ATTEMPTS = 5;

function safeSessionDirectory(root, telegramId) {
  const id = normalizeTelegramId(telegramId);
  const directory = path.resolve(root, id);
  if (!directory.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid Telegram session directory.');
  return directory;
}

class TelegramPairingManager {
  constructor({ authDir, log = console, onSocket, baileys = {} }) {
  constructor({ authDir, log = console, baileys = {} }) {
    this.root = path.resolve(authDir, 'telegram-pairings');
    this.log = log;
    this.sessions = new Map();
    this.onConnected = undefined;
    this.onSocket = onSocket;
    this.baileys = {
      makeWASocket: baileys.makeWASocket || makeWASocket,
      useMultiFileAuthState: baileys.useMultiFileAuthState || useMultiFileAuthState,
      makeCacheableSignalKeyStore: baileys.makeCacheableSignalKeyStore || makeCacheableSignalKeyStore
    };
  }

  entry(ownerId) {
    const id = normalizeTelegramId(ownerId);
    let entry = this.sessions.get(id);
    if (!entry) {
      entry = { id, state: 'idle', connected: false, number: null, socket: undefined, ready: undefined, readyResolve: undefined, request: undefined, reconnects: 0, timer: undefined, startedAt: Date.now(), updatedAt: Date.now(), stopped: false };
      this.sessions.set(id, entry);
    }
    return entry;
  }

  snapshot(ownerId) {
    const entry = this.entry(ownerId);
    return { state: entry.state, connected: entry.connected, pairingNumber: entry.number, session: entry.connected ? 'paired' : entry.state, startedAt: entry.startedAt, updatedAt: entry.updatedAt };
  }

  async ensureSocket(ownerId) {
    const entry = this.entry(ownerId);
    if (entry.socket) return entry;
    const authDir = safeSessionDirectory(this.root, entry.id);
    const { state, saveCreds } = await this.baileys.useMultiFileAuthState(authDir);
    const logger = pino({ level: 'silent' });
    const socket = this.baileys.makeWASocket({
      auth: { creds: state.creds, keys: this.baileys.makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: ['ANIME MD', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });
    entry.socket = socket;
    entry.connected = Boolean(state.creds.registered);
    entry.state = entry.connected ? 'connecting' : 'initializing';
    entry.updatedAt = Date.now();
    entry.ready = new Promise((resolve) => { entry.readyResolve = resolve; });
    socket.ev.on('creds.update', () => { void saveCreds().catch(() => this.log.error?.('[telegram-pairing] Could not save WhatsApp credentials.')); });
    socket.ev.on('connection.update', (update) => this.connectionUpdate(entry, update));
    await this.onSocket?.(socket, entry.id);
    return entry;
  }

  connectionUpdate(entry, update) {
    if (entry.stopped) return;
    if (update.connection === 'connecting' || update.qr) {
      entry.state = 'ready';
      entry.updatedAt = Date.now();
      entry.readyResolve?.();
      entry.readyResolve = undefined;
      return;
    }
    if (update.connection === 'open') {
      entry.connected = true;
      entry.state = 'connected';
      entry.reconnects = 0;
      entry.updatedAt = Date.now();
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      void this.onConnected?.(entry.id, this.snapshot(entry.id));
      return;
    }
    if (update.connection !== 'close') return;
    entry.socket = undefined;
    entry.connected = false;
    entry.updatedAt = Date.now();
    const code = update.lastDisconnect?.error?.output?.statusCode;
    if ([DisconnectReason.loggedOut, DisconnectReason.badSession, DisconnectReason.connectionReplaced].includes(code)) {
      entry.state = 'logged_out';
      return;
    }
    if (entry.reconnects >= MAX_RECONNECT_ATTEMPTS) { entry.state = 'error'; return; }
    entry.state = 'reconnecting';
    entry.reconnects += 1;
    setTimeout(() => { void this.ensureSocket(entry.id).catch(() => { entry.state = 'error'; }); }, Math.min(2_000 * 2 ** entry.reconnects, 30_000)).unref();
  }

  async requestPairing(ownerId, rawNumber) {
    let entry = this.entry(ownerId);
    const number = normalizeWhatsappNumber(rawNumber);
    // A logged-out credential set cannot be revived. Remove only this
    // controller's private directory before creating a fresh pairing socket.
    if (entry.state === 'logged_out') {
      entry.stopped = true;
      try { entry.socket?.ws?.close(); } catch { /* best effort */ }
      await fs.rm(safeSessionDirectory(this.root, entry.id), { recursive: true, force: true });
      this.sessions.delete(entry.id);
      entry = this.entry(ownerId);
    }
    entry = await this.ensureSocket(ownerId);
    if (entry.connected) throw Object.assign(new Error('Your WhatsApp session is already connected.'), { status: 409 });
    if (entry.request) return entry.request;
    if (entry.number && entry.number !== number && entry.state === 'pairing') throw Object.assign(new Error('A pairing request is already active for your session.'), { status: 409 });
    entry.request = (async () => {
      entry.number = number;
      entry.state = 'waiting';
      entry.updatedAt = Date.now();
      await Promise.race([entry.ready, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('WhatsApp did not become ready for pairing in time.'), { status: 504 })), PAIRING_READY_TIMEOUT_MS))]);
      const code = await entry.socket.requestPairingCode(number);
      entry.state = 'pairing';
      entry.updatedAt = Date.now();
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => { if (!entry.connected) { entry.state = 'expired'; entry.number = null; } }, PAIRING_CODE_TTL_MS);
      entry.timer.unref();
      return code;
    })();
    try { return await entry.request; } finally { entry.request = undefined; }
  }

  async stopSession(ownerId, rawNumber) {
    const entry = this.entry(ownerId);
    const number = normalizeWhatsappNumber(rawNumber);
    if (entry.number !== number) throw new Error('That number does not belong to your active pairing session.');
    if (entry.connected) throw new Error('Connected sessions must be logged out from WhatsApp Linked Devices.');
    entry.stopped = true;
    try { entry.socket?.ws?.close(); } catch { /* best effort */ }
    if (entry.timer) clearTimeout(entry.timer);
    await fs.rm(safeSessionDirectory(this.root, entry.id), { recursive: true, force: true });
    this.sessions.delete(entry.id);
  }

  async shutdown() {
    for (const entry of this.sessions.values()) { if (entry.timer) clearTimeout(entry.timer); try { entry.socket?.ws?.close(); } catch { /* best effort */ } }
    this.sessions.clear();
  }
}

module.exports = { MAX_RECONNECT_ATTEMPTS, TelegramPairingManager, safeSessionDirectory };
