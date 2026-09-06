'use strict';

const { stdout: output } = require('node:process');
const chalk = require('chalk');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  DisconnectReason,
  jidDecode,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');

const { config } = require('./system/config');
const { handleGroupParticipantsUpdate } = require('./system/group-events');
const handleMessage = require('./system/handler');
const { getTheme, isThemeId, listThemes, resolveTheme } = require('./system/theme');
const { createWebServer } = require('./system/web');

let activeSocket;
let webServer;
let reconnectTimer;
let reconnectAttempts = 0;
let stopping = false;
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
    console.log(chalk.green(`[pairing] Enter this code in WhatsApp (${number}): ${code}`));
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
  if (!activeSocket || !currentPairingState) {
    throw Object.assign(
      new Error('The WhatsApp client is still starting. Try again in a few seconds.'),
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
    if (config.authMethod === 'pairing') {
      setStatus('pairing', `Requesting a pairing code for ${config.botNumber}…`);
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
      pairingRequestedAt: null
    });
    console.log(chalk.green(`[connection] ${config.botName} is connected to WhatsApp.`));
    return;
  }

  if (update.connection !== 'close') return;

  const reason = disconnectStatusCode(update.lastDisconnect);
  const label = disconnectLabels[reason] || `Unknown disconnect reason: ${reason ?? 'not supplied'}.`;
  setStatus(reason === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected', label, {
    pairingCode: null
  });
  console.warn(`[connection] ${label}`);

  if (shouldReconnect(reason)) {
    scheduleReconnect();
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

async function startBot() {
  if (stopping) return;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const socket = makeWASocket({
      auth: state,
      browser: [config.botName, 'Chrome', '1.0.0'],
      logger: pino({ level: config.logLevel }),
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    activeSocket = socket;
    socket.decodeJid = decodeJid;
    socket.public = config.publicMode;

    const pairingState = {
      pending: false,
      requested: false,
      registered: state.creds.registered,
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

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  console.error('[process] Unhandled promise rejection:', error);
});
process.on('uncaughtException', (error) => {
  console.error('[process] Uncaught exception:', error);
  process.exitCode = 1;
  shutdown('uncaughtException');
});

if (config.dryRun) {
  console.log(`[startup] Dry run successful. Configuration for ${config.botName} is valid; no WhatsApp connection was opened.`);
} else {
  startWebServer();
  void startBot();
}

module.exports = {
  decodeJid,
  disconnectStatusCode,
  getActiveThemeId: () => activeTheme.id,
  handlePairingRequest,
  liveStatus,
  setActiveTheme,
  shouldReconnect,
  startBot
};
