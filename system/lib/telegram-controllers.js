'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseDuration } = require('./premium');
const { normalizeTelegramId } = require('./telegram-controller');

// Persistent Telegram data: authorized controllers, premium users, and the
// runtime pairing settings toggled from the Telegram settings page. Everything
// is stored in one private JSON file (mode 0600, atomic rename) and every
// access runs through a serialized transaction queue so concurrent updates
// can never interleave.

const SETTINGS_KEYS = Object.freeze(['publicMode', 'premiumOnly']);

function normalizePremiumRecords(records) {
  if (!Array.isArray(records)) return [];
  return records
    .filter((record) => record && Number.isSafeInteger(record.expiresAt))
    .map((record) => ({ id: String(record.id ?? '').trim(), expiresAt: record.expiresAt }))
    .filter((record) => /^\d{1,20}$/.test(record.id));
}

class TelegramControllerStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  transaction(operation) { const next = this.queue.then(operation, operation); this.queue = next.catch(() => undefined); return next; }

  async readAll() {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      const controllers = Array.isArray(value?.controllers) ? value.controllers.filter((id) => /^\d{1,20}$/.test(String(id))) : [];
      const premium = normalizePremiumRecords(value?.premium);
      const settings = value?.settings && typeof value.settings === 'object' ? value.settings : {};
      return { controllers, premium, settings };
    } catch (error) {
      if (error.code === 'ENOENT') return { controllers: [], premium: [], settings: {} };
      throw new Error(`Unable to read Telegram controllers: ${error.message}`);
    }
  }

  async writeAll(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }

  async read() {
    return (await this.readAll()).controllers;
  }

  async write(controllers) {
    const { premium, settings } = await this.readAll();
    await this.writeAll({ controllers, premium, settings });
  }

  async has(id) { const normalized = normalizeTelegramId(id); return this.transaction(async () => (await this.readAll()).controllers.includes(normalized)); }
  async add(id) { const normalized = normalizeTelegramId(id); return this.transaction(async () => { const data = await this.readAll(); if (!data.controllers.includes(normalized)) { data.controllers.push(normalized); await this.writeAll(data); } return data.controllers; }); }
  async remove(id) { const normalized = normalizeTelegramId(id); return this.transaction(async () => { const data = await this.readAll(); const next = data.controllers.filter((entry) => entry !== normalized); if (next.length !== data.controllers.length) await this.writeAll({ ...data, controllers: next }); return next.length !== data.controllers.length; }); }

  // ----------------------------- settings ---------------------------------

  // Returns ONLY the keys that were explicitly persisted at runtime, so a
  // fresh store never overrides the config.js boot defaults.
  async getSettings() {
    return this.transaction(async () => {
      const { settings } = await this.readAll();
      const result = {};
      if (typeof settings.publicMode === 'boolean') result.publicMode = settings.publicMode;
      if (typeof settings.premiumOnly === 'boolean') result.premiumOnly = settings.premiumOnly;
      return result;
    });
  }

  async setSetting(key, value) {
    if (!SETTINGS_KEYS.includes(key)) throw new Error(`Unknown Telegram setting: ${key}`);
    return this.transaction(async () => {
      const data = await this.readAll();
      data.settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
      data.settings[key] = Boolean(value);
      await this.writeAll(data);
      return Boolean(value);
    });
  }

  // ------------------------------ premium ---------------------------------

  async listPremium() {
    return this.transaction(async () => {
      const now = Date.now();
      const data = await this.readAll();
      const active = data.premium.filter((record) => record.expiresAt > now);
      if (active.length !== data.premium.length) await this.writeAll({ ...data, premium: active });
      return active.sort((a, b) => a.expiresAt - b.expiresAt);
    });
  }

  async addPremium(id, duration = '30d') {
    const normalized = normalizeTelegramId(id);
    const durationMs = parseDuration(duration);
    return this.transaction(async () => {
      const now = Date.now();
      const data = await this.readAll();
      const index = data.premium.findIndex((record) => record.id === normalized);
      const previousExpiry = index === -1 ? now : Math.max(data.premium[index].expiresAt, now);
      const record = { id: normalized, expiresAt: previousExpiry + durationMs };
      if (index === -1) data.premium.push(record);
      else data.premium[index] = record;
      data.premium = data.premium.filter((entry) => entry.expiresAt > now);
      await this.writeAll(data);
      return record;
    });
  }

  async removePremium(id) {
    const normalized = normalizeTelegramId(id);
    return this.transaction(async () => {
      const now = Date.now();
      const data = await this.readAll();
      const remaining = data.premium.filter((record) => record.id !== normalized && record.expiresAt > now);
      const removed = remaining.length !== data.premium.length;
      if (removed) await this.writeAll({ ...data, premium: remaining });
      return removed;
    });
  }

  async hasPremium(id) {
    const normalized = normalizeTelegramId(id);
    return this.transaction(async () => {
      const now = Date.now();
      const data = await this.readAll();
      const active = data.premium.filter((record) => record.expiresAt > now);
      if (active.length !== data.premium.length) await this.writeAll({ ...data, premium: active });
      const record = active.find((entry) => entry.id === normalized);
      return record ? { premium: true, expiresAt: record.expiresAt } : { premium: false };
    });
  }
}
module.exports = { SETTINGS_KEYS, TelegramControllerStore };
