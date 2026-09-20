'use strict';

const path = require('node:path');
const userConfig = require('../config');
const { CANONICAL_IDENTITY } = require('./security');
const { normalizeAnimeConfig } = require('./lib/anime-library');
const { normalizeWelcomeConfig } = require('./lib/connection-welcome');

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
function normalizePhoneNumber(value, fieldName) {
  const number = String(value || '').replace(/\D/g, '');
  if (!/^\d{7,15}$/.test(number)) throw new Error(`${fieldName} must contain a 7-15 digit international phone number.`);
  return number;
}
// NOTE: there is intentionally no "custom pairing code" setting. WhatsApp only
// accepts pairing codes drawn from its own 32-symbol alphabet, so the code is
// always produced by WhatsApp through Baileys' native requestPairingCode().
const HIDDEN_VIDEO_RESPONSE_PATHS = ['resultsPath', 'titlePath', 'mediaUrlPath', 'thumbnailPath', 'durationPath', 'sizePath', 'sourceUrlPath'];
function normalizeHiddenVideoProvider(raw, index, requestTimeoutMs) {
  const label = `hiddenVideo.providers[${index}]`;
  const id = string(raw?.id, `${label}.id`).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
    throw configurationError(`${label}.id must be 1-32 characters of a-z, 0-9, "-" or "_" and start with a letter or digit.`);
  }
  const name = string(raw?.name, `${label}.name`) || id;
  const enabled = bool(raw?.enabled, `${label}.enabled`, true);
  const method = (string(raw?.method, `${label}.method`) || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw configurationError(`${label}.method must be "GET" or "POST".`);
  const providerUrl = url(raw?.url, `${label}.url`);
  const searchParam = string(raw?.searchParam, `${label}.searchParam`) || 'search';
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(searchParam)) throw configurationError(`${label}.searchParam must be 1-32 URL-safe characters.`);
  const keywords = [...new Set((Array.isArray(raw?.keywords) ? raw.keywords : [])
    .map((keyword) => String(keyword ?? '').toLowerCase().replace(/\s+/g, ' ').trim())
    .filter(Boolean))];
  const timeoutMs = integer(raw?.timeoutMs, `${label}.timeoutMs`, requestTimeoutMs, 1000, 60000);
  // Optional auth/extra headers. Empty values and YOUR_... placeholders are
  // dropped so an unset env var never sends a literal header. Header VALUES
  // are secrets: they are never logged and never shown in chat.
  const headers = {};
  if (raw?.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    for (const [headerName, headerValue] of Object.entries(raw.headers)) {
      const value = String(headerValue ?? '');
      if (/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName) && value && !PLACEHOLDER.test(value)) headers[headerName] = value;
    }
  }
  const response = {};
  if (raw?.response && typeof raw.response === 'object' && !Array.isArray(raw.response)) {
    for (const field of HIDDEN_VIDEO_RESPONSE_PATHS) {
      const pathValue = string(raw.response[field], `${label}.response.${field}`);
      if (!pathValue) continue;
      if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(pathValue)) {
        throw configurationError(`${label}.response.${field} must be a dot path such as "data.results".`);
      }
      response[field] = pathValue;
    }
  }
  return Object.freeze({
    id, name, enabled, method, url: providerUrl, searchParam,
    keywords: Object.freeze(keywords), timeoutMs,
    headers: Object.freeze(headers), response: Object.freeze(response)
  });
}
function normalizeHiddenVideoConfig(raw = {}) {
  const enabled = bool(raw.enabled, 'hiddenVideo.enabled', true);
  const sessionTimeoutMs = integer(raw.sessionTimeoutMs ?? raw.sessionTTL, 'hiddenVideo.sessionTimeoutMs', 120000, 15000, 3600000);
  const maxResults = integer(raw.maxResults, 'hiddenVideo.maxResults', 5, 1, 10);
  let maxDownloadBytes;
  if (raw.maxDownloadBytes !== undefined) {
    maxDownloadBytes = integer(raw.maxDownloadBytes, 'hiddenVideo.maxDownloadBytes', 50 * 1024 * 1024, 1024 * 1024, 512 * 1024 * 1024);
  } else {
    maxDownloadBytes = integer(raw.maxDownloadSizeMb, 'hiddenVideo.maxDownloadSizeMb', 50, 1, 512) * 1024 * 1024;
  }
  const maxConcurrentDownloads = integer(raw.maxConcurrentDownloads, 'hiddenVideo.maxConcurrentDownloads', 1, 1, 5);
  const maxResponseBytes = integer(raw.maxResponseBytes, 'hiddenVideo.maxResponseBytes', 10 * 1024 * 1024, 1024 * 1024, 50 * 1024 * 1024);
  const requestTimeoutMs = integer(raw.requestTimeoutMs, 'hiddenVideo.requestTimeoutMs', 6500, 1000, 60000);
  const headTimeoutMs = integer(raw.headTimeoutMs, 'hiddenVideo.headTimeoutMs', 4000, 1000, 30000);
  const downloadTimeoutMs = integer(raw.downloadTimeoutMs, 'hiddenVideo.downloadTimeoutMs', 120000, 5000, 600000);
  const providers = [];
  const seenIds = new Set();
  for (const [index, entry] of (Array.isArray(raw.providers) ? raw.providers : []).entries()) {
    const provider = normalizeHiddenVideoProvider(entry, index, requestTimeoutMs);
    if (seenIds.has(provider.id)) throw configurationError(`hiddenVideo.providers[${index}].id "${provider.id}" is used more than once.`);
    seenIds.add(provider.id);
    providers.push(provider);
  }
  return Object.freeze({
    enabled, sessionTimeoutMs, maxResults, maxDownloadBytes, maxConcurrentDownloads,
    maxResponseBytes, requestTimeoutMs, headTimeoutMs, downloadTimeoutMs,
    providers: Object.freeze(providers)
  });
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
  const telegramPublicMode = bool(telegram.publicMode, 'telegram.publicMode', false);
  const telegramPremiumOnly = bool(telegram.premiumOnly, 'telegram.premiumOnly', false);
  const telegramRequiredChannels = (Array.isArray(telegram.requiredChannels) ? telegram.requiredChannels : [])
    .map((channel) => ({
      name: string(channel?.name, 'telegram.requiredChannels[].name', { required: false }) || 'Channel',
      chatId: string(channel?.chatId, 'telegram.requiredChannels[].chatId'),
      link: string(channel?.link, 'telegram.requiredChannels[].link', { required: false }),
      kind: channel?.kind === 'group' ? 'group' : channel?.kind === 'channel' ? 'channel' : undefined
    }))
    .filter((channel) => channel.chatId && !PLACEHOLDER.test(channel.chatId));
  if (telegramRequiredChannels.some((channel) => channel.chatId.startsWith('@') ? channel.chatId.length < 5 : !/^-100\d{4,}$/.test(channel.chatId))) {
    throw configurationError('telegram.requiredChannels entries must be a @username or a numeric -100 channel ID.');
  }
  if (telegramRequiredChannels.some((channel) => channel.kind !== undefined && channel.kind !== 'channel' && channel.kind !== 'group')) {
    throw configurationError('telegram.requiredChannels[].kind must be "channel" or "group".');
  }
  for (const channel of telegramRequiredChannels) {
    if (!channel.link) continue;
    try {
      const parsed = new URL(channel.link);
      if (parsed.protocol !== 'https:') throw new Error();
    } catch {
      throw configurationError(`telegram.requiredChannels[].link ("${channel.link}") must be a valid HTTPS URL.`);
    }
  }
  const baseDelay = integer(deployment.reconnectBaseDelayMs, 'deployment.reconnectBaseDelayMs', 3000, 1000, 300000);
  const maxDelay = integer(deployment.reconnectMaxDelayMs, 'deployment.reconnectMaxDelayMs', 60000, baseDelay, 900000);
  const logLevel = string(deployment.logLevel, 'deployment.logLevel', { required: true }).toLowerCase();
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) throw configurationError('deployment.logLevel must be a valid pino log level.');
  const db = (key, file) => optionalPath(database[key], path.join(dataDir, file), `database.${key}`);
  return Object.freeze({
    // Optional media is validated at delivery, never a boot/pairing dependency.
    telegramAnimeEdit: normalizeAnimeConfig(source.telegramAnimeEdit),
    connectionWelcomeVideo: normalizeWelcomeConfig(source.connectionWelcomeVideo),
    hiddenVideo: normalizeHiddenVideoConfig(source.hiddenVideo),
    botName: string(bot.name, 'bot.name', { required: true }), ownerName: string(bot.ownerName, 'bot.ownerName', { required: true }),
    projectName: CANONICAL_IDENTITY.projectName, developerName: CANONICAL_IDENTITY.developer, developerBrand: CANONICAL_IDENTITY.organization, authorName: CANONICAL_IDENTITY.author,
    whatsappChannel: url(owner.whatsappChannel, 'owner.whatsappChannel'), commandPrefix: prefix,
    stickerPackname: string(commands.stickerPackname, 'commands.stickerPackname', { required: true }), stickerAuthor: string(commands.stickerAuthor, 'commands.stickerAuthor', { required: true }), publicMode: bool(bot.publicMode, 'bot.publicMode', true),
    authMethod, authDir: runtimePath(whatsapp.authDir, 'whatsapp.authDir'), sessionId: string(whatsapp.sessionId, 'whatsapp.sessionId'), sessionOverwrite: bool(whatsapp.sessionOverwrite, 'whatsapp.sessionOverwrite', false),
    dataDir, premiumDbPath: db('premiumDbPath', 'premium.json'), groupSettingsDbPath: db('groupSettingsDbPath', 'groups.json'), modeDbPath: db('modeDbPath', 'mode.json'), sudoDbPath: db('sudoDbPath', 'sudo.json'), warningDbPath: db('warningDbPath', 'warnings.json'), economyDbPath: db('economyDbPath', 'economy.json'), settingsDbPath: db('settingsDbPath', 'settings.json'), automationDbPath: db('automationDbPath', 'automation.json'), chatsDbPath: db('chatsDbPath', 'chats.json'),
    telegramEnabled: enabled, telegramBotToken: PLACEHOLDER.test(token) ? '' : token, telegramBotLink: optionalTelegramLink(telegram.botLink), telegramOwnerIds: Object.freeze(ownerIds), telegramControllerDbPath: optionalPath(telegram.controllerDbPath, path.join(dataDir, 'telegram-controllers.json'), 'telegram.controllerDbPath'), telegramPublicMode, telegramPremiumOnly, telegramRequiredChannels: Object.freeze(telegramRequiredChannels.map((channel) => Object.freeze({ ...channel }))),
    theme: Object.freeze({ name: string(theme.name, 'theme.name', { required: true }) }), webHost: string(deployment.webHost, 'deployment.webHost', { required: true }), webPort: integer(deployment.webPort, 'deployment.webPort', 3000, 1, 65535), webPairingEnabled: bool(deployment.webPairingEnabled, 'deployment.webPairingEnabled', false),
    welcomeMessage: string(commands.welcomeMessage, 'commands.welcomeMessage', { required: true }), goodbyeMessage: string(commands.goodbyeMessage, 'commands.goodbyeMessage', { required: true }), connectionSuccessImage: url(whatsapp.connectionSuccessImage, 'whatsapp.connectionSuccessImage'), telegramStartImage: url(telegram.startImage, 'telegram.startImage'), telegramConnectedImage: url(telegram.connectedImage, 'telegram.connectedImage'),
    groqApiKey: PLACEHOLDER.test(string(api.groqApiKey, 'api.groqApiKey')) ? '' : string(api.groqApiKey, 'api.groqApiKey'), groqModel: string(api.groqModel, 'api.groqModel', { required: true }), cobaltApiUrl: url(api.cobaltApiUrl, 'api.cobaltApiUrl'), uploadApiUrl: url(api.uploadApiUrl, 'api.uploadApiUrl'), reconnectBaseDelayMs: baseDelay, reconnectMaxDelayMs: maxDelay, logLevel, dryRun: bool(deployment.dryRun, 'deployment.dryRun', false)
  });
}

const config = loadConfig();
module.exports = { PHONE_NUMBER_HELP, assertWhatsappNumber, config, loadConfig, normalizePhoneNumber };
