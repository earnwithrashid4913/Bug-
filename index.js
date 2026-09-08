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
const { formatPairingCodeDisplay: formatPairingCode } = require('./system/lib/pairing-number');
const { prepareSession } = require('./system/session');
const { sendButtons } = require('./system/lib/ui');
const { TelegramController } = require('./system/lib/telegram-controller');
const { TelegramControllerStore } = require('./system/lib/telegram-controllers');
const { TelegramPairingManager } = require('./system/lib/telegram-pairing-manager');

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
let childProcess;
let workerLaunchTimer;
let reconnectTimer;
let idleKeepAliveTimer;
let reconnectAttempts = 0;
let stopping = false;
let resetting = false;
let telegramController;
let telegramPairingManager;
let connectionCardSent = false;

// Live mirror of the primary WhatsApp socket state. Telegram pairing sessions
// expose their own owner-scoped status through TelegramPairingManager.
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
    console.warn('[qr] A QR code was received, but this host is non-interactive. Use Telegram /pair <number> instead.');
    return;
  }

  console.log('[qr] Scan this QR code from WhatsApp Linked Devices:');
  qrcode.generate(qr, { small: true });
}

// Pairing codes are displayed in groups of four characters:
// two groups of four characters separated by a dash. The formatter lives in
// system/lib/pairing-number.js and is shared with the Telegram pairing flow.

function startTelegramController() {
  if (!config.telegramEnabled || (!config.telegramBotToken && !config.telegramOwnerIds.length)) {
    console.info('[telegram] Controller disabled: configure telegram.enabled, telegram.botToken, and telegram.ownerIds in config.js to enable it.');
    return;
  }
  if (!config.telegramBotToken) {
    console.error('[telegram] Controller disabled: telegram.botToken is missing. Get a token from @BotFather and add it to config.js.');
    return;
  }
  if (!config.telegramOwnerIds.length) {
    console.error('[telegram] telegram.botToken is set but telegram.ownerIds is empty; controller is disabled.');
    return;
  }
  telegramPairingManager = new TelegramPairingManager({
    authDir: config.authDir,
    customPairingCode: config.telegramPairingCode,
    onSocket: async (socket) => {
      socket.decodeJid = decodeJid;
      socket.public = (await handleMessage.initializeMode(socket)) === 'public';
      socket.ev.on('messages.upsert', (upsert) => {
        if (upsert.type !== 'notify') return;
        for (const rawMessage of upsert.messages || []) {
          if (!rawMessage?.message || rawMessage.key?.remoteJid === 'status@broadcast') continue;
          void handleMessage(socket, rawMessage).catch((error) => console.error('[message] Failed to process Telegram-paired session message:', error));
        }
      });
      socket.ev.on('group-participants.update', (update) => {
        void handleGroupParticipantsUpdate(socket, update).catch((error) => console.error('[group-events] Failed to process Telegram-paired session update:', error));
      });
    }
  });
  telegramController = new TelegramController({
    token: config.telegramBotToken,
    owners: config.telegramOwnerIds,
    controllerStore: new TelegramControllerStore(config.telegramControllerDbPath),
    pairing: {
      requestPairing: (ownerId, number) => telegramPairingManager.requestPairing(ownerId, number),
      getStatus: (ownerId) => telegramPairingManager.snapshot(ownerId),
      statusOf: (ownerId, number, options) => telegramPairingManager.statusOf(ownerId, number, options),
      listSessions: (ownerId) => telegramPairingManager.listSessions(ownerId),
      listAllSessions: () => telegramPairingManager.listAllSessions(),
      stopSession: (ownerId, number, options) => telegramPairingManager.stopSession(ownerId, number, options),
      restartSession: (ownerId, number, options) => telegramPairingManager.restartSession(ownerId, number, options)
    },
    startImage: config.telegramStartImage,
    connectedImage: config.telegramConnectedImage,
    publicMode: config.telegramPublicMode,
    premiumOnly: config.telegramPremiumOnly,
    requiredChannels: config.telegramRequiredChannels,
    sessionLimit: telegramPairingManager.limits.maxSessionsPerController,
    pairingBrand: telegramPairingManager.brandLabel
  });
  telegramPairingManager.onConnected = async (ownerId, session) => {
    // This notification is scoped to the Telegram owner whose isolated
    // WhatsApp socket authenticated. It is never broadcast to other owners.
    await telegramController?.notifySessionConnected(ownerId, session);
  };
  telegramPairingManager.onDisconnected = async (ownerId, session, classification) => {
    // Only permanent endings (logged out, replaced, bad session) reach the
    // owner; temporary disconnects are handled by the reconnect logic.
    await telegramController?.notifySessionDisconnected(ownerId, session, classification);
  };
  void telegramController.start()
    .then(async () => {
      console.info('[telegram] Controller started successfully.');
      // Bring previously paired sessions back online after a restart. This
      // never claims a WhatsApp connection: each session only reports CONNECTED
      // when its own socket reaches connection open.
      await telegramPairingManager.restore().catch((error) => {
        console.error(`[telegram] Session restore failed: ${error.message}`);
      });
    })
    .catch((error) => {
      telegramController = undefined;
      console.error(`[telegram] Controller failed to start: ${error.message}. Check telegram.botToken, telegram.ownerIds, and Telegram network access.`);
    });
}

async function sendConnectionSuccess(socket) {
  const target = normalizeSelfJid(socket.user?.id);
  if (!target) throw new Error('Connected socket did not expose a user JID.');

  await socket.sendMessage(target, {
    image: { url: config.connectionSuccessImage },
    caption: '*ANIME MD*'
  });

  const text = [
    '*ANIME MD*',
    '',
    '*Connected Successfully* ✓',
    '',
    'Your WhatsApp session is now active and ready to use.',
    '',
    `Developer: ${config.developerName}`
  ].join('\n');

  // The menu button follows the live prefix (!setprefix changes it at runtime).
  const prefix = handleMessage.getCommandPrefix();
  await sendButtons(socket, target, {
    text,
    footer: `${config.botName} · ${config.ownerName}`,
    buttons: [{ label: '☷ Open Menu', id: `${prefix}menu home` }],
    fallbackText: `${text}\n\nType ${prefix}menu to open the command menu.`
  });
}

function normalizeSelfJid(jid) {
  if (!jid) return undefined;
  return jid.includes(':') ? jid.replace(/:\d+@/, '@') : jid;
}

async function handleConnectionUpdate(socket, update, pairingState) {
  if (socket !== activeSocket || stopping) return;

  if (update.qr && !pairingState.registered) {
    // The handshake is complete from here on, so a pairing code can be issued.
    pairingState.readyForPairing = true;

    if (config.authMethod === 'pairing') {
      setStatus('pairing', 'Telegram Pairing is available to authorized controllers.');
    } else {
      // Terminal-only QR fallback for directly managed primary sessions.
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
    // Send exactly once per process/session lifecycle: reconnects and duplicate
    // connection.update events reuse the guarded socket and this flag.
    if (socket.user?.id && !connectionCardSent) {
      connectionCardSent = true;
      void sendConnectionSuccess(socket)
        .then(() => console.log('[connection] Connection success card sent.'))
        .catch((error) => {
          connectionCardSent = false;
          console.warn(`[connection] Could not send the connection success card: ${error.message}`);
        });
    }
    void telegramController?.notifyConnected().catch((error) => {
      console.warn(`[telegram] Could not send WhatsApp-connected notification: ${error.message}`);
    });
    return;
  }

  if (update.connection !== 'close') return;

  pairingState.readyForPairing = false;
  const reason = disconnectStatusCode(update.lastDisconnect);
  const label = disconnectLabels[reason] || `Unknown disconnect reason: ${reason ?? 'not supplied'}.`;
  setStatus(reason === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected', label, {
    pairingCode: null,
    pairingNumber: null,
    pairingRequestedAt: null,
    session: reason === DisconnectReason.loggedOut ? 'logged_out' : liveStatus.session
  });
  console.warn(`[connection] ${label}`);

  if (shouldReconnect(reason)) {
    scheduleReconnect();
    return;
  }

  if (reason === DisconnectReason.loggedOut) {
    console.error('[connection] This device was logged out. Pair again through Telegram, or set a fresh SESSION_ID, then restart the bot.');
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
    // A bad SESSION_ID must not brick the deployment: Telegram Pairing remains
    // available for authorized controllers.
    liveStatus.session = 'invalid';
    console.error(chalk.red(`[session] ${error.message}`));
    console.error('[session] Telegram Pairing remains available so you can pair again with /pair.');
    return 'invalid';
  }
}

async function startBot() {
  if (stopping) return;

  // Telegram owns new pairing sessions. Do not create an unauthenticated
  // primary socket when there is no restored primary session: it cannot serve
  // a pairing request and was the source of needless timeout/reconnect noise.
  if (config.authMethod === 'pairing' && !['existing', 'created', 'overwritten'].includes(liveStatus.session)) {
    setStatus('telegram_pairing', 'No primary session is restored. Use an authorized Telegram controller to pair a session.');
    // With no restored primary session and no Telegram token, Node otherwise
    // has no active handles and the supervisor would repeatedly restart the
    // healthy worker. Keep the process alive for later panel/env configuration.
    if (!idleKeepAliveTimer) idleKeepAliveTimer = setInterval(() => {}, 60 * 60_000);
    console.info('[startup] Primary WhatsApp socket is idle; Telegram Pairing owns new sessions.');
    return;
  }

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
      requestPromise: undefined,
      registered: state.creds.registered,
      // True once the WhatsApp handshake completed and a code can be issued.
      readyForPairing: false,
      lastQr: undefined
    };

    setStatus(
      pairingState.registered ? 'connecting' : 'pairing',
      pairingState.registered
        ? 'Restoring the saved WhatsApp session…'
        : 'Telegram Pairing is ready for authorized controllers.'
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
    setStatus('error', `WhatsApp failed to initialize: ${error.message}`);
    console.error('[startup] Failed to initialize WhatsApp:', error);
    scheduleReconnect();
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (idleKeepAliveTimer) clearInterval(idleKeepAliveTimer);
  if (workerLaunchTimer) clearTimeout(workerLaunchTimer);
  console.log(`[shutdown] Received ${signal}; closing the bot process.`);

  try {
    activeSocket?.ws?.close();
  } catch (error) {
    console.error('[shutdown] Failed to close the WhatsApp socket cleanly:', error);
  }
  telegramController?.stop();
  void telegramPairingManager?.shutdown();

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
  startTelegramController();
  void startBot();
}

module.exports = {
  IGNORED_PROCESS_ERRORS,
  decodeJid,
  disconnectStatusCode,
  formatPairingCode,
  liveStatus,
  shouldReconnect,
  // Exposed for integration tests; the worker calls this during startup.
  startTelegramController
};
