'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizePhoneNumber } = require('../config');

const DURATION_UNITS = Object.freeze({
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
});
const MAX_PREMIUM_DURATION_MS = 366 * DURATION_UNITS.d;

function parseDuration(value) {
  const match = /^(\d{1,3})\s*([smhd])$/i.exec(String(value || '').trim());
  if (!match) {
    throw new Error('Duration must use a whole number followed by s, m, h, or d (for example: 30d).');
  }

  const milliseconds = Number(match[1]) * DURATION_UNITS[match[2].toLowerCase()];
  if (milliseconds > MAX_PREMIUM_DURATION_MS) {
    throw new Error('Premium duration cannot be longer than 366 days in one command.');
  }
  return milliseconds;
}

function validateRecords(records) {
  if (!Array.isArray(records)) throw new Error('Premium database must contain a JSON array.');

  return records
    .filter((record) => record && typeof record.id === 'string' && Number.isSafeInteger(record.expiresAt))
    .map((record) => ({ id: normalizePhoneNumber(record.id, 'Premium user ID'), expiresAt: record.expiresAt }));
}

class PremiumStore {
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
      await this.write([]);
    }
  }

  async read() {
    await this.initialize();
    const raw = await fs.readFile(this.filePath, 'utf8');
    try {
      return validateRecords(JSON.parse(raw));
    } catch (error) {
      throw new Error(`Unable to read premium database at ${this.filePath}: ${error.message}`);
    }
  }

  async write(records) {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, this.filePath);
  }

  transaction(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list() {
    return this.transaction(async () => {
      const records = await this.read();
      const active = records.filter((record) => record.expiresAt > Date.now());
      if (active.length !== records.length) await this.write(active);
      return active.sort((a, b) => a.expiresAt - b.expiresAt);
    });
  }

  async add(phoneNumber, duration) {
    const id = normalizePhoneNumber(phoneNumber, 'Premium user number');
    const durationMs = parseDuration(duration);

    return this.transaction(async () => {
      const records = await this.read();
      const now = Date.now();
      const index = records.findIndex((record) => record.id === id);
      const previousExpiry = index === -1 ? now : Math.max(records[index].expiresAt, now);
      const record = { id, expiresAt: previousExpiry + durationMs };

      if (index === -1) records.push(record);
      else records[index] = record;

      await this.write(records.filter((entry) => entry.expiresAt > now));
      return record;
    });
  }

  async remove(phoneNumber) {
    const id = normalizePhoneNumber(phoneNumber, 'Premium user number');

    return this.transaction(async () => {
      const records = await this.read();
      const now = Date.now();
      const removed = records.some((record) => record.id === id && record.expiresAt > now);
      const remaining = records.filter((record) => record.id !== id && record.expiresAt > now);
      if (remaining.length !== records.length) await this.write(remaining);
      return removed;
    });
  }
}

module.exports = {
  PremiumStore,
  parseDuration
};
