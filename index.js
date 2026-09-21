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
  Browsers,
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
const { hasSession, prepareSession } = require('./system/session');
const { sendButtons } = require('./system/lib/ui');
const { authenticatedSelfJid, sendWelcomeVideo, welcomeCaption } = require('./system/lib/connection-welcome');
const { TelegramController } = require('./system/lib/telegram-controller');
const { TelegramControllerStore } = require('./system/lib/telegram-controllers');
const { TelegramPairingManager } = require('./system/lib/telegram-pairing-manager');
const { createSessionStatus, sessionDashboard, sessionDigits, transitionSessionStatus } = require('./system/lib/session-status');

// ---------------------------------------------------------------------------
// Process supervisor.
//
// `node index.js` spawns `node index.js --child` and keeps it alive. A crash or
// a `!restart` request therefore recovers without relying on the hosting panel
// to notice.
// ---------------------------------------------------------------------------

const CHILD_FLAG = '--child';
const isChildProcess = process.argv.includes(CHILD_FLAG);

// ---------------------------------------------------------------------------
// Supervisor restart policy.
//
// On Pterodactyl (and Heroku/Render) the supervisor *is* the container process,
// so `process.exit()` here is exactly what the panel reports as the server going
// OFFLINE. A worker that dies repeatedly therefore no longer takes the whole
// deployment down with it: after a burst of fast exits the supervisor cools off
// and keeps trying, and only gives up after a genuinely sustained failure.
// ---------------------------------------------------------------------------
const MAX_WORKER_RESTARTS_PER_MINUTE = 5;
// First pause taken after a burst of fast worker exits, instead of exiting.
// It doubles on every consecutive burst (60s, 120s, 240s, 300s cap), so a
// broken worker cannot burn CPU while a healthy one is never delayed.
const WORKER_COOLDOWN_MS = 60_000;
const WORKER_COOLDOWN_MAX_MS = 5 * 60_000;
// Absolute ceiling: only this many exits inside this window ends the supervisor.
const MAX_WORKER_RESTARTS_PER_WINDOW = 20;
const WORKER_GIVEUP_WINDOW_MS = 10 * 60_000;
// A worker that stayed up this long proves the deployment is healthy, so the
// burst/cool-off accounting starts fresh.
const HEALTHY_WORKER_MS = 60_000;
let workerExits = [];
let workerCoolingDown = false;
let workerCoolOffCount = 0;
let workerStartedAt = 0;

// The worker must never be allowed to run out of event-loop handles while it is
// supposed to be running. A dropped close event, a terminal primary disconnect
// (logout / replaced), or a Telegram outage would otherwise let Node exit
// cleanly with code 0 — the exact "silently goes OFFLINE" failure this bot had.
// This is not synthetic activity and it does not mask a crash: an uncaught
// exception still exits through the supervisor path below. It only stops a
// *legitimate* "nothing left to wait for" exit while Telegram-paired sessions,
// pending reconnects and the polling loop still have work to do. The watchdog
// in startDiagnostics() makes any genuinely stuck state visible instead of
// silent.
const KEEP_ALIVE_INTERVAL_MS = 60 * 60_000;
// Resource/health heartbeat for 24/7 diagnosis. Nothing secret is logged.
const MEMORY_LOG_INTERVAL_MS = 10 * 60_000;

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
let keepAliveTimer;
let memoryTimer;
let reconnectAttempts = 0;
let stopping = false;
let resetting = false;
let telegramController;
let telegramPairingManager;
let connectionCardSent = false;
// One connected-account welcome per paired session during this process. A
// reconnect must restore command handling without spamming the self chat.
const pairedSelfWelcomeSent = new Set();

// Live mirror of the primary WhatsApp socket state. Telegram pairing sessions
// expose their own owner-scoped status through TelegramPairingManager.
const liveStatus = Object.assign(createSessionStatus('primary'), {
  message: 'Starting the WhatsApp client…',
  pairingCode: null,
  pairingNumber: null,
  pairingRequestedAt: null,
  session: 'unknown',
  botUser: null,
  startedAt: Date.now()
});


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

// ---------------------------------------------------------------------------
// Diagnostics helpers.
//
// Every operational line carries one of the stable tags — [BOOT] [WHATSAPP]
// [TELEGRAM] [RECONNECT] [DATABASE] [ERROR] [MEMORY] [SHUTDOWN] — so a 24/7 host
// can be diagnosed from the panel console alone. The original human-readable
// prefixes ([connection], [startup], [telegram], [session], [supervisor], ...)
// are kept verbatim next to them, so anything already reading these logs keeps
// working. Nothing secret is ever interpolated: no Telegram token, no pairing
// code, no credential or session material — only status codes, counters and
// timings.
// ---------------------------------------------------------------------------

function stamp() {
  return new Date().toISOString();
}

function megabytes(value) {
  return (Number(value || 0) / 1_048_576).toFixed(1);
}

// Whether the primary WhatsApp credentials are still usable. Read from the live
// Baileys credential object only — never from disk, never logged in full.
function authStillValid() {
  const creds = activeSocket?.authState?.creds;
  return creds ? Boolean(creds.registered) : Boolean(liveStatus.session === 'paired');
}

function ensureKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => { /* intentional no-op handle; see note above */ }, KEEP_ALIVE_INTERVAL_MS);
}

// Slow resource/health heartbeat. Runs in the worker only, is unref'd so it can
// never by itself hold the loop open, and logs enough to spot a leak or a stuck
// connection from the panel console after the fact.
function startDiagnostics() {
  if (memoryTimer) return;
  memoryTimer = setInterval(() => {
    const memory = process.memoryUsage();
    console.info(
      `[MEMORY] ${stamp()} rss=${megabytes(memory.rss)}MB heapUsed=${megabytes(memory.heapUsed)}MB`
      + ` heapTotal=${megabytes(memory.heapTotal)}MB external=${megabytes(memory.external)}MB`
      + ` handles=${process.getActiveResourcesInfo().length} uptime=${Math.floor(process.uptime())}s`
      + ` state=${liveStatus.state} connected=${liveStatus.connected}`
      + ` reconnectPending=${Boolean(reconnectTimer)} authValid=${authStillValid()}`
      + ` pairedSockets=${telegramPairingManager ? telegramPairingManager.socketCount() : 0}`
    );
  }, MEMORY_LOG_INTERVAL_MS);
  memoryTimer.unref();
}

function disconnectStatusCode(lastDisconnect) {
  const error = lastDisconnect?.error;
  if (!error) return undefined;
  return error?.output?.statusCode || new Boom(error).output.statusCode;
}

// Disconnect reasons that permanently end the primary session.
//
// `badSession` (500) is deliberately NOT in this list. Baileys uses 500 as its
// catch-all fallback for every error it cannot classify:
//   lib/Utils/generics.js  getCodeFromWSError()      -> `let statusCode = 500;`
//   lib/Utils/generics.js  getErrorCodeFromStreamError() -> `|| DisconnectReason.badSession`
// so most 500s are transient server-side hiccups, not invalid credentials.
// Treating 500 as terminal was what stopped the bot reconnecting and let the
// worker fall through to a clean exit. Credentials are never deleted here for
// any reason — re-pairing stays a deliberate human action.
const TERMINAL_DISCONNECT_REASONS = Object.freeze([
  DisconnectReason.connectionReplaced,
  DisconnectReason.loggedOut
]);

function shouldReconnect(reason) {
  return !TERMINAL_DISCONNECT_REASONS.includes(reason);
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;

  const exponent = Math.min(reconnectAttempts, 5);
  const delay = Math.min(config.reconnectBaseDelayMs * 2 ** exponent, config.reconnectMaxDelayMs);
  reconnectAttempts += 1;

  console.warn(`[RECONNECT] [connection] ${stamp()} reconnecting in ${Math.ceil(delay / 1000)}s (attempt ${reconnectAttempts}, backoff capped at ${Math.ceil(config.reconnectMaxDelayMs / 1000)}s).`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void startBot();
  }, delay);
}

function setStatus(state, message, extra = {}) {
  // The lifecycle state drives `⚡ Last Event` (CONNECTED / RECONNECTING / …).
  // The human sentence stays available as liveStatus.message for logs; it must
  // never replace the event label, or the dashboard reports prose as an event.
  transitionSessionStatus(liveStatus, state);
  Object.assign(liveStatus, { message, ...extra });
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

// Telegram controller startup retry: 5s, 10s, 20s … capped at 5 minutes,
// unlimited attempts. The controller instance is reused, so no duplicate
// polling loop can ever be created.
const TELEGRAM_RETRY_BASE_DELAY_MS = 5_000;
const TELEGRAM_RETRY_MAX_DELAY_MS = 5 * 60_000;
const TELEGRAM_RETRY_JITTER = 0.2;

function isPermanentTelegramStartError(error) {
  const status = Number(error?.httpStatus || error?.telegramErrorCode);
  return status === 401 || status === 403;
}

function telegramStartRetryDelay(attempt, random = Math.random) {
  const exponent = Math.min(Math.max(0, attempt - 1), 6);
  const base = Math.min(TELEGRAM_RETRY_BASE_DELAY_MS * 2 ** exponent, TELEGRAM_RETRY_MAX_DELAY_MS);
  const draw = Number(random());
  const unit = Math.max(0, Math.min(1, Number.isFinite(draw) ? draw : 0.5));
  return Math.max(1_000, Math.round(base * (1 + ((unit * 2 - 1) * TELEGRAM_RETRY_JITTER))));
}
let telegramStartAttempts = 0;
let telegramRetryTimer;

function startTelegramController() {
  if (!config.telegramEnabled || (!config.telegramBotToken && !config.telegramOwnerIds.length)) {
    console.info('[TELEGRAM] [telegram] Controller disabled: configure telegram.enabled, telegram.botToken, and telegram.ownerIds in config.js to enable it.');
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
    onSocket: async (socket) => {
      socket.decodeJid = decodeJid;
      socket.public = (await handleMessage.initializeMode(socket)) === 'public';
      socket.ev.on('messages.upsert', (upsert) => {
        if (upsert.type !== 'notify') return;
        for (const rawMessage of upsert.messages || []) {
          if (!rawMessage?.message) continue;
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
      requestPairing: (ownerId, number, options) => telegramPairingManager.requestPairing(ownerId, number, options),
      cancelPairing: (ownerId, number, options) => telegramPairingManager.cancelPairing(ownerId, number, options),
      getStatus: (ownerId) => telegramPairingManager.snapshot(ownerId),
      statusOf: (ownerId, number, options) => telegramPairingManager.statusOf(ownerId, number, options),
      listSessions: (ownerId) => telegramPairingManager.listSessions(ownerId),
      // Async contract: the controller awaits this list (see the Sessions
      // button). Keeping it async here means a synchronous manager method can
      // never be mistaken for a Promise by a caller.
      listAllSessions: async () => telegramPairingManager.listAllSessions(),
      stopSession: (ownerId, number, options) => telegramPairingManager.stopSession(ownerId, number, options),
      restartSession: (ownerId, number, options) => telegramPairingManager.restartSession(ownerId, number, options),
      queuedPairingCount: () => telegramPairingManager.queuedPairingCount()
    },
    startImage: config.telegramStartImage,
    connectedImage: config.telegramConnectedImage,
    animeEdit: config.telegramAnimeEdit,
    publicMode: config.telegramPublicMode,
    premiumOnly: config.telegramPremiumOnly,
    requiredChannels: config.telegramRequiredChannels,
    sessionLimit: telegramPairingManager.limits.maxSessionsPerController,
    codeSource: telegramPairingManager.codeSourceLabel,
    // Identity shown by the Telegram DEVELOPER / THANKS TO pages: the configured
    // owner name plus the canonical protected developer identity, and the
    // configured official contact link. Nothing secret is passed here.
    identity: {
      owner: config.ownerName,
      developer: config.developerName,
      channel: config.whatsappChannel
    },
    // WhatsApp command prefix, used only to render the read-only ALL MENU
    // command directory on Telegram.
    commandPrefix: config.commandPrefix,
    // Owner activity monitoring: every notable event (start, pair request,
    // pairing issued/failed/completed, session connect/disconnect, protected
    // command use, verification success/failure) is formatted into a compact
    // ANIME MD • ACTIVITY box and delivered to the configured bootstrap owners.
    // Only non-sensitive fields are included — never pairing codes, tokens or
    // session credentials.
    activityLogger: (event) => telegramController?.sendOwnerActivity(event)
  });
  telegramPairingManager.onConnected = async (ownerId, session, socket) => {
    // ---------------------------------------------------------------------
    // The once-per-session WhatsApp welcome is claimed SYNCHRONOUSLY, before
    // any await. Two connection.open callbacks for the same session (a
    // duplicate Baileys event, or a reconnect racing the previous callback)
    // can otherwise both pass a check that runs after an await and deliver the
    // video/dashboard twice. The key is this session's own identity
    // (Telegram owner + paired number), never a single global flag, so
    // independent sessions each get exactly one welcome and can never block or
    // overwrite each other.
    // ---------------------------------------------------------------------
    const sessionKey = `${ownerId}:${session?.number || ''}`;
    const selfJid = authenticatedSelfJid(socket);
    const claimed = Boolean(socket) && Boolean(selfJid) && !pairedSelfWelcomeSent.has(sessionKey);
    if (claimed) pairedSelfWelcomeSent.add(sessionKey);

    // This notification is scoped to the Telegram owner whose isolated
    // WhatsApp socket authenticated. It is never broadcast to other owners.
    await telegramController?.notifySessionConnected(ownerId, session).catch(() => {
      console.warn('[telegram] Could not send the connected notification.');
    });

    // The paired account, not the Telegram owner or a configured developer,
    // receives the WhatsApp-side welcome. `socket.user.id` is Baileys' own
    // authenticated JID for this isolated session.
    if (!claimed) return;
    // socket.animeSessionStatus is THIS session's own status mirror, set by the
    // pairing manager when the socket was created: the dashboard therefore
    // reports the identity/state of the session that actually connected.
    const delivery = await sendConnectionSuccess(socket, socket.animeSessionStatus).catch((error) => {
      console.warn(`[connection] Could not send paired self-chat welcome: ${error?.message || error}`);
      return { delivered: false };
    });
    // Nothing reached the paired account (invalid destination, transport down):
    // release the claim so the next real connection can still greet it. A
    // partially delivered welcome keeps the claim, so a reconnect never repeats
    // a video that was already sent.
    if (!delivery?.delivered) pairedSelfWelcomeSent.delete(sessionKey);
  };
  telegramPairingManager.onDisconnected = async (ownerId, session, classification) => {
    // Only permanent endings (logged out, replaced, bad session) reach the
    // owner; temporary disconnects are handled by the reconnect logic.
    await telegramController?.notifySessionDisconnected(ownerId, session, classification);
  };
  telegramPairingManager.onCodeExpired = async (ownerId, session) => {
    // The code's TTL passed without a link (socket + unregistered credentials
    // already cleaned up): keep the pairing message honest instead of leaving
    // a stale "code ready" box.
    await telegramController?.notifyCodeExpired(ownerId, session);
  };
  void startTelegramWithRetry();
}

// Telegram must survive a transient API/network failure at boot. The previous
// one-shot `.catch()` assigned `telegramController = undefined` permanently, so
// a single failed `getMe` left the entire pairing system dead for the lifetime
// of the process. The SAME controller instance is retried: `start()` guards on
// `this.running`, so a retry can never open a second polling loop.
async function startTelegramWithRetry() {
  if (stopping || !telegramController) return;
  try {
    await telegramController.start();
    telegramStartAttempts = 0;
    console.info(`[TELEGRAM] [telegram] ${stamp()} Controller started successfully.`);
    // Bring previously paired sessions back online after a restart. This
    // never claims a WhatsApp connection: each session only reports CONNECTED
    // when its own socket reaches connection open.
    await telegramPairingManager.restore().catch((error) => {
      console.error(`[DATABASE] [telegram] Session restore failed: ${error.message}`);
    });
  } catch (error) {
    if (isPermanentTelegramStartError(error)) {
      console.error(`[TELEGRAM] [telegram] ${stamp()} Controller is disabled after a permanent Telegram API rejection (HTTP ${error.httpStatus}). Check telegram.botToken and bot access; it will not retry this configuration error automatically.`);
      return;
    }
    telegramStartAttempts += 1;
    const delay = telegramStartRetryDelay(telegramStartAttempts);
    console.error(`[TELEGRAM] [telegram] ${stamp()} Controller failed to start (attempt ${telegramStartAttempts}): ${error.message}. Recovery scheduled; Retrying in ${Math.ceil(delay / 1000)}s.`);
    if (telegramStartAttempts === 1) {
      console.error('[TELEGRAM] Check Telegram network/DNS access and the controller data file. Pairing stays unavailable until the controller starts.');
    }
    if (stopping) return;
    telegramRetryTimer = setTimeout(() => {
      telegramRetryTimer = undefined;
      void startTelegramWithRetry();
    }, delay);
  }
}

// Delivers the connected dashboard (+ the optional welcome video) for ONE real
// connection. It resolves its own failure modes: every media step is optional
// and contained, so a missing/invalid video, a failed upload or a temporary
// network problem can never fail the WhatsApp connection, mark the session
// inactive or crash the worker. The caller's once-per-session guard is released
// only when nothing at all was delivered (`delivered === false`).
async function sendConnectionSuccess(socket) {
  // The caller passes the session status that belongs to THIS connection
  // (the primary mirror, or a paired session's own mirror). Signature kept as
  // `(socket)` on purpose: the connection-media integration test extracts this
  // exact function from the source and runs the real code.
  const sessionStatus = arguments[1] || socket?.animeSessionStatus || liveStatus;
  const target = authenticatedSelfJid(socket);
  // The dashboard carries the real session number, so the only acceptable
  // destination is this session's own private chat. Groups, channels and status
  // broadcasts are rejected here; no auth state, session directory, credential
  // or socket internals are ever included in the payload.
  if (!target) throw new Error('Connected socket did not expose an authenticated private user JID.');

  const delivery = { delivered: false, video: false, image: false, card: false };

  // 1. Optional configured welcome video, captioned with the real dashboard.
  const video = await sendWelcomeVideo(socket, config.connectionWelcomeVideo);
  delivery.video = video.status === 'sent';
  if (delivery.video) delivery.delivered = true;

  // 2. Existing image fallback when the video is disabled or could not be sent.
  if (!delivery.video) {
    try {
      await socket.sendMessage(target, {
        image: { url: config.connectionSuccessImage },
        caption: config.connectionWelcomeVideo.enabled ? welcomeCaption(socket, sessionStatus) : `*${config.botName}*`
      });
      delivery.image = true;
      delivery.delivered = true;
    } catch {
      // A remote image must never prevent the existing text/menu fallback.
      console.warn('[connection] Welcome image could not be sent.');
    }
  }

  // 3. The connected dashboard card. Every value is resolved from this
  //    session's own live status/identity — never hardcoded, never masked.
  const text = [
    `*${config.botName}*`,
    '',
    '*Connected Successfully* ✓',
    '',
    sessionDashboard(sessionStatus, {
      socket,
      number: sessionStatus?.safeNumber || sessionStatus?.botUser || sessionDigits(target)
    }),
    '',
    'Your WhatsApp session is now active and ready to use.',
    '🔐 Secure Session • 🟢 System Ready'
  ].join('\n');

  // The menu button follows the live prefix (!setprefix changes it at runtime).
  const prefix = handleMessage.getCommandPrefix();
  try {
    await sendButtons(socket, target, {
      text,
      footer: config.botName,
      buttons: [{ label: '📖 MENU', id: `${prefix}menu home` }],
      fallbackText: `${text}\n\nType ${prefix}menu to open the command menu.`
    });
    delivery.card = true;
    delivery.delivered = true;
  } catch {
    // Keep the existing once-per-lifecycle flag after a media attempt. A
    // failed menu must not cause the successful video to repeat on reconnect.
    console.warn('[connection] Welcome menu could not be sent.');
  }

  return delivery;
}

async function handleConnectionUpdate(socket, update, pairingState) {
  if (socket !== activeSocket || stopping) return;

  if (update.connection === 'connecting') {
    setStatus('connecting', pairingState.registered ? 'Restoring the WhatsApp session…' : 'Connecting to WhatsApp…');
  }

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
    // Session identity comes from THIS socket's own authenticated JID — the
    // only value WhatsApp itself confirmed for the connection that just opened.
    // It is read here (not from a shared global set elsewhere) so two sessions
    // can never overwrite each other's number, and a stale socket cannot mutate
    // it: this whole handler is already gated on `socket === activeSocket`.
    const selfJid = authenticatedSelfJid(socket);
    const selfNumber = sessionDigits(selfJid) || null;
    setStatus('connected', `${config.botName} is connected to WhatsApp.`, {
      pairingCode: null,
      pairingRequestedAt: null,
      session: 'paired',
      sessionLabel: 'paired',
      safeNumber: selfNumber,
      botUser: socket.user?.id?.split(':')[0] || socket.user?.id || null
    });
    console.log(chalk.green(`[connection] ${config.botName} is connected to WhatsApp.`));
    console.log(chalk.cyan(`[connection] Logged in as: ${socket.user?.name || 'Unknown'} (${socket.user?.id?.split(':')[0] || 'n/a'})`));
    // Send exactly once per connected session lifecycle: reconnects and duplicate
    // connection.update events reuse the guarded socket and this flag. The flag
    // is claimed synchronously (before any await) and is only released again
    // when nothing at all could be delivered, so a duplicate open event or a
    // concurrent callback can never produce a second video/dashboard.
    if (selfJid && !connectionCardSent) {
      connectionCardSent = true;
      void sendConnectionSuccess(socket, liveStatus)
        .then((result) => {
          if (result?.delivered) {
            console.log('[connection] Connection success card sent.');
            return;
          }
          connectionCardSent = false;
          console.warn('[connection] Connection success card could not be delivered; it may be retried on the next real connection.');
        })
        .catch((error) => {
          connectionCardSent = false;
          console.warn(`[connection] Could not send the connection success card: ${error?.message || error}`);
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
  const willReconnect = shouldReconnect(reason);
  setStatus(reason === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected', label, {
    pairingCode: null,
    pairingNumber: null,
    pairingRequestedAt: null,
    session: reason === DisconnectReason.loggedOut ? 'logged_out' : liveStatus.session
  });
  // A terminal ending closes this session for good: transitionSessionStatus()
  // has already dropped its identity and stopped its uptime clock, and the
  // once-per-session welcome guard is released so a genuinely NEW session
  // (re-paired inside the same process) is greeted exactly once, while a
  // duplicate close event for the dead session cannot greet anything.
  if (!willReconnect) connectionCardSent = false;
  // One line per close carrying everything needed to diagnose a 24/7 outage
  // after the fact: reason, status code, the reconnect decision, and whether
  // the saved credentials are still usable. Never any credential material.
  console.warn(
    `[WHATSAPP] [connection] ${stamp()} ${label}`
    + ` | reason=${reason ?? 'none'} code=${reason ?? 'n/a'}`
    + ` reconnect=${willReconnect} authValid=${authStillValid()}`
    + ` registered=${Boolean(pairingState.registered)}`
  );

  if (willReconnect) {
    setStatus('reconnecting', label);
    scheduleReconnect();
    return;
  }

  // Terminal reasons (loggedOut / connectionReplaced). Credentials are left on
  // disk untouched, and the worker deliberately stays alive: one dead primary
  // session must never take the Telegram-paired sessions down with it. Without
  // the keep-alive handle this is exactly where Node used to run out of things
  // to wait for and exit cleanly with code 0.
  ensureKeepAlive();

  if (reason === DisconnectReason.loggedOut) {
    console.error('[ERROR] [WHATSAPP] This device was logged out. Pair again through Telegram, or set a fresh SESSION_ID, then restart the bot.');
    console.info('[WHATSAPP] The process stays online: Telegram pairing and any already-paired sessions keep working.');
    return;
  }

  console.error('[ERROR] [WHATSAPP] Automatic reconnection of the PRIMARY session stopped to avoid a loop (the session was replaced by another WhatsApp connection).');
  console.info('[WHATSAPP] The process stays online: Telegram pairing and any already-paired sessions keep working. Remove the invalid AUTH_DIR only if you need to pair again, then restart the bot.');
}

async function handleMessages(socket, upsert) {
  if (socket !== activeSocket || upsert.type !== 'notify') return;

  for (const rawMessage of upsert.messages || []) {
    if (!rawMessage?.message) continue;
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
  // primary socket when there is no primary session on disk: it cannot serve a
  // pairing request and was the source of needless timeout/reconnect noise.
  //
  // The decision is made from the credential file itself, NOT from
  // liveStatus.session. That string is a live status mirror: it becomes 'paired'
  // the moment the socket reaches connection open and 'logged_out' after a
  // logout. Gating on it meant a session that had connected even once could
  // never be recreated by the reconnect path — its first disconnect fell into
  // this idle branch and the primary session stayed dead until a manual restart.
  // Reading the disk is the only check that stays correct across reconnects,
  // restarts and a session being added or removed while the bot is running.
  if (config.authMethod === 'pairing' && !hasSession(config.authDir)) {
    setStatus('telegram_pairing', 'No primary session is restored. Use an authorized Telegram controller to pair a session.');
    // With no restored primary session and no Telegram token, Node otherwise
    // has no active handles and the supervisor would repeatedly restart the
    // healthy worker. Keep the process alive for later panel/env configuration.
    ensureKeepAlive();
    console.info('[BOOT] [WHATSAPP] [startup] Primary WhatsApp socket is idle; Telegram Pairing owns new sessions.');
    return;
  }

  try {
    // Pin the socket to the newest published WhatsApp Web
    // version; falling back to Baileys' bundled default keeps this safe offline.
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    if (!version) console.warn('[connection] Could not fetch the latest WhatsApp Web version; using the bundled default.');

    // A reconnect creates a fresh socket. Close a stale previous socket that
    // is somehow still open so it can never hold a handle, fire events into
    // the previous pairing state, or race the new socket. (Normally the old
    // socket is already dead — that is what triggered the reconnect — so this
    // is a no-op; its events are additionally filtered by the identity guard
    // in handleConnectionUpdate.)
    if (activeSocket?.ws?.isOpen) {
      try {
        activeSocket.ws.close();
      } catch {
        /* already gone */
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const logger = pino({ level: config.logLevel });
    const socket = makeWASocket({
      ...(version ? { version } : {}),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger.child({ level: 'silent' }))
      },
      logger,
      // Stock Baileys Ubuntu Desktop descriptor (['Ubuntu', 'Chrome', <current
      // Ubuntu version>]) — the SAME identity the Telegram pairing manager
      // announces, and the format Baileys currently supports. The old inline
      // tuple advertised Ubuntu too, but with a malformed version string
      // ('20.0.04') that drifted from every other connection path. Chrome is
      // deliberately KEPT: it is the client app name inside the descriptor, a
      // plain string — no Chrome installation is involved or required.
      browser: Browsers.ubuntu('Chrome'),
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

    // ---------------------------------------------------------------------
    // Listener attachment MUST happen synchronously right here.
    //
    // makeWASocket() starts the WebSocket handshake synchronously, and Baileys
    // destroys the socket's emitter inside its own end() handler
    // (lib/Socket/socket.js: `ev.removeAllListeners('connection.update')` +
    // `ev.destroy()`, which in turn calls `ev.removeAllListeners()`). Any
    // `await` between creating the socket and subscribing therefore opens a
    // window in which a connection.update is emitted and permanently lost.
    //
    // That is exactly what used to take this bot OFFLINE: a 'close' landing in
    // the window meant no reconnect was scheduled and no handle was left, so
    // Node exited cleanly with code 0. Subscribing first makes the race
    // impossible; everything after the subscriptions may await safely.
    // ---------------------------------------------------------------------
    activeSocket = socket;
    socket.decodeJid = decodeJid;
    // Handlers read this live object; they never infer status from auth files.
    socket.animeSessionStatus = liveStatus;

    const pairingState = {
      pending: false,
      requested: false,
      requestPromise: undefined,
      registered: state.creds.registered,
      // True once the WhatsApp handshake completed and a code can be issued.
      readyForPairing: false,
      lastQr: undefined
    };

    socket.ev.on('creds.update', () => {
      void saveCreds().catch((error) => console.error('[DATABASE] [auth] Failed to save credentials:', error));
    });
    socket.ev.on('connection.update', (update) => {
      void handleConnectionUpdate(socket, update, pairingState);
    });
    socket.ev.on('messages.upsert', (upsert) => {
      void handleMessages(socket, upsert);
    });
    socket.ev.on('group-participants.update', (update) => {
      void handleGroupParticipantsUpdate(socket, update).catch((error) => {
        console.error('[ERROR] [group-events] Failed to process participant update:', error);
      });
    });

    setStatus(
      pairingState.registered ? 'connecting' : 'pairing',
      pairingState.registered
        ? 'Restoring the saved WhatsApp session…'
        : 'Telegram Pairing is ready for authorized controllers.'
    );

    // Restores the persisted public/self mode (data/mode.json).
    socket.public = (await handleMessage.initializeMode(socket)) === 'public';

    console.log(chalk.cyan(`[BOOT] [startup] ${config.botName} started. Auth directory: ${config.authDir}`));
  } catch (error) {
    activeSocket = undefined;
    setStatus('error', `WhatsApp failed to initialize: ${error.message}`);
    console.error(`[ERROR] [WHATSAPP] [startup] ${stamp()} Failed to initialize WhatsApp: ${error.message}`);
    console.error('[startup] Failed to initialize WhatsApp:', error);
    scheduleReconnect();
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  if (memoryTimer) clearInterval(memoryTimer);
  if (telegramRetryTimer) clearTimeout(telegramRetryTimer);
  if (workerLaunchTimer) clearTimeout(workerLaunchTimer);
  console.log(`[SHUTDOWN] [shutdown] ${stamp()} Received ${signal}; closing the bot process.`);

  try {
    activeSocket?.ws?.close();
  } catch (error) {
    console.error('[SHUTDOWN] [shutdown] Failed to close the WhatsApp socket cleanly:', error);
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
  workerStartedAt = Date.now();

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

    // ---------------------------------------------------------------------
    // Crash-loop guard.
    //
    // This used to call shutdown() — and therefore process.exit() — after 5
    // worker exits in a minute. On Pterodactyl/Heroku/Render the supervisor IS
    // the container process, so that single exit is exactly what the panel
    // reports as the server going OFFLINE, and nothing brings it back. A
    // transient WhatsApp or network outage could therefore end the deployment
    // permanently.
    //
    // Now a burst of fast exits triggers a cool-off pause instead (so a broken
    // worker cannot burn CPU in a tight loop) and the supervisor keeps running.
    // It only gives up after a genuinely sustained failure.
    // ---------------------------------------------------------------------
    const now = Date.now();
    // A worker that stayed up for a while proves the deployment is healthy, so
    // the burst accounting starts fresh and a normal deployment can never
    // accumulate its way to the ceiling below.
    if (workerStartedAt && now - workerStartedAt >= HEALTHY_WORKER_MS) {
      workerExits = [];
      workerCoolOffCount = 0;
    }
    workerStartedAt = 0;
    workerExits.push(now);
    workerExits = workerExits.filter((at) => now - at < WORKER_GIVEUP_WINDOW_MS);
    const burst = workerExits.filter((at) => now - at < 60_000).length;

    if (workerExits.length >= MAX_WORKER_RESTARTS_PER_WINDOW) {
      // Documented fatal termination. The worker has exited
      // MAX_WORKER_RESTARTS_PER_WINDOW times inside WORKER_GIVEUP_WINDOW_MS,
      // which means the deployment itself cannot start (bad configuration,
      // missing credentials, unreadable auth directory). Continuing would burn
      // CPU forever without progress, so a human has to intervene.
      console.error(`[ERROR] [supervisor] ${stamp()} The worker exited ${workerExits.length} times in ${Math.round(WORKER_GIVEUP_WINDOW_MS / 60_000)} minutes; the deployment cannot start. Check the errors above.`);
      process.exitCode = code ?? 1;
      shutdown('crash-loop');
      return;
    }

    if (burst >= MAX_WORKER_RESTARTS_PER_MINUTE) {
      const cooldownMs = Math.min(WORKER_COOLDOWN_MS * 2 ** Math.min(workerCoolOffCount, 4), WORKER_COOLDOWN_MAX_MS);
      workerCoolOffCount += 1;
      if (!workerCoolingDown) {
        workerCoolingDown = true;
        console.error(`[ERROR] [supervisor] ${stamp()} The worker exited ${burst} times in the last minute (code ${code}, signal ${signal}). Pausing ${Math.round(cooldownMs / 1000)}s before the next start instead of stopping — the container stays online.`);
      }
      scheduleWorkerLaunch(cooldownMs);
      return;
    }

    workerCoolingDown = false;
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
function scheduleWorkerLaunch(delayMs = 25) {
  if (stopping || workerLaunchTimer) return;

  workerLaunchTimer = setTimeout(() => {
    workerLaunchTimer = undefined;
    // Each cool-off cycle reports itself once, then the counter starts fresh.
    workerCoolingDown = false;
    if (!stopping) launchChild();
  }, delayMs);
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
  // Deliberately non-fatal: a single rejected promise (a failed send, a stalled
  // API call) must not end a 24/7 process. It is logged with enough context to
  // find the cause.
  console.error(`[ERROR] [process] ${stamp()} Unhandled promise rejection:`, error);
});

process.on('uncaughtException', (error) => {
  const text = String(error?.message || error);
  if (IGNORED_PROCESS_ERRORS.some((needle) => text.includes(needle))) {
    console.warn(`[ERROR] [process] ${stamp()} Ignored known WhatsApp socket noise: ${text}`);
    return;
  }

  console.error(`[ERROR] [process] ${stamp()} Uncaught exception:`, error);
  process.exitCode = 1;
  shutdown('uncaughtException');
});

if (!isChildProcess && !config.dryRun) {
  launchChild();
} else if (config.dryRun) {
  bootstrapSession();
  console.log(`[BOOT] [startup] Dry run successful. Configuration for ${config.botName} is valid; no WhatsApp connection was opened.`);
} else {
  console.log(`[BOOT] [startup] ${stamp()} ${config.botName} worker starting (pid ${process.pid}, node ${process.version}).`);
  // Keeps the worker from ever running out of event-loop handles while it is
  // supposed to be running, and emits the periodic [MEMORY]/health heartbeat.
  ensureKeepAlive();
  startDiagnostics();
  bootstrapSession();
  startTelegramController();
  void startBot();
}

module.exports = {
  IGNORED_PROCESS_ERRORS,
  MAX_WORKER_RESTARTS_PER_MINUTE,
  MAX_WORKER_RESTARTS_PER_WINDOW,
  MEMORY_LOG_INTERVAL_MS,
  TELEGRAM_RETRY_BASE_DELAY_MS,
  TELEGRAM_RETRY_MAX_DELAY_MS,
  TELEGRAM_RETRY_JITTER,
  TERMINAL_DISCONNECT_REASONS,
  WORKER_COOLDOWN_MS,
  WORKER_GIVEUP_WINDOW_MS,
  decodeJid,
  disconnectStatusCode,
  formatPairingCode,
  liveStatus,
  isPermanentTelegramStartError,
  shouldReconnect,
  telegramStartRetryDelay,
  // Exposed for integration tests; the worker calls these during startup.
  startBot,
  startTelegramController,
  startTelegramWithRetry
};
