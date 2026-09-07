'use strict';

// The canonical identity lock adopted from system/security.js. Identity must not
// be overridable through deployment configuration.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const {
  CANONICAL_IDENTITY,
  PROTECTED_DEVELOPER,
  assertProtectedSecurityEnvironment,
  isAuthorizedAdmin,
  isDeveloper,
  isGlobalOwner,
  isInstanceOwner,
  normalizeIdentity,
  verifyCanonicalIdentity
} = require('../system/security');
const { config } = require('../system/config');

test('the canonical project identity is intact', () => {
  assert.equal(verifyCanonicalIdentity(), true);
  assert.equal(CANONICAL_IDENTITY.organization, 'F!xa Dev');
  assert.equal(CANONICAL_IDENTITY.developer, 'F!xa Dev');
  assert.equal(CANONICAL_IDENTITY.author, 'Rashid Hussain');
  assert.equal(PROTECTED_DEVELOPER.community, CANONICAL_IDENTITY.organization);
});

test('protected identity keys cannot be supplied through the environment', () => {
  assert.doesNotThrow(() => assertProtectedSecurityEnvironment({}));
  assert.doesNotThrow(() => assertProtectedSecurityEnvironment({ BOT_NUMBER: '923001234567' }));

  for (const key of ['OWNER_NUMBER', 'OWNER_NUMBERS', 'GLOBAL_OWNER', 'DEVELOPER_NUMBER', 'DEVELOPER_IDENTITY']) {
    assert.throws(
      () => assertProtectedSecurityEnvironment({ [key]: '923001234567' }),
      /protected identity overrides are not allowed/,
      `${key} must be rejected`
    );
  }

  // Whitespace-only values are not an override attempt.
  assert.doesNotThrow(() => assertProtectedSecurityEnvironment({ OWNER_NUMBER: '   ' }));
});

test('the bot refuses to start when a protected identity key is set', () => {
  const script = "require('./system/config'); process.stdout.write('loaded');";
  assert.throws(
    () => execFileSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, OWNER_NUMBER: '923001234567' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }),
    /protected identity overrides are not allowed/
  );
});

test('identity values are normalized to WhatsApp JIDs', () => {
  assert.equal(normalizeIdentity('923001234567'), '923001234567@s.whatsapp.net');
  assert.equal(normalizeIdentity('+92 300 1234567'), '923001234567@s.whatsapp.net');
  assert.equal(normalizeIdentity('923001234567:12@s.whatsapp.net'), '923001234567@s.whatsapp.net');
  assert.equal(normalizeIdentity('12345@lid'), '12345@lid');
  assert.equal(normalizeIdentity('not-a-number'), undefined);
  assert.equal(normalizeIdentity(undefined), undefined);
});

test('authorization falls back to the instance owner without a signed manifest', () => {
  const socket = { decodeJid: (jid) => jid };
  const owner = '923001234568@s.whatsapp.net';

  assert.equal(isInstanceOwner(socket, owner, config.botNumber), false, 'a different number is not the instance owner');
  assert.equal(isInstanceOwner(socket, `${config.botNumber}@s.whatsapp.net`, config.botNumber), true);
  assert.equal(isAuthorizedAdmin(socket, `${config.botNumber}@s.whatsapp.net`, config.botNumber), true);

  // No ANIME_MD_TRUSTED_IDENTITY_FILE/HMAC pair is configured, so there are no
  // global owner or developer grants — privileged access stays closed.
  assert.equal(isGlobalOwner(socket, owner), false);
  assert.equal(isDeveloper(socket, owner), false);
  assert.equal(isAuthorizedAdmin(socket, owner, config.botNumber), false);
});

test('config exposes the canonical identity and no protected owner alias', () => {
  assert.equal(config.projectName, CANONICAL_IDENTITY.projectName);
  assert.equal(config.developerBrand, CANONICAL_IDENTITY.organization);
  assert.equal(config.developerName, CANONICAL_IDENTITY.developer);
  assert.equal(config.authorName, CANONICAL_IDENTITY.author);
  // The instance owner is still deployer-configured, via BOT_NUMBER only.
  assert.equal(config.ownerNumber, config.botNumber);
});
