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

const { config, normalizePhoneNumber } = require('./system/config');
const { handleGroupParticipantsUpdate } = require('./system/group-events');
const handleMessage = require('./system/handler');
const { getActiveTheme, listThemes } = require('./system/theme');
const { createWebServer } = require('./system/web');

let activeSocket;
let currentPairingState;
let reconnectTimer;
let reconnectAttempts = 0;
let stopping = false;
let httpServer;

const liveStatus = {
  status: 'starting',
  pairingCode: null,
  lastQr: null,
  connectedAt: null
};
const recentLogs = [];

function logEvent(level, message) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  recentLogs.push({ time, level, message });
  if (recentLogs.length > 50) recentLogs.shift();
}

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

function assertConnectedBotIdentity(socket) {
  const connectedJid = decodeJid(socket.user?.id);
  const connectedNumber = connectedJid?.split('@')[0];
  let normalizedConnectedNumber;
  try {
    normalizedConnectedNumber = normalizePhoneNumber(connectedNumber, 'Connected WhatsApp account');
  } catch {
    throw new Error('Bot connection identity could not be verified from the authenticated WhatsApp account.');
  }

  if (normalizedConnectedNumber !== config.botNumber) {
    throw new Error(
      `Bot connection identity mismatch: BOT_NUMBER is ${config.botNumber}, ` +
      `but the authenticated WhatsApp account is ${normalizedConnectedNumber}.`
    );
  }
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

function renderQrCode(qr, pairingState) {
  if (pairingState.lastQr === qr) return;
  pairingState.lastQr = qr;

  if (!output.isTTY) {
    console.warn('[qr] A QR code was received, but this host is non-interactive. Use AUTH_METHOD=pairing with BOT_NUMBER for cloud hosting.');
    return;
  }

  console.log('[qr] Scan this QR code from WhatsApp Linked Devices:');
  qrcode.generate(qr, { small: true });
}

async function requestPairingCode(socket, pairingState, targetNumber) {
  const numberToPair = targetNumber || config.botNumber;
  if (pairingState.pending || pairingState.registered) return liveStatus.pairingCode;
  pairingState.pending = true;

  try {
    // Add a small delay to ensure socket is ready for pairing
    // Baileys 7.0.0-rc14 may emit QR before full socket initialization
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const code = await socket.requestPairingCode(numberToPair);
    pairingState.requested = true;
    liveStatus.pairingCode = code;
    liveStatus.botNumber = numberToPair;
    liveStatus.status = 'pairing';
    logEvent('pairing', `Pairing code generated for +${numberToPair}: ${code}`);
    console.log(chalk.green(`[pairing] Enter this code in WhatsApp (+${numberToPair}): ${code}`));
    return code;
  } catch (error) {
    logEvent('error', `Could not request pairing code for +${numberToPair}: ${error.message}`);
    console.error(`[pairing] Could not request a pairing code: ${error.message}`);
    throw error;
  } finally {
    pairingState.pending = false;
  }
}

async function handleConnectionUpdate(socket, update, pairingState) {
  if (socket !== activeSocket || stopping) return;

  // Handle pairing/QR flow when connection is connecting or open
  if (update.qr && !pairingState.registered) {
    liveStatus.lastQr = update.qr;
    if (config.authMethod === 'pairing') {
      // Only request pairing code when socket is actively connecting
      // This prevents race conditions where QR fires before socket is ready
      if (update.connection === 'connecting' || update.connection === undefined) {
        await requestPairingCode(socket, pairingState);
      }
    } else {
      liveStatus.status = 'qr';
      renderQrCode(update.qr, pairingState);
    }
  }

  if (update.connection === 'open') {
    try {
      assertConnectedBotIdentity(socket);
    } catch (error) {
      logEvent('error', `Connection identity mismatch: ${error.message}`);
      console.error(`[security] ${error.message}`);
      process.exitCode = 1;
      shutdown('connection identity mismatch');
      return;
    }
    reconnectAttempts = 0;
    pairingState.registered = true;
    liveStatus.status = 'connected';
    liveStatus.connectedAt = new Date().toISOString();
    logEvent('info', `${config.masterBotName} is connected to WhatsApp.`);
    console.log(chalk.green(`[connection] ${config.masterBotName} is connected to WhatsApp.`));
    return;
  }

  if (update.connection !== 'close') return;

  const reason = disconnectStatusCode(update.lastDisconnect);
  const label = disconnectLabels[reason] || `Unknown disconnect reason: ${reason ?? 'not supplied'}.`;
  liveStatus.status = 'disconnected';
  logEvent('warn', `WhatsApp disconnected: ${label}`);
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
      browser: [config.masterBotName, 'Chrome', '1.0.0'],
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

    console.log(chalk.cyan(`[startup] ${config.masterBotName} started. Auth directory: ${config.authDir}`));
  } catch (error) {
    console.error('[startup] Failed to initialize WhatsApp:', error);
    scheduleReconnect();
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log(`[shutdown] Received ${signal}; closing the bot process.`);

  if (httpServer) {
    try {
      httpServer.close();
    } catch (error) {
      console.error('[shutdown] Failed to close web server cleanly:', error);
    }
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

function startServer(port = config.webPort, host = '0.0.0.0') {
  if (httpServer) return httpServer;
  httpServer = createWebServer({
    config,
    liveStatus,
    recentLogs,
    getActiveTheme,
    listThemes,
    getPublicMode: handleMessage.getPublicMode,
    port,
    host,
    onRefreshPairingCode: async (phoneNumber) => {
      let targetNumber = config.botNumber;
      if (phoneNumber && typeof phoneNumber === 'string' && phoneNumber.trim()) {
        try {
          const requestedNumber = normalizePhoneNumber(phoneNumber, 'Pairing phone number');
          if (requestedNumber !== config.botNumber) {
            throw new Error('The web pairing interface can only request a code for the configured BOT_NUMBER.');
          }
        } catch (err) {
          logEvent('warn', `Invalid pairing request: ${err.message}`);
          throw err;
        }
      }
      if (activeSocket && currentPairingState && !currentPairingState.registered) {
        currentPairingState.requested = false;
        currentPairingState.pending = false;
        liveStatus.pairingCode = null;
        logEvent('pairing', `Pairing code requested for +${targetNumber}`);
        return await requestPairingCode(activeSocket, currentPairingState, targetNumber);
      }
      return liveStatus.pairingCode;
    }
  });
  return httpServer;
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

if (require.main === module) {
  if (config.dryRun) {
    liveStatus.status = 'dry_run';
    console.log(`[startup] Dry run successful. Configuration for ${config.masterBotName} is valid; no WhatsApp connection was opened.`);
  } else {
    startServer();
    logEvent('info', `${config.masterBotName} starting... Auth dir: ${config.authDir}`);
    void startBot();
  }
}

module.exports = {
  decodeJid,
  assertConnectedBotIdentity,
  disconnectStatusCode,
  shouldReconnect,
  startBot,
  startServer
};
