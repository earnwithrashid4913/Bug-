'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_GROUP_SETTINGS = Object.freeze({
  welcomeEnabled: false,
  goodbyeEnabled: false
});

function normalizeSettings(value) {
  return {
    welcomeEnabled: Boolean(value?.welcomeEnabled),
    goodbyeEnabled: Boolean(value?.goodbyeEnabled)
  };
}

class GroupSettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.write({});
    }
  }

  async read() {
    await this.initialize();
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('group settings database must contain an object');
      }
      return parsed;
    } catch (error) {
      throw new Error(`Unable to read group settings at ${this.filePath}: ${error.message}`);
    }
  }

  async write(data) {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, this.filePath);
  }

  transaction(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async get(groupId) {
    return this.transaction(async () => {
      const groups = await this.read();
      return { ...DEFAULT_GROUP_SETTINGS, ...normalizeSettings(groups[groupId]) };
    });
  }

  async update(groupId, updates) {
    if (!groupId?.endsWith('@g.us')) throw new Error('Group settings require a group JID.');

    return this.transaction(async () => {
      const groups = await this.read();
      const next = { ...DEFAULT_GROUP_SETTINGS, ...normalizeSettings(groups[groupId]), ...updates };
      groups[groupId] = normalizeSettings(next);
      await this.write(groups);
      return groups[groupId];
    });
  }
}

module.exports = {
  DEFAULT_GROUP_SETTINGS,
  GroupSettingsStore
};
