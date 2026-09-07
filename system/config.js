'use strict';

// ============================================================================
// ANIME MD — Centralized Configuration
//
// This file is the SINGLE SOURCE for all bot settings.
// Values come from .env (environment variables) → DEFAULTS → logic below.
//
// DO NOT change variable names here without checking every file that reads
// config.* properties — the entire bot depends on these names.
//
// For help editing your .env file, see .env.example (fully commented).
// ============================================================================

const path = require('node:path');
const dotenv = require('dotenv');
const { CANONICAL_IDENTITY, assertProtectedSecurityEnvironment } = require('./security');

// Load the repository-root .env even when a hosting panel launches Node from a
// different working directory. Existing Pterodactyl/process environment values
// retain dotenv's normal precedence and are never overwritten.
dotenv.config({ path: process.env.ENV_FILE || path.resolve(__dirname, '..', '.env') });

// Project identity is canonical, not deployer-tunable. `security.js` refuses to
// start when a protected identity key (OWNER_NUMBER, DEVELOPER_*, GLOBAL_OWNER*)
// is supplied through the environment, so identity cannot be spoofed by config.
assertProtectedSecurityEnvironment();

// These come from system/security.js — they are permanent and source-controlled.
const DEVELOPER_NAME = CANONICAL_IDENTITY.organization;   // "F!xa Dev"
const DEVELOPER_HANDLE = CANONICAL_IDENTITY.developer;     // "F!xa Dev"
const AUTHOR_NAME = CANONICAL_IDENTITY.author;             // "Rashid Hussain"
const PROJECT_NAME = CANONICAL_IDENTITY.projectName;       // "ANIME MD"

// ---------------------------------------------------------------------------
// DEFAULTS — safe fallback values for every optional setting.
//
// OWNER_NAME is a display setting. The WhatsApp account is selected by the
// person requesting a pairing code; it is never a deployment environment value.
// ---------------------------------------------------------------------------
const DEFAULTS = Object.freeze({
  botName: PROJECT_NAME,
  ownerName: 'Rashid Hussain',
  whatsappChannel: 'https://whatsapp.com/channel/0029VbBepCNBVJl5vGUHET3T',
  commandPrefix: '!',
  stickerPackname: PROJECT_NAME,
  stickerAuthor: DEVELOPER_HANDLE,
  publicMode: true,
  // Telegram is the primary pairing surface. QR remains available for a
  // directly managed primary WhatsApp session.
  authMethod: 'pairing',
  authDir: './session',
  dataDir: './data',
  sessionOverwrite: false,
  welcomeMessage: 'Welcome @user to *@group*!',
  goodbyeMessage: 'Goodbye @user from *@group*.',
  connectionSuccessImage: 'https://files.catbox.moe/6ghm7j.png',
  telegramStartImage: 'https://files.catbox.moe/cvdoo3.png',
  telegramConnectedImage: 'https://files.catbox.moe/uuuqdm.png',
  groqModel: 'openai/gpt-oss-20b',
  cobaltApiUrl: 'https://cobalt-api.kwiatekmiki.com',
  uploadApiUrl: 'https://catbox.moe/user/api.php',
  reconnectBaseDelayMs: 3_000,
  reconnectMaxDelayMs: 60_000,
  logLevel: 'info'
});

// ---------------------------------------------------------------------------
// HELPER FUNCTIONS — parse and validate .env values
// ---------------------------------------------------------------------------

const PHONE_NUMBER_HELP = 'Enter your WhatsApp number with country code, without + (for example 923001234567).';

/** Read a trimmed string from process.env; return fallback if empty/missing. */
function readString(name, fallback) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** Parse a boolean from process.env (accepts true/false/1/0/yes/no/on/off). */
function parseBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  throw new Error(`${name} must be true or false.`);
}

/** Parse an integer from process.env within [min, max] range. */
function parseInteger(name, fallback, min, max) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;

  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
}

/** Strip non-digits and validate a 7-15 digit phone number. */
function normalizePhoneNumber(value, fieldName) {
  const number = String(value || '').replace(/\D/g, '');
  if (!/^\d{7,15}$/.test(number)) {
    throw new Error(`${fieldName} must contain a 7-15 digit international phone number.`);
  }
  return number;
}

/**
 * Strict bot number validation.
 * Fails fast with guidance text if "+" is present — the most common mistake.
 */
function assertWhatsappNumber(value, fieldName = 'Phone number') {
  const raw = String(value ?? '').trim();

  if (raw.includes('+')) {
    throw new Error(`${fieldName} must not contain "+". ${PHONE_NUMBER_HELP}`);
  }
  if (!/^\d{7,15}$/.test(raw)) {
    throw new Error(`${fieldName} must be 7-15 digits including the country code. ${PHONE_NUMBER_HELP}`);
  }

  return raw;
}

/** Parse and validate an HTTPS URL from env. */
function parseUrl(name, fallback) {
  const value = readString(name, fallback);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error('Only HTTPS URLs are supported.');
    return parsed.toString().replace(/\/$/, '');
  } catch (error) {
    throw new Error(`${name} must be a valid HTTPS URL. ${error.message}`);
  }
}

/** Parse TELEGRAM_BOT_LINK — must be an HTTPS t.me link. */
function parseTelegramLink() {
  // Telegram Bot Link
  // Example: https://t.me/YourBotUsername
  const value = readString('TELEGRAM_BOT_LINK', '');
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || !['t.me', 'telegram.me'].includes(parsed.hostname)) throw new Error('Use an HTTPS t.me link.');
    return parsed.toString();
  } catch (error) { throw new Error(`TELEGRAM_BOT_LINK must be a valid HTTPS Telegram bot link. ${error.message}`); }
}

/** Resolve a relative path against the current working directory. */
function resolveRuntimePath(value) {
  return path.resolve(process.cwd(), value);
}

// ---------------------------------------------------------------------------
// loadConfig() — builds the frozen config object used by the entire bot.
//
// Every property here is read by one or more files in the project.
// Do NOT rename, remove, or reorder properties without checking usage:
//   grep -rn "config\." system/ index.js
// ---------------------------------------------------------------------------
function loadConfig() {

  // === CORE IDENTITY =======================================================
  const commandPrefix = readString('COMMAND_PREFIX', DEFAULTS.commandPrefix);

  if (commandPrefix.length > 4 || /\s/.test(commandPrefix)) {
    throw new Error('COMMAND_PREFIX must be 1-4 non-whitespace characters.');
  }

  // === AUTHENTICATION ======================================================
  const authMethod = readString('AUTH_METHOD', DEFAULTS.authMethod).toLowerCase();
  if (!['pairing', 'qr'].includes(authMethod)) {
    throw new Error('AUTH_METHOD must be either "pairing" or "qr".');
  }

  // === RECONNECTION ========================================================
  const reconnectBaseDelayMs = parseInteger(
    'RECONNECT_BASE_DELAY_MS',
    DEFAULTS.reconnectBaseDelayMs,
    1_000,
    300_000
  );
  const reconnectMaxDelayMs = parseInteger(
    'RECONNECT_MAX_DELAY_MS',
    DEFAULTS.reconnectMaxDelayMs,
    reconnectBaseDelayMs,
    900_000
  );

  // === LOGGING =============================================================
  const logLevel = readString('LOG_LEVEL', DEFAULTS.logLevel).toLowerCase();
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be a valid pino log level.');
  }

  // === STORAGE PATHS =======================================================
  // All database paths default to DATA_DIR/<name>.json.
  // Override individually only if you need custom paths.
  const dataDir = resolveRuntimePath(readString('DATA_DIR', DEFAULTS.dataDir));
  const premiumDbPath = resolveRuntimePath(readString('PREMIUM_DB_PATH', path.join(dataDir, 'premium.json')));
  const groupSettingsDbPath = resolveRuntimePath(readString('GROUP_SETTINGS_DB_PATH', path.join(dataDir, 'groups.json')));
  const modeDbPath = resolveRuntimePath(readString('MODE_DB_PATH', path.join(dataDir, 'mode.json')));
  const sudoDbPath = resolveRuntimePath(readString('SUDO_DB_PATH', path.join(dataDir, 'sudo.json')));
  const warningDbPath = resolveRuntimePath(readString('WARNING_DB_PATH', path.join(dataDir, 'warnings.json')));
  const economyDbPath = resolveRuntimePath(readString('ECONOMY_DB_PATH', path.join(dataDir, 'economy.json')));
  const settingsDbPath = resolveRuntimePath(readString('RUNTIME_SETTINGS_DB_PATH', path.join(dataDir, 'settings.json')));
  const automationDbPath = resolveRuntimePath(readString('AUTOMATION_DB_PATH', path.join(dataDir, 'automation.json')));

  // === TELEGRAM CONTROLLER =================================================
  const telegramControllerDbPath = resolveRuntimePath(readString('TELEGRAM_CONTROLLER_DB_PATH', path.join(dataDir, 'telegram-controllers.json')));
  // Telegram Owner IDs: numeric user IDs, separated by commas.
  const telegramOwnerIds = readString('TELEGRAM_OWNER_IDS', '')
    .split(',').map((id) => id.trim()).filter(Boolean);
  if (telegramOwnerIds.some((id) => !/^\d{1,20}$/.test(id))) {
    throw new Error('TELEGRAM_OWNER_IDS must be a comma-separated list of numeric Telegram IDs.');
  }

  // === BUILD FROZEN CONFIG OBJECT ==========================================
  return Object.freeze({

    // --- Identity -----------------------------------------------------------
    botName: readString('BOT_NAME', DEFAULTS.botName),
    ownerName: readString('OWNER_NAME', DEFAULTS.ownerName),
    // Canonical project identity from system/security.js — not deployer-tunable.
    projectName: PROJECT_NAME,
    developerName: DEVELOPER_HANDLE,
    developerBrand: DEVELOPER_NAME,
    authorName: AUTHOR_NAME,

    // --- Appearance & behavior ---------------------------------------------
    whatsappChannel: parseUrl('WHATSAPP_CHANNEL', DEFAULTS.whatsappChannel),
    commandPrefix,
    stickerPackname: readString('STICKER_PACKNAME', DEFAULTS.stickerPackname),
    stickerAuthor: readString('STICKER_AUTHOR', DEFAULTS.stickerAuthor),
    publicMode: parseBoolean('PUBLIC_MODE', DEFAULTS.publicMode),

    // --- Authentication & sessions -----------------------------------------
    authMethod,
    authDir: resolveRuntimePath(readString('AUTH_DIR', DEFAULTS.authDir)),
    // Raw creds.json (JSON or base64) used to restore a session on hosts with
    // ephemeral storage. Never logged or exposed through an API.
    sessionId: readString('SESSION_ID', ''),
    sessionOverwrite: parseBoolean('SESSION_OVERWRITE', DEFAULTS.sessionOverwrite),

    // --- Storage paths -----------------------------------------------------
    dataDir,
    premiumDbPath,
    groupSettingsDbPath,
    modeDbPath,
    sudoDbPath,
    warningDbPath,
    economyDbPath,
    settingsDbPath,
    automationDbPath,

    // --- Telegram controller -----------------------------------------------
    // Telegram settings intentionally have no legacy aliases. Keeping one
    // canonical name avoids accidentally enabling a controller with stale
    // deployment variables.
    telegramBotToken: readString('TELEGRAM_BOT_TOKEN', ''),
    telegramBotLink: parseTelegramLink(),
    telegramOwnerIds: Object.freeze(telegramOwnerIds),
    telegramControllerDbPath,

    // --- Theme & dashboard -------------------------------------------------
    theme: parseTheme(),
    webHost: readString('WEB_HOST', DEFAULTS.webHost),
    webPort: parseInteger('PORT', DEFAULTS.webPort, 1, 65_535),
    webPairingEnabled: parseBoolean('WEB_PAIRING_ENABLED', false),

    // --- Group greetings ---------------------------------------------------
    welcomeMessage: readString('WELCOME_MESSAGE', DEFAULTS.welcomeMessage),
    goodbyeMessage: readString('GOODBYE_MESSAGE', DEFAULTS.goodbyeMessage),

    // --- Images & media URLs -----------------------------------------------
    connectionSuccessImage: parseUrl('CONNECTION_SUCCESS_IMAGE', DEFAULTS.connectionSuccessImage),
    telegramStartImage: parseUrl('TELEGRAM_START_IMAGE', DEFAULTS.telegramStartImage),
    telegramConnectedImage: parseUrl('TELEGRAM_CONNECTED_IMAGE', DEFAULTS.telegramConnectedImage),

    // --- AI (Groq) ---------------------------------------------------------
    groqApiKey: readString('GROQ_API_KEY', ''),
    groqModel: readString('GROQ_MODEL', DEFAULTS.groqModel),

    // --- Media downloader APIs ---------------------------------------------
    cobaltApiUrl: readString('COBALT_API_URL', DEFAULTS.cobaltApiUrl).replace(/\/$/, ''),
    uploadApiUrl: readString('UPLOAD_API_URL', DEFAULTS.uploadApiUrl).replace(/\/$/, ''),

    // --- Reconnection & runtime --------------------------------------------
    reconnectBaseDelayMs,
    reconnectMaxDelayMs,
    logLevel,
    dryRun: parseBoolean('BOT_DRY_RUN', false)
  });
}

const config = loadConfig();

module.exports = {
  DEFAULTS,
  DEVELOPER_NAME,
  DEVELOPER_HANDLE,
  AUTHOR_NAME,
  PROJECT_NAME,
  PHONE_NUMBER_HELP,
  assertWhatsappNumber,
  config,
  loadConfig,
  normalizePhoneNumber
};
