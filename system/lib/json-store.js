'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class JsonStore {
  constructor(filePath, fallback) {
    this.filePath = path.resolve(filePath);
    this.fallback = typeof fallback === 'function' ? fallback : () => structuredClone(fallback);
    this.queue = Promise.resolve();
  }

  transaction(operation) {
    const next = this.queue.then(() => operation());
    this.queue = next.catch(() => undefined);
    return next;
  }

  async read() {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return value && typeof value === 'object' ? value : this.fallback();
    } catch (error) {
      if (error.code === 'ENOENT') return this.fallback();
      throw new Error(`Unable to read ${path.basename(this.filePath)}: ${error.message}`);
    }
  }

  async write(value) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    return value;
  }

  async update(mutator) {
    return this.transaction(async () => {
      const current = await this.read();
      const next = await mutator(current) || current;
      await this.write(next);
      return next;
    });
  }
}

module.exports = { JsonStore };
