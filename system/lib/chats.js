'use strict';

// ---------------------------------------------------------------------------
// Known-chat registry.
//
// `!broadcast` needs a list of destinations. Rather than inventing one, the bot
// remembers every chat it has actually seen a message in. The registry is
// loaded once at startup and written only when a NEW chat appears, so the hot
// message path never touches the disk.
// ---------------------------------------------------------------------------

const { JsonStore } = require('./json-store');

// Broadcast targets are real conversations; transient server JIDs are not.
const BROADCASTABLE_SUFFIXES = Object.freeze(['@s.whatsapp.net', '@g.us', '@lid']);
const MAX_TRACKED_CHATS = 5_000;

class ChatStore extends JsonStore {
  constructor(filePath) {
    super(filePath, { chats: [] });
    this.known = new Set();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this.known;
    this.loaded = true;
    try {
      const data = await this.read();
      for (const chat of Array.isArray(data.chats) ? data.chats : []) {
        if (typeof chat === 'string') this.known.add(chat);
      }
    } catch {
      // An unreadable registry only limits broadcast reach; it must never stop
      // the message pipeline.
      this.known = new Set();
    }
    return this.known;
  }

  isBroadcastable(chatId) {
    return typeof chatId === 'string' && BROADCASTABLE_SUFFIXES.some((suffix) => chatId.endsWith(suffix));
  }

  // Records a chat the bot has seen. Returns true when the registry changed.
  async track(chatId) {
    if (!this.isBroadcastable(chatId)) return false;
    await this.load();
    if (this.known.has(chatId)) return false;
    this.known.add(chatId);
    const chats = [...this.known].slice(-MAX_TRACKED_CHATS);
    this.known = new Set(chats);
    try {
      await this.write({ chats });
    } catch {
      /* the in-memory set still serves this process lifetime */
    }
    return true;
  }

  async list() {
    await this.load();
    return [...this.known];
  }
}

module.exports = { BROADCASTABLE_SUFFIXES, ChatStore, MAX_TRACKED_CHATS };
