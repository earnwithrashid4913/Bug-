'use strict';

// =============================================================================
// EXECUTEAFTER — ERROR TAXONOMY + USER-FACING MESSAGES
// =============================================================================
// Every provider failure is converted into an ExecuteAfterError carrying:
//   * code         — stable machine code (used by tests and logs)
//   * status       — HTTP status when one was involved
//   * provider     — provider slot id ('provider_01')
//   * userMessage  — short, clean, user-facing sentence (no stack traces)
//   * hint         — optional actionable hint
//   * technical    — detail kept for the logs only
//
// Technical detail is NEVER sent to the chat. A failure in one provider can
// never throw out of the framework: the router catches every error and replies
// with userMessage.
// =============================================================================

const ERROR_CODES = Object.freeze({
  DISABLED: 'EDISABLED',
  NOT_CONFIGURED: 'ENOTCONFIGURED',
  UNRESOLVED: 'EUNRESOLVED',
  UNSUPPORTED_MODE: 'EUNSUPPORTEDMODE',
  MISSING_PARAMETER: 'ENOPARAM',
  MISSING_QUERY: 'ENOQUERY',
  BUSY: 'EBUSY',
  COOLDOWN: 'ECOOLDOWN',
  BAD_REQUEST: 'EBADREQUEST',
  UNAUTHORIZED: 'EUNAUTHORIZED',
  FORBIDDEN: 'EFORBIDDEN',
  NOT_FOUND: 'ENOTFOUND',
  CONFLICT: 'ECONFLICT',
  RATE_LIMITED: 'ERATELIMITED',
  SERVER_ERROR: 'ESERVERERROR',
  TIMEOUT: 'ETIMEOUT',
  ABORTED: 'EABORTED',
  DNS: 'EDNS',
  NETWORK: 'ENETWORK',
  INVALID_JSON: 'EJSON',
  EMPTY_RESPONSE: 'EEMPTY',
  RESPONSE_TOO_LARGE: 'ERESPONSELIMIT',
  NO_RESULTS: 'ENORESULTS',
  MISSING_MEDIA_URL: 'EMEDIAURL',
  INVALID_MEDIA_URL: 'EMEDIAINVALID',
  UNSUPPORTED_MEDIA: 'EMEDIATYPE',
  MEDIA_TOO_LARGE: 'EMEDIATOOLARGE',
  EXPIRED_MEDIA: 'EEXPIRED',
  POLICY_BLOCKED: 'EPOLICY',
  TEMP_FILE: 'ETMPFILE',
  UNKNOWN: 'EUNKNOWN'
});

const STATUS_MESSAGES = Object.freeze({
  400: { code: ERROR_CODES.BAD_REQUEST, user: 'The provider rejected that request (400).' },
  401: { code: ERROR_CODES.UNAUTHORIZED, user: 'This provider refused the request (401). Check the endpoint, headers or API key in the config.' },
  403: { code: ERROR_CODES.FORBIDDEN, user: 'This provider denied access (403). Check the endpoint, headers or API key in the config.' },
  404: { code: ERROR_CODES.NOT_FOUND, user: 'Nothing was found at that provider (404).' },
  408: { code: ERROR_CODES.TIMEOUT, user: 'The provider timed out while handling the request (408).' },
  409: { code: ERROR_CODES.CONFLICT, user: 'The provider reported a conflict for that request (409).' },
  410: { code: ERROR_CODES.EXPIRED_MEDIA, user: 'That provider link has expired (410).' },
  429: { code: ERROR_CODES.RATE_LIMITED, user: 'This provider is rate-limiting requests (429). Try again in a moment.' },
  500: { code: ERROR_CODES.SERVER_ERROR, user: 'The provider had an internal error (500). Try again later.' },
  502: { code: ERROR_CODES.SERVER_ERROR, user: 'The provider is temporarily unavailable (502). Try again later.' },
  503: { code: ERROR_CODES.SERVER_ERROR, user: 'The provider is overloaded or offline (503). Try again later.' },
  504: { code: ERROR_CODES.SERVER_ERROR, user: 'The provider did not answer in time (504). Try again later.' }
});

const CODE_MESSAGES = Object.freeze({
  [ERROR_CODES.DISABLED]: { user: 'This provider slot is disabled in the config.', hint: 'Set enabled to true for that provider in execute-after.config.js.' },
  [ERROR_CODES.NOT_CONFIGURED]: { user: 'This provider slot has no endpoint yet.', hint: 'PUT YOUR PERMITTED API ENDPOINT HERE in execute-after.config.js.' },
  [ERROR_CODES.UNRESOLVED]: { user: 'This provider is still UNRESOLVED — its API response was never verified.', hint: 'Fill endpoint and contract in execute-after.config.js, then check the real response.' },
  [ERROR_CODES.UNSUPPORTED_MODE]: { user: 'This provider does not support that mode.', hint: 'Only the modes declared for the slot can be used.' },
  [ERROR_CODES.MISSING_PARAMETER]: { user: 'This provider is missing the request parameter for that mode.', hint: 'Declare the parameter your API documents (queryParam / idParam / pageParam) in execute-after.config.js.' },
  [ERROR_CODES.MISSING_QUERY]: { user: 'Send a search query together with the command.', hint: '' },
  [ERROR_CODES.BAD_REQUEST]: { user: 'The provider rejected that request.', hint: 'Check the parameters your API documents in execute-after.config.js.' },
  [ERROR_CODES.UNAUTHORIZED]: { user: 'This provider refused the request. Check the endpoint, headers or API key in the config.', hint: '' },
  [ERROR_CODES.FORBIDDEN]: { user: 'This provider denied access. Check the endpoint, headers or API key in the config.', hint: '' },
  [ERROR_CODES.NOT_FOUND]: { user: 'Nothing was found at that provider.', hint: 'Check the endpoint path in execute-after.config.js.' },
  [ERROR_CODES.CONFLICT]: { user: 'The provider reported a conflict for that request.', hint: 'Try again in a moment.' },
  [ERROR_CODES.RATE_LIMITED]: { user: 'This provider is rate-limiting requests. Try again in a moment.', hint: 'Lower framework.http.minHostIntervalMs or wait for the provider limit to reset.' },
  [ERROR_CODES.SERVER_ERROR]: { user: 'The provider is temporarily unavailable. Try again later.', hint: '' },
  [ERROR_CODES.BUSY]: { user: 'This provider is still busy with an earlier request.', hint: 'Wait for the current request to finish.' },
  [ERROR_CODES.COOLDOWN]: { user: 'Please wait a moment before using this provider again.', hint: '' },
  [ERROR_CODES.TIMEOUT]: { user: 'The provider did not answer in time.', hint: 'Try again, or raise the timeout in execute-after.config.js.' },
  [ERROR_CODES.ABORTED]: { user: 'The request was cancelled before it finished.', hint: '' },
  [ERROR_CODES.DNS]: { user: 'The provider host could not be reached.', hint: 'Check the endpoint spelling in execute-after.config.js.' },
  [ERROR_CODES.NETWORK]: { user: 'The provider could not be reached over the network.', hint: 'Try again in a moment.' },
  [ERROR_CODES.INVALID_JSON]: { user: 'The provider returned a malformed response.', hint: 'Confirm the endpoint really returns JSON, then set the response contract in the config.' },
  [ERROR_CODES.EMPTY_RESPONSE]: { user: 'The provider returned an empty response.', hint: 'Confirm the endpoint is correct and reachable.' },
  [ERROR_CODES.RESPONSE_TOO_LARGE]: { user: 'The provider response is larger than the safe limit.', hint: 'Narrow the query or raise http.maxResponseBytes in execute-after.config.js.' },
  [ERROR_CODES.NO_RESULTS]: { user: 'No results were found for that query.', hint: '' },
  [ERROR_CODES.MISSING_MEDIA_URL]: { user: 'The provider did not return a playable media URL.', hint: 'Open the result page and provide the direct media URL from the provider response.' },
  [ERROR_CODES.INVALID_MEDIA_URL]: { user: 'The media URL from the provider is not a valid direct media file.', hint: 'A webpage URL is never used as a media URL.' },
  [ERROR_CODES.UNSUPPORTED_MEDIA]: { user: 'That media type is not supported by this bot.', hint: '' },
  [ERROR_CODES.MEDIA_TOO_LARGE]: { user: 'That file is larger than the configured size limit.', hint: 'Raise media.maxBytes in execute-after.config.js only if your host can handle it.' },
  [ERROR_CODES.EXPIRED_MEDIA]: { user: 'The media link has expired.', hint: 'Run the command again to get a fresh link.' },
  [ERROR_CODES.POLICY_BLOCKED]: { user: 'That result is not allowed by this bot config.', hint: 'Only permitted, non-explicit video APIs are supported.' },
  [ERROR_CODES.TEMP_FILE]: { user: 'The file could not be prepared safely.', hint: '' },
  [ERROR_CODES.UNKNOWN]: { user: 'The provider request failed.', hint: '' }
});

class ExecuteAfterError extends Error {
  constructor(code, { provider = '', mode = '', status = 0, technical = '', hint, userMessage, cause } = {}) {
    const preset = CODE_MESSAGES[code] || CODE_MESSAGES[ERROR_CODES.UNKNOWN];
    super(userMessage || preset.user || CODE_MESSAGES[ERROR_CODES.UNKNOWN].user);
    this.name = 'ExecuteAfterError';
    this.isExecuteAfterError = true;
    this.code = code || ERROR_CODES.UNKNOWN;
    this.provider = provider;
    this.mode = mode;
    this.status = Number(status) || 0;
    this.userMessage = userMessage || preset.user || CODE_MESSAGES[ERROR_CODES.UNKNOWN].user;
    this.hint = hint === undefined ? (preset.hint || '') : hint;
    this.technical = technical || '';
    if (cause) this.cause = cause;
  }
}

function isExecuteAfterError(error) {
  return Boolean(error && error.isExecuteAfterError === true);
}

// Maps any thrown value (native fetch failure, HTTP status, custom error) to a
// clean ExecuteAfterError. Never throws.
function toExecuteAfterError(error, { provider = '', mode = '' } = {}) {
  if (isExecuteAfterError(error)) {
    if (!error.provider) error.provider = provider;
    if (!error.mode) error.mode = mode;
    return error;
  }
  const technical = String(error?.stack || error?.message || error || 'unknown error');
  // Native fetch wraps the real socket error in `cause` (undici), so both
  // levels are inspected before falling back to a generic failure.
  const cause = error?.cause;
  const code = String(error?.code || cause?.code || '');
  const name = String(error?.name || cause?.name || '');
  const status = Number(error?.status || error?.statusCode || 0);

  if (status && STATUS_MESSAGES[status]) return new ExecuteAfterError(STATUS_MESSAGES[status].code, { provider, mode, status, technical });
  if (status >= 500 && status <= 599) return new ExecuteAfterError(ERROR_CODES.SERVER_ERROR, { provider, mode, status, technical });
  if (status >= 400 && status <= 499) return new ExecuteAfterError(ERROR_CODES.BAD_REQUEST, { provider, mode, status, technical });
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_ADDRFAMILY', 'ENODATA'].includes(code)) return new ExecuteAfterError(ERROR_CODES.DNS, { provider, mode, technical });
  if (name === 'AbortError' || code === 'ABORT_ERR' || /aborted/i.test(String(error?.message || ''))) return new ExecuteAfterError(ERROR_CODES.TIMEOUT, { provider, mode, technical });
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return new ExecuteAfterError(ERROR_CODES.TIMEOUT, { provider, mode, technical });
  if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'UND_ERR_SOCKET'].includes(code)) return new ExecuteAfterError(ERROR_CODES.NETWORK, { provider, mode, technical });
  if (error?.isSyntaxError || name === 'SyntaxError') return new ExecuteAfterError(ERROR_CODES.INVALID_JSON, { provider, mode, technical });
  // Undici reports a bare "fetch failed" with an empty cause for transport
  // problems; that is a network failure, not an unknown one.
  if (/fetch failed/i.test(String(error?.message || ''))) return new ExecuteAfterError(ERROR_CODES.NETWORK, { provider, mode, technical });
  return new ExecuteAfterError(ERROR_CODES.UNKNOWN, { provider, mode, technical, userMessage: cleanMessage(error?.message) });
}

// Keeps an unexpected native message readable but short and free of internals.
function cleanMessage(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

// Logs the technical side of a failure. The chat only ever sees userMessage.
function logFailure(error, { provider = '', mode = '', verbose = false } = {}) {
  const info = toExecuteAfterError(error, { provider, mode });
  const scope = `[execute-after:${info.provider || provider || 'framework'}${info.mode ? `:${info.mode}` : ''}]`;
  const head = `${scope} ${info.code}${info.status ? ` http=${info.status}` : ''} ${info.technical ? `— ${info.technical.split('\n')[0]}` : ''}`.trim();
  if (verbose) console.warn(head);
  else console.warn(`${scope} ${info.code}${info.status ? ` http=${info.status}` : ''}`);
  return info;
}

// Never log a full URL with credentials or API keys in it.
function redactUrl(value) {
  try {
    const url = new URL(String(value));
    for (const key of [...url.searchParams.keys()]) {
      if (/(key|token|secret|auth|password|signature|sig|expire)/i.test(key)) url.searchParams.set(key, '***');
    }
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    return url.toString();
  } catch {
    return String(value || '').slice(0, 200);
  }
}

module.exports = {
  ERROR_CODES,
  STATUS_MESSAGES,
  ExecuteAfterError,
  cleanMessage,
  isExecuteAfterError,
  logFailure,
  redactUrl,
  toExecuteAfterError
};
