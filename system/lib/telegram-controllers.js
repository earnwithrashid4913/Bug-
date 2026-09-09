'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseDuration } = require('./premium');
const { normalizeTelegramId } = require('./telegram-controller');

// Persistent Telegram data: authorized controllers, premium users, per-user
// records (verification, temporary blocking, VIP status, paired-number usage),
// and the runtime pairing settings toggled from the Telegram settings page.
// Everything is stored in one private JSON file (mode 0600, atomic rename) and
// every access runs through a serialized transaction queue so concurrent
// updates can never interleave.

const SETTINGS_KEYS = Object.freeze(['publicMode', 'premiumOnly']);

function normalizePremiumRecords(records) {
  if (!Array.isArray(records)) return [];
  return records
    .filter((record) => record && Number.isSafeInteger(record.expiresAt))
    .map((record) => ({ id: String(record.id ?? '').trim(), expiresAt: record.expiresAt }))
    .filter((record) => /^\d{1,20}$/.test(record.id));
}

function normalizeUserRecords(users) {
  const result = {};
  if (!users || typeof users !== 'object' || Array.isArray(users)) return result;
  for (const [id, record] of Object.entries(users)) {
    if (!/^\d{1,20}$/.test(id)) continue;
    if (!record || typeof record !== 'object') continue;
    result[id] = {
      verified: Boolean(record.verified),
      verifiedAt: Number.isSafeInteger(record.verifiedAt) ? record.verifiedAt : undefined,
      blockedAt: Number.isSafeInteger(record.blockedAt) ? record.blockedAt : undefined,
      blockedUntil: Number.isSafeInteger(record.blockedUntil) ? record.blockedUntil : undefined,
      vip: Boolean(record.vip),
      vipExpiresAt: Number.isSafeInteger(record.vipExpiresAt) ? record.vipExpiresAt : undefined,
      pairedNumbers: Array.isArray(record.pairedNumbers)
        ? [...new Set(record.pairedNumbers.map((entry) => String(entry)).filter((entry) => /^\d{7,15}$/.test(entry)))]
        : []
    };
  }
  return result;
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
      const users = normalizeUserRecords(value?.users);
      const result = { controllers, premium, settings };
      if (Object.keys(users).length) result.users = users;
      return result;
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
    const { premium, settings, users } = await this.readAll();
    const data = { controllers, premium, settings };
    if (users && Object.keys(users).length) data.users = users;
    await this.writeAll(data);
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

  // ------------------------------ users ----------------------------------
  // One private record per Telegram user: verification, temporary blocking,
  // VIP status and the unique set of paired numbers. The store is the source
  // of truth for these fields; no ID is ever hardcoded in source.

  async users() {
    return this.transaction(async () => (await this.readAll()).users || {});
  }

  async updateUser(id, patch) {
    const normalized = normalizeTelegramId(id);
    return this.transaction(async () => {
      const data = await this.readAll();
      const allUsers = data.users || {};
      const current = allUsers[normalized] || {};
      const record = {
        ...current,
        ...patch,
        pairedNumbers: Array.isArray(patch?.pairedNumbers) ? patch.pairedNumbers : (Array.isArray(current.pairedNumbers) ? current.pairedNumbers : [])
      };
      if (record.blockedUntil !== undefined && record.blockedUntil <= Date.now()) {
        record.blockedAt = undefined;
        record.blockedUntil = undefined;
      }
      allUsers[normalized] = record;
      data.users = allUsers;
      await this.writeAll(data);
      return record;
    });
  }

  async getUser(id) {
    const normalized = normalizeTelegramId(id);
    return this.transaction(async () => ((await this.readAll()).users || {})[normalized] || undefined);
  }

  async isVerified(id) {
    const record = await this.getUser(id);
    return Boolean(record?.verified);
  }

  async markVerified(id) {
    return this.updateUser(id, { verified: true, verifiedAt: Date.now() });
  }

  // Reads the current block state and auto-restores access once a block has
  // expired (blockedUntil <= now). No manual administrative action is needed.
  async blockStatus(id) {
    const record = await this.getUser(id);
    if (!record) return { blocked: false };
    if (record.blockedUntil !== undefined && record.blockedUntil <= Date.now()) {
      await this.updateUser(id, { blockedAt: undefined, blockedUntil: undefined });
      return { blocked: false };
    }
    if (record.blockedUntil === undefined) return { blocked: false };
    return {
      blocked: true,
      blockedAt: record.blockedAt,
      blockedUntil: record.blockedUntil,
      remainingMs: Math.max(0, record.blockedUntil - Date.now())
    };
  }

  async setBlocked(id, durationMs) {
    const now = Date.now();
    return this.updateUser(id, { blockedAt: now, blockedUntil: now + durationMs });
  }

  async clearBlocked(id) {
    return this.updateUser(id, { blockedAt: undefined, blockedUntil: undefined });
  }

  async setVip(id, expiresAt) {
    return this.updateUser(id, { vip: true, vipExpiresAt: expiresAt });
  }

  async removeVip(id) {
    return this.updateUser(id, { vip: false, vipExpiresAt: undefined });
  }

  async vipStatus(id) {
    const record = await this.getUser(id);
    if (!record?.vip) return { vip: false };
    if (record.vipExpiresAt === undefined || record.vipExpiresAt > Date.now()) return { vip: true, expiresAt: record.vipExpiresAt };
    await this.updateUser(id, { vip: false, vipExpiresAt: undefined });
    return { vip: false };
  }

  async pairedNumbersOf(id) {
    const record = await this.getUser(id);
    return Array.isArray(record?.pairedNumbers) ? [...record.pairedNumbers] : [];
  }

  async addPairedNumber(id, number) {
    const normalized = normalizeTelegramId(id);
    const canonical = String(number ?? '').replace(/\D/g, '');
    if (!/^\d{7,15}$/.test(canonical)) return this.getUser(id);
    const record = await this.getUser(normalized);
    const current = Array.isArray(record?.pairedNumbers) ? record.pairedNumbers : [];
    if (current.includes(canonical)) return record;
    return this.updateUser(normalized, { pairedNumbers: [...current, canonical] });
  }

  async removePairedNumber(id, number) {
    const normalized = normalizeTelegramId(id);
    const canonical = String(number ?? '').replace(/\D/g, '');
    const record = await this.getUser(normalized);
    const current = Array.isArray(record?.pairedNumbers) ? record.pairedNumbers : [];
    if (!current.includes(canonical)) return record;
    return this.updateUser(normalized, { pairedNumbers: current.filter((entry) => entry !== canonical) });
  }

  async clearPairedNumbers(id) {
    return this.updateUser(id, { pairedNumbers: [] });
  }
}
module.exports = { SETTINGS_KEYS, TelegramControllerStore };
