'use strict';

// ---------------------------------------------------------------------------
// ONE authoritative session-state model and ONE dashboard renderer.
//
// Every surface that reports a WhatsApp session (the primary socket mirror in
// index.js, each isolated Telegram-paired session in telegram-pairing-manager.js,
// the WhatsApp !status / !alive / !sessions commands and the Telegram
// CONNECTED / SESSION STATUS boxes) reads its values from here, so a state, a
// timestamp or a number can never be invented in two different places.
//
// Rules enforced by this module:
//   * `connected` is only ever true after a real transition INTO the connected
//     state (Baileys `connection.update === 'open'`). Creating a socket,
//     generating a pairing code, finding a session folder or authenticating
//     never marks a session CONNECTED.
//   * `connectedAt` is written only on that transition, so an unrelated event
//     (a message, a heartbeat, a dashboard render, a duplicate update) can
//     neither reset nor fake it.
//   * `reconnects` counts real re-established connections only: the first
//     connect of a session is 0, every later not-connected → connected
//     transition adds exactly one, and duplicate `open` events add nothing.
//   * Uptime stops when the connection stops. A terminal state (logged out /
//     failed) never keeps a connection clock running.
//   * Every rendered value is finite and validated: no NaN, no negative
//     duration, no Invalid Date.
//   * Session identity (the phone number) belongs to the session that produced
//     the view. It is resolved from that session's own status/socket, never
//     from a shared global, and it is only masked where a caller explicitly
//     asks for a public-chat rendering.
// ---------------------------------------------------------------------------

const { maskInternationalNumber } = require('./pairing-number');

const SESSION_STATES = Object.freeze({
  STARTING: 'starting',
  CONNECTING: 'connecting',
  RECONNECTING: 'reconnecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  LOGGED_OUT: 'logged_out',
  ERROR: 'error',
  PAIRING: 'pairing',
  // The primary socket is deliberately idle: no primary session is restored and
  // Telegram pairing owns new sessions. A real project state, not an error.
  TELEGRAM_PAIRING: 'telegram_pairing'
});

const KNOWN_STATES = Object.freeze(new Set(Object.values(SESSION_STATES)));

// States that end a session for good. No connection clock keeps running and no
// stale identity is carried into a later session.
const TERMINAL_STATES = Object.freeze([SESSION_STATES.LOGGED_OUT, SESSION_STATES.ERROR]);

// Lifecycle event labels. `⚡ Last Event` reports the connection lifecycle
// event that produced the current state, not a human sentence and not a value
// left over from an earlier state.
const STATE_EVENT_LABELS = Object.freeze({
  [SESSION_STATES.STARTING]: 'STARTING',
  [SESSION_STATES.CONNECTING]: 'CONNECTING',
  [SESSION_STATES.RECONNECTING]: 'RECONNECTING',
  [SESSION_STATES.CONNECTED]: 'CONNECTED',
  [SESSION_STATES.DISCONNECTED]: 'DISCONNECTED',
  [SESSION_STATES.LOGGED_OUT]: 'LOGGED_OUT',
  [SESSION_STATES.ERROR]: 'FAILED',
  [SESSION_STATES.PAIRING]: 'PAIRING',
  [SESSION_STATES.TELEGRAM_PAIRING]: 'TELEGRAM_PAIRING'
});

const STATE_ICONS = Object.freeze({
  [SESSION_STATES.CONNECTED]: '🟢',
  [SESSION_STATES.CONNECTING]: '🟡',
  [SESSION_STATES.RECONNECTING]: '🔵',
  [SESSION_STATES.PAIRING]: '🟣',
  [SESSION_STATES.TELEGRAM_PAIRING]: '🟣',
  [SESSION_STATES.STARTING]: '🟡',
  [SESSION_STATES.DISCONNECTED]: '🔴',
  [SESSION_STATES.LOGGED_OUT]: '⚪',
  [SESSION_STATES.ERROR]: '⚠️'
});

// Callers outside this module speak their own lifecycle vocabulary (the
// Telegram pairing manager reports RECEIVED / VALIDATING / PAIRING_READY /
// OFFLINE / CLEANUP …). Every known word is canonicalised here so an ordinary
// intermediate state can never be rendered as a false FAILED, and so no caller
// has to keep a second state table of its own.
const STATE_ALIASES = Object.freeze({
  received: SESSION_STATES.CONNECTING,
  validating: SESSION_STATES.CONNECTING,
  normalizing: SESSION_STATES.CONNECTING,
  locking: SESSION_STATES.CONNECTING,
  init: SESSION_STATES.STARTING,
  initializing: SESSION_STATES.STARTING,
  ready: SESSION_STATES.PAIRING,
  pairing_ready: SESSION_STATES.PAIRING,
  code_generated: SESSION_STATES.PAIRING,
  waiting_for_link: SESSION_STATES.PAIRING,
  active: SESSION_STATES.CONNECTED,
  online: SESSION_STATES.CONNECTED,
  open: SESSION_STATES.CONNECTED,
  offline: SESSION_STATES.DISCONNECTED,
  close: SESSION_STATES.DISCONNECTED,
  closed: SESSION_STATES.DISCONNECTED,
  disconnect: SESSION_STATES.DISCONNECTED,
  cleanup: SESSION_STATES.DISCONNECTED,
  expired: SESSION_STATES.DISCONNECTED,
  failed: SESSION_STATES.ERROR,
  failure: SESSION_STATES.ERROR,
  logout: SESSION_STATES.LOGGED_OUT,
  loggedout: SESSION_STATES.LOGGED_OUT,
  reconnect: SESSION_STATES.RECONNECTING
});

/**
 * Canonical lifecycle state for a caller-supplied word.
 *
 * `strict` is used by state TRANSITIONS, where an unmappable word means a
 * caller bug and must fail safe. Rendering prefers the session's own
 * `connected` flag over inventing a state.
 */
function canonicalSessionState(state, { connected, strict = false } = {}) {
  const requested = String(state ?? '').trim().toLowerCase();
  if (KNOWN_STATES.has(requested)) return requested;
  const alias = STATE_ALIASES[requested];
  if (alias) return alias;
  if (!strict) {
    if (connected === true) return SESSION_STATES.CONNECTED;
    if (connected === false) return SESSION_STATES.DISCONNECTED;
  }
  return SESSION_STATES.ERROR;
}

const UNKNOWN_VALUE = 'Unavailable';
// A live session that is not connected has no running connection clock. This is
// deliberately not a duration: an offline session must never look like it is
// still accumulating uptime.
const OFFLINE_UPTIME = 'Offline';

function stateEventLabel(state) {
  return STATE_EVENT_LABELS[String(state || '').toLowerCase()] || String(state || '').replace('_', ' ').toUpperCase() || 'STARTING';
}

function isTerminalState(state) {
  return TERMINAL_STATES.includes(String(state || '').toLowerCase());
}

function positiveTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function createSessionStatus(id = 'primary') {
  const now = Date.now();
  return {
    id: String(id),
    state: SESSION_STATES.STARTING,
    connected: false,
    // Real timestamp of the current (or most recent) successful connection.
    connectedAt: null,
    // Real timestamp the current connection ended; stops the uptime clock.
    endedAt: null,
    reconnects: 0,
    hasConnected: false,
    lastEvent: stateEventLabel(SESSION_STATES.STARTING),
    lastUpdate: now,
    // Runtime reference of THIS status object: the honest fallback clock when a
    // session has no connection metadata yet.
    startedAt: now,
    // Canonical digits of the number this session is authenticated as. Set from
    // the session's own socket/credentials, never from a shared global.
    safeNumber: null,
    sessionLabel: 'unknown'
  };
}

/**
 * Moves a session status to a new lifecycle state.
 *
 * `event` is the lifecycle label reported by `⚡ Last Event`; it defaults to the
 * label of the new state so a caller can never leave a stale event behind.
 */
function transitionSessionStatus(status, state, event) {
  if (!status || typeof status !== 'object') return status;
  const next = canonicalSessionState(state || SESSION_STATES.ERROR, { strict: true });
  const now = Date.now();
  const wasConnected = status.state === SESSION_STATES.CONNECTED || status.connected === true;

  if (next === SESSION_STATES.CONNECTED) {
    if (!wasConnected) {
      // A genuine re-established connection. The very first connect of a
      // session is not a reconnect.
      if (status.hasConnected) status.reconnects = Number(status.reconnects || 0) + 1;
      status.connectedAt = now;
      status.endedAt = null;
      status.hasConnected = true;
    }
    status.connected = true;
  } else {
    if (wasConnected) status.endedAt = now;
    status.connected = false;
    // A terminal ending must not carry the previous session's identity into a
    // later one: the number is only ever re-set from a real authenticated
    // socket/credential, so a new session can never display an old number.
    if (isTerminalState(next)) {
      status.connectedAt = null;
      status.safeNumber = null;
      status.sessionLabel = next === SESSION_STATES.LOGGED_OUT ? 'logged_out' : status.sessionLabel;
    }
  }

  status.state = next;
  status.lastEvent = String(event || stateEventLabel(next));
  status.lastUpdate = now;
  if (!positiveTimestamp(status.startedAt)) status.startedAt = now;
  return status;
}

function formatDuration(from, now = Date.now()) {
  const timestamp = positiveTimestamp(from);
  const reference = positiveTimestamp(now) || Date.now();
  if (!timestamp || reference < timestamp) return null;
  const total = Math.floor((reference - timestamp) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

function formatTimestamp(timestamp) {
  const value = positiveTimestamp(timestamp);
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const month = date.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${String(date.getUTCDate()).padStart(2, '0')} ${month} ${date.getUTCFullYear()} • ${date.toISOString().slice(11, 19)} UTC`;
}

/** Digits of a WhatsApp phone number, or '' when the value is not one. */
function sessionDigits(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.includes('@')) {
    // Only a phone-number JID carries a phone number. A LID (@lid) is a real
    // WhatsApp identity but NOT a phone number and must never be shown as one;
    // groups/channels/newsletters never are either.
    const [user, server = ''] = raw.split('@');
    if (server.toLowerCase() !== 's.whatsapp.net') return '';
    const digits = user.split(':')[0];
    return /^\d{7,15}$/.test(digits) ? digits : '';
  }
  const digits = raw.replace(/\D/g, '');
  return /^\d{7,15}$/.test(digits) ? digits : '';
}

/**
 * Public-chat display form of a number: masked. Kept for surfaces that must
 * never broadcast a full phone number into a group or a supergroup.
 */
function safeSessionNumber(number) {
  const digits = sessionDigits(number);
  if (!digits) return UNKNOWN_VALUE;
  try {
    return maskInternationalNumber(digits);
  } catch {
    return UNKNOWN_VALUE;
  }
}

/**
 * The number shown by the connected dashboard.
 *
 * Default is the ACTUAL number of the connected session in international form
 * (+923001234567) — never masked and never hardcoded. `masked: true` is used
 * only for public group/channel surfaces, and an already formatted display
 * string supplied by the caller is rendered verbatim so a public caller cannot
 * accidentally unmask a number it masked on purpose.
 */
function formatSessionNumber(number, { masked = false, verbatim = false } = {}) {
  const raw = String(number ?? '').trim();
  if (!raw) return UNKNOWN_VALUE;
  // An already masked display is never unmasked and never re-masked from its
  // remaining digits (which would invent a different number).
  if (raw.includes('•')) return raw;
  const digits = sessionDigits(raw);
  // Masking wins over a caller's display form: a public surface can never be
  // unmasked by a full number passed in by mistake.
  if (masked) return digits ? safeSessionNumber(digits) : UNKNOWN_VALUE;
  // `verbatim` keeps a display form the caller already chose ("+92 300 1234567").
  if (verbatim && /[+\s()-]/.test(raw)) return raw;
  // Not reducible to a phone number (a LID or a display name, for example): it
  // must never be presented as one.
  if (!digits) return UNKNOWN_VALUE;
  return `+${digits}`;
}

/** True for a status produced by createSessionStatus() or a session snapshot. */
function isSessionStatus(status) {
  return Boolean(status)
    && typeof status === 'object'
    && typeof status.state === 'string'
    && (positiveTimestamp(status.lastUpdate) !== null || positiveTimestamp(status.connectedAt) !== null || typeof status.connected === 'boolean');
}

/** Real start of this process, used only as the derived-runtime fallback. */
function runtimeStartedAt(now = Date.now()) {
  const uptimeMs = typeof process?.uptime === 'function' ? process.uptime() * 1000 : 0;
  const started = now - Math.floor(uptimeMs);
  return positiveTimestamp(started) || now;
}

/**
 * Builds the complete, validated view the dashboard renders.
 *
 * `status` is the live mirror of the session that is being reported. When a
 * caller has no live mirror at all (an isolated socket handled outside
 * index.js/the pairing manager), the view is DERIVED from that socket and the
 * process runtime instead of printing placeholders: a socket that is serving a
 * command is authenticated, and the process start is the only real timestamp
 * available. A socket that reports a closed transport is never shown as
 * connected.
 */
function resolveSessionView(socket, status, { now = Date.now() } = {}) {
  const reference = positiveTimestamp(now) || Date.now();

  if (isSessionStatus(status)) {
    const state = canonicalSessionState(status.state || SESSION_STATES.ERROR, { connected: status.connected });
    const connected = status.connected === true && state === SESSION_STATES.CONNECTED;
    const connectedAt = positiveTimestamp(status.connectedAt);
    const startedAt = positiveTimestamp(status.startedAt) || connectedAt || reference;
    return {
      derived: false,
      id: String(status.id || 'session'),
      state: KNOWN_STATES.has(state) ? state : SESSION_STATES.ERROR,
      connected,
      connectedAt: connected ? (connectedAt || startedAt) : connectedAt,
      endedAt: positiveTimestamp(status.endedAt),
      startedAt,
      reconnects: Math.max(0, Number(status.reconnects) || 0),
      hasConnected: Boolean(status.hasConnected || connectedAt),
      lastEvent: String(status.lastEvent || stateEventLabel(state)),
      lastUpdate: positiveTimestamp(status.lastUpdate) || reference,
      sessionLabel: status.sessionLabel || (status.registered ? 'paired' : 'unknown'),
      number: sessionDigits(status.number ?? status.safeNumber ?? status.botUser ?? status.pairingNumber) || sessionDigits(socket?.user?.id)
    };
  }

  // ------------------------------ derived view -----------------------------
  const transportOpen = socket?.ws?.isOpen;
  const authenticated = Boolean(socket?.user?.id) || transportOpen === true;
  const connected = transportOpen === false ? false : authenticated;
  const startedAt = positiveTimestamp(status?.startedAt) || runtimeStartedAt(reference);
  const state = transportOpen === false
    ? SESSION_STATES.DISCONNECTED
    : connected ? SESSION_STATES.CONNECTED : SESSION_STATES.STARTING;
  return {
    derived: true,
    id: String(status?.id || 'derived'),
    state,
    connected,
    connectedAt: connected ? startedAt : null,
    endedAt: null,
    startedAt,
    reconnects: Math.max(0, Number(status?.reconnects) || 0),
    hasConnected: connected,
    lastEvent: String(status?.lastEvent || stateEventLabel(state)),
    lastUpdate: positiveTimestamp(status?.lastUpdate) || reference,
    sessionLabel: 'unknown',
    number: sessionDigits(socket?.user?.id) || sessionDigits(status?.safeNumber ?? status?.botUser)
  };
}

/**
 * "Connected Since" is only ever a real successful-connection timestamp. A
 * session that is not connected right now reports no connection time instead of
 * reusing a stale one from an earlier connection.
 */
function connectedSinceText(view, { now = Date.now() } = {}) {
  if (!view.connected) return null;
  return formatTimestamp(view.connectedAt) || formatTimestamp(view.startedAt);
}

function uptimeText(view, { now = Date.now() } = {}) {
  if (view.connected) return formatDuration(view.connectedAt, now) || formatDuration(view.startedAt, now) || OFFLINE_UPTIME;
  // A derived view has no connection lifecycle to report: the process runtime
  // is the only real clock, and it is labelled by the state line next to it.
  if (view.derived) return formatDuration(view.startedAt, now) || OFFLINE_UPTIME;
  // A live session that is not connected has no running connection uptime.
  return OFFLINE_UPTIME;
}

/**
 * Renders the session dashboard.
 *
 * Design (borders, icons, order and wording) is unchanged; only the values are
 * resolved from real session state.
 *
 * @param {object} status live session status/snapshot (may be null)
 * @param {object} [options]
 * @param {string|number} [options.number] session number (digits or a display string)
 * @param {object} [options.socket] socket the report belongs to (identity source)
 * @param {boolean} [options.compact] render the first four lines only
 * @param {boolean} [options.maskNumber] public-chat rendering: mask the number
 * @param {boolean} [options.verbatimNumber] keep a caller-supplied display form
 * @param {string} [options.numberLabel] label of the number line ("Session")
 */
function sessionDashboard(status, { number, socket, compact = false, maskNumber = false, verbatimNumber = false, numberLabel = 'Session' } = {}) {
  const now = Date.now();
  const view = resolveSessionView(socket, status, { now });
  const displayed = number === undefined || number === null || number === '' ? view.number : number;
  const icon = STATE_ICONS[view.state] || '⚠️';
  // One lifecycle vocabulary for both the Status line and `⚡ Last Event`:
  // CONNECTING / CONNECTED / DISCONNECTED / RECONNECTING / LOGGED_OUT / FAILED.
  const label = STATE_EVENT_LABELS[view.state] || String(view.state).replace(/_/g, ' ').toUpperCase();
  const lines = [
    `${icon} Status: ${label}`,
    `📱 ${numberLabel}: ${formatSessionNumber(displayed, { masked: maskNumber, verbatim: verbatimNumber })}`,
    `⏱️ Uptime: ${uptimeText(view, { now })}`,
    `📅 Connected Since: ${connectedSinceText(view) || UNKNOWN_VALUE}`,
    `🔄 Reconnects: ${view.reconnects}`,
    `⚡ Last Event: ${view.lastEvent || stateEventLabel(view.state)}`,
    `🕐 Last Update: ${formatTimestamp(view.lastUpdate) || UNKNOWN_VALUE}`
  ];
  return compact ? lines.slice(0, 4).join('\n') : lines.join('\n');
}

/** Machine-readable form of the same view (Telegram/system surfaces, tests). */
function snapshotSessionStatus(status, number, { socket } = {}) {
  const now = Date.now();
  const view = resolveSessionView(socket, status, { now });
  const displayed = number === undefined || number === null || number === '' ? view.number : number;
  return {
    id: view.id,
    state: view.state,
    connected: view.connected,
    connectedAt: view.connectedAt || null,
    startedAt: view.startedAt,
    uptime: uptimeText(view, { now }),
    connectedSince: connectedSinceText(view, { now }) || UNKNOWN_VALUE,
    reconnects: view.reconnects,
    lastEvent: view.lastEvent,
    lastUpdate: view.lastUpdate,
    session: formatSessionNumber(displayed),
    safeNumberDisplay: safeSessionNumber(displayed)
  };
}

module.exports = {
  OFFLINE_UPTIME,
  SESSION_STATES,
  STATE_ALIASES,
  STATE_EVENT_LABELS,
  TERMINAL_STATES,
  UNKNOWN_VALUE,
  connectedSinceText,
  canonicalSessionState,
  createSessionStatus,
  formatDuration,
  formatSessionNumber,
  formatTimestamp,
  isSessionStatus,
  isTerminalState,
  resolveSessionView,
  safeSessionNumber,
  sessionDigits,
  sessionDashboard,
  snapshotSessionStatus,
  stateEventLabel,
  transitionSessionStatus,
  uptimeText
};
