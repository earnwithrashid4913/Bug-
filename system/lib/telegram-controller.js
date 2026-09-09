'use strict';

// A small Telegram Bot API client used for remote *control* of the WhatsApp
// pairing system. It deliberately has no WhatsApp implementation of its own:
// the TelegramPairingManager owns every socket and session.
//
// All user-facing text uses the ANIME MD box style. Raw technical errors stay
// in the internal log; Telegram users only ever see friendly messages.
//
// Access levels (checked server-side on EVERY command and callback):
//   bootstrap — telegram.ownerIds from config.js. Full control, may manage
//               every session and change settings.
//   controller— added at runtime with /addowner. Manages only own sessions.
//   public    — when public pairing is enabled, any Telegram user may pair
//               and manage their OWN sessions. Never anyone else's.
//
// Interactive surface: a dashboard with inline buttons, a guided pairing flow,
// per-session management, and a settings page. Every button has a real
// handler; ownership is always re-resolved through the pairing manager.

const TELEGRAM_API = 'https://api.telegram.org';
const POLL_TIMEOUT_SECONDS = 25;
const SENSITIVE_COOLDOWN_MS = 20_000;
const SENSITIVE_LOCK_TTL_MS = 2 * 60_000;
const PENDING_NUMBER_TTL_MS = 5 * 60_000;
const MAX_SESSION_BUTTONS = 8;

const { formatInternationalNumber, normalizeWhatsAppNumber } = require('./pairing-number');

// Telegram treats Markdown parsing errors as a failed API request. Keep all
// controller output in HTML and escape untrusted values at the boundary.
function escapeTelegramHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function normalizeTelegramId(value) {
  const id = String(value ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('Telegram IDs must be numeric.');
  return id;
}

function commandFromUpdate(update) {
  const message = update?.message;
  const text = message?.text?.trim();
  if (!text?.startsWith('/')) return undefined;
  const [token, ...args] = text.split(/\s+/);
  const name = token.slice(1).split('@')[0].toLowerCase();
  return { chatId: message.chat?.id, senderId: message.from?.id, name, args, text: args.join(' ') };
}

// ---------------------------------------------------------------------------
// ANIME MD box rendering.
// ---------------------------------------------------------------------------

function box(title, lines) {
  const body = lines.map((line) => (line ? `┃ ${line}` : '┃')).join('\n');
  return `╭━━〔 ${title} 〕━╮\n${body}\n╰${'━'.repeat(24)}╯`;
}

const CODE_SOURCE_LABEL = 'WhatsApp-generated';

// The ANIME MD intro. Gojo-style, no server-dashboard jargon. It never claims
// a WhatsApp connection: the connected notification is a separate, real event.
function startupBox() {
  return [
    '╰┈➤ ⚡ 𝘼𝙉𝙄𝙀 𝙈',
    '',
    '𝙂𝙊𝙊 𝙄 𝙃𝙀𝙍𝙀.',
    '🟢 𝙎𝙔𝙎𝙀𝙈 𝘼𝘿𝙔',
    '',
    "𝙒𝙝𝙖𝙩' 𝙣𝙚𝙭𝙩? 𝙔𝙤 𝙘𝙝𝙤𝙤𝙚. 👇"
  ].join('\n');
}

function pairingStartedBox(numberDisplay) {
  return box('ANIME MD • PAIRING', [
    '',
    `📱 Number: ${numberDisplay}`,
    '⏳ Preparing WhatsApp pairing...',
    '',
    'Please wait.'
  ]);
}

function codeReadyBox({ displayCode, numberDisplay, expiresAt }, { ttlMinutes = 5 } = {}) {
  const minutes = Number.isFinite(expiresAt)
    ? Math.max(1, Math.ceil((expiresAt - Date.now()) / 60_000))
    : ttlMinutes;
  return box('ANIME MD • PAIRING CODE', [
    '',
    '✅ Pairing Code Ready',
    '',
    `🔐 CODE: ${displayCode}`,
    `📱 Number: ${numberDisplay}`,
    `⏳ Valid: about ${minutes} minute${minutes === 1 ? '' : 's'}`,
    '',
    'WhatsApp → Linked Devices →',
    'Link a Device →',
    'Link with phone number',
    '',
    `This code was issued by WhatsApp itself and is valid once.`
  ]);
}

function guideBox() {
  return box('ANIME MD • PAIRING GUIDE', [
    '',
    '📱 How to pair your WhatsApp',
    '',
    '1. Tap 🔗 Pair WhatsApp, or send',
    '   /pair <your number>',
    '2. Wait — your pairing code',
    '   arrives here as a message',
    '3. Open WhatsApp → Settings →',
    '   Linked Devices',
    '4. Tap "Link a Device"',
    '5. Tap "Link with phone number"',
    '6. Enter the code',
    '7. Wait for ✅ WhatsApp Connected',
    '',
    '── Roman Urdu ──',
    '',
    '1. 🔗 Pair WhatsApp par tap karein',
    '   ya /pair <number> bhejein',
    '2. Pairing code ka intezar karein',
    '3. WhatsApp khol kar Settings →',
    '   Linked Devices par jayein',
    '4. "Link a Device" par tap karein',
    '5. "Link with phone number" chunein',
    '6. Code daal kar confirm karein',
    '7. ✅ WhatsApp Connected ka',
    '   intezar karein',
    '',
    'Number format: country code +',
    'number, without + (923001234567).'
  ]);
}

function connectedBox(numberDisplay) {
  return box('ANIME MD • CONNECTED', [
    '',
    '✅ WhatsApp Connected',
    '',
    `📱 ${numberDisplay}`,
    '',
    '🟢 Session: ACTIVE',
    '',
    'Your ANIME MD session is ready.',
    '',
    'Roman Urdu: Aapka WhatsApp connect',
    'ho gaya hai — session active hai.'
  ]);
}

function pairingFailedBox(reasonLines, { retry = true } = {}) {
  return box('ANIME MD • PAIRING FAILED', [
    '',
    '❌ Pairing could not be completed.',
    '',
    ...reasonLines,
    ...(retry ? ['', 'Please try /pair again.'] : [])
  ]);
}

function stoppedBox(numberDisplay) {
  return box('ANIME MD • SESSION REMOVED', [
    '',
    `📱 ${numberDisplay}`,
    '',
    '🧹 Session stopped and its credentials removed.',
    '',
    'Pair again anytime with /pair.'
  ]);
}

function channelsBox(channels) {
  const lines = ['', '❌ These channels must be joined first:', ''];
  for (const channel of channels) lines.push(`🚀 ${channel.name}: ${channel.chatId}`);
  lines.push('', 'Join karein, phir /pair <number> dobara bhejein.');
  return box('ANIME MD • JOIN REQUIRED', lines);
}

function premiumRequiredBox() {
  return box('ANIME MD • PREMIUM', [
    '',
    '💎 Pairing is currently limited to',
    'premium users.',
    '',
    'Contact the bot owner to get premium access.'
  ]);
}

function myIdBox({ id, premium, owner }) {
  return box('ANIME MD • MY ID', [
    '',
    `👤 Telegram ID: ${id}`,
    `💎 Premium: ${premium ? 'Active ✅' : 'Inactive ❌'}`,
    `👑 Owner: ${owner ? 'Yes ✅' : 'No ❌'}`,
    '',
    'Use this ID if the owner adds you as',
    'a controller or premium user.'
  ]);
}

function premiumBox({ id, expiresAt, active }) {
  const lines = [
    '',
    `👤 User: ${id}`,
    `💎 Premium: ${active ? 'Active ✅' : 'Inactive ❌'}`
  ];
  if (active && Number.isFinite(expiresAt)) {
    lines.push(`⏳ Expires: ${new Date(expiresAt).toISOString().slice(0, 10)}`);
  }
  if (!active) lines.push('', 'Premium lene ke liye owner se rabta karein.');
  return box('ANIME MD • PREMIUM', lines);
}

// Session states shown to users. CONNECTED is only ever reported after the
// WhatsApp socket actually reached connection open.
const SESSION_STATE_BADGES = Object.freeze({
  CONNECTED: '🟢 CONNECTED',
  PAIRING_READY: '🟡 PAIRING',
  CODE_GENERATED: '🟡 PAIRING',
  WAITING_FOR_LINK: '🟡 PAIRING',
  CONNECTING: '🔵 CONNECTING',
  INITIALIZING: '🔵 CONNECTING',
  LOCKING: '🔵 CONNECTING',
  VALIDATING: '🔵 CONNECTING',
  NORMALIZING: '🔵 CONNECTING',
  RECEIVED: '🔵 CONNECTING',
  RECONNECTING: '🟠 RECONNECTING',
  OFFLINE: '🔴 OFFLINE',
  FAILED: '⚠️ FAILED',
  EXPIRED: '⚠️ FAILED',
  LOGGED_OUT: '⚠️ FAILED',
  CLEANUP: '⚠️ FAILED'
});

function stateBadge(status) {
  return SESSION_STATE_BADGES[status] || `⚠️ ${status}`;
}

function badgeParts(status) {
  const badge = stateBadge(status);
  const space = badge.indexOf(' ');
  return space === -1 ? { icon: badge, label: '' } : { icon: badge.slice(0, space), label: badge.slice(space + 1) };
}

function sessionsBox(sessions) {
  if (!sessions.length) {
    return box('ANIME MD • SESSIONS', [
      '',
      '📭 No sessions yet.',
      '',
      'Use /pair <number> to pair a WhatsApp number.'
    ]);
  }
  const lines = sessions.map((session) => {
    const { icon, label } = badgeParts(session.status);
    return `${icon} ${session.numberDisplay} — ${label || session.status}`;
  });
  return box('ANIME MD • SESSIONS', [
    '',
    ...lines,
    '',
    `Total: ${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
    '',
    'Tap a session below to manage it.'
  ]);
}

function statusBox(session, { ownerId } = {}) {
  const { icon, label } = badgeParts(session.status);
  const lines = [
    '',
    `📱 Number: ${session.numberDisplay}`,
    `${icon} Status: ${label || session.status}`,
    `🔗 Paired: ${session.registered ? 'yes' : 'no'}`,
    `🔄 Reconnects: ${session.reconnects}`
  ];
  if (ownerId) lines.push(`👤 Owner: ${ownerId}`);
  lines.push('', 'Your ANIME MD session.');
  return box('ANIME MD • SESSION STATUS', lines);
}

function overallStatusBox(sessions, controllerUptimeSeconds) {
  const lines = [
    '',
    `🤖 Controller: Online (${Math.floor(controllerUptimeSeconds / 60)}m uptime)`,
    `📱 WhatsApp sessions: ${sessions.length}`
  ];
  if (sessions.length) {
    lines.push('', ...sessions.map((session) => {
      const { icon, label } = badgeParts(session.status);
      return `${icon} ${session.numberDisplay} — ${label || session.status}`;
    }));
  } else {
    lines.push('', 'No WhatsApp sessions yet.', 'Telegram online ≠ WhatsApp connected.', 'Use /pair <number> to pair.');
  }
  return box('ANIME MD • STATUS', lines);
}

function settingsBox({ id, premium, owner, sessionsUsed, sessionLimit, publicMode, premiumOnly, brand, controllers, premiumUsers }) {
  if (owner) {
    return box('ANIME MD • SETTINGS', [
      '',
      '👑 Master Control',
      `🤖 Controllers: ${controllers}`,
      `💎 Premium users: ${premiumUsers}`,
      `🌍 Public pairing: ${publicMode ? 'ON 🌍' : 'OFF 🔒'}`,
      `💎 Premium-only pairing: ${premiumOnly ? 'ON 🔒' : 'OFF 🌍'}`,
      `🔐 Pairing code: ${brand || 'WhatsApp-generated'}`,
      '',
      'Toggle with the buttons below.'
    ]);
  }
  return box('ANIME MD • SETTINGS', [
    '',
    `👤 User: ${id}`,
    `💎 Premium: ${premium ? 'Active ✅' : 'Inactive ❌'}`,
    `📱 Sessions: ${sessionsUsed}/${sessionLimit}`,
    `🌍 Public pairing: ${publicMode ? 'ON 🌍' : 'OFF 🔒'}`,
    `💎 Premium-only pairing: ${premiumOnly ? 'ON 🔒' : 'OFF 🌍'}`
  ]);
}

// Map stable pairing error codes to friendly user-facing reasons. Unknown
// errors never leak their raw text to Telegram.
const PAIRING_ERROR_TEXTS = Object.freeze({
  INVALID_NUMBER: { lines: ['The number format is invalid.', 'Use the full international number with', 'country code, without + (example: 923001234567).'], retry: true },
  ALREADY_PAIRED: { lines: ['This number is already paired on this controller.', 'Use /status <number> or /restart <number>.'], retry: false },
  LOCKED: { lines: ['This number already has an active pairing', 'or session on another controller.'], retry: false },
  BUSY: { lines: ['The pairing system is busy right now.'], retry: true },
  QUEUE_TIMEOUT: { lines: ['The pairing system is busy right now.'], retry: true },
  COOLDOWN: { lines: ['You are starting pairings too quickly.'], retry: true },
  LIMIT: { lines: ['The session limit for this controller is reached.', 'Stop an unused session with /stop first.'], retry: false },
  PAIRING_TIMEOUT: { lines: ['WhatsApp did not become ready for pairing in time.', 'This is usually a network issue — try again.'], retry: true },
  CONNECTION_CLOSED: { lines: ['WhatsApp closed the connection before', 'pairing was completed.'], retry: true },
  NOT_FOUND: { lines: ['No session found for that number', 'on this controller.'], retry: false },
  NOT_PAIRED: { lines: ['That number is not paired yet.', 'Use /pair first.'], retry: false },
  CONNECTED: { lines: ['This session is connected.', 'Remove it from WhatsApp → Linked Devices first, then /stop again.'], retry: false },
  SHUTDOWN: { lines: ['The pairing system is restarting. Please try again shortly.'], retry: true },
  CANCELLED: { lines: ['The pairing request was cancelled.'], retry: true }
});

function friendlyPairingError(error) {
  const mapped = error?.code ? PAIRING_ERROR_TEXTS[error.code] : undefined;
  if (mapped) return { lines: mapped.lines, retry: mapped.retry };
  return { lines: ['An unexpected error occurred while pairing.'], retry: true };
}

function helpText() {
  return [
    '╭━━〔 ANIME MD • HELP 〕━╮',
    '┃',
    '┃ /pair <number> — pair a WhatsApp number',
    '┃ /sessions — list your WhatsApp sessions',
    '┃ /status [number] — session status',
    '┃ /stop <number> — remove an unpaired session',
    '┃ /restart <number> — bring a paired session back online',
    '┃ /guide — pairing guide (English + Roman Urdu)',
    '┃ /settings — your settings and limits',
    '┃ /myid — show your Telegram ID',
    '┃ /premium — premium status',
    '┃ /addowner <telegram_id> — authorize a controller',
    '┃ /delowner <telegram_id> — remove a controller',
    '┃ /addprem <id> [30d] — grant premium (owner)',
    '┃ /delprem <id> — revoke premium (owner)',
    '┃ /listpaired — all sessions (owner)',
    '┃ /help — show this help',
    '┃',
    '┃ Aliases: /delpair = /stop,',
    '┃ /listsessions = /sessions',
    '┃',
    '┃ Number format: country code + number,',
    '┃ no + required (example: 923001234567).',
    '╰' + '━'.repeat(23) + '╯'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Inline keyboards. Every button below has a handler in handleCallback().
// ---------------------------------------------------------------------------

function homeMarkup() {
  return { inline_keyboard: [[
    { text: '🔗 Pair WhatsApp', callback_data: 'pair:new' },
    { text: '📱 My Sessions', callback_data: 'nav:sessions' }
  ], [
    { text: '📊 Status', callback_data: 'nav:status' },
    { text: '📖 Pairing Guide', callback_data: 'nav:guide' }
  ], [
    { text: '⚙️ Settings', callback_data: 'nav:settings' },
    { text: '❓ Help', callback_data: 'nav:help' }
  ]] };
}

// Backward-compatible export name for the dashboard keyboard.
const menuMarkup = homeMarkup;

function guideMarkup() {
  return { inline_keyboard: [[
    { text: '🔗 Pair WhatsApp', callback_data: 'pair:new' }
  ], [
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

function sessionsMarkup(sessions) {
  const rows = sessions.slice(0, MAX_SESSION_BUTTONS).map((session) => [{
    text: `📱 ${session.numberDisplay}`,
    callback_data: `ses:menu:${session.number}`
  }]);
  rows.push([
    { text: '🔄 Refresh', callback_data: 'nav:sessions' },
    { text: '🏠 Home', callback_data: 'home' }
  ]);
  return { inline_keyboard: rows };
}

function sessionMenuMarkup(number) {
  return { inline_keyboard: [[
    { text: '🔄 Restart', callback_data: `ses:restart:${number}` },
    { text: '🗑 Remove', callback_data: `ses:stop:${number}` }
  ], [
    { text: '⬅️ Back', callback_data: 'nav:sessions' },
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

function stopConfirmMarkup(number) {
  return { inline_keyboard: [[
    { text: '🗑 Yes, remove it', callback_data: `ses:stopok:${number}` },
    { text: '❌ Cancel', callback_data: `ses:menu:${number}` }
  ]] };
}

function connectedMarkup() {
  return { inline_keyboard: [[
    { text: '📱 My Sessions', callback_data: 'nav:sessions' },
    { text: '📊 Status', callback_data: 'nav:status' }
  ]] };
}

function retryMarkup() {
  return { inline_keyboard: [[
    { text: '🔄 Try Again', callback_data: 'pair:new' },
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

function pairAgainMarkup() {
  return { inline_keyboard: [[
    { text: '🔗 Pair Again', callback_data: 'pair:new' },
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

function backHomeMarkup() {
  return { inline_keyboard: [[
    { text: '⬅️ Back', callback_data: 'nav:sessions' },
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

function homeOnlyMarkup() {
  return { inline_keyboard: [[{ text: '🏠 Home', callback_data: 'home' }]] };
}

function settingsMarkup({ owner, publicMode, premiumOnly }) {
  if (!owner) return { inline_keyboard: [[{ text: '🏠 Home', callback_data: 'home' }]] };
  return { inline_keyboard: [[
    { text: publicMode ? '🔒 Public OFF' : '🌍 Public ON', callback_data: `set:public:${publicMode ? 'off' : 'on'}` },
    { text: premiumOnly ? '💎 Premium OFF' : '💎 Premium ON', callback_data: `set:prem:${premiumOnly ? 'off' : 'on'}` }
  ], [
    { text: '🔄 Refresh', callback_data: 'nav:settings' },
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

const BOOTSTRAP_COMMANDS = new Set(['addowner', 'delowner', 'addprem', 'delprem', 'listpaired']);

class TelegramController {
  constructor({
    token, owners = [], controllerStore, pairing, startImage = '', connectedImage = '',
    publicMode = false, premiumOnly = false, requiredChannels = [], sessionLimit = 5, codeSource = '',
    fetchImpl = globalThis.fetch, log = console
  }) {
    this.token = token;
    this.bootstrapOwners = new Set(owners.map(normalizeTelegramId));
    this.controllerStore = controllerStore;
    this.pairing = pairing;
    this.startImage = startImage;
    this.connectedImage = connectedImage;
    this.publicMode = Boolean(publicMode);
    this.premiumOnly = Boolean(premiumOnly);
    this.requiredChannels = requiredChannels
      .filter((channel) => channel && String(channel.chatId || '').trim())
      .map((channel) => ({ name: String(channel.name || 'Channel').slice(0, 60), chatId: String(channel.chatId).trim() }));
    this.sessionLimit = Number.isSafeInteger(sessionLimit) && sessionLimit > 0 ? sessionLimit : 5;
    this.codeSource = String(codeSource || '');
    this.fetch = fetchImpl;
    this.log = log;
    this.offset = 0;
    this.running = false;
    this.startedAt = undefined;
    this.bot = undefined;
    this.pollPromise = undefined;
    this.settingsLoaded = false;
    this.sensitiveRequests = new Map();
    this.sensitiveLocks = new Map();
    this.pendingPairNumbers = new Map();
  }

  // ------------------------------ access ----------------------------------

  async loadSettings() {
    if (this.settingsLoaded) return;
    this.settingsLoaded = true;
    if (typeof this.controllerStore?.getSettings !== 'function') return;
    try {
      const persisted = await this.controllerStore.getSettings();
      if (typeof persisted?.publicMode === 'boolean') this.publicMode = persisted.publicMode;
      if (typeof persisted?.premiumOnly === 'boolean') this.premiumOnly = persisted.premiumOnly;
    } catch (error) {
      this.log.warn?.(`[telegram] Could not load persisted settings: ${error.message}`);
    }
  }

  async persistSetting(key, value) {
    this[key] = Boolean(value);
    if (typeof this.controllerStore?.setSetting !== 'function') return;
    try {
      await this.controllerStore.setSetting(key, Boolean(value));
    } catch (error) {
      this.log.warn?.(`[telegram] Could not persist the ${key} setting: ${error.message}`);
    }
  }

  isBootstrapOwner(id) {
    return this.bootstrapOwners.has(normalizeTelegramId(id));
  }

  async authorized(id) {
    const normalized = normalizeTelegramId(id);
    return this.bootstrapOwners.has(normalized) || await this.controllerStore.has(normalized);
  }

  // bootstrap > controller > public > none
  async accessOf(id) {
    await this.loadSettings();
    if (this.isBootstrapOwner(id)) return 'bootstrap';
    if (await this.authorized(id)) return 'controller';
    if (this.publicMode) return 'public';
    return 'none';
  }

  async premiumStatusOf(id) {
    const normalized = normalizeTelegramId(id);
    if (this.isBootstrapOwner(normalized)) return { premium: true, bootstrap: true, expiresAt: undefined };
    if (typeof this.controllerStore?.hasPremium !== 'function') return { premium: false };
    try {
      const record = await this.controllerStore.hasPremium(normalized);
      if (record && typeof record === 'object') return { premium: Boolean(record.premium), expiresAt: record.expiresAt };
      return { premium: Boolean(record) };
    } catch (error) {
      this.log.warn?.(`[telegram] Could not read premium status for ${normalized}: ${error.message}`);
      return { premium: false };
    }
  }

  // Optional channel-join verification before pairing. Bootstrap owners skip
  // it. Fails closed (with a clear log) when the membership cannot be checked.
  async joinedRequiredChannels(senderId) {
    if (!this.requiredChannels.length) return { ok: true };
    if (this.isBootstrapOwner(senderId)) return { ok: true };
    for (const channel of this.requiredChannels) {
      try {
        const member = await this.api('getChatMember', { chat_id: channel.chatId, user_id: Number(senderId) });
        if (!['member', 'administrator', 'creator'].includes(member?.status)) {
          return { ok: false, channel };
        }
      } catch (error) {
        this.log.warn?.(`[telegram] Could not verify membership of ${senderId} in ${channel.chatId}: ${error.message}`);
        return { ok: false, channel };
      }
    }
    return { ok: true };
  }

  // ------------------------------ Telegram API ----------------------------

  async api(method, payload) {
    const response = await this.fetch(`${TELEGRAM_API}/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API request failed (${response.status}).`);
    return result.result;
  }

  async reply(chatId, text, replyMarkup) {
    return this.api('sendMessage', { chat_id: chatId, text: escapeTelegramHtml(text), parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  async replyPhoto(chatId, image, caption, replyMarkup) {
    if (!image) return this.reply(chatId, caption, replyMarkup);
    return this.api('sendPhoto', { chat_id: chatId, photo: image, caption: escapeTelegramHtml(caption), parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  // Edits an existing message when it is still editable; otherwise sends a
  // new one. Used by the inline navigation so the chat stays clean.
  async present(chatId, messageId, text, replyMarkup) {
    if (messageId) {
      try {
        return await this.api('editMessageText', {
          chat_id: chatId, message_id: messageId,
          text: escapeTelegramHtml(text), parse_mode: 'HTML',
          ...(replyMarkup ? { reply_markup: replyMarkup } : {})
        });
      } catch (error) {
        if (/not modified/i.test(String(error?.message))) return undefined;
        // fall through to sending a new message (too old, deleted, etc.)
      }
    }
    return this.reply(chatId, text, replyMarkup);
  }

  reserveSensitiveRequest(senderId, scope = 'global') {
    const key = `${String(senderId)}:${String(scope)}`;
    const now = Date.now();
    const active = this.sensitiveLocks.get(key);
    if (active && now - active < SENSITIVE_LOCK_TTL_MS) {
      throw Object.assign(new Error('That sensitive operation is already in progress. Please wait for it to finish.'), { code: 'BUSY' });
    }
    const previous = this.sensitiveRequests.get(key) || 0;
    if (now - previous < SENSITIVE_COOLDOWN_MS) {
      throw Object.assign(new Error(`Please wait ${Math.ceil((SENSITIVE_COOLDOWN_MS - (now - previous)) / 1000)} seconds before another sensitive operation.`), { code: 'COOLDOWN' });
    }
    this.sensitiveRequests.set(key, now);
    this.sensitiveLocks.set(key, now);
    return () => this.sensitiveLocks.delete(key);
  }

  prunePendingState() {
    const now = Date.now();
    for (const [key, entry] of this.pendingPairNumbers) {
      if (!entry || entry.expiresAt <= now) this.pendingPairNumbers.delete(key);
    }
  }

  // ------------------------------ pairing ---------------------------------

  async beginPairPrompt(chatId, senderId) {
    this.pendingPairNumbers.set(String(senderId), { chatId, expiresAt: Date.now() + PENDING_NUMBER_TTL_MS });
    return this.reply(chatId, [
      '📱 Send your WhatsApp number with country code, for example 923001234567. Do not include a plus sign.',
      '',
      'Roman Urdu: Country code ke sath apna WhatsApp number bhejein, plus (+) ke baghair — misal: 923001234567.'
    ].join('\n'), { force_reply: true, input_field_placeholder: '923001234567' });
  }

  // The /pair flow: acknowledge first, then show the code only after the real
  // WhatsApp pairing flow produced one, and never claim success early.
  async handlePairCommand(command) {
    const chatId = command.chatId;
    // Join the arguments so spaced forms like "/pair 92 300 1234567" work;
    // normalization handles +, dashes, dots, and parentheses on its own.
    const input = command.args.join('');
    let numberDisplay;
    try {
      const number = normalizeWhatsAppNumber(input);
      numberDisplay = formatInternationalNumber(number);
    } catch (error) {
      const friendly = friendlyPairingError(error);
      await this.reply(chatId, pairingFailedBox(friendly.lines, { retry: friendly.retry }));
      return;
    }

    if (this.premiumOnly) {
      const premium = await this.premiumStatusOf(command.senderId);
      if (!premium.premium) {
        await this.reply(chatId, premiumRequiredBox());
        return;
      }
    }

    const joined = await this.joinedRequiredChannels(command.senderId);
    if (!joined.ok) {
      await this.reply(chatId, channelsBox(this.requiredChannels));
      return;
    }

    const release = this.reserveSensitiveRequest(command.senderId, 'pair');
    await this.reply(chatId, pairingStartedBox(numberDisplay));
    try {
      const result = await this.pairing.requestPairing(command.senderId, input);
      await this.reply(chatId, codeReadyBox(result));
    } catch (error) {
      // Raw errors stay in the log; the user sees a friendly box.
      this.log.error?.(`[telegram] Pairing failed for ${numberDisplay}: ${error?.message || error}`);
      const friendly = friendlyPairingError(error);
      await this.reply(chatId, pairingFailedBox(friendly.lines, { retry: friendly.retry }), friendly.retry ? retryMarkup() : undefined);
    } finally {
      release();
    }
  }

  // ------------------------------ views -----------------------------------

  async sendSessionsView(chatId, senderId, { messageId, admin = false } = {}) {
    const sessions = await this.pairing.listSessions(senderId);
    return this.present(chatId, messageId, sessionsBox(sessions), sessionsMarkup(sessions));
  }

  async sendStatusView(chatId, senderId, { messageId } = {}) {
    const sessions = await this.pairing.listSessions(senderId);
    const text = overallStatusBox(sessions, (Date.now() - (this.startedAt || Date.now())) / 1000);
    return this.present(chatId, messageId, text, { inline_keyboard: [[
      { text: '🔄 Refresh', callback_data: 'nav:status' },
      { text: '🏠 Home', callback_data: 'home' }
    ]] });
  }

  async sendSessionMenuView(chatId, senderId, number, { messageId, admin = false } = {}) {
    const session = await this.pairing.statusOf(senderId, number, { admin });
    const foreign = admin && String(session.ownerId) !== String(senderId);
    return this.present(chatId, messageId, statusBox(session, { ownerId: foreign ? session.ownerId : undefined }), sessionMenuMarkup(session.number));
  }

  async sendSettingsView(chatId, senderId, { messageId, admin = false } = {}) {
    const premium = await this.premiumStatusOf(senderId);
    if (admin) {
      const controllers = typeof this.controllerStore?.read === 'function'
        ? (await this.controllerStore.read().catch(() => [])).length
        : 0;
      const premiumUsers = typeof this.controllerStore?.listPremium === 'function'
        ? (await this.controllerStore.listPremium().catch(() => [])).length
        : 0;
      const text = settingsBox({
        id: senderId, premium: premium.premium, owner: true,
        publicMode: this.publicMode, premiumOnly: this.premiumOnly,
        brand: this.codeSource || CODE_SOURCE_LABEL, controllers, premiumUsers
      });
      return this.present(chatId, messageId, text, settingsMarkup({ owner: true, publicMode: this.publicMode, premiumOnly: this.premiumOnly }));
    }
    const sessionsUsed = typeof this.pairing?.listSessions === 'function'
      ? (await this.pairing.listSessions(senderId).catch(() => [])).length
      : 0;
    const text = settingsBox({
      id: senderId, premium: premium.premium, owner: false,
      sessionsUsed, sessionLimit: this.sessionLimit,
      publicMode: this.publicMode, premiumOnly: this.premiumOnly
    });
    return this.present(chatId, messageId, text, settingsMarkup({ owner: false }));
  }

  // ------------------------------ update routing --------------------------

  async handleUpdate(update) {
    if (update?.callback_query) return this.handleCallback(update.callback_query);
    this.prunePendingState();
    let command = commandFromUpdate(update);
    const message = update?.message;
    if (!command && message?.text?.trim() && message.from?.id != null && message.chat?.id != null) {
      const pending = this.pendingPairNumbers.get(String(message.from.id));
      if (pending && pending.expiresAt > Date.now() && String(pending.chatId) === String(message.chat.id)) {
        this.pendingPairNumbers.delete(String(message.from.id));
        command = { chatId: message.chat.id, senderId: message.from.id, name: 'pair', args: [message.text.trim()], text: message.text.trim() };
      }
    }
    if (!command?.chatId || !command.senderId) return;

    // /myid is intentionally open: a user needs their ID to be granted access.
    if (command.name === 'myid') {
      const premium = await this.premiumStatusOf(command.senderId);
      return this.reply(command.chatId, myIdBox({ id: command.senderId, premium: premium.premium, owner: this.isBootstrapOwner(command.senderId) }), homeOnlyMarkup());
    }

    const access = await this.accessOf(command.senderId);
    if (access === 'none') {
      await this.reply(command.chatId, box('ANIME MD • ACCESS DENIED', ['', '❌ You are not authorized to control this bot.', '']));
      return;
    }
    if (BOOTSTRAP_COMMANDS.has(command.name) && access !== 'bootstrap') {
      await this.reply(command.chatId, box('ANIME MD • DENIED', ['', '❌ Only bootstrap owners (telegram.ownerIds in config.js) can use this command.', '']));
      return;
    }

    try {
      switch (command.name) {
        case 'help':
        case 'start':
          await this.replyPhoto(command.chatId, this.startImage, `${startupBox()}\n\nChoose an action below, or use /help.`, homeMarkup());
          return;
        case 'guide':
          await this.reply(command.chatId, guideBox(), guideMarkup());
          return;
        case 'pair': {
          if (!command.args.length) {
            await this.beginPairPrompt(command.chatId, command.senderId);
            return;
          }
          await this.handlePairCommand(command);
          return;
        }
        case 'sessions':
        case 'listsessions': {
          const sessions = await this.pairing.listSessions(command.senderId);
          await this.reply(command.chatId, sessionsBox(sessions), sessionsMarkup(sessions));
          return;
        }
        case 'status': {
          if (command.args[0]) {
            const session = await this.pairing.statusOf(command.senderId, command.args[0], { admin: access === 'bootstrap' });
            const foreign = access === 'bootstrap' && String(session.ownerId) !== String(command.senderId);
            await this.reply(command.chatId, statusBox(session, { ownerId: foreign ? session.ownerId : undefined }), sessionMenuMarkup(session.number));
            return;
          }
          const sessions = await this.pairing.listSessions(command.senderId);
          const anyConnected = sessions.some((session) => session.connected);
          const text = overallStatusBox(sessions, (Date.now() - (this.startedAt || Date.now())) / 1000);
          if (anyConnected) await this.replyPhoto(command.chatId, this.connectedImage, text);
          else await this.reply(command.chatId, text);
          return;
        }
        case 'restart': {
          if (!command.args[0]) {
            await this.reply(command.chatId, box('ANIME MD • RESTART', ['', 'Usage: /restart <number>', '']));
            return;
          }
          const release = this.reserveSensitiveRequest(command.senderId, 'restart');
          try {
            const session = await this.pairing.restartSession(command.senderId, command.args[0], { admin: access === 'bootstrap' });
            await this.reply(command.chatId, box('ANIME MD • RESTARTING', ['', `📱 ${session.numberDisplay}`, `${badgeParts(session.status).icon} Status: ${badgeParts(session.status).label || session.status}`, '', 'The CONNECTED confirmation arrives', 'when WhatsApp reports the session online.']), backHomeMarkup());
          } finally {
            release();
          }
          return;
        }
        case 'addowner': {
          const release = this.reserveSensitiveRequest(command.senderId, 'addowner');
          try {
            const id = normalizeTelegramId(command.args[0]);
            await this.controllerStore.add(id);
            await this.reply(command.chatId, box('ANIME MD • CONTROLLER ADDED', ['', `✅ Telegram controller ${id} authorized.`, '']));
          } finally {
            release();
          }
          return;
        }
        case 'delowner': {
          const release = this.reserveSensitiveRequest(command.senderId, 'delowner');
          try {
            const id = normalizeTelegramId(command.args[0]);
            if (this.bootstrapOwners.has(id)) throw Object.assign(new Error('Bootstrap owners are configured through telegram.ownerIds in config.js and cannot be removed at runtime.'), { code: 'PROTECTED' });
            const removed = await this.controllerStore.remove(id);
            await this.reply(command.chatId, removed
              ? box('ANIME MD • CONTROLLER REMOVED', ['', `✅ Telegram controller ${id} removed.`, ''])
              : box('ANIME MD • INFO', ['', `Telegram controller ${id} was not stored.`, '']));
          } finally {
            release();
          }
          return;
        }
        case 'addprem': {
          const release = this.reserveSensitiveRequest(command.senderId, 'addprem');
          try {
            const id = normalizeTelegramId(command.args[0]);
            const duration = command.args[1] || '30d';
            const record = await this.controllerStore.addPremium(id, duration);
            await this.reply(command.chatId, box('ANIME MD • PREMIUM GRANTED', ['', `✅ ${id} is premium until`, `${new Date(record.expiresAt).toISOString().slice(0, 10)}.`, '']));
          } finally {
            release();
          }
          return;
        }
        case 'delprem': {
          const release = this.reserveSensitiveRequest(command.senderId, 'delprem');
          try {
            const id = normalizeTelegramId(command.args[0]);
            const removed = typeof this.controllerStore.removePremium === 'function' && await this.controllerStore.removePremium(id);
            await this.reply(command.chatId, removed
              ? box('ANIME MD • PREMIUM REMOVED', ['', `✅ Premium access removed from ${id}.`, ''])
              : box('ANIME MD • INFO', ['', `${id} has no active premium access.`, '']));
          } finally {
            release();
          }
          return;
        }
        case 'listpaired': {
          const sessions = typeof this.pairing.listAllSessions === 'function' ? await this.pairing.listAllSessions() : [];
          if (!sessions.length) {
            await this.reply(command.chatId, box('ANIME MD • ALL SESSIONS', ['', '📭 No paired sessions on this bot.', '']));
            return;
          }
          const lines = sessions.map((session) => `${badgeParts(session.status).icon} ${session.numberDisplay} — ${badgeParts(session.status).label || session.status} (user ${session.ownerId ?? '?'})`);
          await this.reply(command.chatId, box('ANIME MD • ALL SESSIONS', ['', ...lines, '', `Total: ${sessions.length} session${sessions.length === 1 ? '' : 's'}`]), homeOnlyMarkup());
          return;
        }
        case 'premium': {
          const mode = command.args[0]?.toLowerCase();
          if (mode === 'on' || mode === 'off') {
            if (access !== 'bootstrap') {
              await this.reply(command.chatId, box('ANIME MD • DENIED', ['', '❌ Only bootstrap owners can change this setting.', '']));
              return;
            }
            await this.persistSetting('premiumOnly', mode === 'on');
            await this.reply(command.chatId, box('ANIME MD • SETTINGS', ['', `💎 Premium-only pairing: ${mode === 'on' ? 'ON 🔒' : 'OFF 🌍'}`, '']), settingsMarkup({ owner: true, publicMode: this.publicMode, premiumOnly: this.premiumOnly }));
            return;
          }
          const premium = await this.premiumStatusOf(command.senderId);
          await this.reply(command.chatId, premiumBox({ id: command.senderId, expiresAt: premium.expiresAt, active: premium.premium && !premium.bootstrap }), homeOnlyMarkup());
          return;
        }
        case 'public': {
          const mode = command.args[0]?.toLowerCase();
          if (mode === 'on' || mode === 'off') {
            if (access !== 'bootstrap') {
              await this.reply(command.chatId, box('ANIME MD • DENIED', ['', '❌ Only bootstrap owners can change this setting.', '']));
              return;
            }
            await this.persistSetting('publicMode', mode === 'on');
            await this.reply(command.chatId, box('ANIME MD • SETTINGS', ['', `🌍 Public pairing: ${mode === 'on' ? 'ON 🌍' : 'OFF 🔒'}`, '', mode === 'on' ? 'Any Telegram user can now pair their own number.' : 'Only authorized controllers can pair.']), settingsMarkup({ owner: true, publicMode: this.publicMode, premiumOnly: this.premiumOnly }));
            return;
          }
          await this.reply(command.chatId, box('ANIME MD • INFO', ['', `🌍 Public pairing: ${this.publicMode ? 'ON 🌍' : 'OFF 🔒'}`, this.publicMode ? 'Any Telegram user can pair their own number.' : 'Only authorized controllers can pair.', '']));
          return;
        }
        case 'settings': {
          await this.sendSettingsView(command.chatId, command.senderId, { admin: access === 'bootstrap' });
          return;
        }
        case 'stop':
        case 'delpair': {
          if (!command.args[0]) {
            await this.reply(command.chatId, box('ANIME MD • STOP', ['', 'Usage: /stop <number>', '', 'Removes an unpaired session and its credentials.', '']));
            return;
          }
          const release = this.reserveSensitiveRequest(command.senderId, 'stop');
          try {
            const session = await this.pairing.stopSession(command.senderId, command.args[0], { admin: access === 'bootstrap' });
            await this.reply(command.chatId, stoppedBox(session.numberDisplay || formatInternationalNumber(command.args[0])), pairAgainMarkup());
          } finally {
            release();
          }
          return;
        }
        default:
          await this.reply(command.chatId, `${box('ANIME MD • UNKNOWN COMMAND', ['', '❌ Unknown command.', ''])}\n\n${helpText()}`, homeOnlyMarkup());
      }
    } catch (error) {
      // Rate-limit style errors show a small "please wait" box first.
      if (error?.code === 'BUSY' || error?.code === 'COOLDOWN') {
        await this.reply(command.chatId, box('ANIME MD • PLEASE WAIT', ['', `⏳ ${error.message}`, '']));
        return;
      }
      // Pairing-domain errors render as their friendly box; other messages
      // (input validation) are shown directly because they are already
      // user-facing. Raw internal errors are logged, never displayed.
      const friendly = friendlyPairingError(error);
      if (error?.code && PAIRING_ERROR_TEXTS[error.code]) {
        this.log.error?.(`[telegram] Command /${command.name} failed: ${error.message}`);
        await this.reply(command.chatId, pairingFailedBox(friendly.lines, { retry: friendly.retry }), friendly.retry ? retryMarkup() : undefined);
        return;
      }
      await this.reply(command.chatId, box('ANIME MD • ERROR', ['', `❌ ${error.message}`, '']), homeOnlyMarkup());
    }
  }

  // ------------------------------ callbacks -------------------------------

  async handleCallback(callback) {
    const senderId = callback.from?.id;
    const chatId = callback.message?.chat?.id;
    const messageId = callback.message?.message_id;
    const action = String(callback.data || '');
    if (!senderId || !chatId) return;
    const answer = () => this.api('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
    try {
      await answer();
      const access = await this.accessOf(senderId);
      if (access === 'none') throw Object.assign(new Error('You are not authorized to control this bot.'), { code: 'DENIED' });
      const admin = access === 'bootstrap';
      const [scope, verb, argument] = action.split(':');

      // Legacy one-word callbacks kept working for older messages.
      if (action === 'pair_help') return await this.beginPairPrompt(chatId, senderId);
      if (action === 'help') return await this.present(chatId, messageId, helpText(), homeMarkup());
      if (action === 'status') return await this.sendStatusView(chatId, senderId, {});
      if (action === 'sessions') return await this.sendSessionsView(chatId, senderId, {});

      if (action === 'home') {
        return await this.present(chatId, messageId, `${startupBox()}\n\nChoose an action below, or use /help.`, homeMarkup());
      }
      if (action === 'pair:new') {
        return await this.beginPairPrompt(chatId, senderId);
      }
      if (action === 'nav:guide') {
        return await this.present(chatId, messageId, guideBox(), guideMarkup());
      }
      if (action === 'nav:help') {
        return await this.present(chatId, messageId, helpText(), homeMarkup());
      }
      if (action === 'nav:status') {
        return await this.sendStatusView(chatId, senderId, { messageId });
      }
      if (action === 'nav:sessions') {
        return await this.sendSessionsView(chatId, senderId, { messageId, admin });
      }
      if (action === 'nav:settings') {
        return await this.sendSettingsView(chatId, senderId, { messageId, admin });
      }

      if (scope === 'ses') {
        // Numbers are re-validated; ownership is resolved server-side by the
        // pairing manager, never trusted from the callback data.
        const number = normalizeWhatsAppNumber(argument);
        if (verb === 'menu') {
          return await this.sendSessionMenuView(chatId, senderId, number, { messageId, admin });
        }
        if (verb === 'restart') {
          const release = this.reserveSensitiveRequest(senderId, 'restart');
          try {
            const session = await this.pairing.restartSession(senderId, number, { admin });
            return await this.present(chatId, messageId, box('ANIME MD • RESTARTING', ['', `📱 ${session.numberDisplay}`, `${badgeParts(session.status).icon} Status: ${badgeParts(session.status).label || session.status}`, '', 'The CONNECTED confirmation arrives', 'when WhatsApp reports the session online.']), backHomeMarkup());
          } finally {
            release();
          }
        }
        if (verb === 'stop') {
          const session = await this.pairing.statusOf(senderId, number, { admin });
          return await this.present(chatId, messageId, box('ANIME MD • REMOVE SESSION', [
            '',
            `📱 ${session.numberDisplay}`,
            '',
            'This stops the session and deletes its',
            'stored credentials. The WhatsApp bot',
            'for this number goes offline.',
            '',
            'Remove it?'
          ]), stopConfirmMarkup(number));
        }
        if (verb === 'stopok') {
          const release = this.reserveSensitiveRequest(senderId, 'stop');
          try {
            const session = await this.pairing.stopSession(senderId, number, { admin });
            return await this.present(chatId, messageId, stoppedBox(session.numberDisplay), pairAgainMarkup());
          } finally {
            release();
          }
        }
        throw Object.assign(new Error('This button is no longer valid. Open My Sessions again.'), { code: 'EXPIRED' });
      }

      if (scope === 'set') {
        if (!admin) throw Object.assign(new Error('You don\'t have permission to change this setting.'), { code: 'DENIED' });
        if (verb === 'public' && (argument === 'on' || argument === 'off')) {
          await this.persistSetting('publicMode', argument === 'on');
          return await this.sendSettingsView(chatId, senderId, { messageId, admin });
        }
        if (verb === 'prem' && (argument === 'on' || argument === 'off')) {
          await this.persistSetting('premiumOnly', argument === 'on');
          return await this.sendSettingsView(chatId, senderId, { messageId, admin });
        }
        throw Object.assign(new Error('This button is no longer valid. Open Settings again.'), { code: 'EXPIRED' });
      }

      throw Object.assign(new Error('This button is no longer valid. Send /help.'), { code: 'EXPIRED' });
    } catch (error) {
      const friendly = friendlyPairingError(error);
      if (error?.code && PAIRING_ERROR_TEXTS[error.code]) {
        return await this.present(chatId, messageId, pairingFailedBox(friendly.lines, { retry: friendly.retry }), friendly.retry ? retryMarkup() : undefined);
      }
      return await this.reply(chatId, box('ANIME MD • ERROR', ['', `❌ ${error.message}`, '']), homeOnlyMarkup());
    }
  }

  async pollOnce() {
    const updates = await this.api('getUpdates', { offset: this.offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ['message', 'callback_query'] });
    for (const update of updates) {
      this.offset = Math.max(this.offset, Number(update.update_id) + 1);
      await this.handleUpdate(update);
    }
  }

  async notifyBootstrapOwners(image, caption) {
    for (const ownerId of this.bootstrapOwners) {
      try {
        await this.replyPhoto(ownerId, image, caption, homeMarkup());
      } catch (error) {
        // A Telegram user must open the bot before it can receive a proactive
        // message. This must not stop polling for the other authorized owners.
        this.log.warn?.(`[telegram] Could not notify configured owner ${ownerId}: ${error.message}`);
      }
    }
  }

  // Called by the pairing manager when an owner's WhatsApp session actually
  // reaches connection open. It is never called earlier.
  async notifySessionConnected(ownerId, session) {
    if (!this.running) return;
    try {
      await this.replyPhoto(ownerId, this.connectedImage, connectedBox(session?.numberDisplay || session?.number || ''), connectedMarkup());
    } catch (error) {
      this.log.warn?.(`[telegram] Could not deliver the connected notification to ${ownerId}: ${error.message}`);
    }
  }

  async notifySessionDisconnected(ownerId, session, classification) {
    if (!this.running) return;
    // A session that never finished pairing reads as a failed pairing, not
    // as an ended session; the reason line comes straight from the
    // disconnect classification, so failures are never generic.
    const failedBeforeLink = !session?.registered;
    const title = failedBeforeLink ? 'ANIME MD • PAIRING FAILED' : 'ANIME MD • SESSION ENDED';
    const lines = [
      '',
      `📱 ${session?.numberDisplay || session?.number || ''}`,
      `⚠️ ${classification?.userMessage || 'The WhatsApp session ended.'}`
    ];
    if (failedBeforeLink) lines.push('', '❌ Pairing could not be completed.');
    lines.push('', 'Pair again anytime with /pair.');
    try {
      await this.reply(ownerId, box(title, lines), pairAgainMarkup());
    } catch (error) {
      this.log.warn?.(`[telegram] Could not deliver the disconnect notification to ${ownerId}: ${error.message}`);
    }
  }

  async notifyConnected() {
    if (!this.running) return;
    await this.notifyBootstrapOwners(this.connectedImage, box('ANIME MD • CONNECTED', ['', '✅ Primary WhatsApp session connected.', '']));
  }

  async start() {
    if (!this.token || this.running) return false;
    if (typeof this.fetch !== 'function') throw new Error('Telegram controller requires Node.js fetch support.');

    // Long polling cannot receive updates while a webhook is registered. Clear
    // a stale webhook explicitly before polling, while retaining queued updates.
    this.bot = await this.api('getMe', {});
    await this.api('deleteWebhook', { drop_pending_updates: false });
    await this.loadSettings();
    this.running = true;
    this.startedAt = Date.now();
    this.pollPromise = (async () => {
      while (this.running) {
        try {
          await this.pollOnce();
          // Telegram long polling normally blocks for up to 25 seconds. Yield
          // here as well so an immediately returning proxy/API cannot spin a
          // microtask loop and starve startup, shutdown, or other bot work.
          await new Promise((resolve) => setImmediate(resolve));
        } catch (error) {
          this.log.error?.(`[telegram] Poll failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
    })();
    const username = this.bot?.username ? `@${this.bot.username}` : 'the configured Telegram bot';
    this.log.info?.(`[telegram] Controller verified as ${username}; long polling started for ${this.bootstrapOwners.size} bootstrap owner(s).`);
    // The intro describes the Telegram-side subsystems only. It never claims
    // a WhatsApp session is connected.
    await this.notifyBootstrapOwners(this.startImage, `${startupBox()}\n\nSend /help to view commands, or use the buttons below.`);
    return true;
  }

  stop() { this.running = false; }
}

module.exports = {
  CODE_SOURCE_LABEL,
  SENSITIVE_COOLDOWN_MS,
  SENSITIVE_LOCK_TTL_MS,
  SESSION_STATE_BADGES,
  TelegramController,
  badgeParts,
  channelsBox,
  codeReadyBox,
  commandFromUpdate,
  connectedBox,
  connectedMarkup,
  escapeTelegramHtml,
  friendlyPairingError,
  guideBox,
  guideMarkup,
  helpText,
  homeMarkup,
  menuMarkup,
  myIdBox,
  normalizeTelegramId,
  normalizeWhatsappNumber: normalizeWhatsAppNumber,
  pairingFailedBox,
  pairingStartedBox,
  premiumBox,
  premiumRequiredBox,
  sessionsBox,
  sessionsMarkup,
  sessionMenuMarkup,
  settingsBox,
  settingsMarkup,
  startupBox,
  stateBadge,
  statusBox,
  stopConfirmMarkup
};
