'use strict';

// Integration test: the real index.js Telegram wiring (controller + pairing
// manager + controller store + restore) against a stubbed Telegram Bot API.
// No WhatsApp socket is opened here: the primary bot is in dry-run mode, and
// the pairing path exercised is the input-validation fast fail. Real pairing
// flows are covered by the unit tests with a fake Baileys implementation.

const { displayAssert: assert, normalizeTelegramHeadings } = require('../test-support/telegram-display');
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
// The runtime (validated) configuration the controller is actually built from.
const { config } = require('../system/config');

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
      message(5, 11, '/sessions'),
      message(6, 10, '/start'),
      message(7, 10, '/developer'),
      message(8, 10, '/allmenu'),
      message(9, 10, '/thanks')
    ]);
  }
  return respond(payload);
};

test('the Telegram controller wiring starts, greets with the ANIME MD intro, and serves commands', async () => {
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
  await waitFor((entry) => /ANIME MD • MAIN MENU/.test(normalizeTelegramHeadings(entry.payload.text || entry.payload.caption || '')), 'the anime md intro');
  const greeting = sent.find((entry) => /ANIME MD • MAIN MENU/.test(normalizeTelegramHeadings(entry.payload.text || entry.payload.caption || '')));
  const greetingText = greeting.payload.text || greeting.payload.caption;
  assert.match(greetingText, /🤖 System: Online/);
  assert.doesNotMatch(greetingText, /WhatsApp Connected/);
  assert.ok(/[\u{1D400}-\u{1D7FF}]/u.test(greetingText.split('\n')[0]), 'styled title');
  assert.ok(!/[\u{1D400}-\u{1D7FF}]/u.test(greetingText.split('\n').slice(1).join('\n')), 'body is unchanged');

  // /sessions through the real manager: no sessions yet.
  await waitFor((entry) => entry.method === 'sendMessage' && /ANIME MD • SESSIONS/.test(normalizeTelegramHeadings(entry.payload.text)), '/sessions');
  const sessionsText = sent.find((entry) => /ANIME MD • SESSIONS/.test(normalizeTelegramHeadings(entry.payload.text))).payload.text;
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

  // Unauthorized senders now get verification prompt (functional, not ACCESS DENIED as not authorized)
  // With new architecture, normal users can register via /start, so /sessions for unverified user shows VERIFICATION
  await waitFor((entry) => /not authorized|VERIFICATION|ACCESS BLOCKED/.test(normalizeTelegramHeadings(entry.payload.text || entry.payload.caption || '')), 'authorization');

  // The wired activityLogger delivers a compact ANIME MD • ACTIVITY box to the
  // bootstrap owner for the /start event, with non-sensitive fields only.
  await waitFor((entry) => /ANIME MD • ACTIVITY/.test(normalizeTelegramHeadings(entry.payload.text || '')), 'owner activity box');
  const activity = sent.find((entry) => /ANIME MD • ACTIVITY/.test(normalizeTelegramHeadings(entry.payload.text || '')));
  const activityText = activity.payload.text;
  assert.match(activityText, /⚡ Action: Start/);
  assert.match(activityText, /🆔 ID: 10/);
  assert.match(activityText, /👑 Tier: OWNER/);
  assert.match(activityText, /🔐 Membership: Verified/);

  // The new ANIME MD pages are wired through index.js: the DEVELOPER page uses
  // the configured owner name plus the canonical developer identity, the
  // THANKS TO page uses the same identity, and ALL MENU renders the real
  // WhatsApp command directory with the configured prefix.
  await waitFor((entry) => /ANIME MD • DEVELOPER/.test(normalizeTelegramHeadings(entry.payload.text || '')), '/developer');
  const developerText = sent.find((entry) => /ANIME MD • DEVELOPER/.test(normalizeTelegramHeadings(entry.payload.text || ''))).payload.text;
  assert.match(developerText, /👑 Global Owner/);
  assert.ok(developerText.includes(config.ownerName), 'the configured owner name is shown');
  assert.ok(developerText.includes(config.developerName), 'the canonical developer identity is shown');
  assert.doesNotMatch(developerText, /integration-token|creds|authDir|\.json/, 'no secret or path on the developer page');

  await waitFor((entry) => /ANIME MD • ALL MENU/.test(normalizeTelegramHeadings(entry.payload.text || '')), '/allmenu');
  const allMenuText = sent.find((entry) => /ANIME MD • ALL MENU/.test(normalizeTelegramHeadings(entry.payload.text || ''))).payload.text;
  assert.ok(allMenuText.includes(`⌨️ Prefix: ${config.commandPrefix}`), 'the configured WhatsApp prefix is used');
  assert.match(allMenuText, /🧩 Commands: \d+/);
  assert.doesNotMatch(allMenuText, /undefined|NaN/);

  await waitFor((entry) => /ANIME MD • THANKS TO/.test(normalizeTelegramHeadings(entry.payload.text || '')), '/thanks');
  const thanksText = sent.find((entry) => /ANIME MD • THANKS TO/.test(normalizeTelegramHeadings(entry.payload.text || ''))).payload.text;
  assert.ok(thanksText.includes(config.developerName), 'the thanks page names the real developer');
});

test('cleanup removes the temporary integration directory', async () => {
  globalThis.fetch = realFetch;
  await fs.rm(tempRoot, { recursive: true, force: true });
});
