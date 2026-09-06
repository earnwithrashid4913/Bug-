'use strict';

// Connection semantics exported by index.js. The module is loaded in dry-run
// mode so no WhatsApp socket or dashboard server is opened.

process.env.BOT_DRY_RUN = 'true';
process.env.OWNER_NAME = 'F!xa Dev';
process.env.BOT_NUMBER = '923001234567';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Boom } = require('@hapi/boom');
const { DisconnectReason } = require('@whiskeysockets/baileys');

const {
  IGNORED_PROCESS_ERRORS,
  decodeJid,
  disconnectStatusCode,
  formatPairingCode,
  shouldReconnect
} = require('../index');

test('a logged-out or invalid session never triggers automatic reconnection', () => {
  assert.equal(shouldReconnect(DisconnectReason.loggedOut), false);
  assert.equal(shouldReconnect(DisconnectReason.badSession), false);
  assert.equal(shouldReconnect(DisconnectReason.connectionReplaced), false);
  assert.equal(DisconnectReason.loggedOut, 401, 'WhatsApp reports logout as HTTP 401');
});

test('transient disconnects do reconnect', () => {
  for (const reason of [
    DisconnectReason.connectionClosed,
    DisconnectReason.connectionLost,
    DisconnectReason.restartRequired,
    DisconnectReason.timedOut,
    undefined
  ]) {
    assert.equal(shouldReconnect(reason), true, `expected reconnect for ${reason}`);
  }
});

test('the disconnect status code is read from a Boom or a raw error', () => {
  assert.equal(disconnectStatusCode({ error: new Boom('x', { statusCode: 401 }) }), 401);
  assert.equal(disconnectStatusCode({ error: { output: { statusCode: 408 } } }), 408);
  assert.equal(disconnectStatusCode({}), undefined);
  assert.equal(disconnectStatusCode(undefined), undefined);
});

test('pairing codes are grouped in fours like the reference bot', () => {
  assert.equal(formatPairingCode('ABCDEFGH'), 'ABCD-EFGH');
  assert.equal(formatPairingCode('ABC'), 'ABC');
  assert.equal(formatPairingCode(undefined), undefined);
});

test('known WhatsApp socket noise is filtered instead of killing the process', () => {
  for (const needle of ['conflict', 'not-authorized', 'rate-overlimit', 'Connection Closed', 'Timed Out']) {
    assert.ok(IGNORED_PROCESS_ERRORS.includes(needle), `expected ${needle} to be ignored`);
  }
});

test('device JIDs are decoded to their address part', () => {
  assert.equal(decodeJid('923001234567:12@s.whatsapp.net'), '923001234567@s.whatsapp.net');
  assert.equal(decodeJid('923001234567@s.whatsapp.net'), '923001234567@s.whatsapp.net');
  assert.equal(decodeJid('123456789@g.us'), '123456789@g.us');
  assert.equal(decodeJid(undefined), undefined);
});
