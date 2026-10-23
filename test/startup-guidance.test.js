'use strict';

// The primary socket is idle when no session exists in pairing mode. These
// tests pin the guidance that replaced the contradictory "Telegram Pairing owns
// new sessions" line printed while Telegram was disabled.

const assert = require('node:assert/strict');
const test = require('node:test');

require('../config').deployment.dryRun = true;
const { primaryIdleGuidance } = require('../index');

test('Telegram-ready projects keep the pairing instruction', () => {
  const guidance = primaryIdleGuidance({ telegramReady: true });
  assert.equal(guidance.ready, true);
  assert.match(guidance.message, /authorized Telegram controller/);
  assert.equal(guidance.fix, '');
});

test('pairing mode without Telegram explains every real fix instead of a dead end', () => {
  const guidance = primaryIdleGuidance({ telegramReady: false });
  assert.equal(guidance.ready, false);
  assert.match(guidance.message, /cannot connect/);
  assert.match(guidance.fix, /telegram\.enabled=true/);
  assert.match(guidance.fix, /whatsapp\.authMethod="qr"/);
  assert.match(guidance.fix, /whatsapp\.sessionId/);
  assert.match(guidance.fix, /stays online/);
});
