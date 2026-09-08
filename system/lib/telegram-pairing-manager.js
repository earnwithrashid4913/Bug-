'use strict';

// -----------------------------------------------------------------------------
// Isolated multi-session WhatsApp pairing manager for Telegram controllers.
//
// Every WhatsApp number paired by a Telegram controller receives its own
// session with its own Baileys socket and its own credential directory below
// <authDir>/telegram-pairings/<telegramId>/<number>. A controller can never
// observe or stop another controller's sessions.
//
// Session lifecycle:
//   RECEIVED → VALIDATING → NORMALIZING → LOCKING → INITIALIZING → CONNECTING
//   → PAIRING_READY → CODE_GENERATED → WAITING_FOR_LINK → CONNECTED
//   and on failure: FAILED → CLEANUP
//
// Pairing codes are always produced by the real Baileys/WhatsApp pairing flow.
// A configured custom code (exactly 8 characters, e.g. GOATMODS) is passed to
// Baileys' native requestPairingCode(number, customCode) and is cryptographically
// bound into the link flow — WhatsApp accepts it because the code derives the
// key that protects the pairing handshake. Codes are never invented locally.
//
// Traffic is protected by: a global socket budget, a concurrent-pairing limit,
// a bounded FIFO pairing queue, per-number locks (across all controllers),
// per-controller cooldowns, session caps, pairing timeouts with TTL cleanup,
// reconnect backoff, and stale-session sweeps.
// -----------------------------------------------------------------------------

const fs = require('node:fs/promises');
const path = require('node:path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const { normalizeTelegramId } = require('./telegram-controller');
const { formatInternationalNumber, formatPairingCodeDisplay, normalizeWhatsAppNumber } = require('./pairing-number');

// ---------------------------------------------------------------------------
// Lifecycle states and traffic defaults.
// ---------------------------------------------------------------------------

const STATUS = Object.freeze({
  RECEIVED: 'RECEIVED',
  VALIDATING: 'VALIDATING',
  NORMALIZING: 'NORMALIZING',
  LOCKING: 'LOCKING',
  INITIALIZING: 'INITIALIZING',
  CONNECTING: 'CONNECTING',
  PAIRING_READY: 'PAIRING_READY',
  CODE_GENERATED: 'CODE_GENERATED',
  WAITING_FOR_LINK: 'WAITING_FOR_LINK',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  OFFLINE: 'OFFLINE',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  LOGGED_OUT: 'LOGGED_OUT',
  CLEANUP: 'CLEANUP'
});

// Statuses that describe a session whose pairing attempt is definitively over.
const TERMINAL_STATUSES = new Set([STATUS.FAILED, STATUS.EXPIRED, STATUS.LOGGED_OUT, STATUS.CLEANUP]);

const DEFAULT_LIMITS = Object.freeze({
  maxConcurrentPairings: 3,      // unregistered pairing sockets running at once
  maxActiveSockets: 10,          // total WhatsApp sockets (pairing + connected)
  maxSessionsPerController: 5,   // sessions a single Telegram controller may hold
  pairingQueueLimit: 10,         // requests that may wait for a pairing slot
  queueWaitTimeoutMs: 60_000,    // how long a queued request may wait
  ownerCooldownMs: 10_000,       // minimum spacing between new pairing flows
  pairingReadyTimeoutMs: 45_000, // wait for the WhatsApp handshake
  pairingCodeTtlMs: 5 * 60_000,  // pairing code lifetime before cleanup
  reconnectBaseDelayMs: 2_000,
  reconnectMaxDelayMs: 30_000,
  staleSweepIntervalMs: 10 * 60_000,
  staleUnregisteredDirMs: 60 * 60_000
});

const MAX_RECONNECT_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Disconnect classification.
//
// Raw disconnect reasons stay in the internal log; `userMessage` is the safe
// text controllers may show. Credentials are only deleted for conditions that
// make them permanently unusable — never for a temporary network failure.
// ---------------------------------------------------------------------------

const DISCONNECT_CLASSIFICATIONS = new Map([
  [DisconnectReason.loggedOut, {
    type: 'LOGGED_OUT', terminal: true, deleteCreds: true,
    userMessage: 'This device was logged out from WhatsApp. Pair again with /pair.'
  }],
  [DisconnectReason.forbidden, {
    type: 'BAD_AUTH', terminal: true, deleteCreds: true,
    userMessage: 'WhatsApp refused this session. Pair again with /pair.'
  }],
  [DisconnectReason.badSession, {
    type: 'BAD_AUTH', terminal: true, deleteCreds: true,
    userMessage: 'The saved WhatsApp session became invalid. Pair again with /pair.'
  }],
  [DisconnectReason.multideviceMismatch, {
    type: 'BAD_AUTH', terminal: true, deleteCreds: true,
    userMessage: 'This session is not compatible with the linked device. Pair again with /pair.'
  }],
  [DisconnectReason.connectionReplaced, {
    type: 'REPLACED', terminal: true, deleteCreds: true,
    userMessage: 'This session was replaced by another WhatsApp connection.'
  }],
  [DisconnectReason.timedOut, {
    type: 'TIMEOUT', reconnect: true,
    userMessage: 'The WhatsApp connection timed out.'
  }],
  [DisconnectReason.connectionClosed, {
    type: 'CONNECTION_LOST', reconnect: true,
    userMessage: 'The WhatsApp connection closed.'
  }],
  [DisconnectReason.unavailableService, {
    type: 'NETWORK_ERROR', reconnect: true,
    userMessage: 'WhatsApp is temporarily unavailable.'
  }],
  [DisconnectReason.restartRequired, {
    type: 'RESTART_REQUIRED', reconnect: true, immediate: true,
    userMessage: 'WhatsApp requested a connection restart.'
  }]
]);

const UNKNOWN_CLASSIFICATION = Object.freeze({
  type: 'UNKNOWN', reconnect: true,
  userMessage: 'The WhatsApp connection ended unexpectedly.'
});

function classifyDisconnect(lastDisconnect) {
  const error = lastDisconnect?.error;
  if (!error) return UNKNOWN_CLASSIFICATION;
  const code = error?.output?.statusCode || new Boom(error).output.statusCode;
  return DISCONNECT_CLASSIFICATIONS.get(code) || UNKNOWN_CLASSIFICATION;
}

// ---------------------------------------------------------------------------
// Errors. Every failure carries a stable `code` so the Telegram layer can map
// it to a friendly message without leaking internals.
// ---------------------------------------------------------------------------

function pairingError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function normalizeCustomPairingCode(value) {
  const cleaned = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned || undefined;
}

async function waitForPairingReady(ready, timeoutMs) {
  let timeout;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(pairingError('WhatsApp did not become ready for pairing in time.', 'PAIRING_TIMEOUT', 504)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// Each path segment must be purely numeric; together with the resolve + prefix
// check this prevents any path traversal outside the pairing root.
function safeSessionDirectory(root, ...segments) {
  for (const segment of segments) {
    if (!/^\d{1,20}$/.test(String(segment))) throw new Error('Invalid Telegram session directory.');
  }
  const directory = path.resolve(root, ...segments);
  if (!directory.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid Telegram session directory.');
  return directory;
}

// ---------------------------------------------------------------------------
// PairingSession — one isolated WhatsApp number pairing/link for one controller.
// ---------------------------------------------------------------------------

class PairingSession {
  constructor(ownerId, number, authDir) {
    this.id = `${ownerId}:${number}`;
    this.ownerId = ownerId;
    this.number = number;
    this.numberDisplay = formatInternationalNumber(number);
    this.authDir = authDir;
    this.socket = undefined;
    this.status = STATUS.RECEIVED;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    this.lastActivity = this.createdAt;
    this.pairingCode = undefined;
    this.codeRequestedAt = undefined;
    this.codeExpiresAt = undefined;
    this.registered = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = undefined;
    this.expiryTimer = undefined;
    this.ready = undefined;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    this.request = undefined;
    this.lastResult = undefined;
    this.stopped = false;
    this.closeExpected = false;
    this.lastDisconnectType = undefined;
    this.pairingFlowActive = false;
    this.socketReserved = false;
    this.cleanupState = 'none';
    this.cleanupPromise = undefined;
  }

  setStatus(status) {
    this.status = status;
    this.updatedAt = Date.now();
    this.lastActivity = this.updatedAt;
  }
}

// ---------------------------------------------------------------------------
// TelegramPairingManager.
// ---------------------------------------------------------------------------

class TelegramPairingManager {
  constructor({ authDir, log = console, onSocket, baileys = {}, customPairingCode, limits = {} }) {
    this.root = path.resolve(authDir, 'telegram-pairings');
    this.log = log;
    this.onConnected = undefined;
    this.onDisconnected = undefined;
    this.onSocket = onSocket;
    this.baileys = {
      makeWASocket: baileys.makeWASocket || makeWASocket,
      useMultiFileAuthState: baileys.useMultiFileAuthState || useMultiFileAuthState,
      makeCacheableSignalKeyStore: baileys.makeCacheableSignalKeyStore || makeCacheableSignalKeyStore
    };
    this.limits = { ...DEFAULT_LIMITS, ...limits };

    // A custom pairing code is only real when Baileys/WhatsApp can accept it:
    // exactly 8 characters. Anything else falls back to WhatsApp-generated
    // codes and the configured value is used for display branding only.
    const normalizedCode = normalizeCustomPairingCode(customPairingCode);
    this.customPairingCode = normalizedCode?.length === 8 ? normalizedCode : undefined;
    this.brandLabel = normalizedCode ? formatPairingCodeDisplay(normalizedCode) : 'PAIRING';
    if (customPairingCode && normalizedCode && normalizedCode.length !== 8) {
      log.warn?.(`[telegram-pairing] Custom pairing code "${customPairingCode}" is not exactly 8 characters; WhatsApp cannot accept it as a real code. Using WhatsApp-generated codes and keeping the value as branding only.`);
    }

    this.sessions = new Map();       // "ownerId:number" → PairingSession
    this.numberLocks = new Set();    // numbers with an in-flight pairing flow
    this.pairingQueue = [];          // FIFO of waiting pairing requests
    this.ownerCooldowns = new Map(); // ownerId → last flow start time
    this.socketReservations = 0;
    this.sweepTimer = undefined;
    this.shutdownCalled = false;
    this.sweepTimer = setInterval(() => this.sweepStaleSessions(), this.limits.staleSweepIntervalMs);
    this.sweepTimer.unref();
  }

  // ------------------------------ helpers ---------------------------------

  sessionKey(ownerId, number) {
    return `${normalizeTelegramId(ownerId)}:${number}`;
  }

  getSession(ownerId, number) {
    return this.sessions.get(this.sessionKey(ownerId, number));
  }

  sessionSnapshot(session) {
    return {
      id: session.id,
      number: session.number,
      numberDisplay: session.numberDisplay,
      status: session.status,
      state: STATUS_TO_STATE[session.status] || session.status.toLowerCase(),
      connected: session.status === STATUS.CONNECTED,
      registered: session.registered,
      pairingNumber: session.number,
      session: session.registered ? 'paired' : session.status.toLowerCase(),
      pairingCode: null,
      startedAt: session.createdAt,
      updatedAt: session.updatedAt,
      reconnects: session.reconnectAttempts,
      codeExpiresAt: session.codeExpiresAt,
      lastDisconnect: session.lastDisconnectType
    };
  }

  listSessions(ownerId) {
    const id = normalizeTelegramId(ownerId);
    return [...this.sessions.values()]
      .filter((session) => session.ownerId === id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((session) => this.sessionSnapshot(session));
  }

  // Backwards-compatible single summary: the most relevant session for a
  // controller (connected first, otherwise the most recently updated).
  snapshot(ownerId) {
    const sessions = this.listSessions(ownerId);
    if (!sessions.length) {
      return { state: 'idle', connected: false, pairingNumber: null, session: 'none', startedAt: Date.now(), updatedAt: Date.now(), sessions: [] };
    }
    const best = sessions.find((entry) => entry.connected) || sessions.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
    return { ...best, sessions };
  }

  socketCount() {
    return this.socketReservations;
  }

  pairingFlowCount() {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.pairingFlowActive) count += 1;
    }
    return count;
  }

  activeSessionsForNumber(number) {
    for (const session of this.sessions.values()) {
      if (session.number === number) return session;
    }
    return undefined;
  }

  ensureActive() {
    if (this.shutdownCalled) throw pairingError('The pairing manager is shutting down.', 'SHUTDOWN', 503);
  }

  // ------------------------- traffic management ---------------------------

  canCreateSocket() {
    return this.socketReservations < this.limits.maxActiveSockets;
  }

  reserveSocketSlot(session) {
    if (session.socketReserved) return;
    session.socketReserved = true;
    this.socketReservations += 1;
  }

  releaseSocketReservation(session) {
    if (!session.socketReserved) return;
    session.socketReserved = false;
    this.socketReservations = Math.max(0, this.socketReservations - 1);
    this.pumpPairingQueue();
  }

  // Grants a pairing slot through the bounded FIFO queue. The promise rejects
  // with BUSY when the queue is full and QUEUE_TIMEOUT when no slot frees up.
  acquirePairingSlot(session) {
    return new Promise((resolve, reject) => {
      const grant = () => {
        session.pairingFlowActive = true;
        session.setStatus(STATUS.INITIALIZING);
        resolve();
      };
      if (this.pairingFlowCount() < this.limits.maxConcurrentPairings && this.canCreateSocket()) {
        grant();
        return;
      }
      if (this.pairingQueue.length >= this.limits.pairingQueueLimit) {
        reject(pairingError('The pairing system is busy right now. Please try again in a few minutes.', 'BUSY', 503));
        return;
      }
      const item = { session, grant, reject, timer: undefined };
      item.timer = setTimeout(() => {
        const index = this.pairingQueue.indexOf(item);
        if (index >= 0) this.pairingQueue.splice(index, 1);
        reject(pairingError('The pairing system is busy right now. Please try again shortly.', 'QUEUE_TIMEOUT', 503));
      }, this.limits.queueWaitTimeoutMs);
      item.timer.unref();
      this.pairingQueue.push(item);
    });
  }

  releasePairingSlot(session) {
    if (!session.pairingFlowActive) return;
    session.pairingFlowActive = false;
    this.pumpPairingQueue();
  }

  pumpPairingQueue() {
    while (this.pairingQueue.length) {
      const item = this.pairingQueue[0];
      if (item.session.stopped || item.session.cleanupState !== 'none') {
        this.pairingQueue.shift();
        clearTimeout(item.timer);
        item.reject(pairingError('The pairing request was cancelled.', 'CANCELLED', 410));
        continue;
      }
      if (this.pairingFlowCount() >= this.limits.maxConcurrentPairings || !this.canCreateSocket()) return;
      this.pairingQueue.shift();
      clearTimeout(item.timer);
      item.grant();
    }
  }

  // ------------------------------ sockets ---------------------------------

  async openSocket(session, { state, saveCreds }) {
    const logger = pino({ level: 'silent' });
    const socket = this.baileys.makeWASocket({
      auth: { creds: state.creds, keys: this.baileys.makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: ['ANIME MD', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });
    this.reserveSocketSlot(session);
    session.socket = socket;
    session.closeExpected = false;
    socket.ev.on('creds.update', (updatedCreds) => {
      // The phone-number link completes on the same socket: Baileys marks the
      // live credentials registered and emits them before the server forces a
      // restart (515). Latch that immediately so the restart is never mistaken
      // for a failed pairing.
      if (updatedCreds?.registered === true) session.registered = true;
      void saveCreds().catch(() => this.log.error?.(`[telegram-pairing] Could not save WhatsApp credentials for ${session.numberDisplay}.`));
    });
    socket.ev.on('connection.update', (update) => {
      try {
        this.connectionUpdate(session, update, socket);
      } catch (error) {
        this.log.error?.(`[telegram-pairing] Connection update handler failed for ${session.numberDisplay}: ${error.message}`);
      }
    });
    await this.onSocket?.(socket, session.ownerId, this.sessionSnapshot(session));
    return socket;
  }

  async connectRegistered(session) {
    if (!this.canCreateSocket()) {
      session.setStatus(STATUS.OFFLINE);
      throw pairingError('The session limit is reached. Stop an unused session first, then use /restart.', 'LIMIT', 503);
    }
    const { state, saveCreds } = await this.baileys.useMultiFileAuthState(session.authDir);
    if (!state.creds.registered) {
      throw pairingError('That number is not paired yet. Use /pair first.', 'NOT_PAIRED', 409);
    }
    session.registered = true;
    session.setStatus(STATUS.CONNECTING);
    await this.openSocket(session, { state, saveCreds });
    return this.sessionSnapshot(session);
  }

  // Closes the current socket without triggering the reconnect path.
  suspendSocket(session) {
    if (!session.socket) return;
    session.closeExpected = true;
    try {
      session.socket.ws?.close();
    } catch {
      /* best effort — the close handler is suppressed via closeExpected */
    }
    session.socket = undefined;
    this.releaseSocketReservation(session);
  }

  // --------------------------- lifecycle ----------------------------------

  connectionUpdate(session, update, socket) {
    if (session.stopped || this.shutdownCalled) return;
    // Events from a socket that is no longer this session's current socket
    // (restart/stop already replaced or removed it) are stale and ignored.
    if (socket && session.socket && socket !== session.socket) return;
    if (socket && !session.socket && !session.closeExpected) return;

    if (update.connection === 'connecting' || update.qr) {
      // The handshake reached the point where a pairing code can be issued.
      if (session.readyResolve) {
        const resolve = session.readyResolve;
        session.readyResolve = undefined;
        session.readyReject = undefined;
        resolve();
      }
      if (session.status !== STATUS.WAITING_FOR_LINK && session.status !== STATUS.CONNECTED) {
        session.setStatus(session.registered ? STATUS.CONNECTING : STATUS.PAIRING_READY);
      }
      return;
    }

    if (update.connection === 'open') {
      session.registered = true;
      session.reconnectAttempts = 0;
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      session.reconnectTimer = undefined;
      if (session.expiryTimer) clearTimeout(session.expiryTimer);
      session.expiryTimer = undefined;
      session.setStatus(STATUS.CONNECTED);
      // The pairing flow is complete: free the slot for queued requests.
      this.releasePairingSlot(session);
      const snapshot = this.sessionSnapshot(session);
      try {
        this.onConnected?.(session.ownerId, snapshot);
      } catch (error) {
        this.log.error?.(`[telegram-pairing] onConnected callback failed for ${session.numberDisplay}: ${error.message}`);
      }
      return;
    }

    if (update.connection !== 'close') return;

    // Expected closes (restart/stop/cleanup) never enter the reconnect path.
    if (session.closeExpected) {
      session.closeExpected = false;
      return;
    }

    const classification = classifyDisconnect(update.lastDisconnect);
    session.lastDisconnectType = classification.type;

    // Wake a pending pairing handshake immediately instead of letting it
    // run into its timeout.
    if (session.readyReject) {
      const reject = session.readyReject;
      session.readyResolve = undefined;
      session.readyReject = undefined;
      reject(pairingError('The WhatsApp connection closed before a pairing code could be generated.', 'CONNECTION_CLOSED', 502));
    }

    session.socket = undefined;
    this.releaseSocketReservation(session);
    const linked = session.registered || Boolean(update.receivedPendingNotifications && classification.type === 'RESTART_REQUIRED');

    this.log.warn?.(`[telegram-pairing] ${session.numberDisplay} disconnected (${classification.type}).`);

    if (classification.terminal) {
      session.setStatus(classification.type === 'LOGGED_OUT' ? STATUS.LOGGED_OUT : STATUS.FAILED);
      const snapshot = this.sessionSnapshot(session);
      void this.cleanupSession(session, { deleteCreds: true })
        .then(() => {
          try {
            this.onDisconnected?.(session.ownerId, snapshot, classification);
          } catch (error) {
            this.log.error?.(`[telegram-pairing] onDisconnected callback failed: ${error.message}`);
          }
        })
        .catch((error) => {
          this.log.error?.(`[telegram-pairing] Cleanup after disconnect failed for ${session.numberDisplay}: ${error.message}`);
        });
      return;
    }

    if (!linked) {
      // The socket died before linking completed. If a pairing request is in
      // flight its own error path performs the cleanup; otherwise clean up now.
      if (!session.request) {
        session.setStatus(STATUS.FAILED);
        void this.cleanupSession(session, { deleteCreds: true });
      } else {
        session.setStatus(STATUS.FAILED);
      }
      return;
    }

    // A linked session reconnects with exponential backoff; restartRequired
    // (normal right after linking) reconnects immediately.
    if (session.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      session.setStatus(STATUS.FAILED);
      this.log.error?.(`[telegram-pairing] ${session.numberDisplay} exhausted ${MAX_RECONNECT_ATTEMPTS} reconnect attempts; session is offline. Use /restart to try again.`);
      return;
    }

    const exponent = Math.min(session.reconnectAttempts, 5);
    const delay = classification.immediate
      ? 0
      : Math.min(this.limits.reconnectBaseDelayMs * 2 ** exponent, this.limits.reconnectMaxDelayMs);
    session.reconnectAttempts += 1;
    session.setStatus(STATUS.RECONNECTING);
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = undefined;
      if (session.stopped || this.shutdownCalled) return;
      void this.connectRegistered(session).catch((error) => {
        this.log.error?.(`[telegram-pairing] Reconnect failed for ${session.numberDisplay}: ${error.message}`);
        if (!session.socket) session.setStatus(STATUS.FAILED);
      });
    }, delay);
    session.reconnectTimer.unref();
  }

  armExpiryTimer(session) {
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    session.expiryTimer = setTimeout(() => {
      session.expiryTimer = undefined;
      if (session.stopped || session.registered || session.status === STATUS.CONNECTED) return;
      session.setStatus(STATUS.EXPIRED);
      this.log.info?.(`[telegram-pairing] Pairing code for ${session.numberDisplay} expired without a link.`);
      void this.cleanupSession(session, { deleteCreds: true });
    }, this.limits.pairingCodeTtlMs);
    session.expiryTimer.unref();
  }

  async requestPairing(ownerId, rawNumber) {
    this.ensureActive();
    const owner = normalizeTelegramId(ownerId);

    // VALIDATING → NORMALIZING: format only; WhatsApp availability is only
    // determined by the real pairing flow further below.
    const number = normalizeWhatsAppNumber(rawNumber);
    const key = this.sessionKey(owner, number);
    const existing = this.sessions.get(key);

    // Deduplicate: an in-flight request is shared, and a recently issued code
    // is returned again instead of opening a second socket for the number.
    if (existing?.request) return existing.request;
    if (existing?.lastResult && existing.status === STATUS.WAITING_FOR_LINK && existing.codeExpiresAt > Date.now()) {
      return existing.lastResult;
    }
    if (existing?.status === STATUS.CONNECTED) {
      throw pairingError(`${existing.numberDisplay} is already connected on this controller.`, 'ALREADY_PAIRED', 409);
    }

    // Another controller already owns this number.
    const numberOwner = this.activeSessionsForNumber(number);
    if (numberOwner && numberOwner.ownerId !== owner) {
      throw pairingError('This number already has an active session on another controller.', 'LOCKED', 409);
    }

    // A registered (already paired) session: bring it online in the background
    // instead of issuing a second code for the same account.
    if (existing?.registered && existing.status !== STATUS.CONNECTED) {
      void this.restartRegisteredSession(existing).catch(() => {});
      throw pairingError(`${existing.numberDisplay} is already paired on this controller and is being brought back online. Check /status ${existing.number}.`, 'ALREADY_PAIRED', 409);
    }

    // Terminal leftovers are cleaned before a fresh attempt.
    if (existing && TERMINAL_STATUSES.has(existing.status)) {
      await this.cleanupSession(existing, { deleteCreds: !existing.registered });
    }

    if (this.listSessions(owner).length >= this.limits.maxSessionsPerController) {
      throw pairingError(`This controller already holds the maximum of ${this.limits.maxSessionsPerController} sessions. Stop an unused one with /stop first.`, 'LIMIT', 409);
    }

    const now = Date.now();
    const lastFlow = this.ownerCooldowns.get(owner) || 0;
    if (now - lastFlow < this.limits.ownerCooldownMs) {
      throw pairingError(`Please wait ${Math.ceil((this.limits.ownerCooldownMs - (now - lastFlow)) / 1000)} seconds before starting another pairing.`, 'COOLDOWN', 429);
    }
    this.ownerCooldowns.set(owner, now);

    // LOCKING: one pairing flow per number, process-wide.
    this.numberLocks.add(number);
    const authDir = safeSessionDirectory(this.root, owner, number);
    const session = new PairingSession(owner, number, authDir);
    session.setStatus(STATUS.RECEIVED);
    session.setStatus(STATUS.VALIDATING);
    session.setStatus(STATUS.NORMALIZING);
    session.setStatus(STATUS.LOCKING);
    this.sessions.set(key, session);

    session.request = (async () => {
      try {
        // Traffic gate: bounded queue with backpressure.
        await this.acquirePairingSlot(session);

        const { state, saveCreds } = await this.baileys.useMultiFileAuthState(authDir);

        if (state.creds.registered) {
          // Credentials exist from an earlier successful pairing.
          this.releasePairingSlot(session);
          const conflict = await this.numberPairedElsewhere(owner, number);
          if (conflict) {
            throw pairingError('This number is already paired under another controller. Ask that controller to /stop it first.', 'LOCKED', 409);
          }
          session.registered = true;
          session.lastResult = undefined;
          void this.restartRegisteredSession(session, { state, saveCreds }).catch(() => {});
          throw pairingError(`${session.numberDisplay} is already paired on this controller and is being brought back online. Check /status ${number}.`, 'ALREADY_PAIRED', 409);
        }

        session.setStatus(STATUS.INITIALIZING);
        session.ready = new Promise((resolve, reject) => {
          session.readyResolve = resolve;
          session.readyReject = reject;
        });
        await this.openSocket(session, { state, saveCreds });
        // The socket may already have reported PAIRING_READY while the onSocket
        // hook was running; never regress that status.
        if (session.status === STATUS.INITIALIZING) session.setStatus(STATUS.CONNECTING);

        await waitForPairingReady(session.ready, this.limits.pairingReadyTimeoutMs);

        if (session.stopped || !session.socket) {
          throw pairingError('The WhatsApp pairing socket closed before a pairing code could be generated.', 'CONNECTION_CLOSED', 502);
        }
        if (typeof session.socket.requestPairingCode !== 'function') {
          throw pairingError('The installed Baileys version does not support native pairing codes.', 'UNSUPPORTED', 500);
        }

        // The real WhatsApp pairing flow. The custom code (when configured and
        // exactly 8 characters) is forwarded to Baileys' native implementation.
        const code = await session.socket.requestPairingCode(number, this.customPairingCode);
        session.pairingCode = code;
        session.codeRequestedAt = Date.now();
        session.codeExpiresAt = Date.now() + this.limits.pairingCodeTtlMs;
        session.setStatus(STATUS.CODE_GENERATED);
        session.setStatus(STATUS.WAITING_FOR_LINK);
        this.armExpiryTimer(session);

        const result = {
          code,
          displayCode: formatPairingCodeDisplay(code),
          brand: this.brandLabel,
          custom: this.customPairingCode === code,
          number,
          numberDisplay: session.numberDisplay,
          expiresAt: session.codeExpiresAt
        };
        session.lastResult = result;
        return result;
      } catch (error) {
        if (error?.code === 'ALREADY_PAIRED') throw error;
        if (error?.code === 'QUEUE_TIMEOUT' || error?.code === 'BUSY') {
          this.numberLocks.delete(number);
          this.sessions.delete(key);
          throw error;
        }
        const known = Boolean(error?.code);
        const failure = known
          ? error
          : pairingError('Pairing could not be completed.', 'PAIRING_FAILED', 502);
        if (!known) {
          this.log.error?.(`[telegram-pairing] Pairing ${session.numberDisplay} failed: ${error?.message || error}`);
        }
        if (!session.registered && session.status !== STATUS.RECONNECTING) {
          session.setStatus(STATUS.FAILED);
          await this.cleanupSession(session, { deleteCreds: !session.registered });
        }
        throw failure;
      } finally {
        session.request = undefined;
      }
    })();

    return session.request;
  }

  async numberPairedElsewhere(ownerId, number) {
    let ownerDirs = [];
    try {
      ownerDirs = await fs.readdir(this.root, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of ownerDirs) {
      if (!entry.isDirectory() || entry.name === ownerId || !/^\d{1,20}$/.test(entry.name)) continue;
      if (await pathExists(safeSessionDirectory(this.root, entry.name, number, 'creds.json'))) return true;
    }
    return false;
  }

  async restartRegisteredSession(session, providedState) {
    this.suspendSocket(session);
    session.reconnectAttempts = 0;
    session.setStatus(STATUS.CONNECTING);
    if (providedState) {
      await this.openSocket(session, providedState);
      return this.sessionSnapshot(session);
    }
    return this.connectRegistered(session);
  }

  async restartSession(ownerId, rawNumber) {
    this.ensureActive();
    const owner = normalizeTelegramId(ownerId);
    const number = normalizeWhatsAppNumber(rawNumber);
    let session = this.getSession(owner, number);
    if (!session) {
      const authDir = safeSessionDirectory(this.root, owner, number);
      const creds = await readJsonSafe(path.join(authDir, 'creds.json'));
      if (!creds?.registered) {
        throw pairingError('No paired session found for that number. Use /pair first.', 'NOT_FOUND', 404);
      }
      session = new PairingSession(owner, number, authDir);
      this.sessions.set(this.sessionKey(owner, number), session);
    }
    if (!session.registered) {
      const creds = await readJsonSafe(path.join(session.authDir, 'creds.json'));
      if (!creds?.registered) {
        throw pairingError('That number is not paired yet. Use /pair first.', 'NOT_PAIRED', 409);
      }
      session.registered = true;
    }
    const snapshot = await this.restartRegisteredSession(session);
    return snapshot;
  }

  async stopSession(ownerId, rawNumber) {
    this.ensureActive();
    const owner = normalizeTelegramId(ownerId);
    const number = normalizeWhatsAppNumber(rawNumber);
    const session = this.getSession(owner, number);
    if (!session) {
      throw pairingError('No session found for that number on this controller.', 'NOT_FOUND', 404);
    }
    if (session.status === STATUS.CONNECTED) {
      throw pairingError('This session is connected. Remove it from WhatsApp → Settings → Linked Devices first, then run /stop again.', 'CONNECTED', 409);
    }
    await this.cleanupSession(session, { deleteCreds: true });
    return this.sessionSnapshot(session);
  }

  statusOf(ownerId, rawNumber) {
    const owner = normalizeTelegramId(ownerId);
    const number = normalizeWhatsAppNumber(rawNumber);
    const session = this.getSession(owner, number);
    if (!session) throw pairingError('No session found for that number on this controller.', 'NOT_FOUND', 404);
    return this.sessionSnapshot(session);
  }

  async cleanupSession(session, { deleteCreds = false } = {}) {
    if (session.cleanupState === 'running' || session.cleanupState === 'done') return session.cleanupPromise;
    session.cleanupState = 'running';
    session.setStatus(STATUS.CLEANUP);
    session.cleanupPromise = (async () => {
      session.stopped = true;
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      session.reconnectTimer = undefined;
      if (session.expiryTimer) clearTimeout(session.expiryTimer);
      session.expiryTimer = undefined;
      session.closeExpected = true;
      try {
        session.socket?.ws?.close();
      } catch {
        /* best effort */
      }
      session.socket = undefined;
      this.releasePairingSlot(session);
      this.releaseSocketReservation(session);
      this.numberLocks.delete(session.number);
      this.sessions.delete(`${session.ownerId}:${session.number}`);
      if (deleteCreds) {
        try {
          await fs.rm(session.authDir, { recursive: true, force: true });
        } catch (error) {
          this.log.warn?.(`[telegram-pairing] Could not remove credentials for ${session.numberDisplay}: ${error.message}`);
        }
      }
      session.cleanupState = 'done';
      this.pumpPairingQueue();
    })();
    return session.cleanupPromise;
  }

  // --------------------------- persistence --------------------------------

  /**
   * Restores paired sessions after a bot restart: scans every controller's
   * directories, migrates the legacy single-session layout, removes stale
   * unpaired credentials, and reconnects registered sessions within the
   * socket budget. Sessions above the budget are recorded as OFFLINE and can
   * be revived with /restart.
   */
  async restore() {
    this.ensureActive();
    let ownerEntries = [];
    try {
      ownerEntries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const ownerEntry of ownerEntries) {
      if (!ownerEntry.isDirectory() || !/^\d{1,20}$/.test(ownerEntry.name)) continue;
      try {
        const ownerDir = safeSessionDirectory(this.root, ownerEntry.name);
        await this.migrateLegacySession(ownerDir, ownerEntry.name);
        let numberEntries = [];
        try {
          numberEntries = await fs.readdir(ownerDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const numberEntry of numberEntries) {
          if (!numberEntry.isDirectory() || !/^\d{7,15}$/.test(numberEntry.name)) continue;
          const numberDir = safeSessionDirectory(this.root, ownerEntry.name, numberEntry.name);
          try {
            const creds = await readJsonSafe(path.join(numberDir, 'creds.json'));
            if (!creds) {
              await fs.rm(numberDir, { recursive: true, force: true }).catch(() => {});
              continue;
            }
            if (!creds.registered) {
              await this.sweepStaleDir(numberDir);
              continue;
            }
            const existing = this.getSession(ownerEntry.name, numberEntry.name);
            if (existing && (existing.socket || existing.status === STATUS.CONNECTED)) continue;
            const session = existing || new PairingSession(ownerEntry.name, numberEntry.name, numberDir);
            session.registered = true;
            if (!existing) this.sessions.set(session.id, session);
            if (!this.canCreateSocket()) {
              session.setStatus(STATUS.OFFLINE);
              this.log.warn?.(`[telegram-pairing] ${session.numberDisplay} stays offline: the socket limit (${this.limits.maxActiveSockets}) is reached. Use /restart to bring it online later.`);
              continue;
            }
            session.setStatus(STATUS.CONNECTING);
            await this.connectRegistered(session).catch((error) => {
              this.log.error?.(`[telegram-pairing] Could not restore ${session.numberDisplay}: ${error.message}`);
              if (!session.socket) session.setStatus(STATUS.FAILED);
            });
          } catch (error) {
            this.log.warn?.(`[telegram-pairing] Skipping session ${ownerEntry.name}/${numberEntry.name} during restore: ${error.message}`);
          }
        }
      } catch (error) {
        this.log.warn?.(`[telegram-pairing] Could not restore sessions for controller ${ownerEntry.name}: ${error.message}`);
      }
    }
  }

  // Pre-multi-session layouts stored credentials directly below
  // telegram-pairings/<telegramId>/. The paired number is recovered from the
  // credentials and the files are moved into the per-number layout.
  async migrateLegacySession(ownerDir, ownerId) {
    const legacyCredsPath = path.join(ownerDir, 'creds.json');
    if (!await pathExists(legacyCredsPath)) return;
    const creds = await readJsonSafe(legacyCredsPath);
    if (!creds) {
      await fs.rm(ownerDir, { recursive: true, force: true }).catch(() => {});
      return;
    }
    const number = String(creds.me?.id || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!creds.registered || !/^\d{7,15}$/.test(number)) {
      this.log.warn?.(`[telegram-pairing] Legacy session for controller ${ownerId} could not be migrated automatically; leaving its data untouched.`);
      return;
    }
    const targetDir = safeSessionDirectory(this.root, ownerId, number);
    await fs.mkdir(targetDir, { recursive: true });
    for (const entry of await fs.readdir(ownerDir, { withFileTypes: true })) {
      if (entry.name === number) continue;
      await fs.rename(path.join(ownerDir, entry.name), path.join(targetDir, entry.name));
    }
    this.log.info?.(`[telegram-pairing] Migrated legacy session for controller ${ownerId} to ${number}.`);
  }

  async sweepStaleDir(dir) {
    try {
      const stats = await fs.stat(dir);
      if (Date.now() - stats.mtimeMs > this.limits.staleUnregisteredDirMs) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    } catch {
      /* already gone */
    }
  }

  sweepStaleSessions() {
    if (this.shutdownCalled) return;
    // Prune finished cooldowns.
    for (const [owner, at] of this.ownerCooldowns) {
      if (Date.now() - at > this.limits.ownerCooldownMs * 2) this.ownerCooldowns.delete(owner);
    }
    // Close sockets of expired pairing attempts that somehow survived.
    for (const session of [...this.sessions.values()]) {
      if (!session.registered && session.codeExpiresAt && session.codeExpiresAt < Date.now()) {
        session.setStatus(STATUS.EXPIRED);
        void this.cleanupSession(session, { deleteCreds: true });
      }
    }
  }

  async shutdown() {
    this.shutdownCalled = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const item of this.pairingQueue.splice(0)) {
      clearTimeout(item.timer);
      item.reject(pairingError('The pairing manager is shutting down.', 'SHUTDOWN', 503));
    }
    for (const session of [...this.sessions.values()]) {
      session.stopped = true;
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      if (session.expiryTimer) clearTimeout(session.expiryTimer);
      session.closeExpected = true;
      try {
        session.socket?.ws?.close();
      } catch {
        /* best effort */
      }
      session.socket = undefined;
    }
    this.sessions.clear();
    this.socketReservations = 0;
    this.numberLocks.clear();
  }
}

// Friendly lowercase state names for compatibility with the previous snapshot.
const STATUS_TO_STATE = Object.freeze({
  [STATUS.RECEIVED]: 'received',
  [STATUS.VALIDATING]: 'validating',
  [STATUS.NORMALIZING]: 'normalizing',
  [STATUS.LOCKING]: 'locking',
  [STATUS.INITIALIZING]: 'initializing',
  [STATUS.CONNECTING]: 'connecting',
  [STATUS.PAIRING_READY]: 'ready',
  [STATUS.CODE_GENERATED]: 'pairing',
  [STATUS.WAITING_FOR_LINK]: 'pairing',
  [STATUS.CONNECTED]: 'connected',
  [STATUS.RECONNECTING]: 'reconnecting',
  [STATUS.OFFLINE]: 'offline',
  [STATUS.FAILED]: 'failed',
  [STATUS.EXPIRED]: 'expired',
  [STATUS.LOGGED_OUT]: 'logged_out',
  [STATUS.CLEANUP]: 'cleanup'
});

module.exports = {
  DEFAULT_LIMITS,
  MAX_RECONNECT_ATTEMPTS,
  PairingSession,
  STATUS,
  TelegramPairingManager,
  classifyDisconnect,
  normalizeCustomPairingCode,
  safeSessionDirectory,
  waitForPairingReady
};
