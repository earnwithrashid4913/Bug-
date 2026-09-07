'use strict';

const { JsonStore } = require('./json-store');

class RuntimeSettingsStore extends JsonStore {
  constructor(filePath, defaults = {}) {
    super(filePath, () => ({ ...defaults }));
    this.defaults = { ...defaults };
  }

  async getAll() {
    return { ...this.defaults, ...(await this.read()) };
  }

  async get(key) {
    return (await this.getAll())[key];
  }

  async set(key, value) {
    let next;
    await this.update((settings) => {
      settings[key] = value;
      next = settings;
    });
    return next;
  }
}

module.exports = { RuntimeSettingsStore };
