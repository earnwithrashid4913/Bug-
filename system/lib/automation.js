'use strict';

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
