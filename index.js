'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { stdout: output } = require('node:process');
const chalk = require('chalk');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidDecode,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');

const { config } = require('./system/config');
const { handleGroupParticipantsUpdate } = require('./system/group-events');
const handleMessage = require('./system/handler');
const { MemoryCache } = require('./system/lib/cache');
const { prepareSession } = require('./system/session');
const { getTheme, isThemeId, listThemes, resolveTheme } = require('./system/theme');
const { createWebServer } = require('./system/web');

// ---------------------------------------------------------------------------
// Process supervisor.
//
// `node index.js` spawns `node index.js --child` and keeps it alive. A crash or
// a `!restart` request therefore recovers without relying on the hosting panel
// to notice.
// ---------------------------------------------------------------------------

const CHILD_FLAG = '--child';
const isChildProcess = process.argv.includes(CHILD_FLAG);

// How many worker exits inside one minute are tolerated before the supervisor
// gives up instead of looping forever.
const MAX_WORKER_RESTARTS_PER_MINUTE = 5;
let workerExits = [];

// Grace period after the WhatsApp handshake before a pairing code is requested,
// so the registration query is not sent into a settling socket.
const PAIRING_SETTLE_MS = 3_000;

// WhatsApp/socket noise that must never take the whole process down. The
// connection layer filters these; each one is already handled by the
// reconnect logic below.
const IGNORED_PROCESS_ERRORS = Object.freeze([
  'conflict',
  'Socket connection timeout',
  'not-authorized',
  'already-exists',
  'rate-overlimit',
  'Connection Closed',
  'Timed Out',
  'Value not found'
]);

let activeSocket;
let webServer;
let childProcess;
let workerLaunchTimer;
let reconnectTimer;
let reconnectAttempts = 0;
let stopping = false;
let resetting = false;
let currentPairingState;

// Live mirror of the WhatsApp socket state. The dashboard renders this object
// verbatim, so it is only ever written from real socket events — the UI never
// shows "connected" unless WhatsApp actually reported an open connection.
const liveStatus = {
  state: 'starting',
  connected: false,
  message: 'Starting the WhatsApp client…',
  pairingCode: null,
  pairingNumber: null,
  pairingRequestedAt: null,
  session: 'unknown',
  botUser: null,
  startedAt: Date.now(),
  updatedAt: Date.now()
};

let activeTheme = resolveTheme(config.theme);

const disconnectLabels = Object.freeze({
  [DisconnectReason.badSession]: 'The saved WhatsApp session is invalid.',
  [DisconnectReason.connectionClosed]: 'The connection was closed.',
  [DisconnectReason.connectionLost]: 'The connection was lost.',
  [DisconnectReason.connectionReplaced]: 'This session was replaced by another WhatsApp connection.',
  [DisconnectReason.loggedOut]: 'WhatsApp logged this session out.',
  [DisconnectReason.restartRequired]: 'WhatsApp requested a connection restart.',
  [DisconnectReason.timedOut]: 'The WhatsApp connection timed out.'
});

function decodeJid(jid) {
  if (!jid) return jid;
  if (/:\d+@/i.test(jid)) {
    const decoded = jidDecode(jid);
    return decoded?.user && decoded?.server ? `${decoded.user}@${decoded.server}` : jid;
  }
  return jid;
}

function disconnectStatusCode(lastDisconnect) {
  const error = lastDisconnect?.error;
  if (!error) return undefined;
  return error?.output?.statusCode || new Boom(error).output.statusCode;
}

function shouldReconnect(reason) {
  return ![
    DisconnectReason.badSession,
    DisconnectReason.connectionReplaced,
    DisconnectReason.loggedOut
  ].includes(reason);
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;

  const exponent = Math.min(reconnectAttempts, 5);
  const delay = Math.min(config.reconnectBaseDelayMs * 2 ** exponent, config.reconnectMaxDelayMs);
  reconnectAttempts += 1;

  console.warn(`[connection] Reconnecting in ${Math.ceil(delay / 1000)}s (attempt ${reconnectAttempts}).`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void startBot();
  }, delay);
}

function setStatus(state, message, extra = {}) {
  Object.assign(liveStatus, {
    state,
    message,
    connected: state === 'connected',
    updatedAt: Date.now(),
    ...extra
  });
}

function renderQrCode(qr, pairingState) {
  if (pairingState.lastQr === qr) return;
  pairingState.lastQr = qr;

  if (!output.isTTY) {
    console.warn('[qr] A QR code was received, but this host is non-interactive. Use the web dashboard pairing flow instead.');
    return;
  }

  console.log('[qr] Scan this QR code from WhatsApp Linked Devices:');
  qrcode.generate(qr, { small: true });
}

// Pairing codes are displayed in groups of four characters:
// two groups of four characters separated by a dash.
function formatPairingCode(code) {
  return code?.match(/.{1,4}/g)?.join('-') || code;
}

async function requestPairingCode(socket, pairingState, targetNumber) {
  if (!socket || pairingState.registered) return liveStatus.pairingCode;

  const number = targetNumber || config.botNumber;

  try {
    const code = await socket.requestPairingCode(number);
    pairingState.requested = true;
    pairingState.pending = false;
    pairingState.lastQr = undefined;
    liveStatus.pairingCode = code;
    liveStatus.pairingNumber = number;
    liveStatus.pairingRequestedAt = Date.now();
    setStatus('pairing', `Enter the pairing code in WhatsApp on ${number}.`);
    console.log(chalk.green(`[pairing] Enter this code in WhatsApp (${number}): ${formatPairingCode(code)}`));
    return code;
  } catch (error) {
    pairingState.pending = false;
    console.error(`[pairing] Could not request a pairing code: ${error.message}`);
    throw error;
  }
}

// Called by the dashboard. Real errors surface to the user; nothing is faked.
async function handlePairingRequest(number) {
  if (liveStatus.connected || currentPairingState?.registered) {
    throw Object.assign(new Error('WhatsApp is already connected.'), { status: 409 });
  }
  // A pairing code can only be requested once the WhatsApp handshake finished
  // (the socket reported a QR / reached the pairing stage).
  if (!activeSocket || !currentPairingState?.readyForPairing) {
    throw Object.assign(
      new Error('The WhatsApp client is still connecting. Try again in a few seconds.'),
      { status: 503 }
    );
  }

  return requestPairingCode(activeSocket, currentPairingState, number);
}

function setActiveTheme(themeId) {
  if (!isThemeId(themeId)) {
    throw new Error(`Unknown theme "${themeId}". Available themes: ${listThemes().map((theme) => theme.id).join(', ')}.`);
  }
  activeTheme = getTheme(themeId);
  console.log(`[theme] Active theme is now ${activeTheme.name}.`);
  return activeTheme;
}

async function handleConnectionUpdate(socket, update, pairingState) {
  if (socket !== activeSocket || stopping) return;

  if (update.qr && !pairingState.registered) {
    // The handshake is complete from here on, so a pairing code can be issued.
    pairingState.readyForPairing = true;

    if (config.authMethod === 'pairing') {
      setStatus('pairing', `Requesting a pairing code for ${config.botNumber}…`);
      // Give the socket a moment to settle before the registration IQ so its
      // automatic pairing request is not sent into a settling connection.
      await new Promise((resolve) => setTimeout(resolve, PAIRING_SETTLE_MS).unref());
      if (stopping || socket !== activeSocket) return;

      await requestPairingCode(socket, pairingState, config.botNumber).catch((error) => {
        setStatus('connecting', `Pairing code request failed: ${error.message}`);
      });
    } else {
      // Internal, terminal-only fallback. The dashboard never offers QR.
      setStatus('connecting', 'Scan the QR code printed in the server terminal.');
      renderQrCode(update.qr, pairingState);
    }
  }

  if (update.connection === 'open') {
    reconnectAttempts = 0;
    pairingState.registered = true;
    setStatus('connected', `${config.botName} is connected to WhatsApp.`, {
      pairingCode: null,
      pairingRequestedAt: null,
      session: 'paired',
      botUser: socket.user?.id?.split(':')[0] || socket.user?.id || null
    });
    console.log(chalk.green(`[connection] ${config.botName} is connected to WhatsApp.`));
    console.log(chalk.cyan(`[connection] Logged in as: ${socket.user?.name || 'Unknown'} (${socket.user?.id?.split(':')[0] || 'n/a'})`));
    // Send the connection card only after Baileys confirms the open state.
    // A media-delivery problem must not change the real connection status.
    if (socket.user?.id) {
      void socket.sendMessage(socket.user.id, {
        image: { url: config.connectionSuccessImage },
        caption: `*${config.botName} connected successfully.*\nYour WhatsApp session is now active.`
      }).catch((error) => console.warn(`[connection] Could not send the connection card: ${error.message}`));
    }
    return;
  }

  if (update.connection !== 'close') return;

  pairingState.readyForPairing = false;
  const reason = disconnectStatusCode(update.lastDisconnect);
  const label = disconnectLabels[reason] || `Unknown disconnect reason: ${reason ?? 'not supplied'}.`;
  setStatus(reason === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected', label, {
    pairingCode: null,
    session: reason === DisconnectReason.loggedOut ? 'logged_out' : liveStatus.session
  });
  console.warn(`[connection] ${label}`);

  if (shouldReconnect(reason)) {
    scheduleReconnect();
    return;
  }

  if (reason === DisconnectReason.loggedOut) {
    console.error('[connection] This device was logged out. Pair again from the dashboard, or set a fresh SESSION_ID, then restart the bot.');
    return;
  }

  console.error('[connection] Automatic reconnection stopped to avoid a loop. Remove the invalid AUTH_DIR only if you need to pair again, then restart the bot.');
}

async function handleMessages(socket, upsert) {
  if (socket !== activeSocket || upsert.type !== 'notify') return;

  for (const rawMessage of upsert.messages || []) {
    if (!rawMessage?.message || rawMessage.key?.remoteJid === 'status@broadcast') continue;
    try {
      await handleMessage(socket, rawMessage);
    } catch (error) {
      console.error('[message] Failed to process an incoming message:', error);
    }
  }
}

function bootstrapSession() {
  try {
    const result = prepareSession({
      authDir: config.authDir,
      sessionId: config.sessionId,
      overwrite: config.sessionOverwrite
    });
    liveStatus.session = result === 'empty' ? 'none' : result;
    return result;
  } catch (error) {
    // A bad SESSION_ID must not brick the deployment: keep serving the
    // dashboard so the owner can pair again from the browser.
    liveStatus.session = 'invalid';
    console.error(chalk.red(`[session] ${error.message}`));
    console.error('[session] The dashboard is still available so you can pair again from the browser.');
    return 'invalid';
  }
}

async function startBot() {
  if (stopping) return;

  try {
    // Pin the socket to the newest published WhatsApp Web
    // version; falling back to Baileys' bundled default keeps this safe offline.
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    if (!version) console.warn('[connection] Could not fetch the latest WhatsApp Web version; using the bundled default.');

    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const logger = pino({ level: config.logLevel });
    const socket = makeWASocket({
      ...(version ? { version } : {}),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger.child({ level: 'silent' }))
      },
      logger,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      fireInitQueries: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true,
      // Full history sync is skipped for a lightweight startup, but recent
      // history sync stays enabled: Baileys 7 needs it for the initial LID
      // mappings and warns that disabling every sync type causes session errors.
      syncFullHistory: false,
      msgRetryCounterCache: new MemoryCache({ maxEntries: 1_000 }),
      userDevicesCache: new MemoryCache({ stdTtlMs: 5 * 60_000, maxEntries: 500 })
    });

    activeSocket = socket;
    socket.decodeJid = decodeJid;
    // Restores the persisted public/self mode (data/mode.json).
    socket.public = (await handleMessage.initializeMode(socket)) === 'public';

    const pairingState = {
      pending: false,
      requested: false,
      registered: state.creds.registered,
      // True once the WhatsApp handshake completed and a code can be issued.
      readyForPairing: false,
      lastQr: undefined
    };
    currentPairingState = pairingState;

    setStatus(
      pairingState.registered ? 'connecting' : 'pairing',
      pairingState.registered
        ? 'Restoring the saved WhatsApp session…'
        : `Waiting to pair ${config.botNumber}.`
    );

    socket.ev.on('creds.update', () => {
      void saveCreds().catch((error) => console.error('[auth] Failed to save credentials:', error));
    });
    socket.ev.on('connection.update', (update) => {
      void handleConnectionUpdate(socket, update, pairingState);
    });
    socket.ev.on('messages.upsert', (upsert) => {
      void handleMessages(socket, upsert);
    });
    socket.ev.on('group-participants.update', (update) => {
      void handleGroupParticipantsUpdate(socket, update).catch((error) => {
        console.error('[group-events] Failed to process participant update:', error);
      });
    });

    console.log(chalk.cyan(`[startup] ${config.botName} started. Auth directory: ${config.authDir}`));
  } catch (error) {
    activeSocket = undefined;
    currentPairingState = undefined;
    setStatus('error', `WhatsApp failed to initialize: ${error.message}`);
    console.error('[startup] Failed to initialize WhatsApp:', error);
    scheduleReconnect();
  }
}

function startWebServer() {
  webServer = createWebServer({
    config,
    themes: listThemes(),
    getActiveThemeId: () => activeTheme.id,
    setActiveTheme,
    getStatus: () => ({ ...liveStatus, uptimeMs: Date.now() - liveStatus.startedAt }),
    requestPairing: handlePairingRequest
  });

  webServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[web] Port ${config.webPort} is already in use. Set PORT to a free port.`);
      return;
    }
    console.error('[web] Dashboard server error:', error);
  });

  webServer.listen(config.webPort, config.webHost, () => {
    console.log(chalk.cyan(`[web] Pairing dashboard listening on http://${config.webHost}:${config.webPort} (theme: ${activeTheme.name}).`));
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (workerLaunchTimer) clearTimeout(workerLaunchTimer);
  console.log(`[shutdown] Received ${signal}; closing the bot process.`);

  try {
    webServer?.close();
  } catch (error) {
    console.error('[shutdown] Failed to close the dashboard server cleanly:', error);
  }

  try {
    activeSocket?.ws?.close();
  } catch (error) {
    console.error('[shutdown] Failed to close the WhatsApp socket cleanly:', error);
  }

  // A WebSocket implementation can occasionally retain an internal handle while closing.
  // Do not leave a deployment worker stuck during a stop/redeploy operation.
  setTimeout(() => process.exit(process.exitCode || 0), 5_000).unref();
}

// ---------------------------------------------------------------------------
// Supervisor side: spawn and keep the worker alive.
// ---------------------------------------------------------------------------

function launchChild() {
  const entry = path.join(__dirname, 'index.js');
  const child = spawn(process.execPath, [entry, CHILD_FLAG], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: process.env
  });
  childProcess = child;

  child.on('message', (message) => {
    if (message?.type !== 'reset') return;
    console.log('[supervisor] Restart requested by the bot; relaunching the worker.');
    resetting = true;
    child.kill('SIGTERM');
  });

  child.on('exit', (code, signal) => {
    childProcess = undefined;
    if (stopping) return;

    if (resetting) {
      resetting = false;
      scheduleWorkerLaunch();
      return;
    }

    // Crash-loop guard: a worker that keeps dying immediately means the
    // deployment itself is broken (bad configuration, missing credentials), so
    // report it instead of burning CPU in a restart loop.
    const now = Date.now();
    workerExits = workerExits.filter((at) => now - at < 60_000);
    workerExits.push(now);

    if (workerExits.length >= MAX_WORKER_RESTARTS_PER_MINUTE) {
      console.error('[supervisor] The worker keeps exiting; stopping instead of looping. Check the errors above.');
      process.exitCode = code ?? 1;
      shutdown('crash-loop');
      return;
    }

    console.warn(`[supervisor] Worker exited (code ${code}, signal ${signal}); restarting.`);
    scheduleWorkerLaunch();
  });

  child.on('error', (error) => {
    console.error('[supervisor] Failed to manage the worker process:', error);
  });
}

// Schedule restarts on a later turn rather than spawning inside the `exit`
// callback. Besides giving stdio a chance to flush the exit diagnostic, this
// prevents a rapidly failing worker from re-entering the supervisor's child
// lifecycle while Node is still delivering the prior exit event.
function scheduleWorkerLaunch() {
  if (stopping || workerLaunchTimer) return;

  workerLaunchTimer = setTimeout(() => {
    workerLaunchTimer = undefined;
    if (!stopping) launchChild();
  }, 25);
}

process.once('SIGINT', () => {
  if (!isChildProcess && childProcess) {
    stopping = true;
    childProcess.kill('SIGINT');
    return;
  }
  shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  if (!isChildProcess && childProcess) {
    stopping = true;
    childProcess.kill('SIGTERM');
    return;
  }
  shutdown('SIGTERM');
});

process.on('unhandledRejection', (error) => {
  console.error('[process] Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  const text = String(error?.message || error);
  if (IGNORED_PROCESS_ERRORS.some((needle) => text.includes(needle))) {
    console.warn(`[process] Ignored known WhatsApp socket noise: ${text}`);
    return;
  }

  console.error('[process] Uncaught exception:', error);
  process.exitCode = 1;
  shutdown('uncaughtException');
});

if (!isChildProcess && !config.dryRun) {
  launchChild();
} else if (config.dryRun) {
  bootstrapSession();
  console.log(`[startup] Dry run successful. Configuration for ${config.botName} is valid; no WhatsApp connection was opened.`);
} else {
  bootstrapSession();
  startWebServer();
  void startBot();
}

module.exports = {
  IGNORED_PROCESS_ERRORS,
  decodeJid,
  disconnectStatusCode,
  formatPairingCode,
  getActiveThemeId: () => activeTheme.id,
  handlePairingRequest,
  liveStatus,
  setActiveTheme,
  shouldReconnect
};
