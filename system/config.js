'use strict';

const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

const DEFAULTS = Object.freeze({
  botName: 'Black Clover',
  ownerName: 'Only Fixa Dev',
  ownerNumber: '923448170040',
  authorName: 'Rashid Hussain',
  authorNumber: '923448170040',
  ownerLink: 'https://wa.me/923448170040',
  whatsappChannel: 'https://whatsapp.com/channel/0029VbBepCNBVJl5vGUHET3T',
  commandPrefix: '.',
  publicMode: true,
  authMethod: 'pairing',
  authDir: './session',
  dataDir: './data',
  reconnectBaseDelayMs: 3_000,
  reconnectMaxDelayMs: 60_000,
  logLevel: 'info'
});

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

function parseOptionalPhoneNumber(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return undefined;
  return normalizePhoneNumber(value, name);
}

function parseOwnerNumbers(primaryOwner) {
  const additional = readString('OWNER_NUMBERS', '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => normalizePhoneNumber(value, 'OWNER_NUMBERS'));

  return [...new Set([primaryOwner, ...additional])];
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

function resolveRuntimePath(value) {
  return path.resolve(process.cwd(), value);
}

function loadConfig() {
  const ownerNumber = normalizePhoneNumber(readString('OWNER_NUMBER', DEFAULTS.ownerNumber), 'OWNER_NUMBER');
  const authorNumber = normalizePhoneNumber(readString('AUTHOR_NUMBER', DEFAULTS.authorNumber), 'AUTHOR_NUMBER');
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

  return Object.freeze({
    botName: readString('BOT_NAME', DEFAULTS.botName),
    ownerName: readString('OWNER_NAME', DEFAULTS.ownerName),
    ownerNumber,
    ownerNumbers: parseOwnerNumbers(ownerNumber),
    authorName: readString('AUTHOR_NAME', DEFAULTS.authorName),
    authorNumber,
    ownerLink: parseUrl('OWNER_LINK', DEFAULTS.ownerLink),
    whatsappChannel: parseUrl('WHATSAPP_CHANNEL', DEFAULTS.whatsappChannel),
    commandPrefix,
    publicMode: parseBoolean('PUBLIC_MODE', DEFAULTS.publicMode),
    authMethod,
    pairingNumber: parseOptionalPhoneNumber('PAIRING_NUMBER'),
    authDir: resolveRuntimePath(readString('AUTH_DIR', DEFAULTS.authDir)),
    dataDir,
    premiumDbPath,
    reconnectBaseDelayMs,
    reconnectMaxDelayMs,
    logLevel,
    dryRun: parseBoolean('BOT_DRY_RUN', false)
  });
}

const config = loadConfig();

module.exports = {
  DEFAULTS,
  config,
  loadConfig,
  normalizePhoneNumber
};
