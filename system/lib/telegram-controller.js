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
  const number = String(value ?? '').replace(/\D/g, '');
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
    '/addowner <telegram_id> — authorize another controller',
    '/delowner <telegram_id> — remove an added controller',
    '/stop <number> — remove the unpaired session for that number',
    '/status — show controller and WhatsApp health',
    '/help <text> — show controller help'
  ].join('\n');
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

  async reply(chatId, text) {
    return this.api('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
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
          return;
        case 'pair': {
          this.reserveSensitiveRequest(command.senderId);
          const number = normalizeWhatsappNumber(command.args[0]);
          const code = await this.pairing.requestPairing(number);
          await this.reply(command.chatId, `*PAIRING CODE*\nNumber: ${number}\nCode: \`${code}\``);
          return;
        }
        case 'sessions': {
          const status = await this.pairing.getStatus();
          const number = status.botUser?.replace(/\D/g, '') || status.pairingNumber || 'none';
          await this.reply(command.chatId, `*ACTIVE SESSIONS*\n1. ${number}\nStatus: ${status.state}\nSession: ${status.session}`);
          return;
        }
        case 'status': {
          const status = await this.pairing.getStatus();
          const text = `*ANIME MD STATUS*\nWhatsApp: ${status.state}\nConnected: ${status.connected ? 'yes' : 'no'}\nUptime: ${Math.floor((Date.now() - status.startedAt) / 1000)} seconds`;
          if (status.connected) await this.replyPhoto(command.chatId, this.connectedImage, text);
          else await this.reply(command.chatId, text);
          return;
        }
        case 'addowner': {
          this.reserveSensitiveRequest(command.senderId);
          const id = normalizeTelegramId(command.args[0]);
          await this.controllerStore.add(id);
          await this.reply(command.chatId, `*SUCCESS*\nTelegram controller ${id} authorized.`);
          return;
        }
        case 'delowner': {
          this.reserveSensitiveRequest(command.senderId);
          const id = normalizeTelegramId(command.args[0]);
          if (this.bootstrapOwners.has(id)) throw new Error('Bootstrap owners are configured through TELEGRAM_OWNER_IDS and cannot be removed at runtime.');
          const removed = await this.controllerStore.remove(id);
          await this.reply(command.chatId, removed ? `*SUCCESS*\nTelegram controller ${id} removed.` : `*INFO*\nTelegram controller ${id} was not stored.`);
          return;
        }
        case 'stop': {
          this.reserveSensitiveRequest(command.senderId);
          const number = normalizeWhatsappNumber(command.args[0]);
          await this.pairing.stopSession(number);
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

  async pollOnce() {
    const updates = await this.api('getUpdates', { offset: this.offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ['message'] });
    for (const update of updates) {
      this.offset = Math.max(this.offset, Number(update.update_id) + 1);
      await this.handleUpdate(update);
    }
  }

  start() {
    if (!this.token || this.running) return;
    if (typeof this.fetch !== 'function') throw new Error('Telegram controller requires Node.js fetch support.');
    this.running = true;
    this.pollPromise = (async () => {
      while (this.running) {
        try { await this.pollOnce(); } catch (error) {
          this.log.error?.(`[telegram] Poll failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
    })();
    this.log.info?.('[telegram] Authorized Telegram controller started.');
  }

  stop() { this.running = false; }
}

module.exports = { SENSITIVE_COOLDOWN_MS, TelegramController, commandFromUpdate, helpText, normalizeTelegramId, normalizeWhatsappNumber };
