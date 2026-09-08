'use strict';

const path = require('node:path');
const userConfig = require('../config');
const { CANONICAL_IDENTITY } = require('./security');

const PLACEHOLDER = /^YOUR_[A-Z0-9_]+$/;
const PHONE_NUMBER_HELP = 'Enter your WhatsApp number with country code, without + (for example 923001234567).';

function configurationError(message) {
  return new Error(`❌ Configuration Error\n${message}\nOpen config.js and correct this setting.`);
}
function string(value, name, { required = false, fallback = '' } = {}) {
  const result = typeof value === 'string' ? value.trim() : fallback;
  if (required && (!result || PLACEHOLDER.test(result))) throw configurationError(`${name} is missing.`);
  return result;
}
function bool(value, name, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === undefined) return fallback;
  throw configurationError(`${name} must be true or false.`);
}
function integer(value, name, fallback, min, max) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw configurationError(`${name} must be an integer between ${min} and ${max}.`);
  return result;
}
function url(value, name, { required = true } = {}) {
  const result = string(value, name, { required });
  if (!result && !required) return '';
  try { const parsed = new URL(result); if (parsed.protocol !== 'https:') throw new Error(); return parsed.toString().replace(/\/$/, ''); }
  catch { throw configurationError(`${name} must be a valid HTTPS URL.`); }
}
function runtimePath(value, name) { return path.resolve(process.cwd(), string(value, name, { required: true })); }
function optionalPath(value, fallback, name) { return runtimePath(value || fallback, name); }
function optionalTelegramLink(value) {
  const result = string(value, 'telegram.botLink');
  // The documented placeholder must not become a clickable pairing link.
  if (/\/YOUR_[A-Z0-9_]+(?:$|[/?#])/i.test(result)) return '';
  return url(result, 'telegram.botLink', { required: false });
}
}
function integer(value, name, fallback, min, max) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw configurationError(`${name} must be an integer between ${min} and ${max}.`);
  return result;
}
function url(value, name, { required = true } = {}) {
  const result = string(value, name, { required });
  if (!result && !required) return '';
  try { const parsed = new URL(result); if (parsed.protocol !== 'https:') throw new Error(); return parsed.toString().replace(/\/$/, ''); }
  catch { throw configurationError(`${name} must be a valid HTTPS URL.`); }
}
function runtimePath(value, name) { return path.resolve(process.cwd(), string(value, name, { required: true })); }
function optionalPath(value, fallback, name) { return runtimePath(value || fallback, name); }
function normalizePhoneNumber(value, fieldName) {
  const number = String(value || '').replace(/\D/g, '');
  if (!/^\d{7,15}$/.test(number)) throw new Error(`${fieldName} must contain a 7-15 digit international phone number.`);
  return number;
}
function assertWhatsappNumber(value, fieldName = 'Phone number') {
  const raw = String(value ?? '').trim();
  if (raw.includes('+')) throw new Error(`${fieldName} must not contain "+". ${PHONE_NUMBER_HELP}`);
  if (!/^\d{7,15}$/.test(raw)) throw new Error(`${fieldName} must be 7-15 digits including the country code. ${PHONE_NUMBER_HELP}`);
  return raw;
}

function loadConfig(source = userConfig) {
  const bot = source.bot || {}, owner = source.owner || {}, whatsapp = source.whatsapp || {};
  const telegram = source.telegram || {}, api = source.api || {}, database = source.database || {};
  const commands = source.commands || {}, deployment = source.deployment || {}, theme = source.theme || {};
  const authMethod = string(whatsapp.authMethod, 'whatsapp.authMethod', { required: true }).toLowerCase();
  if (!['pairing', 'qr'].includes(authMethod)) throw configurationError('whatsapp.authMethod must be "pairing" or "qr".');
  const prefix = string(bot.prefix, 'bot.prefix', { required: true });
  if (prefix.length > 4 || /\s/.test(prefix)) throw configurationError('bot.prefix must be 1-4 non-whitespace characters.');
  const dataDir = runtimePath(database.dataDir, 'database.dataDir');
  const enabled = bool(telegram.enabled, 'telegram.enabled', true);
  const token = string(telegram.botToken, 'telegram.botToken');
  const ownerIds = Array.isArray(telegram.ownerIds) ? telegram.ownerIds.map(String).map((id) => id.trim()).filter((id) => id && !PLACEHOLDER.test(id)) : [];
  if (ownerIds.some((id) => !/^\d{1,20}$/.test(id))) throw configurationError('telegram.ownerIds must contain numeric Telegram IDs.');
  const usableTelegramToken = token && !PLACEHOLDER.test(token);
  if (enabled && Boolean(usableTelegramToken) !== Boolean(ownerIds.length)) throw configurationError('telegram.botToken and telegram.ownerIds must both be entered, or set telegram.enabled to false.');
  const baseDelay = integer(deployment.reconnectBaseDelayMs, 'deployment.reconnectBaseDelayMs', 3000, 1000, 300000);
  const maxDelay = integer(deployment.reconnectMaxDelayMs, 'deployment.reconnectMaxDelayMs', 60000, baseDelay, 900000);
  const logLevel = string(deployment.logLevel, 'deployment.logLevel', { required: true }).toLowerCase();
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) throw configurationError('deployment.logLevel must be a valid pino log level.');
  const db = (key, file) => optionalPath(database[key], path.join(dataDir, file), `database.${key}`);
  return Object.freeze({
    botName: string(bot.name, 'bot.name', { required: true }), ownerName: string(bot.ownerName, 'bot.ownerName', { required: true }),
    projectName: CANONICAL_IDENTITY.projectName, developerName: CANONICAL_IDENTITY.developer, developerBrand: CANONICAL_IDENTITY.organization, authorName: CANONICAL_IDENTITY.author,
    whatsappChannel: url(owner.whatsappChannel, 'owner.whatsappChannel'), commandPrefix: prefix,
    stickerPackname: string(commands.stickerPackname, 'commands.stickerPackname', { required: true }), stickerAuthor: string(commands.stickerAuthor, 'commands.stickerAuthor', { required: true }), publicMode: bool(bot.publicMode, 'bot.publicMode', true),
    authMethod, authDir: runtimePath(whatsapp.authDir, 'whatsapp.authDir'), sessionId: string(whatsapp.sessionId, 'whatsapp.sessionId'), sessionOverwrite: bool(whatsapp.sessionOverwrite, 'whatsapp.sessionOverwrite', false),
    dataDir, premiumDbPath: db('premiumDbPath', 'premium.json'), groupSettingsDbPath: db('groupSettingsDbPath', 'groups.json'), modeDbPath: db('modeDbPath', 'mode.json'), sudoDbPath: db('sudoDbPath', 'sudo.json'), warningDbPath: db('warningDbPath', 'warnings.json'), economyDbPath: db('economyDbPath', 'economy.json'), settingsDbPath: db('settingsDbPath', 'settings.json'), automationDbPath: db('automationDbPath', 'automation.json'),
    telegramEnabled: enabled, telegramBotToken: PLACEHOLDER.test(token) ? '' : token, telegramBotLink: optionalTelegramLink(telegram.botLink), telegramOwnerIds: Object.freeze(ownerIds), telegramControllerDbPath: optionalPath(telegram.controllerDbPath, path.join(dataDir, 'telegram-controllers.json'), 'telegram.controllerDbPath'),
    theme: Object.freeze({ name: string(theme.name, 'theme.name', { required: true }) }),
    telegramEnabled: enabled, telegramBotToken: PLACEHOLDER.test(token) ? '' : token, telegramBotLink: url(telegram.botLink, 'telegram.botLink', { required: false }), telegramOwnerIds: Object.freeze(ownerIds), telegramControllerDbPath: optionalPath(telegram.controllerDbPath, path.join(dataDir, 'telegram-controllers.json'), 'telegram.controllerDbPath'),
    theme: Object.freeze({ name: string(theme.name, 'theme.name', { required: true }) }), webHost: string(deployment.webHost, 'deployment.webHost', { required: true }), webPort: integer(deployment.webPort, 'deployment.webPort', 3000, 1, 65535), webPairingEnabled: bool(deployment.webPairingEnabled, 'deployment.webPairingEnabled', false),
    welcomeMessage: string(commands.welcomeMessage, 'commands.welcomeMessage', { required: true }), goodbyeMessage: string(commands.goodbyeMessage, 'commands.goodbyeMessage', { required: true }), connectionSuccessImage: url(whatsapp.connectionSuccessImage, 'whatsapp.connectionSuccessImage'), telegramStartImage: url(telegram.startImage, 'telegram.startImage'), telegramConnectedImage: url(telegram.connectedImage, 'telegram.connectedImage'),
    groqApiKey: PLACEHOLDER.test(string(api.groqApiKey, 'api.groqApiKey')) ? '' : string(api.groqApiKey, 'api.groqApiKey'), groqModel: string(api.groqModel, 'api.groqModel', { required: true }), cobaltApiUrl: url(api.cobaltApiUrl, 'api.cobaltApiUrl'), uploadApiUrl: url(api.uploadApiUrl, 'api.uploadApiUrl'), reconnectBaseDelayMs: baseDelay, reconnectMaxDelayMs: maxDelay, logLevel, dryRun: bool(deployment.dryRun, 'deployment.dryRun', false)
  });
}

const config = loadConfig();
module.exports = { PHONE_NUMBER_HELP, assertWhatsappNumber, config, loadConfig, normalizePhoneNumber };
