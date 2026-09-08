'use strict';

// A small Telegram Bot API client used for remote *control* of the WhatsApp
// pairing system. It deliberately has no WhatsApp implementation of its own:
// the TelegramPairingManager owns every socket and session.
//
// All user-facing text uses the ANIME MD box style. Raw technical errors stay
// in the internal log; Telegram users only ever see friendly messages.

const TELEGRAM_API = 'https://api.telegram.org';
const POLL_TIMEOUT_SECONDS = 25;
const SENSITIVE_COOLDOWN_MS = 20_000;
const SENSITIVE_LOCK_TTL_MS = 2 * 60_000;

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

const GOAT_MODS_BRAND = 'GOAT-MODS';

function startupBox() {
  return box('ANIME MD', [
    '',
    '⚡ GOJO MODE ONLINE',
    '',
    '🟢 Telegram Controller',
    '🟢 Pairing System',
    '🟢 Session Manager',
    '🟢 Traffic Manager',
    '',
    '「 THE STRONGEST IS ONLINE 」'
  ]);
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

function codeReadyBox({ displayCode, brand }) {
  return box(`ANIME MD • ${brand || GOAT_MODS_BRAND}`, [
    '',
    '✅ Pairing Code Ready',
    '',
    `🔐 CODE: ${displayCode}`,
    '',
    'WhatsApp:',
    'Linked Devices',
    '→ Link a Device',
    '→ Link with phone number',
    '',
    'Enter the code in WhatsApp.'
  ]);
}

function connectedBox(numberDisplay) {
  return box('ANIME MD • CONNECTED', [
    '',
    '✅ WhatsApp Connected',
    '',
    `📱 ${numberDisplay}`,
    '',
    '🟢 Session is active.',
    '',
    'Your ANIME MD session is ready.'
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

function sessionsBox(sessions) {
  if (!sessions.length) {
    return box('ANIME MD • SESSIONS', [
      '',
      '📭 No sessions yet.',
      '',
      'Use /pair <number> to pair a WhatsApp number.'
    ]);
  }
  const lines = sessions.map((session) => `${stateBadge(session.status).split(' ')[0]} ${session.numberDisplay} — ${stateBadge(session.status).split(' ').slice(1).join(' ')}`);
  return box('ANIME MD • SESSIONS', [
    '',
    ...lines,
    '',
    `Total: ${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
    '',
    '/status <number> for details'
  ]);
}

function statusBox(session) {
  return box('ANIME MD • SESSION STATUS', [
    '',
    `📱 Number: ${session.numberDisplay}`,
    `${stateBadge(session.status).split(' ')[0]} Status: ${stateBadge(session.status).split(' ').slice(1).join(' ')}`,
    `🔗 Paired: ${session.registered ? 'yes' : 'no'}`,
    `🔄 Reconnects: ${session.reconnects}`,
    '',
    'Your ANIME MD session.'
  ]);
}

function overallStatusBox(sessions, controllerUptimeSeconds) {
  const lines = [
    '',
    `🤖 Controller: Online (${Math.floor(controllerUptimeSeconds / 60)}m uptime)`,
    `📱 WhatsApp sessions: ${sessions.length}`
  ];
  if (sessions.length) {
    lines.push('', ...sessions.map((session) => `${stateBadge(session.status).split(' ')[0]} ${session.numberDisplay} — ${stateBadge(session.status).split(' ').slice(1).join(' ')}`));
  } else {
    lines.push('', 'No WhatsApp sessions yet.', 'Telegram online ≠ WhatsApp connected.', 'Use /pair <number> to pair.');
  }
  return box('ANIME MD • STATUS', lines);
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
  PAIRING_TIMEOUT: { lines: ['WhatsApp did not become ready for pairing in time.'], retry: true },
  CONNECTION_CLOSED: { lines: ['The WhatsApp connection closed', 'before linking was completed.'], retry: true },
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
    '┃ /status <number> — session status',
    '┃ /stop <number> — remove an unpaired session',
    '┃ /restart <number> — bring a paired session back online',
    '┃ /addowner <telegram_id> — authorize a controller',
    '┃ /delowner <telegram_id> — remove a controller',
    '┃ /help — show this help',
    '┃',
    '┃ Number format: country code + number,',
    '┃ no + required (example: 923001234567).',
    '╰' + '━'.repeat(23) + '╯'
  ].join('\n');
}

function menuMarkup() {
  return { inline_keyboard: [[
    { text: 'Pair WhatsApp', callback_data: 'pair_help' },
    { text: 'Status', callback_data: 'status' }
  ], [
    { text: 'My sessions', callback_data: 'sessions' },
    { text: 'Help', callback_data: 'help' }
  ]] };
}

class TelegramController {
  constructor({ token, owners = [], controllerStore, pairing, startImage = '', connectedImage = '', fetchImpl = globalThis.fetch, log = console }) {
    this.token = token;
    this.bootstrapOwners = new Set(owners.map(normalizeTelegramId));
    this.controllerStore = controllerStore;
    this.pairing = pairing;
    this.startImage = startImage;
    this.connectedImage = connectedImage;
    this.fetch = fetchImpl;
    this.log = log;
    this.offset = 0;
    this.running = false;
    this.startedAt = undefined;
    this.bot = undefined;
    this.pollPromise = undefined;
    this.sensitiveRequests = new Map();
    this.sensitiveLocks = new Map();
    this.pendingPairNumbers = new Map();
  }

  async authorized(id) {
    const normalized = normalizeTelegramId(id);
    return this.bootstrapOwners.has(normalized) || await this.controllerStore.has(normalized);
  }

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

  async replyPhoto(chatId, image, caption) {
    if (!image) return this.reply(chatId, caption);
    return this.api('sendPhoto', { chat_id: chatId, photo: image, caption: escapeTelegramHtml(caption), parse_mode: 'HTML' });
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

    const release = this.reserveSensitiveRequest(command.senderId, 'pair');
    await this.reply(chatId, pairingStartedBox(numberDisplay));
    try {
      const result = await this.pairing.requestPairing(command.senderId, input);
      await this.reply(chatId, codeReadyBox(result));
    } catch (error) {
      // Raw errors stay in the log; the user sees a friendly box.
      this.log.error?.(`[telegram] Pairing failed for ${numberDisplay}: ${error?.message || error}`);
      const friendly = friendlyPairingError(error);
      await this.reply(chatId, pairingFailedBox(friendly.lines, { retry: friendly.retry }));
    } finally {
      release();
    }
  }
  async handleUpdate(update) {
    if (update?.callback_query) return this.handleCallback(update.callback_query);
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
    if (!(await this.authorized(command.senderId))) {
      await this.reply(command.chatId, box('ANIME MD • ACCESS DENIED', ['', '❌ You are not authorized to control this bot.', '']));
      return;
    }

    try {
      switch (command.name) {
        case 'help':
        case 'start':
          await this.replyPhoto(command.chatId, this.startImage, startupBox());
          await this.reply(command.chatId, 'Choose an action, or use a command:', menuMarkup());
          return;
        case 'pair':
          await this.handlePairCommand(command);
          return;
        case 'sessions': {
          const sessions = await this.pairing.listSessions(command.senderId);
          await this.reply(command.chatId, sessionsBox(sessions));
          return;
        }
        case 'status': {
          if (command.args[0]) {
            const session = await this.pairing.statusOf(command.senderId, command.args[0]);
            await this.reply(command.chatId, statusBox(session));
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
            const session = await this.pairing.restartSession(command.senderId, command.args[0]);
            await this.reply(command.chatId, box('ANIME MD • RESTARTING', ['', `📱 ${session.numberDisplay}`, `${stateBadge(session.status).split(' ')[0]} ${stateBadge(session.status).split(' ').slice(1).join(' ')}`, '', 'The CONNECTED confirmation arrives', 'when WhatsApp reports the session online.']));
          } finally {
            release();
          }
          return;
        }
        case 'addowner': {
          if (!this.bootstrapOwners.has(String(command.senderId))) {
            await this.reply(command.chatId, box('ANIME MD • DENIED', ['', '❌ Only bootstrap owners (telegram.ownerIds in config.js) can add controllers.', '']));
            return;
          }
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
          if (!this.bootstrapOwners.has(String(command.senderId))) {
            await this.reply(command.chatId, box('ANIME MD • DENIED', ['', '❌ Only bootstrap owners (telegram.ownerIds in config.js) can remove controllers.', '']));
            return;
          }
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
        case 'stop': {
          if (!command.args[0]) {
            await this.reply(command.chatId, box('ANIME MD • STOP', ['', 'Usage: /stop <number>', '']));
            return;
          }
          const release = this.reserveSensitiveRequest(command.senderId, 'stop');
          try {
            const { formatInternationalNumber } = require('./pairing-number');
            const session = await this.pairing.stopSession(command.senderId, command.args[0]);
            await this.reply(command.chatId, stoppedBox(session.numberDisplay || formatInternationalNumber(command.args[0])));
          } finally {
            release();
          }
          return;
        }
        default:
          await this.reply(command.chatId, `${box('ANIME MD • UNKNOWN COMMAND', ['', '❌ Unknown command.', ''])}\n\n${helpText()}`);
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
        await this.reply(command.chatId, pairingFailedBox(friendly.lines, { retry: friendly.retry }));
        return;
      }
      await this.reply(command.chatId, box('ANIME MD • ERROR', ['', `❌ ${error.message}`, '']));
    }
  }

  async handleCallback(callback) {
    const senderId = callback.from?.id;
    const chatId = callback.message?.chat?.id;
    const action = callback.data;
    if (!senderId || !chatId) return;
    try {
      await this.api('answerCallbackQuery', { callback_query_id: callback.id });
      if (!(await this.authorized(senderId))) throw Object.assign(new Error('You are not authorized to control this bot.'), { code: 'DENIED' });
      if (action === 'pair_help') {
        this.pendingPairNumbers.set(String(senderId), { chatId, expiresAt: Date.now() + 5 * 60_000 });
        return this.reply(chatId, 'Send your WhatsApp number with country code, for example 923001234567. Do not include a plus sign.', { force_reply: true, input_field_placeholder: '923001234567' });
      }
      if (action === 'help') return this.reply(chatId, helpText());
      if (action === 'status') return this.handleUpdate({ message: { chat: { id: chatId }, from: { id: senderId }, text: '/status' } });
      if (action === 'sessions') return this.handleUpdate({ message: { chat: { id: chatId }, from: { id: senderId }, text: '/sessions' } });
      throw Object.assign(new Error('This button is no longer valid. Send /help.'), { code: 'EXPIRED' });
    } catch (error) {
      await this.reply(chatId, box('ANIME MD • ERROR', ['', `❌ ${error.message}`, '']));
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
        await this.replyPhoto(ownerId, image, caption);
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
      await this.replyPhoto(ownerId, this.connectedImage, connectedBox(session?.numberDisplay || session?.number || ''));
    } catch (error) {
      this.log.warn?.(`[telegram] Could not deliver the connected notification to ${ownerId}: ${error.message}`);
    }
  }

  async notifySessionDisconnected(ownerId, session, classification) {
    if (!this.running) return;
    try {
      await this.reply(ownerId, box('ANIME MD • SESSION ENDED', [
        '',
        `📱 ${session?.numberDisplay || session?.number || ''}`,
        `⚠️ ${classification?.userMessage || 'The WhatsApp session ended.'}`,
        '',
        'Pair again anytime with /pair.'
      ]));
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
    await this.notifyBootstrapOwners(this.startImage, `${startupBox()}\n\nSend /help to view commands.`);
    return true;
  }

  stop() { this.running = false; }
}

module.exports = {
  GOAT_MODS_BRAND,
  SENSITIVE_COOLDOWN_MS,
  SENSITIVE_LOCK_TTL_MS,
  SESSION_STATE_BADGES,
  TelegramController,
  codeReadyBox,
  commandFromUpdate,
  connectedBox,
  escapeTelegramHtml,
  friendlyPairingError,
  helpText,
  menuMarkup,
  normalizeTelegramId,
  normalizeWhatsappNumber: normalizeWhatsAppNumber,
  pairingFailedBox,
  pairingStartedBox,
  sessionsBox,
  startupBox,
  stateBadge,
  statusBox
};
