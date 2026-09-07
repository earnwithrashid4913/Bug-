'use strict';

const { JsonStore } = require('./json-store');

const DAILY_REWARD = 500;
const WORK_MIN = 80;
const WORK_MAX = 220;

function normalizeUser(value = {}) {
  const balance = Number.isFinite(Number(value.balance)) ? Math.max(0, Math.floor(Number(value.balance))) : 0;
  return {
    balance,
    bank: Number.isFinite(Number(value.bank)) ? Math.max(0, Math.floor(Number(value.bank))) : 0,
    xp: Number.isFinite(Number(value.xp)) ? Math.max(0, Math.floor(Number(value.xp))) : 0,
    lastDaily: Number(value.lastDaily || 0),
    lastWork: Number(value.lastWork || 0),
    inventory: value.inventory && typeof value.inventory === 'object' && !Array.isArray(value.inventory) ? value.inventory : {}
  };
}

class EconomyStore extends JsonStore {
  constructor(filePath) {
    super(filePath, { users: {} });
  }

  async get(userJid) {
    const data = await this.read();
    return normalizeUser(data.users?.[userJid]);
  }

  async mutate(userJid, mutator) {
    let result;
    await this.update((data) => {
      data.users = data.users && typeof data.users === 'object' && !Array.isArray(data.users) ? data.users : {};
      data.users[userJid] = normalizeUser(data.users[userJid]);
      result = mutator(data.users[userJid]);
      data.users[userJid] = normalizeUser(data.users[userJid]);
    });
    return result;
  }

  async daily(userJid) {
    return this.mutate(userJid, (user) => {
      const now = Date.now();
      const elapsed = now - user.lastDaily;
      if (elapsed < 20 * 60 * 60 * 1000) {
        return { ok: false, waitMs: 20 * 60 * 60 * 1000 - elapsed, user };
      }
      user.balance += DAILY_REWARD;
      user.xp += 25;
      user.lastDaily = now;
      return { ok: true, amount: DAILY_REWARD, user };
    });
  }

  async work(userJid) {
    return this.mutate(userJid, (user) => {
      const now = Date.now();
      const elapsed = now - user.lastWork;
      if (elapsed < 15 * 60 * 1000) {
        return { ok: false, waitMs: 15 * 60 * 1000 - elapsed, user };
      }
      const amount = WORK_MIN + Math.floor(Math.random() * (WORK_MAX - WORK_MIN + 1));
      user.balance += amount;
      user.xp += 10;
      user.lastWork = now;
      return { ok: true, amount, user };
    });
  }

  async transfer(fromJid, toJid, amount) {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter a positive whole amount.');
    return this.update((data) => {
      data.users = data.users || {};
      const from = normalizeUser(data.users[fromJid]);
      const to = normalizeUser(data.users[toJid]);
      if (from.balance < amount) throw new Error('You do not have enough coins in your wallet.');
      from.balance -= amount;
      to.balance += amount;
      data.users[fromJid] = from;
      data.users[toJid] = to;
      return { amount, from, to };
    });
  }
}

module.exports = { DAILY_REWARD, EconomyStore, WORK_MAX, WORK_MIN, normalizeUser };
