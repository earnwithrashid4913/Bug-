'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { MemoryCache } = require('../system/lib/cache');
const { BotModeStore, normalizeMode } = require('../system/lib/bot-mode');

test('MemoryCache implements the cache contract Baileys expects', () => {
  const cache = new MemoryCache();
  assert.equal(typeof cache.get, 'function');
  assert.equal(typeof cache.set, 'function');
  assert.equal(typeof cache.del, 'function');
  assert.equal(typeof cache.flushAll, 'function');

  cache.set('key', 'value');
  assert.equal(cache.get('key'), 'value');
  assert.equal(cache.del('key'), true);
  assert.equal(cache.get('key'), undefined);

  cache.set('a', 1);
  cache.set('b', 2);
  cache.flushAll();
  assert.equal(cache.size, 0);
});

test('MemoryCache expires entries after the TTL', async () => {
  const cache = new MemoryCache({ stdTtlMs: 20 });
  cache.set('key', 'value');
  assert.equal(cache.get('key'), 'value');

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(cache.get('key'), undefined);
});

test('MemoryCache enforces its entry limit', () => {
  const cache = new MemoryCache({ maxEntries: 3 });
  for (let index = 0; index < 6; index += 1) cache.set(`key-${index}`, index);
  assert.equal(cache.size, 3);
  assert.equal(cache.get('key-5'), 5);
});

test('normalizeMode keeps known modes and falls back otherwise', () => {
  assert.equal(normalizeMode('public', 'self'), 'public');
  assert.equal(normalizeMode('self', 'public'), 'self');
  assert.equal(normalizeMode('nonsense', 'public'), 'public');
  assert.equal(normalizeMode(undefined, 'self'), 'self');
});

test('BotModeStore persists the mode across instances', async () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-mode-')), 'mode.json');
  const store = new BotModeStore(filePath, 'public');

  assert.equal(await store.get(), 'public', 'falls back to the configured default');
  assert.equal(await store.set('self'), 'self');
  assert.equal(await new BotModeStore(filePath, 'public').get(), 'self', 'persisted to disk');

  fs.writeFileSync(filePath, '{"mode":"broken"}', 'utf8');
  assert.equal(await new BotModeStore(filePath, 'public').get(), 'public', 'invalid values fall back');
});

// --- restart helper --------------------------------------------------------

const { execFileSync, spawn } = require('node:child_process');
const { requestRestart } = require('../system/lib/runtime');

test('requestRestart exits the process when there is no supervisor', () => {
  const script = "process.stdout.write(require('./system/lib/runtime').requestRestart());";
  const output = execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(output, 'exit');
});

test('requestRestart asks the supervisor to respawn the worker over IPC', async () => {
  const child = spawn(process.execPath, ['-e', "require('./system/lib/runtime').requestRestart();"], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  const message = await new Promise((resolve) => {
    child.on('message', resolve);
    child.on('exit', () => resolve(null));
  });

  assert.deepEqual(message, { type: 'reset' });
  child.kill('SIGKILL');
});

// `ps` based worker discovery. Matching on the exact argv shape avoids picking
// up shells whose own command line happens to contain the same text.
const WORKER_ARGV = /^(?:\S*\/)?node(?:js)?\s+\S*index\.js --child$/;

function listWorkerPids() {
  const rows = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return rows
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ');
      return { pid: Number(line.slice(0, space)), args: line.slice(space + 1).trim() };
    })
    .filter((row) => WORKER_ARGV.test(row.args))
    .map((row) => row.pid);
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return true;
    } catch {
      /* not ready yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

test.skip('the real supervisor keeps a worker process alive and respawns it', () => {
  // Requires a real WhatsApp connection and is intentionally not run in CI.
});

// --- persisted bot mode wired through the command handler ------------------

test('the handler restores the persisted bot mode onto the socket', async () => {
  // config.modeDbPath is read when the handler module loads, so point it at a
  // throwaway file before requiring it (each test file runs in its own process).
  const fs = require('node:fs');
  const os = require('node:os');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-mode-db-')), 'mode.json');
  require('../config').database.modeDbPath = dbPath;

  const handleMessage = require('../system/handler');
  const socket = { public: true };

  assert.equal(await handleMessage.initializeMode(socket), 'public', 'defaults to the configured mode');
  assert.equal(socket.public, true);

  await handleMessage.modeStore.set('self');
  const reopened = { public: true };
  assert.equal(await handleMessage.initializeMode(reopened), 'self', 'mode survived a restart');
  assert.equal(reopened.public, false, 'self mode is applied to the socket');

  await handleMessage.modeStore.set('public');
  const restored = { public: false };
  assert.equal(await handleMessage.initializeMode(restored), 'public');
  assert.equal(restored.public, true);
});
