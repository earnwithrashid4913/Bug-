'use strict';

// =============================================================================
// EXECUTEAFTER — PROVIDER SLOT REGISTRY
// =============================================================================
// Reads execute-after.config.js and creates:
//   * one independent provider slot per configured provider
//     (sequential internal ids provider_01, provider_02, provider_03, ...)
//   * one independent adapter per slot (adapters/provider_XX.js, or a generated
//     adapter when no file exists)
//   * one executable command per slot (the configured command name; the default
//     placeholder is the matching Exec<N>)
//
// The number of slots is always exactly the number of configured providers.
//
// Renaming a command, changing an endpoint, hiding a command or disabling a slot
// happens ONLY in execute-after.config.js — never in the dispatcher, the router
// or an adapter.
//
// Registration is defensive on purpose: a bad entry disables that single slot
// with a log line and can never stop AnimeMD from booting (24/7 stability).
// =============================================================================

const path = require('node:path');
// The central configuration is execute-after.config.js in the repository root.
// EXECUTE_AFTER_CONFIG is an optional override used by the test suite (and by
// hostings that keep their endpoints in a different file).
const CONFIG_PATH = process.env.EXECUTE_AFTER_CONFIG
  ? path.resolve(process.env.EXECUTE_AFTER_CONFIG)
  : path.join(__dirname, '..', '..', 'execute-after.config.js');
// eslint-disable-next-line global-require, import/no-dynamic-require
const userConfig = require(CONFIG_PATH);
const { loadAdapter } = require('./adapters');
const { supportedModes } = require('./context');
const { compilePolicy } = require('./policy');

const CONFIG_FILE = process.env.EXECUTE_AFTER_CONFIG ? path.basename(String(process.env.EXECUTE_AFTER_CONFIG)) : 'execute-after.config.js';
const COMMAND_PATTERN = /^[a-z][a-z0-9]{0,29}$/;
// Names that must never be taken over by the framework.
const RESERVED_COMMANDS = new Set(['menu', 'help', 'h', 'hidden']);

const NUMBER_LIMITS = Object.freeze({
  maxAttempts: [1, 5, 3],
  baseDelayMs: [50, 60000, 700],
  maxDelayMs: [100, 120000, 8000],
  maxResponseBytes: [1024, 32 * 1024 * 1024, 4 * 1024 * 1024],
  minHostIntervalMs: [0, 10000, 250],
  maxRedirects: [0, 10, 5],
  timeoutMs: [1000, 300000, 20000],
  maxBytes: [1024, 512 * 1024 * 1024, 64 * 1024 * 1024],
  maxConcurrent: [1, 8, 2],
  queueLimit: [0, 32, 4],
  probeTimeoutMs: [1000, 120000, 15000],
  bufferBelowBytes: [0, 128 * 1024 * 1024, 12 * 1024 * 1024],
  streamSettleMs: [0, 30000, 2000],
  maxDepth: [1, 8, 4],
  maxArrayScan: [1, 200, 40],
  ttlMs: [1000, 3600000, 60000],
  maxEntries: [1, 500, 50],
  perChatCooldownMs: [0, 60000, 2500],
  maxInFlightPerProvider: [1, 8, 1],
  maxInFlightGlobal: [1, 16, 3],
  menuLimit: [0, 30, 10],
  resultLimit: [1, 25, 8]
});

function clampNumber(value, key, fallback) {
  const [min, max, preset] = NUMBER_LIMITS[key] || [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0];
  const number = Number(value);
  const chosen = Number.isFinite(number) ? number : (fallback === undefined ? preset : fallback);
  return Math.min(max, Math.max(min, chosen));
}

function normalizeFramework(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const http = source.http && typeof source.http === 'object' ? source.http : {};
  const media = source.media && typeof source.media === 'object' ? source.media : {};
  const discovery = source.discovery && typeof source.discovery === 'object' ? source.discovery : {};
  const cache = source.cache && typeof source.cache === 'object' ? source.cache : {};
  const category = source.category && typeof source.category === 'object' ? source.category : {};
  const list = (value, fallback) => (Array.isArray(value) && value.length ? value.map(String) : fallback);
  return Object.freeze({
    enabled: source.enabled !== false,
    category: Object.freeze({
      icon: String(category.icon || '🎬').slice(0, 4),
      id: String(category.id || 'executeafter').toLowerCase().replace(/[^a-z0-9]/g, '') || 'executeafter',
      label: String(category.label || 'EXECUTE AFTER').slice(0, 30),
      title: String(category.title || 'Execute After').slice(0, 40)
    }),
    cache: Object.freeze({
      enabled: cache.enabled === true,
      maxEntries: clampNumber(cache.maxEntries, 'maxEntries'),
      ttlMs: clampNumber(cache.ttlMs, 'ttlMs')
    }),
    discovery: Object.freeze({
      enabled: discovery.enabled !== false,
      maxArrayScan: clampNumber(discovery.maxArrayScan, 'maxArrayScan'),
      maxDepth: clampNumber(discovery.maxDepth, 'maxDepth')
    }),
    http: Object.freeze({
      baseDelayMs: clampNumber(http.baseDelayMs, 'baseDelayMs'),
      maxAttempts: clampNumber(http.maxAttempts, 'maxAttempts'),
      maxDelayMs: clampNumber(http.maxDelayMs, 'maxDelayMs'),
      maxRedirects: clampNumber(http.maxRedirects, 'maxRedirects'),
      maxResponseBytes: clampNumber(http.maxResponseBytes, 'maxResponseBytes'),
      minHostIntervalMs: clampNumber(http.minHostIntervalMs, 'minHostIntervalMs'),
      respectRetryAfter: http.respectRetryAfter !== false,
      retryPost: http.retryPost === true,
      timeoutMs: clampNumber(http.timeoutMs, 'timeoutMs')
    }),
    maxInFlightGlobal: clampNumber(source.maxInFlightGlobal, 'maxInFlightGlobal'),
    maxInFlightPerProvider: clampNumber(source.maxInFlightPerProvider, 'maxInFlightPerProvider'),
    media: Object.freeze({
      allowedContentTypes: list(media.allowedContentTypes, ['video/', 'audio/', 'image/', 'application/octet-stream', 'application/mp4']),
      allowedHosts: list(media.allowedHosts, []),
      allowPrivateHosts: media.allowPrivateHosts === true,
      bufferBelowBytes: clampNumber(media.bufferBelowBytes, 'bufferBelowBytes'),
      deleteAfterSend: media.deleteAfterSend !== false,
      deniedContentTypes: list(media.deniedContentTypes, ['text/html', 'text/xml', 'application/json']),
      enabled: media.enabled !== false,
      maxBytes: clampNumber(media.maxBytes, 'maxBytes'),
      maxConcurrent: clampNumber(media.maxConcurrent, 'maxConcurrent'),
      maxRedirects: clampNumber(media.maxRedirects, 'maxRedirects'),
      probeTimeoutMs: clampNumber(media.probeTimeoutMs, 'probeTimeoutMs'),
      queueLimit: clampNumber(media.queueLimit, 'queueLimit'),
      streamSettleMs: clampNumber(media.streamSettleMs, 'streamSettleMs'),
      tempDir: media.tempDir ? String(media.tempDir) : '',
      timeoutMs: clampNumber(media.timeoutMs, 'timeoutMs')
    }),
    menuLimit: clampNumber(source.menuLimit, 'menuLimit'),
    perChatCooldownMs: clampNumber(source.perChatCooldownMs, 'perChatCooldownMs'),
    resultLimit: clampNumber(source.resultLimit, 'resultLimit'),
    verbose: source.verbose === true
  });
}

function normalizeProviderEntry(entry, { id, index }) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const rawCommand = String(source.command || `Exec${index + 1}`).trim() || `Exec${index + 1}`;
  const command = rawCommand.toLowerCase();
  return Object.freeze({
    command,
    commandDisplay: /[A-Z]/.test(rawCommand) ? rawCommand : command,
    config: Object.freeze({
      auth: Object.freeze(source.auth && typeof source.auth === 'object' ? { ...source.auth } : {}),
      bodyMode: String(source.bodyMode || ''),
      contract: Object.freeze({
        fields: Object.freeze(source.contract?.fields && typeof source.contract.fields === 'object' ? { ...source.contract.fields } : {}),
        listPath: String(source.contract?.listPath || ''),
        totalPath: String(source.contract?.totalPath || ''),
        verified: source.contract?.verified === true
      }),
      endpoint: String(source.endpoint || '').trim(),
      extraParams: Object.freeze(source.extraParams && typeof source.extraParams === 'object' ? { ...source.extraParams } : {}),
      headers: Object.freeze(source.headers && typeof source.headers === 'object' ? { ...source.headers } : {}),
      idParam: String(source.idParam || ''),
      label: String(source.label || '').slice(0, 40),
      method: String(source.method || 'GET').toUpperCase(),
      mode: String(source.mode || 'auto').toLowerCase(),
      modeOverrides: Object.freeze(source.modeOverrides && typeof source.modeOverrides === 'object' ? { ...source.modeOverrides } : {}),
      pageParam: String(source.pageParam || ''),
      pathTemplate: String(source.pathTemplate || ''),
      queryParam: String(source.queryParam || ''),
      timeoutMs: clampNumber(source.timeoutMs, 'timeoutMs', 0) === 0 ? 0 : clampNumber(source.timeoutMs, 'timeoutMs')
    }),
    enabled: source.enabled !== false,
    hidden: source.hidden === true,
    id,
    index,
    key: id,
    modes: Object.freeze((Array.isArray(source.modes) ? source.modes : []).map((mode) => String(mode || '').toLowerCase()).filter(Boolean))
  });
}

// Canonical keys (provider_01, provider_02, …) decide their own slot id. That
// keeps a slot, its command and its adapters/provider_NN.js file paired even if
// the config entries are reordered, and keeps the user's config comments honest.
// Keys that are not canonical (for example `mySite`) get the next free id.
const CANONICAL_KEY = /^provider_(\d{1,3})$/i;
const NON_CANONICAL_KEYS = [];

function nextFreeId(taken, from = 1) {
  let index = Math.max(1, Number(from) || 1);
  while (taken.has(`provider_${String(index).padStart(2, '0')}`)) index += 1;
  return `provider_${String(index).padStart(2, '0')}`;
}

function buildSlots() {
  const providers = userConfig?.EXECUTE_AFTER_PROVIDERS;
  const entries = providers && typeof providers === 'object' ? Object.entries(providers) : [];
  const taken = new Set();
  let cursor = 1;
  const slots = entries.map(([key, entry]) => {
    const canonical = CANONICAL_KEY.exec(String(key ?? '').trim());
    let id = canonical ? `provider_${String(Number(canonical[1])).padStart(2, '0')}` : '';
    if (id && taken.has(id)) id = '';
    if (!id) {
      id = nextFreeId(taken, cursor);
      if (!canonical && key) NON_CANONICAL_KEYS.push({ id, key });
    }
    taken.add(id);
    cursor = Number(id.slice('provider_'.length)) + 1;
    const index = Number(id.slice('provider_'.length)) - 1;
    return {
      ...normalizeProviderEntry(entry, { id, index, key }),
      adapter: null,
      configKey: key,
      menuHidden: false,
      reason: '',
      registered: false,
      status: 'UNRESOLVED'
    };
  });
  // Deterministic order: provider_01, provider_02, … whatever order the config
  // file happens to use.
  slots.sort((left, right) => left.index - right.index);
  return slots;
}

const framework = normalizeFramework(userConfig?.EXECUTE_AFTER_FRAMEWORK);
const policy = compilePolicy(userConfig?.EXECUTE_AFTER_FRAMEWORK?.policy);
const slots = buildSlots();
const byCommandMap = new Map();
const byIdMap = new Map();

let registration = { duplicate: [], hidden: [], registered: [], rejected: [] };
let registrationDone = false;

function slotStatus(slot) {
  if (!framework.enabled) return 'DISABLED';
  if (!slot.enabled) return 'DISABLED';
  if (!slot.config.endpoint) return 'UNRESOLVED';
  return slot.config.contract.verified ? 'READY' : 'UNVERIFIED';
}

function commandDescriptor(slot, { hidden }) {
  const modes = supportedModes({ modes: slot.modes });
  const capabilities = [];
  if (modes.includes('search')) capabilities.push('search <query>');
  for (const mode of ['trending', 'latest', 'random']) if (modes.includes(mode)) capabilities.push(mode);
  for (const mode of ['info', 'stream', 'download']) if (modes.includes(mode)) capabilities.push(`${mode} <id|url>`);
  return {
    description: `${slot.config.label || slot.id} — provider command (ExecuteAfter). ${capabilities.length ? `Modes: ${modes.join(', ')}` : 'No mode declared yet.'}`,
    hidden,
    name: slot.command,
    permission: 'public',
    usage: capabilities[0] ? `<query>` : ''
  };
}

/**
 * Registers every enabled slot into the EXISTING AnimeMD registry (menu.js).
 * Duplicate names are refused here — no second command parser, no second
 * dispatcher, no duplicate registration.
 */
function registerInto(menu) {
  // Duplicate registration is refused: the same slot can never be added twice.
  if (registrationDone) return registration;
  const summary = { duplicate: [], hidden: [], registered: [], rejected: [] };
  if (!framework.enabled) {
    for (const slot of slots) {
      slot.registered = false;
      slot.reason = 'framework disabled (EXECUTE_AFTER_FRAMEWORK.enabled = false)';
      slot.status = 'DISABLED';
    }
    registration = summary;
    registrationDone = true;
    return summary;
  }
  if (!menu || typeof menu.registerCommands !== 'function') {
    throw new Error('ExecuteAfter requires the AnimeMD menu registry (registerCommands).');
  }

  let visible = 0;
  const frameworkNames = new Set();
  for (const slot of slots) {
    slot.status = slotStatus(slot);
    if (!slot.enabled) {
      slot.reason = 'enabled: false in execute-after.config.js';
      continue;
    }
    if (!COMMAND_PATTERN.test(slot.command) || RESERVED_COMMANDS.has(slot.command)) {
      slot.reason = `command name "${slot.commandDisplay}" is not allowed`;
      slot.status = 'DISABLED';
      summary.rejected.push({ command: slot.commandDisplay, id: slot.id, reason: slot.reason });
      continue;
    }
    const existing = menu.resolveCommand(slot.command);
    if (existing) {
      // Two different problems, reported separately:
      //   duplicate → an earlier ExecuteAfter slot already took this name
      //   rejected  → the name belongs to an existing AnimeMD command
      const takenByFramework = existing.category === framework.category.id && frameworkNames.has(slot.command);
      slot.reason = takenByFramework
        ? `command name "${slot.commandDisplay}" is already used by another ExecuteAfter provider`
        : `command name "${slot.commandDisplay}" is already used by AnimeMD`;
      slot.status = 'DISABLED';
      (takenByFramework ? summary.duplicate : summary.rejected).push({ command: slot.commandDisplay, id: slot.id, reason: slot.reason });
      continue;
    }
    const hidden = slot.hidden || visible >= framework.menuLimit;
    slot.menuHidden = hidden;
    if (hidden && !slot.hidden) {
      slot.reason = `hidden from the menu: menuLimit ${framework.menuLimit} reached (still usable as ${slot.command})`;
    }
    const descriptor = commandDescriptor(slot, { hidden });
    const outcome = menu.registerCommands([descriptor], { category: framework.category });
    if (!outcome.registered.length) {
      const rejection = outcome.rejected[0] || { reason: 'rejected by the menu registry' };
      slot.reason = rejection.reason;
      slot.status = 'DISABLED';
      (rejection.reason === 'duplicate' ? summary.duplicate : summary.rejected).push({ command: slot.commandDisplay, id: slot.id, reason: slot.reason });
      continue;
    }
    if (hidden) summary.hidden.push({ command: slot.command, id: slot.id });
    else visible += 1;
    slot.registered = true;
    slot.reason = slot.reason || '';
    frameworkNames.add(slot.command);
    summary.registered.push({ command: slot.command, id: slot.id, label: descriptor.description });
    byCommandMap.set(slot.command, slot);
    byIdMap.set(slot.id, slot);
  }

  registration = summary;
  registrationDone = true;
  logRegistrationSummary(summary);
  return summary;
}

// Self-registration: guarantees the provider commands exist even when the
// framework is loaded before system/lib/menu.js (tools, tests, other entry
// points). registerInto() is idempotent, so the menu bridge can call it too.
function ensureRegistered() {
  if (registrationDone) return registration;
  try {
    // eslint-disable-next-line global-require
    const menu = require('../lib/menu');
    return registerInto(menu);
  } catch (error) {
    console.warn('[execute-after] registry could not register its commands:', error?.message || error);
    registrationDone = true;
    return registration;
  }
}

function byCommand(name) {
  return byCommandMap.get(String(name || '').toLowerCase());
}

function byId(id) {
  return byIdMap.get(String(id || ''));
}

function entries() {
  return slots.filter((slot) => slot.registered).map((slot) => ({ command: slot.command, hidden: slot.menuHidden === true, id: slot.id }));
}

function attachAdapters() {
  for (const slot of slots) {
    try {
      slot.adapter = loadAdapter(slot.id, { slotIndex: slot.index });
      slot.status = slotStatus(slot);
      if (!slot.reason && slot.status === 'UNRESOLVED') slot.reason = 'endpoint not configured yet (PUT YOUR PERMITTED API ENDPOINT HERE)';
    } catch (error) {
      slot.adapter = null;
      slot.status = 'DISABLED';
      slot.reason = `adapter failed to load: ${error?.message || error}`;
      console.warn(`[execute-after:${slot.id}] ${slot.reason}`);
    }
  }
}

attachAdapters();

// One summary line per boot so a misconfiguration is impossible to miss.
function logRegistrationSummary(summary) {
  const hidden = summary.hidden.map((entry) => `${entry.command} (${entry.id}, hidden)`);
  const registered = summary.registered.filter((entry) => !summary.hidden.some((hiddenEntry) => hiddenEntry.command === entry.command)).map((entry) => `${entry.command} (${entry.id})`);
  if (registered.length || hidden.length) {
    console.info(`[execute-after] ${registered.length + hidden.length}/${slots.length} provider command(s): ${[...registered, ...hidden].join(', ')}`);
  }
  for (const entry of NON_CANONICAL_KEYS) console.warn(`[execute-after:${entry.id}] config key "${entry.key}" is not named provider_NN — that slot got the id ${entry.id}. Rename the key to ${entry.id} to keep the slot, its command and adapters/${entry.id}.js together.`);
  for (const entry of summary.duplicate) console.warn(`[execute-after:${entry.id}] command "${entry.command}" is already used — that provider slot is disabled. Change "command" in ${CONFIG_FILE}.`);
  for (const entry of summary.rejected) console.warn(`[execute-after:${entry.id}] ${entry.reason} — that provider slot is disabled.`);
  for (const slot of slots) {
    if (slot.registered && slot.status === 'UNRESOLVED') console.info(`[execute-after:${slot.id}] UNRESOLVED — PUT YOUR PERMITTED API ENDPOINT HERE in ${CONFIG_FILE} (command: ${slot.command}).`);
  }
}

ensureRegistered();

function stats() {
  const counts = { DISABLED: 0, READY: 0, UNRESOLVED: 0, UNVERIFIED: 0 };
  for (const slot of slots) counts[slot.status] = (counts[slot.status] || 0) + 1;
  return {
    adapters: slots.filter((slot) => slot.adapter).length,
    commands: slots.filter((slot) => slot.registered).length,
    configFile: CONFIG_FILE,
    providers: slots.length,
    ...counts,
    registration
  };
}

module.exports = {
  COMMAND_PATTERN,
  CONFIG_FILE,
  RESERVED_COMMANDS,
  framework,
  byCommand,
  byId,
  ensureRegistered,
  entries,
  policy,
  registerInto,
  slotStatus,
  slots,
  stats,
  userConfig
};
