'use strict';

// ---------------------------------------------------------------------------
// 24/7 stability regression tests.
//
// These lock in the defects that used to take ANIME MD OFFLINE on Pterodactyl:
//
//   1. A connection.update emitted before index.js subscribed was lost forever
//      (Baileys destroys the socket emitter inside its own end() handler), so no
//      reconnect was scheduled, no event-loop handle remained, and the worker
//      exited cleanly with code 0. Repeated a few times a minute, that also
//      tripped the supervisor's crash-loop guard and ended the container.
//   2. A burst of worker exits made the supervisor exit — and on Pterodactyl the
//      supervisor IS the container process, so the server showed OFFLINE.
//   3. One transient Telegram failure at boot disabled pairing permanently.
//   4. A 500 (Baileys' catch-all for unclassifiable errors) was treated as bad
//      auth and deleted valid credentials.
//
// The lifecycle tests run the REAL index.js in a subprocess, with only the
// WhatsApp client replaced by test-support/baileys-stub.js. Assertions are made
// on the bot's own liveStatus over IPC, never inferred from timings.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, '..', 'test-support', 'stability-worker.js');
const CRASH_PRELOAD = path.join(__dirname, '..', 'test-support', 'crash-loop-preload.js');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const userConfig = require('../config');
userConfig.deployment.dryRun = true;
userConfig.telegram.enabled = false;

const index = require('../index');

// --- worker lifecycle (real index.js in a real subprocess) ------------------

function runWorker(scenario, observeMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FIXTURE], {
      cwd: ROOT,
      env: { ...process.env, STABILITY_SCENARIO: scenario },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });

    const logs = [];
    const statuses = [];
    child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
    child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
    child.on('message', (message) => { if (message?.type === 'status') statuses.push(message); });

    let exited = null;
    child.on('exit', (code, signal) => { exited = { code, signal }; });

    setTimeout(() => {
      const alive = exited === null;
      child.kill('SIGKILL');
      resolve({ alive, exited, log: logs.join(''), statuses, lastStatus: statuses[statuses.length - 1] });
    }, observeMs);
  });
}

test('the worker reaches connection open and reports it through liveStatus', async () => {
  const { alive, exited, log, lastStatus } = await runWorker('connected', 3000);
  assert.equal(alive, true, `worker exited early (${JSON.stringify(exited)}); log:\n${log}`);
  assert.equal(lastStatus?.state, 'connected');
  assert.equal(lastStatus?.connected, true);
});

test('a terminal WhatsApp disconnect no longer exits the worker', async () => {
  const { alive, exited, log, lastStatus } = await runWorker('terminal-close', 3000);
  assert.equal(alive, true, `worker exited early (${JSON.stringify(exited)}); log:\n${log}`);
  assert.equal(lastStatus?.state, 'logged_out');
  assert.match(log, /reason=401 .*reconnect=false/, 'the close must log its reason and reconnect decision');
  assert.match(log, /stays online/, 'a terminal primary disconnect must state that the process stays online');
  assert.doesNotMatch(log, /\[RECONNECT\]/, 'a logged-out session must not reconnect');
});

test('a transient WhatsApp disconnect keeps the worker alive and reconnecting', async () => {
  const { alive, exited, log } = await runWorker('transient-close', 3500);
  assert.equal(alive, true, `worker exited early (${JSON.stringify(exited)}); log:\n${log}`);
  assert.match(log, /reason=428 .*reconnect=true/);
  assert.match(log, /\[RECONNECT\] \[connection\] .* reconnecting in \d+s \(attempt \d+/);
});

test('a 500 is treated as transient: it reconnects instead of ending the session', async () => {
  const { alive, exited, log } = await runWorker('bad-session', 3500);
  assert.equal(alive, true, `worker exited early (${JSON.stringify(exited)}); log:\n${log}`);
  assert.match(log, /reason=500 .*reconnect=true/);
  assert.match(log, /\[RECONNECT\]/);
});

// Regression test for the primary-session reconnect defect.
//
// Once the primary socket reaches connection open, handleConnectionUpdate sets
// liveStatus.session = 'paired'. The startBot() gate used to only create a
// socket when liveStatus.session was one of 'existing' | 'created' |
// 'overwritten', so 'paired' fell into the idle branch and NO socket was ever
// created again — a primary session that had connected even once never
// reconnected after its first disconnect without a manual restart.
//
// The gate now reads the credential file on disk (hasSession), which stays
// correct across reconnects, restarts and a session being added or removed.
test('repeated reconnect events do not leak sockets, handles or heap', async () => {
  const CYCLES = 12;

  const child = spawn(process.execPath, [FIXTURE], {
    cwd: ROOT,
    env: { ...process.env, STABILITY_SCENARIO: 'soak', STABILITY_SOAK_CYCLES: String(CYCLES) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  const logs = [];
  const samples = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  child.on('message', (message) => { if (message?.type === 'soak') samples.push(message); });

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  const finished = new Promise((resolve) => {
    const poll = setInterval(() => {
      if (samples.length >= CYCLES || exited) { clearInterval(poll); resolve(); }
    }, 100);
    poll.unref();
    setTimeout(() => { clearInterval(poll); resolve(); }, 90_000).unref();
  });
  await finished;

  const alive = exited === null;
  const log = logs.join('');
  child.kill('SIGKILL');

  assert.equal(samples.length, CYCLES, `expected ${CYCLES} reconnect cycles, saw ${samples.length}; log:\n${log}`);
  assert.equal(alive, true, `worker exited during the soak (${JSON.stringify(exited)}); log:\n${log}`);

  const first = samples[0];
  const last = samples[samples.length - 1];

  // Exactly one live socket at every sample: a duplicate socket or a reconnect
  // storm would show more than one transport open at once.
  assert.ok(
    samples.every((sample) => sample.liveSockets === 1),
    `expected exactly 1 live socket per cycle, saw: ${samples.map((s) => s.liveSockets).join(',')}`
  );

  // One new socket per reconnect cycle and no more — a storm would outrun the
  // cycle count. Cycle N is reached with N+1 sockets created (1 initial + N).
  assert.deepEqual(
    samples.map((sample) => sample.sockets),
    samples.map((sample, index) => index + 2),
    `socket creation must track the cycle count exactly: ${samples.map((s) => s.sockets).join(',')}`
  );

  // Handles and process listeners must not accumulate per reconnect.
  assert.ok(last.handles <= first.handles + 2, `handles grew from ${first.handles} to ${last.handles}`);
  assert.equal(last.listeners, first.listeners, `process listeners grew from ${first.listeners} to ${last.listeners}`);

  // Heap must stay bounded; allow generous headroom for GC timing.
  const heapGrowth = last.heapUsed - first.heapUsed;
  assert.ok(heapGrowth < 15 * 1024 * 1024, `heap grew by ${(heapGrowth / 1048576).toFixed(1)}MB across ${CYCLES} reconnects`);
});

// --- supervisor survives a crash loop --------------------------------------

test('the supervisor survives a worker crash loop instead of going OFFLINE', async () => {
  const { MAX_WORKER_RESTARTS_PER_MINUTE } = index;

  const supervisor = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: `--require ${CRASH_PRELOAD}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const logs = [];
  supervisor.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  supervisor.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  let exited = null;
  supervisor.on('exit', (code, signal) => { exited = { code, signal }; });

  // Long enough for comfortably more than MAX_WORKER_RESTARTS_PER_MINUTE exits.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const alive = exited === null;
  const log = logs.join('');
  supervisor.kill('SIGTERM');
  await new Promise((resolve) => supervisor.once('exit', resolve));

  const launches = log.split('[BOOT] [startup]').length - 1;
  // The old code called process.exit() at exactly this many exits, which on
  // Pterodactyl is the container going OFFLINE. The supervisor must reach the
  // threshold, cool off, and still be running.
  assert.ok(
    launches >= MAX_WORKER_RESTARTS_PER_MINUTE,
    `the fixture should have produced at least ${MAX_WORKER_RESTARTS_PER_MINUTE} worker launches, saw ${launches}; log:\n${log}`
  );
  assert.equal(alive, true, `supervisor exited (${JSON.stringify(exited)}), which on Pterodactyl is the container going OFFLINE; log:\n${log}`);
  assert.match(log, /instead of stopping/, 'the cool-off must be reported');
  assert.match(log, /the container stays online/);
});

test('a graceful stop still terminates the whole tree', async () => {
  const supervisor = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: `--require ${CRASH_PRELOAD}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  supervisor.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  supervisor.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  await new Promise((resolve) => setTimeout(resolve, 1200));
  const began = Date.now();
  supervisor.kill('SIGTERM');
  const code = await new Promise((resolve) => supervisor.once('exit', resolve));
  const elapsed = Date.now() - began;

  assert.ok(elapsed < 10_000, `graceful stop took ${elapsed}ms`);
  assert.notEqual(code, null, 'the supervisor must exit on SIGTERM');
});

// --- reconnect policy ------------------------------------------------------

test('the primary-session gate reads credentials from disk, not the status mirror', async () => {
  const child = spawn(process.execPath, [FIXTURE], {
    cwd: ROOT,
    env: { ...process.env, STABILITY_SCENARIO: 'paired-guard' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  const logs = [];
  const guards = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  child.on('message', (message) => { if (message?.type === 'guard') guards.push(message); });

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  await new Promise((resolve) => {
    const poll = setInterval(() => { if (guards.length >= 2 || exited) { clearInterval(poll); resolve(); } }, 50);
    poll.unref();
    setTimeout(() => { clearInterval(poll); resolve(); }, 20_000).unref();
  });

  const log = logs.join('');
  child.kill('SIGKILL');

  assert.equal(guards.length, 2, `expected both guard phases, got ${guards.length}; log:\n${log}`);
  const [present, missing] = guards;

  // liveStatus.session === 'paired' with credentials on disk must reconnect.
  assert.equal(present.phase, 'creds-present');
  assert.equal(present.grew, true, `a socket must be created while credentials exist; log:\n${log}`);
  assert.notEqual(present.state, 'telegram_pairing');

  // Credentials removed must fall back to the idle Telegram-pairing branch.
  assert.equal(missing.phase, 'creds-missing');
  assert.equal(missing.grew, false, 'no socket may be created without credentials');
  assert.equal(missing.state, 'telegram_pairing');
});

test('a logged-out or replaced session never triggers automatic reconnection', () => {
  const { DisconnectReason } = require('@whiskeysockets/baileys');
  assert.equal(index.shouldReconnect(DisconnectReason.loggedOut), false);
  assert.equal(index.shouldReconnect(DisconnectReason.connectionReplaced), false);
});

test('every other Baileys disconnect reason reconnects', () => {
  const { DisconnectReason } = require('@whiskeysockets/baileys');
  for (const reason of [
    DisconnectReason.badSession,
    DisconnectReason.connectionClosed,
    DisconnectReason.connectionLost,
    DisconnectReason.forbidden,
    DisconnectReason.multideviceMismatch,
    DisconnectReason.restartRequired,
    DisconnectReason.timedOut,
    DisconnectReason.unavailableService,
    undefined
  ]) {
    assert.equal(index.shouldReconnect(reason), true, `expected reconnect for ${reason}`);
  }
});

// --- credentials are never destroyed by the primary path -------------------

test('the primary connection layer never deletes the auth directory', () => {
  const source = read('index.js');
  assert.doesNotMatch(source, /rm(Sync)?\s*\(\s*config\.authDir/);
  assert.doesNotMatch(source, /rm\s*\(\s*\{\s*recursive[^}]*\}\s*\)/);
});

test('a 500 no longer deletes a paired session', () => {
  const { classifyDisconnect } = require('../system/lib/telegram-pairing-manager');
  const { DisconnectReason } = require('@whiskeysockets/baileys');

  const badSession = classifyDisconnect({ error: { output: { statusCode: DisconnectReason.badSession } } });
  assert.equal(badSession.type, 'SESSION_ERROR');
  assert.equal(badSession.terminal, undefined);
  assert.equal(badSession.reconnect, true);
  assert.equal(badSession.deleteCreds, undefined, 'a transient 500 must never delete valid credentials');

  // Genuinely unusable sessions stay terminal.
  for (const reason of [DisconnectReason.loggedOut, DisconnectReason.forbidden, DisconnectReason.multideviceMismatch, DisconnectReason.connectionReplaced]) {
    const classification = classifyDisconnect({ error: { output: { statusCode: reason } } });
    assert.equal(classification.terminal, true, `${reason} must stay terminal`);
    assert.equal(classification.deleteCreds, true);
  }
});

// --- Telegram controller retry --------------------------------------------

test('a Telegram API that never recovers is retried, not permanently disabled', async () => {
  const child = spawn(process.execPath, [FIXTURE], {
    cwd: ROOT,
    env: { ...process.env, STABILITY_SCENARIO: 'telegram-retry' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  // The retry ladder is 5s, 10s, 20s… so 14s must contain at least two attempts.
  await new Promise((resolve) => setTimeout(resolve, 14_000));
  const alive = exited === null;
  const log = logs.join('');
  child.kill('SIGKILL');

  const attempts = log.split('[fixture] telegram attempt').length - 1;
  assert.equal(alive, true, `worker exited (${JSON.stringify(exited)}); log:\n${log}`);
  assert.ok(attempts >= 2, `expected the controller to be retried, saw ${attempts} attempt(s); log:\n${log}`);
  assert.match(log, /Retrying in \d+s/, 'each failure must log the next retry');
  assert.doesNotMatch(log, /TEST-TOKEN/, 'the bot token must never be written to the log');
  assert.match(log, /bot<REDACTED>/);
});

test('a rejected promise and ignored socket noise do not end the process', async () => {
  const { alive, exited, log } = await runWorker('error-handling', 3000);
  assert.equal(alive, true, `worker exited (${JSON.stringify(exited)}); log:\n${log}`);
  assert.match(log, /Unhandled promise rejection/, 'the rejection must still be reported');
  assert.match(log, /Ignored known WhatsApp socket noise/, 'known socket noise must be filtered');
});

test('a transient Telegram failure at boot is retried, not permanent', () => {
  assert.equal(typeof index.startTelegramWithRetry, 'function');
  assert.ok(index.TELEGRAM_RETRY_BASE_DELAY_MS > 0);
  assert.ok(index.TELEGRAM_RETRY_MAX_DELAY_MS >= index.TELEGRAM_RETRY_BASE_DELAY_MS);

  const source = read('index.js');
  assert.doesNotMatch(source, /telegramController = undefined;/, 'the controller must not be permanently discarded on a start failure');
  assert.match(source, /startTelegramWithRetry/, 'startup must go through the retry path');
  assert.match(source, /Retrying in/, 'the retry must be logged');
});

test('every Telegram API call is bounded and a timeout reads as transient', async () => {
  const { TelegramController, API_TIMEOUT_MS, POLL_REQUEST_TIMEOUT_MS, POLL_TIMEOUT_SECONDS } = require('../system/lib/telegram-controller');

  assert.equal(POLL_REQUEST_TIMEOUT_MS, POLL_TIMEOUT_SECONDS * 1000 + 10_000);
  assert.ok(API_TIMEOUT_MS > 0);
  assert.ok(POLL_REQUEST_TIMEOUT_MS > POLL_TIMEOUT_SECONDS * 1000, 'the poll timeout must exceed the long-poll window');

  const TOKEN = 'test-token';
  const seen = [];
  const controller = new TelegramController({
    token: TOKEN,
    owners: ['1'],
    controllerStore: undefined,
    pairing: {},
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), signal: options?.signal });
      // Emulate an abort mid-request, the way an AbortSignal timeout does.
      const error = new Error('This operation was aborted');
      error.name = 'TimeoutError';
      throw error;
    }
  });

  await assert.rejects(() => controller.api('sendMessage', { chat_id: '1', text: 'x' }), (error) => {
    assert.match(error.message, /timed out after 15s/);
    assert.equal(error.httpStatus, 408, 'a timeout must classify as transient for the existing retry logic');
    assert.ok(!error.message.includes(TOKEN), 'the bot token must never appear in an error message');
    return true;
  });

  assert.equal(seen.length, 1);
  assert.ok(seen[0].signal, 'every Telegram request must carry an abort signal');
});

// --- supervisor policy constants -----------------------------------------

test('the supervisor policy keeps the container online for a bounded failure', () => {
  const {
    MAX_WORKER_RESTARTS_PER_MINUTE,
    MAX_WORKER_RESTARTS_PER_WINDOW,
    WORKER_COOLDOWN_MS,
    WORKER_GIVEUP_WINDOW_MS
  } = index;

  assert.equal(MAX_WORKER_RESTARTS_PER_MINUTE, 5);
  assert.ok(WORKER_COOLDOWN_MS > 0, 'a burst must cool off rather than exit');
  assert.ok(MAX_WORKER_RESTARTS_PER_WINDOW > MAX_WORKER_RESTARTS_PER_MINUTE);
  assert.ok(WORKER_GIVEUP_WINDOW_MS >= 60_000);

  const source = read('index.js');
  // The fatal path must stay explicit and documented, and must not be the
  // default response to a burst.
  assert.match(source, /the deployment cannot start/, 'the give-up path must be documented');
  assert.match(source, /WORKER_COOLDOWN_MAX_MS/, 'the cool-off must escalate');
});

test('the worker installs a keep-alive and a resource heartbeat', () => {
  const source = read('index.js');
  assert.match(source, /ensureKeepAlive\(\);\s*\n\s*startDiagnostics\(\);/, 'the worker must install both at boot');
  assert.match(source, /\[MEMORY\]/, 'the periodic resource line must use the [MEMORY] tag');
  for (const tag of ['[BOOT]', '[WHATSAPP]', '[TELEGRAM]', '[RECONNECT]', '[DATABASE]', '[ERROR]', '[MEMORY]', '[SHUTDOWN]']) {
    assert.ok(source.includes(tag), `missing diagnostics tag ${tag}`);
  }
});
