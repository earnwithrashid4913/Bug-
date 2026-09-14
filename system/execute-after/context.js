'use strict';

// =============================================================================
// EXECUTEAFTER — COMMAND CONTEXT + MODE RESOLUTION
// =============================================================================
// Turns "!Exec1 trending 2" / "!Exec1 search naruto" into a provider request
// context. Only modes that the slot declares in execute-after.config.js are
// ever offered, so an endpoint that is not a search endpoint is never used as
// one.
//
// MODE GRAMMAR (all documented in EXECUTE-AFTER.md):
//   !Exec1 <mode> <text>      explicit mode        e.g. !Exec1 search naruto
//   !Exec1 <text>             automatic mode      e.g. !Exec1 naruto
//   !Exec1                    first list mode     random > trending > latest
//   !Exec1 modes              shows the modes this slot really supports
//
// Automatic mode resolution:
//   text given   → search (if supported) → info → stream → download
//   no text      → random → trending → latest (first supported), otherwise
//                  search with a "send a query" hint
// =============================================================================

const MODE_NAMES = Object.freeze(['search', 'random', 'trending', 'latest', 'info', 'stream', 'download', 'auto']);
const CONCRETE_MODES = Object.freeze(MODE_NAMES.filter((mode) => mode !== 'auto'));
const LIST_MODES = Object.freeze(['random', 'trending', 'latest']);
const ID_MODES = Object.freeze(['info', 'stream', 'download']);
const AUTO_PRIORITY = Object.freeze(['search', 'info', 'stream', 'download']);

const { ERROR_CODES, ExecuteAfterError } = require('./errors');

function supportedModes(slot) {
  const declared = Array.isArray(slot?.modes) ? slot.modes : [];
  const cleaned = declared
    .map((mode) => String(mode || '').trim().toLowerCase())
    .filter((mode) => CONCRETE_MODES.includes(mode));
  const unique = [...new Set(cleaned)];
  return unique.length ? unique : ['search'];
}

function splitTokens(command) {
  if (Array.isArray(command?.args) && command.args.length) return command.args.map(String);
  const text = String(command?.text || '').trim();
  return text ? text.split(/\s+/) : [];
}

function isUrlLike(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function normalizePage(value, { pageParam }) {
  if (!pageParam) return null;
  const page = Number(String(value || '').trim());
  return Number.isSafeInteger(page) && page > 0 && page <= 1000 ? page : null;
}

/**
 * Builds the provider request context for one ExecuteAfter command invocation.
 * Throws a clean ExecuteAfterError when the invocation cannot be served
 * (unsupported mode, missing query, missing declared parameter).
 */
function buildContext(slot, command) {
  const modes = supportedModes(slot);
  const tokens = splitTokens(command);
  const first = (tokens[0] || '').toLowerCase();
  const config = slot?.config || {};
  const configuredMode = String(config.mode || 'auto').toLowerCase();
  let requestedMode = tokens.length ? first : '';
  let rest = tokens.slice(1);

  const context = {
    command: String(command?.name || slot?.command || ''),
    explicit: false,
    id: '',
    listModes: false,
    mode: '',
    modeSource: 'auto',
    modes,
    page: null,
    query: '',
    slot,
    text: ''
  };

  // "!Exec1 modes" — read-only status of the slot, no request is made.
  if (tokens.length === 1 && ['modes', 'mode'].includes(first)) {
    context.listModes = true;
    context.mode = configuredMode === 'auto' ? '' : configuredMode;
    return context;
  }

  const explicit = modes.includes(requestedMode) || CONCRETE_MODES.includes(requestedMode);
  if (explicit && modes.includes(requestedMode)) {
    context.modeSource = 'explicit';
    context.explicit = true;
  } else if (explicit && !modes.includes(requestedMode)) {
    // The provider does not expose that mode: never silently fall back.
    throw new ExecuteAfterError(ERROR_CODES.UNSUPPORTED_MODE, {
      provider: slot?.id,
      mode: requestedMode,
      technical: `requested mode "${requestedMode}" is not declared for ${slot?.id} (declared: ${modes.join(', ')})`
    });
  } else {
    rest = tokens;
  }

  if (context.modeSource === 'explicit') {
    context.mode = requestedMode;
  } else if (configuredMode !== 'auto' && CONCRETE_MODES.includes(configuredMode)) {
    context.mode = configuredMode;
    context.modeSource = 'config';
  } else {
    context.modeSource = 'auto';
    context.mode = '';
  }

  const text = rest.join(' ').trim();
  context.text = text;

  if (!context.mode) {
    if (!text) {
      const listMode = LIST_MODES.find((mode) => modes.includes(mode));
      if (listMode) {
        context.mode = listMode;
        context.modeSource = 'auto';
      } else if (modes.includes('search')) {
        context.mode = 'search';
      } else {
        context.mode = modes[0];
      }
    } else {
      context.mode = AUTO_PRIORITY.find((mode) => modes.includes(mode)) || modes[0];
    }
  }

  if (!modes.includes(context.mode)) {
    throw new ExecuteAfterError(ERROR_CODES.UNSUPPORTED_MODE, {
      provider: slot?.id,
      mode: context.mode,
      technical: `resolved mode "${context.mode}" is not declared for ${slot?.id} (declared: ${modes.join(', ')})`
    });
  }

  if (ID_MODES.includes(context.mode)) {
    context.id = text;
    if (!context.id) {
      throw new ExecuteAfterError(ERROR_CODES.MISSING_QUERY, {
        provider: slot?.id,
        mode: context.mode,
        technical: `${context.mode} mode needs an id or a result URL`,
        userMessage: `Send the result id or its page URL with ${context.mode}.`
      });
    }
  } else if (context.mode === 'search') {
    context.query = text;
    const needsQuery = Boolean(config.queryParam || config.pathTemplate?.includes('{query}') || config.modeOverrides?.[context.mode]?.queryParam);
    if (!context.query && needsQuery) {
      throw new ExecuteAfterError(ERROR_CODES.MISSING_QUERY, {
        provider: slot?.id,
        mode: context.mode,
        technical: 'search mode needs a query'
      });
    }
    if (!context.query) {
      throw new ExecuteAfterError(ERROR_CODES.MISSING_QUERY, {
        provider: slot?.id,
        mode: context.mode,
        technical: 'search mode needs a query and no list mode is declared'
      });
    }
    if (!config.queryParam && !config.pathTemplate?.includes('{query}') && !config.modeOverrides?.[context.mode]?.queryParam) {
      throw new ExecuteAfterError(ERROR_CODES.MISSING_PARAMETER, {
        provider: slot?.id,
        mode: context.mode,
        technical: `no queryParam / pathTemplate declared for the search mode of ${slot?.id}`
      });
    }
  } else if (LIST_MODES.includes(context.mode)) {
    context.page = normalizePage(text, { pageParam: config.pageParam });
    if (!context.page && text && isUrlLike(text)) {
      throw new ExecuteAfterError(ERROR_CODES.UNSUPPORTED_MODE, {
        provider: slot?.id,
        mode: context.mode,
        technical: `${context.mode} mode received a URL`,
        userMessage: `This provider does not map links in ${context.mode} mode.`
      });
    }
  }

  return context;
}

function usageLine(prefix, slot, mode = '') {
  const modes = supportedModes(slot);
  const name = slot?.command || 'Exec1';
  const examples = [];
  if (modes.includes('search')) examples.push(`${prefix}${name} search <query>`);
  for (const listMode of LIST_MODES) if (modes.includes(listMode)) examples.push(`${prefix}${name} ${listMode}`);
  for (const idMode of ID_MODES) if (modes.includes(idMode)) examples.push(`${prefix}${name} ${idMode} <id|url>`);
  if (!examples.length) examples.push(`${prefix}${name}`);
  return [
    '*USAGE*',
    examples[0],
    ...examples.slice(1).map((line) => line),
    '',
    `Modes: ${modes.join(', ')}`,
    `Provider: ${slot?.id || 'provider'}`
  ].filter(Boolean).join('\n');
}

module.exports = {
  AUTO_PRIORITY,
  CONCRETE_MODES,
  ID_MODES,
  LIST_MODES,
  MODE_NAMES,
  buildContext,
  isUrlLike,
  normalizePage,
  splitTokens,
  supportedModes,
  usageLine
};
