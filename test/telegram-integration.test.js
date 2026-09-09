'use strict';

// Integration test: the real index.js Telegram wiring (controller + pairing
// manager + controller store + restore) against a stubbed Telegram Bot API.
// No WhatsApp socket is opened here: the primary bot is in dry-run mode, and
// the pairing path exercised is the input-validation fast fail. Real pairing
// flows are covered by the unit tests with a fake Baileys implementation.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'anime-md-integration-'));

const userConfig = require('../config');
userConfig.deployment.dryRun = true;
userConfig.whatsapp.authDir = path.join(tempRoot, 'session');
userConfig.database.dataDir = path.join(tempRoot, 'data');
userConfig.telegram.enabled = true;
userConfig.telegram.botToken = 'integration-token';
userConfig.telegram.ownerIds = ['10'];

const index = require('../index');

// A Telegram API stub: getMe/deleteWebhook succeed, the first getUpdates
// delivers a batch of commands, and later polls never resolve so the poller
// parks without holding any OS handles.
const sent = [];
let firstPoll = true;
const parked = new Promise(() => {});
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop();
  const payload = JSON.parse(init.body);
  sent.push({ method, payload });
  const respond = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
  if (method === 'getMe') return respond({ username: 'AnimeMdBot' });
  if (method === 'deleteWebhook') return respond(true);
  if (method === 'getUpdates') {
    if (!firstPoll) return { ok: true, json: async () => parked };
    firstPoll = false;
    const message = (id, from, text) => ({ update_id: id, message: { chat: { id: from }, from: { id: from }, text } });
    return respond([
      message(1, 10, '/sessions'),
      message(2, 10, '/status'),
      message(3, 10, '/pair 123'),
      message(4, 10, '/restart 923001234567'),
      message(5, 11, '/sessions')
    ]);
  }
  return respond(payload);
};

test('the Telegram controller wiring starts, greets with the Gojo intro, and serves commands', async () => {
  const waitFor = async (predicate, label) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (sent.some(predicate)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`timed out waiting for ${label}`);
  };

  await index.startTelegramController();

  // The startup greeting reaches the configured bootstrap owner first
  // (as a photo caption because a start image is configured).
  await waitFor((entry) => /𝙂𝙊𝙅𝙊\ 𝙄𝙎\ 𝙃𝙀𝙍𝙀\./.test(entry.payload.text || entry.payload.caption || ''), 'the anime md intro');
  const greeting = sent.find((entry) => /𝙂𝙊𝙅𝙊\ 𝙄𝙎\ 𝙃𝙀𝙍𝙀\./.test(entry.payload.text || entry.payload.caption || ''));
  const greetingText = greeting.payload.text || greeting.payload.caption;
  assert.match(greetingText, /🟢\ 𝙎𝙔𝙎𝙏𝙀𝙈\ 𝙍𝙀𝘼𝘿𝙔/);
  assert.doesNotMatch(greetingText, /WhatsApp Connected/);

  // /sessions through the real manager: no sessions yet.
  await waitFor((entry) => entry.method === 'sendMessage' && /ANIME MD • SESSIONS/.test(entry.payload.text), '/sessions');
  const sessionsText = sent.find((entry) => /ANIME MD • SESSIONS/.test(entry.payload.text)).payload.text;
  assert.match(sessionsText, /No sessions yet/);

  // /status never claims a WhatsApp connection.
  await waitFor((entry) => /WhatsApp sessions: 0/.test(entry.payload.text || ''), '/status');
  const statusText = sent.find((entry) => /WhatsApp sessions: 0/.test(entry.payload.text || '')).payload.text;
  assert.match(statusText, /Telegram online ≠ WhatsApp connected/);

  // /pair with an invalid number fails fast with a friendly box and no socket.
  await waitFor((entry) => /number format is invalid/.test(entry.payload.text || ''), '/pair rejection');

  // /restart for an unknown number explains NOT_FOUND through the real manager
  // (raw errors stay in the log; the box shows the friendly mapped text).
  await waitFor((entry) => /No session found for that number/.test(entry.payload.text || ''), '/restart rejection');

  // Unauthorized senders are denied by the real controller.
  await waitFor((entry) => /not authorized/.test(entry.payload.text || ''), 'authorization');
});

test('cleanup removes the temporary integration directory', async () => {
  globalThis.fetch = realFetch;
  await fs.rm(tempRoot, { recursive: true, force: true });
});
