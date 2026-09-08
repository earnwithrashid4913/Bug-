'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  NumberFormatError,
  formatInternationalNumber,
  formatPairingCodeDisplay,
  normalizeWhatsAppNumber,
  splitCountryCode
} = require('../system/lib/pairing-number');
const { loadConfig } = require('../system/config');

test('number input normalizes with or without + and with visual separators', () => {
  assert.equal(normalizeWhatsAppNumber('923001234567'), '923001234567');
  assert.equal(normalizeWhatsAppNumber('+923001234567'), '923001234567');
  assert.equal(normalizeWhatsAppNumber('92 300 1234567'), '923001234567');
  assert.equal(normalizeWhatsAppNumber('92-300-1234567'), '923001234567');
  assert.equal(normalizeWhatsAppNumber('(92) 300.1234567'), '923001234567');
  assert.equal(normalizeWhatsAppNumber(' +1 202-555-0123 '), '12025550123');
});

test('number validation is structural and international, never country-specific', () => {
  // Valid international numbers from different regions all pass.
  for (const number of ['923001234567', '12025550123', '441234567890', '819012345678', '971501234567', '255712345678']) {
    assert.equal(normalizeWhatsAppNumber(number), number);
  }
  // Structural failures.
  assert.throws(() => normalizeWhatsAppNumber('123'), /7-15 digit/);
  assert.throws(() => normalizeWhatsAppNumber('1234567890123456'), /7-15 digit/);
  assert.throws(() => normalizeWhatsAppNumber('03001234567'), /country code/);
  assert.throws(() => normalizeWhatsAppNumber('abcdefghijk'), /digits/);
  assert.throws(() => normalizeWhatsAppNumber(''), /phone number/);
  assert.throws(() => normalizeWhatsAppNumber(undefined), /phone number/);
  // Errors carry the stable INVALID_NUMBER code.
  try {
    normalizeWhatsAppNumber('123');
    assert.fail('expected INVALID_NUMBER');
  } catch (error) {
    assert.equal(error.code, 'INVALID_NUMBER');
    assert.ok(error instanceof NumberFormatError);
  }
});

test('country codes are split for one-, two-, and three-digit zones', () => {
  assert.deepEqual(splitCountryCode('12025550123'), { countryCode: '1', subscriber: '2025550123' });
  assert.deepEqual(splitCountryCode('79161234567'), { countryCode: '7', subscriber: '9161234567' });
  assert.deepEqual(splitCountryCode('923001234567'), { countryCode: '92', subscriber: '3001234567' });
  assert.deepEqual(splitCountryCode('971501234567'), { countryCode: '971', subscriber: '501234567' });
  assert.deepEqual(splitCountryCode('255712345678'), { countryCode: '255', subscriber: '712345678' });
});

test('numbers display in a readable international form', () => {
  assert.equal(formatInternationalNumber('923001234567'), '+92 300 1234567');
  assert.equal(formatInternationalNumber('12025550123'), '+1 202 555 0123');
  assert.equal(formatInternationalNumber('971501234567'), '+971 501 234567');
});

test('pairing codes display as two groups of four', () => {
  assert.equal(formatPairingCodeDisplay('GOATMODS'), 'GOAT-MODS');
  assert.equal(formatPairingCodeDisplay('ABCDEFGH'), 'ABCD-EFGH');
  assert.equal(formatPairingCodeDisplay('ABC'), 'ABC');
  assert.equal(formatPairingCodeDisplay(undefined), undefined);
  assert.equal(formatPairingCodeDisplay(''), '');
});

test('the custom pairing code setting is normalized from config.js', () => {
  const source = structuredClone(require('../config'));
  source.telegram.botToken = 'test-token';
  source.telegram.ownerIds = ['12345'];
  source.telegram.pairingCode = 'goat-mods';
  assert.equal(loadConfig(source).telegramPairingCode, 'GOATMODS');
  source.telegram.pairingCode = '';
  assert.equal(loadConfig(source).telegramPairingCode, '');
});
