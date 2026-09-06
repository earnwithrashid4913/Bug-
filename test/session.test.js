'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SessionError,
  credsPath,
  hasSession,
  parseSessionId,
  prepareSession,
  readSessionId
} = require('../system/session');

const CREDS = {
  noiseKey: { private: { type: 'Buffer', data: [1, 2] }, public: { type: 'Buffer', data: [3, 4] } },
  signedIdentityKey: { private: { type: 'Buffer', data: [5, 6] }, public: { type: 'Buffer', data: [7, 8] } },
  registrationId: 123,
  me: { id: '923001234567:1@s.whatsapp.net', name: 'Owner' }
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bot-session-'));
}

const silentLog = () => {};

test('parseSessionId accepts raw JSON credentials', () => {
  const parsed = parseSessionId(JSON.stringify(CREDS));
  assert.equal(parsed.registrationId, 123);
  assert.equal(parsed.me.id, '923001234567:1@s.whatsapp.net');
});

test('parseSessionId accepts base64-encoded credentials', () => {
  const encoded = Buffer.from(JSON.stringify(CREDS), 'utf8').toString('base64');
  assert.equal(parseSessionId(encoded).registrationId, 123);
});

test('parseSessionId accepts a prefixed SESSION_ID', () => {
  const encoded = Buffer.from(JSON.stringify(CREDS), 'utf8').toString('base64');
  assert.equal(parseSessionId(`MYBOT~~${encoded}`).registrationId, 123);
  assert.equal(parseSessionId(`https://example.com/pair?id=MYBOT~~${encoded}`.slice(33)).registrationId, 123);
});

test('parseSessionId rejects values that are not credentials', () => {
  for (const value of ['', '   ', 'not-a-session', '{"hello":"world"}', '{broken json']) {
    assert.throws(() => parseSessionId(value), SessionError, `expected rejection for ${JSON.stringify(value)}`);
  }
});

test('prepareSession writes creds.json with private permissions and is idempotent', () => {
  const dir = tempDir();
  const authDir = path.join(dir, 'session');

  const first = prepareSession({
    authDir,
    sessionId: JSON.stringify(CREDS),
    log: silentLog
  });
  assert.equal(first, 'created');
  assert.ok(hasSession(authDir));
  assert.equal(JSON.parse(fs.readFileSync(credsPath(authDir), 'utf8')).registrationId, 123);
  assert.equal(fs.statSync(credsPath(authDir)).mode & 0o777, 0o600);

  const second = prepareSession({
    authDir,
    sessionId: JSON.stringify({ ...CREDS, registrationId: 999 }),
    log: silentLog
  });
  assert.equal(second, 'existing');
  assert.equal(JSON.parse(fs.readFileSync(credsPath(authDir), 'utf8')).registrationId, 123);

  const overwritten = prepareSession({
    authDir,
    sessionId: JSON.stringify({ ...CREDS, registrationId: 999 }),
    overwrite: true,
    log: silentLog
  });
  assert.equal(overwritten, 'overwritten');
  assert.equal(JSON.parse(fs.readFileSync(credsPath(authDir), 'utf8')).registrationId, 999);
});

test('prepareSession reports empty when there is no session and no SESSION_ID', () => {
  const dir = tempDir();
  assert.equal(prepareSession({ authDir: path.join(dir, 'session'), sessionId: '', log: silentLog }), 'empty');
  assert.equal(hasSession(path.join(dir, 'session')), false);
});

test('readSessionId returns portable JSON and null when no session exists', () => {
  const dir = tempDir();
  const authDir = path.join(dir, 'session');
  assert.equal(readSessionId(authDir), null);

  prepareSession({ authDir, sessionId: JSON.stringify(CREDS), log: silentLog });
  const sessionId = readSessionId(authDir);
  assert.equal(typeof sessionId, 'string');
  assert.equal(JSON.parse(sessionId).registrationId, 123);

  fs.writeFileSync(credsPath(authDir), 'not json', 'utf8');
  assert.equal(readSessionId(authDir), null);
});
