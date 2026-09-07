'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeTelegramId } = require('./telegram-controller');

class TelegramControllerStore {
  constructor(filePath) { this.filePath = filePath; this.queue = Promise.resolve(); }
  transaction(operation) { const next = this.queue.then(operation, operation); this.queue = next.catch(() => undefined); return next; }
  async read() {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return Array.isArray(value?.controllers) ? value.controllers.filter((id) => /^\d{1,20}$/.test(String(id))) : [];
    } catch (error) { if (error.code === 'ENOENT') return []; throw new Error(`Unable to read Telegram controllers: ${error.message}`); }
  }
  async write(controllers) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ controllers }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }
  async has(id) { const normalized = normalizeTelegramId(id); return this.transaction(async () => (await this.read()).includes(normalized)); }
  async add(id) { const normalized = normalizeTelegramId(id); return this.transaction(async () => { const ids = await this.read(); if (!ids.includes(normalized)) { ids.push(normalized); await this.write(ids); } return ids; }); }
  async remove(id) { const normalized = normalizeTelegramId(id); return this.transaction(async () => { const ids = await this.read(); const next = ids.filter((entry) => entry !== normalized); if (next.length !== ids.length) await this.write(next); return next.length !== ids.length; }); }
}
module.exports = { TelegramControllerStore };
