'use strict';

const { JsonStore } = require('./json-store');
const { normalizePhoneNumber } = require('../config');

class SudoStore extends JsonStore {
  constructor(filePath) {
    super(filePath, { users: [] });
  }

  async read() {
    const data = await super.read();
    return {
      users: [...new Set((Array.isArray(data.users) ? data.users : [])
        .map((entry) => String(entry || '').replace(/\D/g, ''))
        .filter((entry) => /^\d{7,15}$/.test(entry)))]
    };
  }

  async add(number) {
    const normalized = normalizePhoneNumber(number, 'Sudo number');
    const data = await this.update((store) => {
      const users = new Set(Array.isArray(store.users) ? store.users : []);
      users.add(normalized);
      store.users = [...users].sort();
    });
    return { id: normalized, users: data.users };
  }

  async remove(number) {
    const normalized = normalizePhoneNumber(number, 'Sudo number');
    let removed = false;
    const data = await this.update((store) => {
      const users = new Set(Array.isArray(store.users) ? store.users : []);
      removed = users.delete(normalized);
      store.users = [...users].sort();
    });
    return { id: normalized, removed, users: data.users };
  }

  async list() {
    return (await this.read()).users;
  }

  async has(number) {
    const normalized = String(number || '').replace(/\D/g, '');
    return (await this.list()).includes(normalized);
  }
}

module.exports = { SudoStore };
