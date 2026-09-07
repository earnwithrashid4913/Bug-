'use strict';

const { JsonStore } = require('./json-store');

class WarningStore extends JsonStore {
  constructor(filePath) {
    super(filePath, { groups: {} });
  }

  key(groupId, userJid) {
    return `${groupId}:${userJid}`;
  }

  async count(groupId, userJid) {
    const data = await this.read();
    return Number(data.groups?.[this.key(groupId, userJid)]?.count || 0);
  }

  async add(groupId, userJid, reason = 'rule violation') {
    let record;
    await this.update((data) => {
      data.groups = data.groups && typeof data.groups === 'object' && !Array.isArray(data.groups) ? data.groups : {};
      const key = this.key(groupId, userJid);
      const previous = data.groups[key] || { count: 0, history: [] };
      record = {
        count: Number(previous.count || 0) + 1,
        history: [
          ...(Array.isArray(previous.history) ? previous.history : []).slice(-9),
          { reason: String(reason).slice(0, 180), at: Date.now() }
        ]
      };
      data.groups[key] = record;
    });
    return record;
  }

  async remove(groupId, userJid) {
    let removed = false;
    await this.update((data) => {
      data.groups = data.groups || {};
      removed = delete data.groups[this.key(groupId, userJid)];
    });
    return removed;
  }

  async list(groupId) {
    const data = await this.read();
    const prefix = `${groupId}:`;
    return Object.entries(data.groups || {})
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, record]) => ({ userJid: key.slice(prefix.length), count: Number(record?.count || 0) }))
      .sort((a, b) => b.count - a.count);
  }
}

module.exports = { WarningStore };
