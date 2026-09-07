'use strict';

// Persisted bot mode (public / self).
//
// The persisted mode store lets `!public` and `!self`
// survive a restart. The same behaviour is implemented here on top of the
// atomic-write JSON pattern already used for premium and group records.

const fs = require('node:fs/promises');
const path = require('node:path');

const MODES = Object.freeze(['public', 'self']);

function normalizeMode(value, fallback) {
  return MODES.includes(value) ? value : fallback;
}

class BotModeStore {
  constructor(filePath, fallbackMode = 'public') {
    this.filePath = filePath;
    this.fallbackMode = normalizeMode(fallbackMode, 'public');
    this.queue = Promise.resolve();
  }

  async write(mode) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify({ mode }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, this.filePath);
  }

  transaction(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async get() {
    return this.transaction(async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
        return normalizeMode(parsed?.mode, this.fallbackMode);
      } catch {
        return this.fallbackMode;
      }
    });
  }

  async set(mode) {
    const next = normalizeMode(mode, this.fallbackMode);
    return this.transaction(async () => {
      await this.write(next);
      return next;
    });
  }
}

module.exports = { BotModeStore, MODES, normalizeMode };
