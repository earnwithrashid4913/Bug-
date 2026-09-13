'use strict';

const { safeReact, safePresence } = require('./safe-send');
const { JsonStore } = require('./json-store');

class AutomationStore extends JsonStore {
  constructor(filePath) {
    super(filePath, { global: { autostatus: false }, chats: {} });
  }

  async getGlobal(key) {
    const data = await this.read();
    return Boolean(data.global?.[key]);
  }

  async setGlobal(key, value) {
    await this.update((data) => {
      data.global = data.global && typeof data.global === 'object' ? data.global : {};
      data.global[key] = Boolean(value);
    });
    return Boolean(value);
  }

  async getChat(chatId, key) {
    const data = await this.read();
    return Boolean(data.chats?.[chatId]?.[key]);
  }

  async setChat(chatId, key, value) {
    await this.update((data) => {
      data.chats = data.chats && typeof data.chats === 'object' ? data.chats : {};
      data.chats[chatId] = data.chats[chatId] || {};
      data.chats[chatId][key] = Boolean(value);
    });
    return Boolean(value);
  }
}

module.exports = { AutomationStore };

const DEFAULT_EMOJIS = ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','🤭','💗','💓','💞','💕','💘','💝','💟','⭐','🎉','😍','🥰','😘','😻','🥹','😚','😙','😗','😽','🫶','🥺','☺️','😊','🥴','😳','🫣','🤭','😏','😈','👼','💋','👄','👅','🫦','🍑','🍒','🍆','🌶️','💦','🔥','🥵','😮‍💨','🤤','😝','😜','🤪','😛','😋','🫠','💨','💏','💑','👩‍❤️‍👨','👩‍❤️‍👩','👨‍❤️‍👨','👩‍❤️‍💋‍👨','👩‍❤️‍💋‍👩','👨‍❤️‍💋‍👨','💌','💐','🌸','🌹','🌺','🌷','🌻','💐','🎁','🍫','🍬','🍭','🍷','🥂','🍾','🕯️','✨','⭐','💫','🌟','🎆','🎇','🐱','🐶','🦊','🐼','🐸','🍌','🥑','🍩','🎈','🪄','🤡','👻','💩','🐙','🦄','🐝','🦋','🐞','🐥','🐣','🌙','🌃','🌌','🎵','🎶','💭','💤','🛏️','🚿','🪞','🧸','🎀','👠','💎','👑','🧴','🕶️','🎭','🔞','🤫'];
async function handleAutoReact(socket, context, store) {
  if (!context.isGroup || context.fromMe) return;
  const data = await store.read();
  const chat = data.chats?.[context.chatId];
  if (!chat?.autoreact) return;
  const emojis = chat.emojis?.length ? chat.emojis : DEFAULT_EMOJIS;
  await safeReact(socket, context.chatId, context.raw, emojis[Math.floor(Math.random() * emojis.length)]);
}
async function handleAutowriteMessage(socket, context, store) {
  if (context.fromMe || context.chatId === 'status@broadcast') return;
  if (!(await store.getChat(context.chatId, 'autowrite'))) return;
  try {
    await safePresence(socket, context.chatId, 'composing');
    await new Promise(resolve => setTimeout(resolve, 2000));
  } finally { await safePresence(socket, context.chatId, 'paused'); }
}
async function handleAutoStatus(socket, status, store) {
  const data = await store.read();
  const settings = data.global || {};
  if (!settings.autostatus && !settings.statusReact) return;
  for (const msg of status.messages || [status]) {
    if (msg.key?.remoteJid !== 'status@broadcast' || msg.key.fromMe) continue;
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (settings.autostatus) await socket.readMessages([msg.key]);
    if (settings.statusReact) await reactToStatus(socket, msg.key, settings.statusEmoji || '❤️');
  }
}
async function reactToStatus(socket, key, emoji) {
  if (!key.participant) throw new Error('Status author is missing');
  await socket.sendMessage('status@broadcast', { react: { text: emoji, key } }, { statusJidList: [key.participant] });
}
Object.assign(module.exports, { DEFAULT_EMOJIS, handleAutoReact, handleAutowriteMessage, handleAutoStatus, reactToStatus });
