'use strict';

const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
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

let activeSocket;
let reconnectTimer;
let reconnectAttempts = 0;
let stopping = false;

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

async function promptForPairingNumber() {
  if (config.pairingNumber) return config.pairingNumber;

  if (!input.isTTY) {
    console.warn('[pairing] PAIRING_NUMBER is not set and this host is non-interactive. Set PAIRING_NUMBER to request a pairing code, or use AUTH_METHOD=qr in a local terminal.');
    return undefined;
  }

  const terminal = readline.createInterface({ input, output });
  try {
    const answer = await terminal.question('Enter the WhatsApp number to pair (country code, digits only): ');
    const number = answer.replace(/\D/g, '');
    if (!/^\d{7,15}$/.test(number)) {
      throw new Error('The pairing number must contain 7-15 digits, including its country code.');
    }
    return number;
  } finally {
    terminal.close();
  }
}

function renderQrCode(qr, pairingState) {
  if (pairingState.lastQr === qr) return;
  pairingState.lastQr = qr;

  if (!output.isTTY) {
    console.warn('[qr] A QR code was received, but this host is non-interactive. Use AUTH_METHOD=pairing with PAIRING_NUMBER for cloud hosting.');
    return;
  }

  console.log('[qr] Scan this QR code from WhatsApp Linked Devices:');
  qrcode.generate(qr, { small: true });
}

async function requestPairingCode(socket, pairingState) {
  if (pairingState.requested || pairingState.pending || pairingState.registered) return;
  pairingState.pending = true;

  try {
    const number = await promptForPairingNumber();
    if (!number) return;
    
    // Add a small delay to ensure socket is ready for pairing
    // Baileys 7.0.0-rc14 may emit QR before full socket initialization
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const code = await socket.requestPairingCode(number);
    pairingState.requested = true;
    console.log(chalk.green(`[pairing] Enter this code in WhatsApp: ${code}`));
  } catch (error) {
    console.error(`[pairing] Could not request a pairing code: ${error.message}`);
  } finally {
    pairingState.pending = false;
  }
}

async function handleConnectionUpdate(socket, update, pairingState) {
  if (socket !== activeSocket || stopping) return;

  // Handle pairing/QR flow when connection is connecting or open
  if (update.qr && !pairingState.registered) {
    if (config.authMethod === 'pairing') {
      // Only request pairing code when socket is actively connecting
      // This prevents race conditions where QR fires before socket is ready
      if (update.connection === 'connecting' || update.connection === undefined) {
        await requestPairingCode(socket, pairingState);
      }
    } else {
      renderQrCode(update.qr, pairingState);
    }
  }

  if (update.connection === 'open') {
    reconnectAttempts = 0;
    pairingState.registered = true;
    console.log(chalk.green(`[connection] ${config.botName} is connected to WhatsApp.`));
    return;
  }

  if (update.connection !== 'close') return;

  const reason = disconnectStatusCode(update.lastDisconnect);
  const label = disconnectLabels[reason] || `Unknown disconnect reason: ${reason ?? 'not supplied'}.`;
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
    console.error('[startup] Failed to initialize WhatsApp:', error);
    scheduleReconnect();
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log(`[shutdown] Received ${signal}; closing the bot process.`);

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
  void startBot();
}

module.exports = {
  decodeJid,
  disconnectStatusCode,
  shouldReconnect,
  startBot
};
