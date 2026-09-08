'use strict';

// A small Telegram Bot API client used for remote *control* of the existing
// Baileys socket.  It deliberately has no WhatsApp implementation of its own:
// callers provide the one connection manager used by the application.

const TELEGRAM_API = 'https://api.telegram.org';
const POLL_TIMEOUT_SECONDS = 25;
const SENSITIVE_COOLDOWN_MS = 20_000;

function normalizeTelegramId(value) {
  const id = String(value ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('Telegram IDs must be numeric.');
  return id;
}

function normalizeWhatsappNumber(value) {
  const raw = String(value ?? '').trim();
  const number = raw.replace(/[\s+]/g, '');
  if (!/^\d{7,15}$/.test(number)) throw new Error('Use a 7-15 digit WhatsApp number with country code.');
  return number;
}

function commandFromUpdate(update) {
  const message = update?.message;
  const text = message?.text?.trim();
  if (!text?.startsWith('/')) return undefined;
  const [token, ...args] = text.split(/\s+/);
  const name = token.slice(1).split('@')[0].toLowerCase();
  return { chatId: message.chat?.id, senderId: message.from?.id, name, args, text: args.join(' ') };
}

function helpText() {
  return [
    '*ANIME MD Telegram controller*',
    '/pair <number> — request a WhatsApp pairing code',
    '/sessions — show the active ANIME MD session',
    '/status — show controller and WhatsApp health',
    '/addowner <telegram_id> — authorize another controller',
    '/delowner <telegram_id> — remove an added controller',
    '/stop <number> — remove the unpaired session for that number',
    '/help — show controller help'
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
    this.bot = undefined;
    this.pollPromise = undefined;
    this.sensitiveRequests = new Map();
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
    return this.api('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  async replyPhoto(chatId, image, caption) {
    if (!image) return this.reply(chatId, caption);
    return this.api('sendPhoto', { chat_id: chatId, photo: image, caption, parse_mode: 'Markdown' });
  }

  reserveSensitiveRequest(senderId) {
    const now = Date.now();
    const previous = this.sensitiveRequests.get(String(senderId)) || 0;
    if (now - previous < SENSITIVE_COOLDOWN_MS) {
      throw new Error(`Please wait ${Math.ceil((SENSITIVE_COOLDOWN_MS - (now - previous)) / 1000)} seconds before another sensitive operation.`);
    }
    this.sensitiveRequests.set(String(senderId), now);
  }

  async handleUpdate(update) {
    if (update?.callback_query) return this.handleCallback(update.callback_query);
    const command = commandFromUpdate(update);
    if (!command?.chatId || !command.senderId) return;
    if (!(await this.authorized(command.senderId))) {
      await this.reply(command.chatId, '*ERROR*\nYou are not authorized to control this bot.');
      return;
    }

    try {
      switch (command.name) {
        case 'help':
        case 'start':
          await this.replyPhoto(command.chatId, this.startImage, helpText());
          await this.reply(command.chatId, 'Choose an action, or use a command:', menuMarkup());
          return;
        case 'pair': {
          this.reserveSensitiveRequest(command.senderId);
          const number = normalizeWhatsappNumber(command.args[0]);
          const code = await this.pairing.requestPairing(command.senderId, number);
          await this.reply(command.chatId, `*PAIRING CODE*\nNumber: ${number}\nCode: \`${code}\``);
          return;
        }
        case 'sessions': {
          const status = await this.pairing.getStatus(command.senderId);
          const number = status.botUser?.replace(/\D/g, '') || status.pairingNumber || 'none';
          await this.reply(command.chatId, `*ACTIVE SESSIONS*\n1. ${number}\nStatus: ${status.state}\nSession: ${status.session}`);
          return;
        }
        case 'status': {
          const status = await this.pairing.getStatus(command.senderId);
          const text = `*ANIME MD STATUS*\nWhatsApp: ${status.state}\nConnected: ${status.connected ? 'yes' : 'no'}\nUptime: ${Math.floor((Date.now() - status.startedAt) / 1000)} seconds`;
          if (status.connected) await this.replyPhoto(command.chatId, this.connectedImage, text);
          else await this.reply(command.chatId, text);
          return;
        }
        case 'addowner': {
          if (!this.bootstrapOwners.has(String(command.senderId))) {
            await this.reply(command.chatId, '*ERROR*\nOnly bootstrap owners (telegram.ownerIds in config.js) can add controllers.');
            return;
          }
          this.reserveSensitiveRequest(command.senderId);
          const id = normalizeTelegramId(command.args[0]);
          await this.controllerStore.add(id);
          await this.reply(command.chatId, `*SUCCESS*\nTelegram controller ${id} authorized.`);
          return;
        }
        case 'delowner': {
          if (!this.bootstrapOwners.has(String(command.senderId))) {
            await this.reply(command.chatId, '*ERROR*\nOnly bootstrap owners (telegram.ownerIds in config.js) can remove controllers.');
            return;
          }
          this.reserveSensitiveRequest(command.senderId);
          const id = normalizeTelegramId(command.args[0]);
          if (this.bootstrapOwners.has(id)) throw new Error('Bootstrap owners are configured through telegram.ownerIds in config.js and cannot be removed at runtime.');
          const removed = await this.controllerStore.remove(id);
          await this.reply(command.chatId, removed ? `*SUCCESS*\nTelegram controller ${id} removed.` : `*INFO*\nTelegram controller ${id} was not stored.`);
          return;
        }
        case 'stop': {
          this.reserveSensitiveRequest(command.senderId);
          const number = normalizeWhatsappNumber(command.args[0]);
          await this.pairing.stopSession(command.senderId, number);
          await this.reply(command.chatId, `*SUCCESS*\nSession for ${number} stopped and removed.`);
          return;
        }
        default:
          await this.reply(command.chatId, `*ERROR*\nUnknown command.\n\n${helpText()}`);
      }
    } catch (error) {
      await this.reply(command.chatId, `*ERROR*\n${error.message}`);
    }
  }

  async handleCallback(callback) {
    const senderId = callback.from?.id;
    const chatId = callback.message?.chat?.id;
    const action = callback.data;
    if (!senderId || !chatId) return;
    try {
      await this.api('answerCallbackQuery', { callback_query_id: callback.id });
      if (!(await this.authorized(senderId))) throw new Error('You are not authorized to control this bot.');
      if (action === 'pair_help') return this.reply(chatId, 'Send `/pair <number>` using country code and no plus sign.');
      if (action === 'help') return this.reply(chatId, helpText());
      if (action === 'status') return this.handleUpdate({ message: { chat: { id: chatId }, from: { id: senderId }, text: '/status' } });
      if (action === 'sessions') return this.handleUpdate({ message: { chat: { id: chatId }, from: { id: senderId }, text: '/sessions' } });
      throw new Error('This button is no longer valid. Send /help.');
    } catch (error) {
      await this.reply(chatId, `*ERROR*\n${error.message}`);
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

  async notifyConnected() {
    if (!this.running) return;
    await this.notifyBootstrapOwners(this.connectedImage, '*ANIME MD STATUS*\nWhatsApp connected successfully.');
  }

  async start() {
    if (!this.token || this.running) return false;
    if (typeof this.fetch !== 'function') throw new Error('Telegram controller requires Node.js fetch support.');

    // Long polling cannot receive updates while a webhook is registered. Clear
    // a stale webhook explicitly before polling, while retaining queued updates.
    this.bot = await this.api('getMe', {});
    await this.api('deleteWebhook', { drop_pending_updates: false });
    this.running = true;
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
    await this.notifyBootstrapOwners(this.startImage, '*ANIME MD Telegram controller is online.*\nSend /help to view available commands.');
    return true;
  }

  stop() { this.running = false; }
}

module.exports = { SENSITIVE_COOLDOWN_MS, TelegramController, commandFromUpdate, helpText, menuMarkup, normalizeTelegramId, normalizeWhatsappNumber };
