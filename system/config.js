'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const { CANONICAL_IDENTITY, assertProtectedSecurityEnvironment } = require('./security');
const { FALLBACK_THEME_ID, isThemeId, resolveTheme } = require('./theme');

dotenv.config();

// Project identity is canonical, not deployer-tunable. `security.js` refuses to
// start when a protected identity key (OWNER_NUMBER, DEVELOPER_*, GLOBAL_OWNER*)
// is supplied through the environment, so identity cannot be spoofed by config.
assertProtectedSecurityEnvironment();

const DEVELOPER_NAME = CANONICAL_IDENTITY.organization;
const DEVELOPER_HANDLE = CANONICAL_IDENTITY.developer;
const AUTHOR_NAME = CANONICAL_IDENTITY.author;
const PROJECT_NAME = CANONICAL_IDENTITY.projectName;

// User-facing configuration is limited to OWNER_NAME and BOT_NUMBER.
// Everything below is internal/optional and has a safe default.
const DEFAULTS = Object.freeze({
  botName: PROJECT_NAME,
  ownerName: 'Enter Your Name',
  // Digits only, country code included, never prefixed with "+".
  botNumber: '923001234567',
  whatsappChannel: 'https://whatsapp.com/channel/0029VbBepCNBVJl5vGUHET3T',
  commandPrefix: '!',
  stickerPackname: PROJECT_NAME,
  stickerAuthor: DEVELOPER_HANDLE,
  publicMode: true,
  // The dashboard is web-pairing only. "qr" stays available as an internal
  // escape hatch for local terminals; it is never offered by the web UI.
  authMethod: 'pairing',
  authDir: './session',
  dataDir: './data',
  // Credentials are never exported from the dashboard unless this is enabled.
  exposeSessionId: false,
  sessionOverwrite: false,
  theme: FALLBACK_THEME_ID,
  webHost: '0.0.0.0',
  webPort: 3_000,
  welcomeMessage: 'Welcome @user to *@group*!',
  goodbyeMessage: 'Goodbye @user from *@group*.',
  connectionSuccessImage: 'https://files.catbox.moe/6ghm7j.png',
  groqModel: 'openai/gpt-oss-20b',
  reconnectBaseDelayMs: 3_000,
  reconnectMaxDelayMs: 60_000,
  logLevel: 'info'
});

const BOT_NUMBER_HINT = 'Enter your WhatsApp number with country code, without + (for example 923001234567).';

function readString(name, fallback) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function parseBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  throw new Error(`${name} must be true or false.`);
}

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

function normalizePhoneNumber(value, fieldName) {
  const number = String(value || '').replace(/\D/g, '');
  if (!/^\d{7,15}$/.test(number)) {
    throw new Error(`${fieldName} must contain a 7-15 digit international phone number.`);
  }
  return number;
}

// Strict on purpose: the value is typed by a human into a dashboard field or a
// .env file, and a stray "+" is the single most common mistake. Failing fast
// with the guidance text beats silently pairing the wrong account.
function assertBotNumber(value, fieldName = 'BOT_NUMBER') {
  const raw = String(value ?? '').trim();

  if (raw.includes('+')) {
    throw new Error(`${fieldName} must not contain "+". ${BOT_NUMBER_HINT}`);
  }
  if (!/^\d{7,15}$/.test(raw)) {
    throw new Error(`${fieldName} must be 7-15 digits including the country code. ${BOT_NUMBER_HINT}`);
  }

  return raw;
}

function parseBotNumber(fallback) {
  // PAIRING_NUMBER is a legacy alias for the same setting. OWNER_NUMBER is not
  // accepted: it is a protected identity key guarded by security.js.
  const raw = readString('BOT_NUMBER', readString('PAIRING_NUMBER', ''));
  return raw ? assertBotNumber(raw, 'BOT_NUMBER') : fallback;
}

function parseTheme(fallback) {
  const requested = readString('THEME', fallback).toLowerCase();
  if (requested === fallback || isThemeId(requested)) return resolveTheme(requested).id;
  console.warn(`[config] Unknown THEME "${requested}"; using the ${resolveTheme(fallback).name} theme instead.`);
  return resolveTheme(fallback).id;
}

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

function parseTelegramLink() {
  const value = readString('TELEGRAM_BOT_LINK', '');
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || !['t.me', 'telegram.me'].includes(parsed.hostname)) throw new Error('Use an HTTPS t.me link.');
    return parsed.toString();
  } catch (error) { throw new Error(`TELEGRAM_BOT_LINK must be a valid HTTPS Telegram bot link. ${error.message}`); }
}

function resolveRuntimePath(value) {
  return path.resolve(process.cwd(), value);
}

function loadConfig() {
  // Single owner only: the number the bot is linked to is the owner's number.
  const botNumber = parseBotNumber(DEFAULTS.botNumber);
  const commandPrefix = readString('COMMAND_PREFIX', DEFAULTS.commandPrefix);

  if (commandPrefix.length > 4 || /\s/.test(commandPrefix)) {
    throw new Error('COMMAND_PREFIX must be 1-4 non-whitespace characters.');
  }

  const authMethod = readString('AUTH_METHOD', DEFAULTS.authMethod).toLowerCase();
  if (!['pairing', 'qr'].includes(authMethod)) {
    throw new Error('AUTH_METHOD must be either "pairing" or "qr".');
  }

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

  const logLevel = readString('LOG_LEVEL', DEFAULTS.logLevel).toLowerCase();
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be a valid pino log level.');
  }

  const dataDir = resolveRuntimePath(readString('DATA_DIR', DEFAULTS.dataDir));
  const premiumDbPath = resolveRuntimePath(readString('PREMIUM_DB_PATH', path.join(dataDir, 'premium.json')));
  const groupSettingsDbPath = resolveRuntimePath(readString('GROUP_SETTINGS_DB_PATH', path.join(dataDir, 'groups.json')));
  const modeDbPath = resolveRuntimePath(readString('MODE_DB_PATH', path.join(dataDir, 'mode.json')));
  const telegramControllerDbPath = resolveRuntimePath(readString('TELEGRAM_CONTROLLER_DB_PATH', path.join(dataDir, 'telegram-controllers.json')));
  const telegramOwnerIds = readString('TELEGRAM_OWNER_IDS', '')
    .split(',').map((id) => id.trim()).filter(Boolean);
  if (telegramOwnerIds.some((id) => !/^\d{1,20}$/.test(id))) {
    throw new Error('TELEGRAM_OWNER_IDS must be a comma-separated list of numeric Telegram IDs.');
  }

  return Object.freeze({
    botName: readString('BOT_NAME', DEFAULTS.botName),
    ownerName: readString('OWNER_NAME', DEFAULTS.ownerName),
    botNumber,
    // Derived from BOT_NUMBER — never configured separately.
    ownerNumber: botNumber,
    ownerNumbers: Object.freeze([botNumber]),
    // Canonical project identity from system/security.js — not deployer-tunable.
    projectName: PROJECT_NAME,
    developerName: DEVELOPER_HANDLE,
    developerBrand: DEVELOPER_NAME,
    authorName: AUTHOR_NAME,
    authorNumber: botNumber,
    ownerLink: `https://wa.me/${botNumber}`,
    whatsappChannel: parseUrl('WHATSAPP_CHANNEL', DEFAULTS.whatsappChannel),
    commandPrefix,
    stickerPackname: readString('STICKER_PACKNAME', DEFAULTS.stickerPackname),
    stickerAuthor: readString('STICKER_AUTHOR', DEFAULTS.stickerAuthor),
    publicMode: parseBoolean('PUBLIC_MODE', DEFAULTS.publicMode),
    authMethod,
    authDir: resolveRuntimePath(readString('AUTH_DIR', DEFAULTS.authDir)),
    // Raw creds.json (JSON or base64) used to restore a session on hosts with
    // ephemeral storage. Never logged, never served by the dashboard.
    sessionId: readString('SESSION_ID', ''),
    sessionOverwrite: parseBoolean('SESSION_OVERWRITE', DEFAULTS.sessionOverwrite),
    exposeSessionId: parseBoolean('EXPOSE_SESSION_ID', DEFAULTS.exposeSessionId),
    dataDir,
    premiumDbPath,
    groupSettingsDbPath,
    modeDbPath,
    telegramBotToken: readString('TELEGRAM_BOT_TOKEN', ''),
    telegramBotLink: parseTelegramLink(),
    telegramOwnerIds: Object.freeze(telegramOwnerIds),
    telegramControllerDbPath,
    theme: parseTheme(DEFAULTS.theme),
    webHost: readString('WEB_HOST', DEFAULTS.webHost),
    webPort: parseInteger('PORT', DEFAULTS.webPort, 1, 65_535),
    welcomeMessage: readString('WELCOME_MESSAGE', DEFAULTS.welcomeMessage),
    goodbyeMessage: readString('GOODBYE_MESSAGE', DEFAULTS.goodbyeMessage),
    connectionSuccessImage: parseUrl('CONNECTION_SUCCESS_IMAGE', DEFAULTS.connectionSuccessImage),
    groqApiKey: readString('GROQ_API_KEY', ''),
    groqModel: readString('GROQ_MODEL', DEFAULTS.groqModel),
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
  BOT_NUMBER_HINT,
  assertBotNumber,
  config,
  loadConfig,
  normalizePhoneNumber
};
