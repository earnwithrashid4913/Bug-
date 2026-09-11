'use strict';

// ---------------------------------------------------------------------------
// Test-only worker: runs the REAL index.js worker against the Baileys test stub
// so a process-lifetime assertion can be made from a parent test process.
//
// The scenario is chosen with the STABILITY_SCENARIO environment variable.
// Nothing here replaces production logic — index.js is required unchanged.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.argv.push('--child');

const scenario = process.env.STABILITY_SCENARIO || 'terminal-close';
const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-stability-'));

// A restored primary session is required so startBot() takes the socket branch
// instead of the idle Telegram-pairing branch.
fs.writeFileSync(
  path.join(authDir, 'creds.json'),
  JSON.stringify({ registered: true, me: { id: '923001234567:5@s.whatsapp.net' }, noiseKey: {}, signedIdentityKey: {}, signedPreKey: {}, registrationId: 1 })
);

const userConfig = require('../config');
userConfig.whatsapp.authDir = authDir;
userConfig.whatsapp.sessionId = '';
userConfig.deployment.reconnectBaseDelayMs = 1000;
userConfig.deployment.reconnectMaxDelayMs = 2000;

if (scenario === 'telegram-retry') {
  // A Telegram API that never works, so the controller's start() keeps failing
  // and the retry path has to keep bringing it back. Before the fix a single
  // failure here disabled Telegram for the whole process lifetime.
  userConfig.telegram.enabled = true;
  userConfig.telegram.botToken = '123456:TEST-TOKEN';
  userConfig.telegram.ownerIds = ['111111'];
  userConfig.telegram.requiredChannels = [];
  let attempts = 0;
  globalThis.fetch = async (url) => {
    attempts += 1;
    // The token must never reach the log.
    console.log(`[fixture] telegram attempt ${attempts} -> ${String(url).replace(/bot[^/]*TEST-TOKEN/, 'bot<REDACTED>')}`);
    throw Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  };
} else {
  userConfig.telegram.enabled = false;
}

require('./baileys-stub').install();
const { closeNewestSocket, liveSocketCount, sockets } = require('./baileys-stub');

const { DisconnectReason } = require('@whiskeysockets/baileys');
const index = require('../index.js');

const started = Date.now();

// Report liveness and the real liveStatus to the parent test, so assertions are
// made on the bot's own state rather than inferred from timings.
const reporter = setInterval(() => {
  process.send?.({
    type: 'status',
    ms: Date.now() - started,
    sockets: sockets.length,
    state: index.liveStatus.state,
    connected: index.liveStatus.connected
  });
}, 200);
reporter.unref();

function waitForSocket(deadlineMs = 5000) {
  return new Promise((resolve, reject) => {
    const began = Date.now();
    const poll = setInterval(() => {
      if (sockets.length) { clearInterval(poll); resolve(sockets[sockets.length - 1]); return; }
      if (Date.now() - began > deadlineMs) { clearInterval(poll); reject(new Error('worker never created a socket')); }
    }, 10);
    poll.unref();
  });
}

function waitForConnected(deadlineMs = 5000) {
  return new Promise((resolve, reject) => {
    const began = Date.now();
    const poll = setInterval(() => {
      if (index.liveStatus.connected) { clearInterval(poll); resolve(true); return; }
      if (Date.now() - began > deadlineMs) { clearInterval(poll); reject(new Error('worker never reached the connected state')); }
    }, 10);
    poll.unref();
  });
}

const CLOSE_BY_SCENARIO = {
  'terminal-close': DisconnectReason.loggedOut,
  'transient-close': DisconnectReason.connectionClosed,
  'bad-session': DisconnectReason.badSession
};

// Long-running stability simulation: drop the connection over and over with
// transient reasons and report resources each cycle, so a reconnect storm or a
// leak shows up as a trend instead of a guess.
async function runSoak(cycles) {
  let done = 0;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await waitForConnected();
    const before = sockets.length;
    closeNewestSocket(DisconnectReason.connectionClosed, `soak close ${cycle}`);
    // Wait for the reconnect to produce a replacement socket.
    await new Promise((resolve, reject) => {
      const began = Date.now();
      const poll = setInterval(() => {
        if (sockets.length > before) { clearInterval(poll); resolve(); return; }
        if (Date.now() - began > 5000) { clearInterval(poll); reject(new Error(`no replacement socket after cycle ${cycle}`)); }
      }, 10);
      poll.unref();
    });
    // Sample from the steady state: the replacement socket is live and
    // connected, the old one is closed.
    await waitForConnected();
    done += 1;
    const memory = process.memoryUsage();
    process.send?.({
      type: 'soak',
      cycle: done,
      // created = sockets ever made (a reconnect storm would outrun the cycle
      // count); live = sockets with an open transport (must stay at exactly 1).
      sockets: sockets.length,
      liveSockets: liveSocketCount(),
      heapUsed: memory.heapUsed,
      rss: memory.rss,
      handles: process.getActiveResourcesInfo().length,
      listeners: process.eventNames().length
    });
  }
}

(async () => {
  await waitForSocket();

  if (scenario === 'telegram-retry') {
    // Nothing to drive: the failing Telegram endpoint is enough. Stay alive so
    // the parent test can count how many times the controller is retried.
    return;
  }

  if (scenario === 'error-handling') {
    // A rejected promise and a thrown error must not end a 24/7 process.
    await waitForConnected();
    Promise.reject(new Error('deliberate unhandled rejection from the stability test'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.emit('uncaughtException', new Error('Timed Out')); // on the ignored-noise list
    return;
  }

  if (scenario === 'soak') {
    await runSoak(Number(process.env.STABILITY_SOAK_CYCLES || 12));
    return;
  }

  // 'connected' only proves the boot path reaches connection open.
  if (scenario === 'connected') {
    await waitForConnected();
    return;
  }

  // Proves the startBot() gate is driven by the credential file on disk rather
  // than by the mutable liveStatus.session string.
  if (scenario === 'paired-guard') {
    await waitForConnected();

    // Half 1: credentials on disk + status 'paired' (what the status mirror
    // holds after any successful connection) must still create a socket.
    index.liveStatus.session = 'paired';
    const before = sockets.length;
    await index.startBot();
    process.send?.({ type: 'guard', phase: 'creds-present', sockets: sockets.length, grew: sockets.length > before, state: index.liveStatus.state });

    // Half 2: with the credentials gone the primary socket must stay idle and
    // leave new sessions to Telegram pairing.
    fs.rmSync(path.join(authDir, 'creds.json'), { force: true });
    index.liveStatus.session = 'paired';
    const beforeIdle = sockets.length;
    await index.startBot();
    process.send?.({ type: 'guard', phase: 'creds-missing', sockets: sockets.length, grew: sockets.length > beforeIdle, state: index.liveStatus.state });
    return;
  }

  const reason = CLOSE_BY_SCENARIO[scenario];
  if (!reason) throw new Error(`Unknown STABILITY_SCENARIO: ${scenario}`);

  // Wait for the stub to deliver 'open', then drop the connection. The stub
  // delivers those events on setImmediate, i.e. before any awaiting caller
  // could have subscribed — the ordering that exposed the original race.
  await waitForConnected();
  closeNewestSocket(reason, `test close (${reason})`);
})().catch((error) => {
  console.error('[fixture] scenario failed:', error.message);
  process.exitCode = 2;
});
