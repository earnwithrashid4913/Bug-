'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TelegramController,
  adminPanelMarkup,
  groupStartMarkup,
  pollRetryDelay
} = require('../system/lib/telegram-controller');

function store(overrides = {}) {
  return {
    has: async () => false,
    getSettings: async () => ({}),
    getUser: async () => undefined,
    updateUser: async () => ({}),
    pairedNumbersOf: async () => [],
    isVerified: async () => true,
    blockStatus: async () => ({ blocked: false }),
    users: async () => ({}),
    ...overrides
  };
}

function pairing() {
  return {
    listSessions: async () => [],
    listAllSessions: async () => [],
    queuedPairingCount: () => 0
  };
}

function success(result = {}) {
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
}

test('group join event shows a safe direct Start-and-Pair deep-link and ignores the bot itself', async () => {
  const calls = [];
  const controller = new TelegramController({
    token: 'test-token',
    owners: ['10'],
    controllerStore: store(),
    pairing: pairing(),
    fetchImpl: async (url, init) => {
      const method = url.split('/').at(-1);
      calls.push({ method, payload: JSON.parse(init.body) });
      return success({});
    },
    log: { info() {}, warn() {}, error() {} }
  });
  controller.bot = { id: 99, username: 'AnimeMdBot' };

  await controller.handleUpdate({
    message: {
      message_id: 77,
      chat: { id: -100123, type: 'supergroup' },
      new_chat_members: [
        { id: 42, first_name: 'New\nMember' },
        { id: 99, first_name: 'ANIME MD' }
      ]
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
  assert.match(calls[0].payload.text, /Welcome, New Member/);
  assert.match(calls[0].payload.text, /private chat/);
  assert.deepEqual(calls[0].payload.reply_markup, groupStartMarkup('AnimeMdBot'));
  assert.equal(calls[0].payload.reply_parameters.message_id, 77);
});

test('telegram poll retries a transient fetch failure once with recovery backoff and never overlaps polls', async () => {
  const warnings = [];
  let updateCalls = 0;
  let controller;
  controller = new TelegramController({
    token: 'test-token',
    owners: ['10'],
    controllerStore: store(),
    pairing: pairing(),
    random: () => 0,
    fetchImpl: async (url, init) => {
      const method = url.split('/').at(-1);
      if (method === 'getMe') return success({ id: 99, username: 'AnimeMdBot' });
      if (method === 'deleteWebhook' || method === 'sendMessage') return success({});
      if (method === 'getUpdates') {
        updateCalls += 1;
        if (updateCalls === 1) throw new TypeError('fetch failed');
        controller.stop();
        return success([]);
      }
      return success({});
    },
    log: { info() {}, warn: (line) => warnings.push(line), error() {} }
  });

  await controller.start();
  await controller.pollPromise;
  assert.equal(updateCalls, 2);
  assert.equal(controller.pollRetryAttempts, 0, 'a successful recovery resets the retry counter');
  assert.ok(warnings.some((line) => /Poll failed \(NETWORK\); recovery retry 1/.test(line)));
  assert.equal(pollRetryDelay(1, () => 0), 800, 'the jittered retry stays bounded and deterministic');
});

test('telegram poll stops on permanent authorization failure instead of retrying a bad token forever', async () => {
  const errors = [];
  let updateCalls = 0;
  const controller = new TelegramController({
    token: 'test-token',
    owners: ['10'],
    controllerStore: store(),
    pairing: pairing(),
    fetchImpl: async (url) => {
      const method = url.split('/').at(-1);
      if (method === 'getMe') return success({ id: 99, username: 'AnimeMdBot' });
      if (method === 'deleteWebhook' || method === 'sendMessage') return success({});
      if (method === 'getUpdates') {
        updateCalls += 1;
        return { ok: false, status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) };
      }
      return success({});
    },
    log: { info() {}, warn() {}, error: (line) => errors.push(line) }
  });

  await controller.start();
  await controller.pollPromise;
  assert.equal(updateCalls, 1);
  assert.equal(controller.running, false);
  assert.ok(errors.some((line) => /Polling stopped \(AUTH, HTTP 401\)/.test(line)));
});

test('pairing settings are not marked loaded or changed in memory when persistent storage fails', async () => {
  let reads = 0;
  const controller = new TelegramController({
    token: 'test-token',
    owners: ['10'],
    publicMode: false,
    premiumOnly: false,
    controllerStore: store({
      getSettings: async () => {
        reads += 1;
        if (reads === 1) throw new Error('temporary storage failure');
        return { publicMode: true, premiumOnly: true };
      },
      setSetting: async () => { throw new Error('disk full'); }
    }),
    pairing: pairing(),
    log: { info() {}, warn() {}, error() {} }
  });

  await assert.rejects(controller.loadSettings(), /temporary storage failure/);
  assert.equal(controller.settingsLoaded, false);
  await controller.loadSettings();
  assert.equal(controller.settingsLoaded, true);
  assert.equal(controller.publicMode, true);
  assert.equal(controller.premiumOnly, true);
  await assert.rejects(controller.persistSetting('publicMode', false), /disk full/);
  assert.equal(controller.publicMode, true, 'failed writes keep the previously persisted runtime state');
});

test('the bootstrap owner sees Public/Premium controls inside the Admin panel without exposing them to runtime controllers', () => {
  const ownerButtons = adminPanelMarkup({ configuration: true }).inline_keyboard.flat().map((button) => button.callback_data);
  const controllerButtons = adminPanelMarkup().inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(ownerButtons.includes('admin:config'));
  assert.ok(!controllerButtons.includes('admin:config'));
});
