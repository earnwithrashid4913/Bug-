'use strict';

// ════════════════════════════════════════════════════════════════════════════
//  UNIVERSAL TEMP MAIL SYSTEM
//
//    !tempmail / !getmail
//      ↓
//    command router (this module's handle*Command entry points)
//      ↓
//    temp mail service (createMailbox / checkInbox / readMessage / …)
//      ↓
//    provider registry (PROVIDERS, one entry per provider, only the operations
//                       that provider's own endpoints actually offer)
//      ↓
//    DavidCyril temp mail client (commands/davidcyril-api.js — the same
//                                 universal client the downloaders, movies and
//                                 image system already use)
//      ↓
//    normalized result { success, operation, provider, mailbox | messages |
//                        message | types | reason }
//      ↓
//    AnimeMD reply (socket.sendMessage, quoted, existing design language)
//
//  Provider identity is preserved end to end: a mailbox created on Guerrilla
//  Mail is only ever checked, read or deleted through Guerrilla Mail. Fallback
//  exists for CREATING a mailbox only — never for an existing session (§21).
//
//  Adding a future temp mail provider is incremental: add its endpoints to
//  TEMPMAIL_ENDPOINTS in commands/davidcyril-api.js and ONE entry to PROVIDERS
//  below. No new dispatcher, no second framework, no change to other commands.
// ════════════════════════════════════════════════════════════════════════════

const dc = require('./davidcyril-api');
const { FOOTER } = require('../system/lib/presentation');
const { cleanText } = require('../system/lib/anime-library');

// ── bounded limits (never infinite, never unbounded) ───────────────────────

const MAX_USERNAME_LENGTH = 40;
const MAX_MESSAGE_BODY = 1600;
const MAX_SUBJECT_LENGTH = 90;
const MAX_STORED_SESSIONS = 200;
const MAX_KNOWN_MESSAGE_IDS = 50;
const MAX_LISTED_MESSAGES = 10;
const DEFAULT_SESSION_TTL_MINUTES = 60;
const CREATE_COOLDOWN_MS = 20_000;
const INBOX_COOLDOWN_MS = 8_000;
const ACTION_COOLDOWN_MS = 6_000;
const MAX_CONCURRENT_CALLS = 3;

// A provider message id is replayed verbatim, so only safe characters are
// accepted before it is ever put into a request (§25).
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_.:+-]{1,120}$/;
// A requested username/address part: letters, digits, dot, dash, underscore.
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{2,40}$/;

// ── provider registry ──────────────────────────────────────────────────────
// `sessionParams` returns ONLY the credential keys that the provider itself
// handed us (or explicitly asked for by name in its own note). `valueKey` is
// the confirmed parameter name for an operation that takes user input; when it
// is null the endpoint is asked what it wants instead of guessing (§27).

const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'guerrilla',
    label: 'Guerrilla Mail',
    keywords: Object.freeze(['guerrilla', 'guerrillamail', 'gm']),
    operations: Object.freeze({ create: true, inbox: true, message: true, setuser: true }),
    // Live create response: { success, email, sid_token, alias,
    //   note: "Use sid_token to check inbox. Emails expire after 1 hour." }
    ttlMinutes: 60,
    sessionParams: (session) => ({ sid_token: session.credentials.sid_token }),
    valueKey: null
  }),
  Object.freeze({
    id: 'mailtm',
    label: 'Mail.tm',
    keywords: Object.freeze(['mailtm', 'mail.tm', 'tm']),
    operations: Object.freeze({ create: true, inbox: true, message: true, delete: true }),
    // Live create response: { success, email, token,
    //   note: "Use the token to check inbox. Inbox expires after ~10 minutes
    //          of inactivity." }
    ttlMinutes: 10,
    sessionParams: (session) => ({ token: session.credentials.token }),
    valueKey: null
  }),
  Object.freeze({
    id: 'temporary-mail',
    label: 'Temporary-Mail',
    keywords: Object.freeze(['temporary-mail', 'temporarymail', 'temporary', 'tmail']),
    operations: Object.freeze({ create: true, inbox: true, message: true, change: true, types: true }),
    // Live create response: { success, status, result: { email, code, types,
    //   note: "Pass email + code to inbox endpoint" } }
    // Live types response documents the change parameter itself:
    //   domain: { code: '4', example: 'name@custom-domain.com',
    //             note: 'optional domain= on change' }
    ttlMinutes: DEFAULT_SESSION_TTL_MINUTES,
    sessionParams: (session) => ({ email: session.email, code: session.credentials.code }),
    valueKey: 'domain'
  }),
  Object.freeze({
    id: 'tempmailio',
    label: 'TempMail.io',
    keywords: Object.freeze(['tempmailio', 'tempmail.io', 'tio']),
    operations: Object.freeze({ create: true, inbox: true, delete: true }),
    // Separate provider from Mail.tm — never shares a session model (§43).
    ttlMinutes: DEFAULT_SESSION_TTL_MINUTES,
    sessionParams: (session) => ({ ...session.credentials }),
    valueKey: null
  }),
  Object.freeze({
    id: 'emailnator',
    label: 'Emailnator',
    keywords: Object.freeze(['emailnator', 'emn']),
    operations: Object.freeze({ create: true, inbox: true }),
    ttlMinutes: DEFAULT_SESSION_TTL_MINUTES,
    sessionParams: (session) => ({ ...session.credentials }),
    valueKey: null
  })
]);

// Creation order: providers whose contract and success were confirmed live
// first, then the remaining supplied providers.
const CREATE_ORDER = Object.freeze(['guerrilla', 'mailtm', 'temporary-mail', 'tempmailio', 'emailnator']);

const PROVIDER_BY_ID = Object.freeze(PROVIDERS.reduce((map, provider) => {
  map[provider.id] = provider;
  return map;
}, {}));

function supports(providerId, operation) {
  return Boolean(PROVIDER_BY_ID[providerId]?.operations?.[operation]);
}

function resolveProviderKeyword(token) {
  const key = String(token || '').trim().toLowerCase();
  if (!key) return null;
  return PROVIDERS.find((provider) => provider.id === key || provider.keywords.includes(key)) || null;
}

function providerList(operation) {
  const ids = operation ? CREATE_ORDER.filter((id) => supports(id, operation)) : [...CREATE_ORDER];
  return ids.map((id) => PROVIDER_BY_ID[id]);
}

// ── session store (per user, in memory, bounded, lazily expired) ───────────
// Temp mailboxes are ephemeral by nature, so the project's existing in-memory
// state pattern is enough: no new database, no persisted credentials (§16).

const sessions = new Map();     // sender JID → session
let callsInFlight = 0;
const recentActions = new Map(); // sender JID → { create, inbox, action } timestamps

function sessionKey(context) {
  return String(context?.sender || context?.chatId || 'anonymous');
}

function pruneSessions() {
  if (sessions.size <= MAX_STORED_SESSIONS) return;
  const ordered = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (const [key] of ordered.slice(0, sessions.size - MAX_STORED_SESSIONS)) sessions.delete(key);
}

function isExpired(session) {
  return Boolean(session?.expiresAt) && session.expiresAt <= Date.now();
}

function getSession(context) {
  const key = sessionKey(context);
  const session = sessions.get(key);
  if (!session) return null;
  if (isExpired(session)) {
    sessions.delete(key);
    return { expired: true, providerLabel: session.providerLabel, email: session.email };
  }
  return session;
}

function saveSession(context, session) {
  const key = sessionKey(context);
  sessions.set(key, session);
  pruneSessions();
  return session;
}

function clearSession(context) {
  sessions.delete(sessionKey(context));
}

function rememberMessages(session, messages) {
  session.lastMessages = messages.slice(0, MAX_LISTED_MESSAGES * 2);
  session.knownIds = new Map();
  for (const message of messages.slice(0, MAX_KNOWN_MESSAGE_IDS)) {
    if (message.id) session.knownIds.set(message.id, message.idKey || 'id');
  }
  return session;
}

// One bounded cooldown per action kind + a small global in-flight cap, the same
// shape as system/lib/ai.js and the image system. No polling timers exist, so
// there is nothing to leak when a mailbox expires or is deleted (§31, §32).
function reserveAction(key, kind, cooldownMs) {
  const now = Date.now();
  const record = recentActions.get(key) || {};
  const previous = record[kind] || 0;
  const remaining = cooldownMs - (now - previous);
  if (remaining > 0) return { ok: false, waitSeconds: Math.ceil(remaining / 1000) };
  record[kind] = now;
  recentActions.set(key, record);
  const timer = setTimeout(() => {
    const current = recentActions.get(key);
    if (current && current[kind] === now) {
      delete current[kind];
      if (!Object.keys(current).length) recentActions.delete(key);
    }
  }, cooldownMs);
  timer.unref?.();
  return { ok: true };
}

function actionGateStatus(key) {
  if (callsInFlight >= MAX_CONCURRENT_CALLS) return { busy: true };
  return {};
}

// ── error translation (no stack traces, no raw internals, no secrets) ──────

const TECHNICAL_MESSAGE = /EPROTO|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ERR_BAD|SSL|TLS|socket|getaddrinfo|errno|stack|https?:\/\/|\bundefined\b|\bNaN\b|\[object Object\]|at [A-Za-z0-9_$.]+\s*\(/i;

// The provider's own short human sentence may be shown; anything technical is
// replaced by a clean description so no internal detail reaches a chat (§18).
// Words that must never appear in an AnimeMD chat reply (the project's own
// command audit rejects them), so a provider sentence carrying one is replaced
// by a clean description instead of being echoed.
const UNPRESENTABLE_MESSAGE = /COMMAND FAILED|\bFAILED\b|\bERROR:|\bUNDEFINED\b|\bNaN\b|UNAVAILABLE|not a function/i;

function safeApiMessage(message) {
  const text = cleanText(String(message || ''), 160).replace(/[\r\n]+/g, ' ');
  if (!text || TECHNICAL_MESSAGE.test(text) || UNPRESENTABLE_MESSAGE.test(text)) return '';
  return text;
}

function describeFailure(error, data) {
  const status = Number(error?.response?.status || data?.status || 0);
  const code = String(error?.code || '');
  const rawMessage = String(error?.message || '');
  const apiMessage = safeApiMessage(dc.pickApiMessage(error?.response?.data || data));
  if (apiMessage) return apiMessage;
  if (code === 'ECONNABORTED' || /timeout/i.test(rawMessage)) return 'that provider took too long to answer';
  if (status === 429) return 'that provider asked us to slow down (too many requests)';
  if (status === 401 || status === 403) return 'that provider no longer accepts this mailbox session';
  if (status === 404) return 'that provider does not have this mailbox or message any more';
  if (status >= 500) return 'that provider is having trouble right now';
  if (status >= 400) return 'that provider rejected the request';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'that provider could not be reached (name not resolved)';
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE') return 'that provider dropped the connection';
  if (/unexpected token|is not valid json|json/i.test(rawMessage)) return 'that provider sent an unreadable reply';
  if (/network/i.test(rawMessage)) return 'that provider could not be reached';
  return 'that provider did not answer with a usable mailbox';
}

// §22: deletion also counts as done when the provider states the account or
// address is already gone.
function alreadyGone(reason) {
  const text = String(reason || '');
  return /\b(?:account|address|mailbox|email|user)\b[^.]{0,40}?\b(?:not found|no longer exists|does not exist|already (?:deleted|removed|gone)|expired|invalid)\b/i.test(text)
    || /\b(?:not found|no such (?:account|address|mailbox|user)|already (?:deleted|removed|gone))\b/i.test(text);
}

// ── provider call with bounded, evidence-driven parameter discovery ────────
// Attempt 1 sends only parameters the provider itself gave us (or named in its
// own note). If the provider then complains that a parameter is missing, its
// OWN message supplies the key name and we retry once with the value we already
// hold. No parameter name is ever invented in code (§12, §27).

async function callProvider(provider, operation, params, { value, valueKeys, holdings } = {}) {
  const started = Date.now();
  const send = (extra) => dc.tempmailRequest(provider.id, operation, { ...params, ...extra });
  // Values we already hold from this provider's own create response. They are
  // only ever sent when the provider asks for that key by name.
  const held = {};
  for (const [key, heldValue] of Object.entries(holdings || {})) {
    if (heldValue !== undefined && heldValue !== null && heldValue !== '') held[key] = heldValue;
  }
  // One bounded retry with a parameter NAME the provider itself supplied.
  const retryWithDiscoveredParam = async (complaint) => {
    const discovered = dc.missingTempmailParam(complaint, params);
    if (!discovered) return null;
    const discoveredValue = held[discovered] ?? value;
    if (discoveredValue === undefined || discoveredValue === null || discoveredValue === '') return null;
    const data = await send({ [discovered]: discoveredValue });
    logCall(provider.id, operation, true, Date.now() - started, data?.status);
    return { data, message: dc.pickApiMessage(data) };
  };
  try {
    // A confirmed key (or a message id key taken from this provider's own inbox
    // entry) is sent straight away; otherwise the endpoint is asked first.
    const knownKeys = [...(valueKeys || []), provider.valueKey].filter(Boolean);
    let data = value === undefined ? await send({}) : await send(knownKeys.length ? { [knownKeys[0]]: value } : {});
    let message = dc.pickApiMessage(data);
    if (dc.pickTempmailAction(data).ok === false) {
      const retried = await retryWithDiscoveredParam(message).catch(() => null);
      if (retried) return retried;
    }
    logCall(provider.id, operation, true, Date.now() - started, data?.status);
    return { data, message };
  } catch (error) {
    logCall(provider.id, operation, false, Date.now() - started, error?.response?.status);
    const complaint = String(error?.response?.data?.message || error?.response?.data?.error || error?.message || '');
    try {
      const retried = await retryWithDiscoveredParam(complaint);
      if (retried) return retried;
    } catch {
      // The retry is a best effort only: the original complaint is the answer.
    }
    throw error;
  }
}

// §30: provider, operation, outcome, duration and HTTP status only — never a
// token, code, cookie, header or email body.
function logCall(providerId, operation, ok, durationMs, status) {
  console.info(`[tempmail] ${providerId} ${operation} ${ok ? 'ok' : 'not-ok'} ${durationMs}ms${status ? ` status=${status}` : ''}`);
}

// Extra values this session already holds. They are never sent on spec — only
// when the provider names the key itself.
function sessionHoldings(session) {
  return {
    email: session.email,
    address: session.email,
    mailbox: session.email,
    alias: session.alias,
    username: session.username,
    domain: session.domain,
    ...session.credentials
  };
}

// ── service operations ─────────────────────────────────────────────────────

async function createMailbox({ providerId } = {}) {
  const attempts = [];
  const chain = providerId ? [PROVIDER_BY_ID[providerId]].filter(Boolean) : providerList('create');
  for (const provider of chain) {
    if (!supports(provider.id, 'create')) continue;
    try {
      const { data } = await callProvider(provider, 'create', {});
      if (!dc.isValidResult(data) && !dc.pickTempmailEmail(data)) {
        attempts.push({ provider: provider.label, reason: safeApiMessage(dc.pickApiMessage(data)) || describeFailure(null, data) });
        continue;
      }
      const mailbox = dc.pickMailbox(data);
      if (!mailbox) {
        // §22: no address in the response means no mailbox was created.
        attempts.push({ provider: provider.label, reason: safeApiMessage(dc.pickApiMessage(data)) || 'no address was returned' });
        continue;
      }
      return {
        success: true,
        operation: 'create',
        provider: provider.label,
        providerId: provider.id,
        mailbox: buildSession(provider, mailbox),
        attempts
      };
    } catch (error) {
      attempts.push({ provider: provider.label, reason: describeFailure(error) });
      console.warn(`[tempmail] create on ${provider.id} was refused: ${describeFailure(error)}`);
    }
  }
  return { success: false, operation: 'create', attempts };
}

function buildSession(provider, mailbox) {
  const ttlMinutes = Number(provider.ttlMinutes) || DEFAULT_SESSION_TTL_MINUTES;
  const created = Date.now();
  return {
    providerId: provider.id,
    providerLabel: provider.label,
    email: mailbox.email,
    alias: mailbox.alias,
    username: mailbox.username,
    domain: mailbox.domain,
    types: mailbox.types,
    credentials: mailbox.credentials,
    createdAt: created,
    expiresAt: mailbox.expiresAt || created + ttlMinutes * 60_000,
    ttlMinutes,
    lastMessages: [],
    knownIds: new Map()
  };
}

// Always bound to the session's own provider — never a silent switch (§21).
async function checkInbox(session) {
  const provider = PROVIDER_BY_ID[session.providerId];
  if (!provider || !supports(provider.id, 'inbox')) {
    return { success: false, operation: 'inbox', reason: `${session.providerLabel} does not offer an inbox endpoint.` };
  }
  try {
    const { data } = await callProvider(provider, 'inbox', provider.sessionParams(session), { holdings: sessionHoldings(session) });
    if (!dc.isValidResult(data) && dc.pickMessages(data) === null) {
      return { success: false, operation: 'inbox', provider: provider.label, reason: describeFailure(null, data) };
    }
    const messages = dc.pickMessages(data);
    if (messages === null) {
      return { success: false, operation: 'inbox', provider: provider.label, reason: safeApiMessage(dc.pickApiMessage(data)) || 'that provider sent an unreadable inbox reply' };
    }
    return { success: true, operation: 'inbox', provider: provider.label, providerId: provider.id, messages, email: session.email };
  } catch (error) {
    return { success: false, operation: 'inbox', provider: provider.label, reason: describeFailure(error) };
  }
}

async function readMessage(session, messageId) {
  const provider = PROVIDER_BY_ID[session.providerId];
  if (!provider || !supports(provider.id, 'message')) {
    return { success: false, operation: 'message', reason: `${session.providerLabel} does not offer a message-reading endpoint. The inbox preview above is all it exposes.` };
  }
  const idKey = session.knownIds?.get(messageId) || '';
  try {
    const { data } = await callProvider(provider, 'message', provider.sessionParams(session), {
      value: messageId,
      valueKeys: idKey ? [idKey] : [],
      holdings: sessionHoldings(session)
    });
    const message = dc.pickMessagePayload(data);
    if (!message) {
      return { success: false, operation: 'message', provider: provider.label, reason: safeApiMessage(dc.pickApiMessage(data)) || describeFailure(null, data) };
    }
    return { success: true, operation: 'message', provider: provider.label, providerId: provider.id, message: { ...message, id: message.id || messageId }, email: session.email };
  } catch (error) {
    return { success: false, operation: 'message', provider: provider.label, reason: describeFailure(error) };
  }
}

async function deleteMailbox(session) {
  const provider = PROVIDER_BY_ID[session.providerId];
  if (!provider || !supports(provider.id, 'delete')) {
    return { success: false, operation: 'delete', unsupported: true, reason: `${session.providerLabel} has no delete endpoint in the supplied API. Its mailbox simply expires on its own.` };
  }
  try {
    const { data } = await callProvider(provider, 'delete', provider.sessionParams(session), { holdings: sessionHoldings(session) });
    const action = dc.pickTempmailAction(data);
    const reason = safeApiMessage(action.message) || safeApiMessage(dc.pickApiMessage(data));
    if (!action.ok && !alreadyGone(reason)) {
      return { success: false, operation: 'delete', provider: provider.label, reason: reason || describeFailure(null, data) };
    }
    return { success: true, operation: 'delete', provider: provider.label, providerId: provider.id, email: session.email, alreadyGone: !action.ok };
  } catch (error) {
    const reason = describeFailure(error);
    const status = Number(error?.response?.status || 0);
    if (alreadyGone(reason) || status === 404) {
      return { success: true, operation: 'delete', provider: provider.label, providerId: provider.id, email: session.email, alreadyGone: true };
    }
    return { success: false, operation: 'delete', provider: provider.label, reason };
  }
}

async function changeAddress(session, requested) {
  const provider = PROVIDER_BY_ID[session.providerId];
  if (!provider || !supports(provider.id, 'change')) {
    return { success: false, operation: 'change', unsupported: true, reason: `${session.providerLabel} does not offer an address-change endpoint.` };
  }
  try {
    const { data } = await callProvider(provider, 'change', provider.sessionParams(session), {
      ...(requested ? { value: requested } : {}),
      holdings: sessionHoldings(session)
    });
    const mailbox = dc.pickMailbox(data);
    const action = dc.pickTempmailAction(data);
    if (mailbox && mailbox.email !== session.email) {
      return { success: true, operation: 'change', provider: provider.label, providerId: provider.id, mailbox: buildSession(provider, mailbox) };
    }
    if (mailbox && requested && String(mailbox.email).toLowerCase().includes(String(requested).toLowerCase())) {
      return { success: true, operation: 'change', provider: provider.label, providerId: provider.id, mailbox: buildSession(provider, mailbox) };
    }
    if (!action.ok) {
      return { success: false, operation: 'change', provider: provider.label, reason: safeApiMessage(action.message) || describeFailure(null, data) };
    }
    return { success: true, operation: 'change', provider: provider.label, providerId: provider.id, unchanged: true, note: safeApiMessage(action.message) };
  } catch (error) {
    return { success: false, operation: 'change', provider: provider.label, reason: describeFailure(error) };
  }
}

async function setUsername(session, username) {
  const provider = PROVIDER_BY_ID[session.providerId];
  if (!provider || !supports(provider.id, 'setuser')) {
    return { success: false, operation: 'setuser', unsupported: true, reason: `${session.providerLabel} does not offer a username endpoint.` };
  }
  try {
    const { data } = await callProvider(provider, 'setuser', provider.sessionParams(session), { value: username, holdings: sessionHoldings(session) });
    const mailbox = dc.pickMailbox(data);
    const action = dc.pickTempmailAction(data);
    if (mailbox) {
      return { success: true, operation: 'setuser', provider: provider.label, providerId: provider.id, mailbox: buildSession(provider, mailbox) };
    }
    if (!action.ok) {
      return { success: false, operation: 'setuser', provider: provider.label, reason: safeApiMessage(action.message) || describeFailure(null, data) };
    }
    return { success: true, operation: 'setuser', provider: provider.label, providerId: provider.id, email: session.email, note: safeApiMessage(action.message) };
  } catch (error) {
    return { success: false, operation: 'setuser', provider: provider.label, reason: describeFailure(error) };
  }
}

// §28: metadata only — `types` never creates a mailbox.
async function listTypes() {
  const provider = PROVIDER_BY_ID['temporary-mail'];
  try {
    const { data } = await callProvider(provider, 'types', {});
    const types = dc.pickTempmailTypes(data);
    if (types === null) {
      return { success: false, operation: 'types', provider: provider.label, reason: safeApiMessage(dc.pickApiMessage(data)) || 'that provider sent an unreadable type list' };
    }
    return { success: true, operation: 'types', provider: provider.label, providerId: provider.id, types };
  } catch (error) {
    return { success: false, operation: 'types', provider: provider.label, reason: describeFailure(error) };
  }
}

// ── presentation (existing AnimeMD design language) ────────────────────────

function formatWhen(value) {
  const text = cleanText(String(value ?? ''), 60);
  if (!text) return '';
  if (/^\d{10}$/.test(text)) return `${new Date(Number(text) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  if (/^\d{13}$/.test(text)) return `${new Date(Number(text)).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return `${new Date(parsed).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  return text;
}

// User input is echoed back only after every character that is not part of a
// plain identifier is stripped, so no path, tag or control sequence can ever be
// reflected into a chat message.
function safeEcho(value, limit = 40) {
  const filtered = cleanText(String(value ?? ''), limit * 2).replace(/[^A-Za-z0-9_.:@+-]/g, '').slice(0, limit);
  return filtered || 'that value';
}

function minutesLeft(session) {
  const ms = Number(session?.expiresAt || 0) - Date.now();
  return ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0;
}

// HTML is converted to plain text; script/style blocks are dropped and no tag
// or entity is ever executed or re-emitted as markup (§24).
function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex) => entityChar(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, decimal) => entityChar(parseInt(decimal, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function entityChar(code) {
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return ' ';
  const char = String.fromCodePoint(code);
  return /[<>]/.test(char) ? ' ' : char;
}

function htmlToText(html, limit = MAX_MESSAGE_BODY) {
  let text = String(html || '');
  text = text.replace(/<\s*(script|style|iframe|object|embed|svg|math|head)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
  text = text.replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?\s*>/gi, '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/<[^>]*>/g, ' ');
  text = text.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return cleanText(text, limit);
}

function bodyOf(message) {
  const text = cleanText(String(message?.text || ''), MAX_MESSAGE_BODY).trim();
  if (text) return text;
  return htmlToText(message?.html || '');
}

function mailboxCard(session, { created = true, prefix = '!', replaced = '' } = {}) {
  const lines = [created ? '*TEMPORARY MAILBOX READY* 📮' : '*ACTIVE MAILBOX* 📮', ''];
  lines.push(`📧 *Address:* ${session.email}`);
  lines.push(`🏷️ *Provider:* ${session.providerLabel}`);
  if (session.alias) lines.push(`🔖 *Alias:* ${cleanText(session.alias, 60)}`);
  if (session.domain) lines.push(`🌐 *Domain:* ${cleanText(session.domain, 60)}`);
  lines.push(`⌛ *Usable for:* about ${session.ttlMinutes} minutes`);
  // Replacing a mailbox must be visible: the old address is never used again.
  if (replaced) lines.push(`♻️ *Replaces:* ${cleanText(replaced, 60)} (released)`);
  lines.push('');
  lines.push(`*Inbox:* ${prefix}tempmail inbox   (or ${prefix}getmail)`);
  if (supports(session.providerId, 'message')) lines.push(`*Read:* ${prefix}tempmail read <message id>`);
  if (supports(session.providerId, 'delete')) lines.push(`*Delete:* ${prefix}tempmail delete`);
  if (supports(session.providerId, 'change')) lines.push(`*Change address:* ${prefix}tempmail change [name]`);
  if (supports(session.providerId, 'setuser')) lines.push(`*Set username:* ${prefix}tempmail setuser <name>`);
  lines.push('', '> Session credentials stay private.', `> ${FOOTER}`);
  return lines.join('\n');
}

function inboxText(result, session, prefix) {
  if (!result.messages.length) {
    return [
      '📭 *Inbox is empty.*',
      '',
      `No messages have arrived for ${session.email} yet.`,
      `*Provider:* ${result.provider}`,
      '',
      `*Check again:* ${prefix}tempmail inbox`,
      '',
      `> ${FOOTER}`
    ].join('\n');
  }
  const shown = result.messages.slice(0, MAX_LISTED_MESSAGES);
  const lines = [`*INBOX* 📬  (${result.messages.length} message${result.messages.length === 1 ? '' : 's'})`, '', `📧 ${session.email}  •  ${result.provider}`, ''];
  shown.forEach((message, index) => {
    lines.push(`${index + 1}. *From:* ${cleanText(message.from || 'Unknown sender', 60)}`);
    lines.push(`   *Subject:* ${cleanText(message.subject || 'No subject', MAX_SUBJECT_LENGTH)}`);
    const when = formatWhen(message.date);
    if (when) lines.push(`   *When:* ${when}`);
    if (message.id) lines.push(`   *Id:* ${cleanText(message.id, 60)}`);
    else if (message.intro) lines.push(`   *Preview:* ${cleanText(message.intro, 120)}`);
    lines.push('');
  });
  if (result.messages.length > shown.length) lines.push(`… and ${result.messages.length - shown.length} more.`, '');
  const readable = shown.find((message) => message.id);
  if (readable && supports(session.providerId, 'message')) {
    lines.push(`*Read one:* ${prefix}tempmail read ${cleanText(readable.id, 60)}`);
  } else if (!supports(session.providerId, 'message')) {
    lines.push('This provider exposes the inbox list only.');
  }
  lines.push('', `> ${FOOTER}`);
  return lines.join('\n');
}

function messageText(result, prefix) {
  const message = result.message;
  const body = bodyOf(message);
  const lines = ['*MESSAGE* ✉️', ''];
  lines.push(`*From:* ${cleanText(message.from || 'Unknown sender', 60)}`);
  lines.push(`*Subject:* ${cleanText(message.subject || 'No subject', MAX_SUBJECT_LENGTH)}`);
  const when = formatWhen(message.date);
  if (when) lines.push(`*When:* ${when}`);
  if (message.id) lines.push(`*Id:* ${cleanText(message.id, 60)}`);
  lines.push(`*Mailbox:* ${result.email}  •  ${result.provider}`);
  if (message.attachments) lines.push(`*Attachments:* ${message.attachments}`);
  lines.push('', body ? body : '(This message carries no readable text body.)');
  lines.push('', `*Back to inbox:* ${prefix}tempmail inbox`, '', `> ${FOOTER}`);
  const text = lines.join('\n');
  return text.length > 3800 ? `${text.slice(0, 3790)}…` : text;
}

function typesText(result, prefix) {
  if (!result.types.length) return `*ADDRESS TYPES* 🧾\n${result.provider} returned an empty type list.\n\n> ${FOOTER}`;
  const lines = ['*ADDRESS TYPES* 🧾', '', `*Provider:* ${result.provider}`, ''];
  result.types.slice(0, 20).forEach((type, index) => {
    const label = cleanText(type.label || type.id, 40);
    const code = cleanText(String(type.id || ''), 20);
    lines.push(`${index + 1}. *${label}*${code && code !== label ? `  (code ${code})` : ''}${type.isDefault ? '  • default' : ''}`);
    if (type.example) lines.push(`   e.g. ${cleanText(type.example, 60)}`);
    if (type.note) lines.push(`   ${cleanText(type.note, 90)}`);
  });
  lines.push('', 'Address-type metadata only — a mailbox is created with', `${prefix}tempmail create.`, '', `> ${FOOTER}`);
  return lines.join('\n');
}

function helpText(prefix, session) {
  const lines = ['*TEMP MAIL* 📮', ''];
  lines.push(`*Create:* ${prefix}tempmail create [provider]`);
  lines.push(`*Inbox:* ${prefix}tempmail inbox   (or ${prefix}getmail)`);
  lines.push(`*Read:* ${prefix}tempmail read <message id>`);
  lines.push(`*Delete:* ${prefix}tempmail delete  (Mail.tm, TempMail.io)`);
  lines.push(`*Change address:* ${prefix}tempmail change [domain]  (Temporary-Mail)`);
  lines.push(`*Set username:* ${prefix}tempmail setuser <name>  (Guerrilla Mail)`);
  lines.push(`*Address types:* ${prefix}tempmail types  (Temporary-Mail)`);
  lines.push(`*Active mailbox:* ${prefix}tempmail session`);
  lines.push('');
  lines.push(`*Providers:* ${PROVIDERS.map((provider) => provider.label).join(', ')}`);
  lines.push('');
  if (session && !session.expired) {
    lines.push(`*Active now:* ${session.email} (${session.providerLabel}, ${minutesLeft(session)} min left)`);
  } else {
    lines.push('*Active now:* none — create one with the command above.');
  }
  lines.push('', `> ${FOOTER}`);
  return lines.join('\n');
}

function refusalText(result, prefix) {
  if (result.busy) return `*TEMP MAIL* ⏳\nAnother mailbox request is still running. Please try again in a moment.\n\n> ${FOOTER}`;
  if (result.cooldownSeconds) return `*TEMP MAIL* ⏳\nPlease wait ${result.cooldownSeconds} second${result.cooldownSeconds === 1 ? '' : 's'} before the next ${result.operation || 'temp mail'} request.\n\n> ${FOOTER}`;
  if (result.noSession) {
    return [
      '*TEMP MAIL* 📭',
      'You do not have an active temporary mailbox in this chat.',
      '',
      `*Create one:* ${prefix}tempmail create`,
      `*Providers:* ${PROVIDERS.map((provider) => provider.label).join(', ')}`,
      '',
      `> ${FOOTER}`
    ].join('\n');
  }
  if (result.expired) {
    return [
      '*TEMP MAIL* ⌛',
      `Your ${result.providerLabel || 'temporary'} mailbox${result.email ? ` ${result.email}` : ''} has expired.`,
      '',
      `*Create a new one:* ${prefix}tempmail create`,
      '',
      `> ${FOOTER}`
    ].join('\n');
  }
  const lines = ['*TEMP MAIL* ❌', cleanText(String(result.reason || 'That request could not be completed.'), 220)];
  if (result.operation === 'create' && Array.isArray(result.attempts) && result.attempts.length) {
    lines.push('', 'Providers tried:');
    for (const attempt of result.attempts.slice(0, 5)) lines.push(`• ${attempt.provider} — ${cleanText(String(attempt.reason || 'no mailbox returned'), 90)}`);
    lines.push('', `Please try again in a moment${prefix ? '' : ''}.`);
  } else if (result.noSession !== true) {
    lines.push('', `*Help:* ${prefix}tempmail`);
  }
  lines.push('', `> ${FOOTER}`);
  return lines.join('\n');
}

// ── command router ─────────────────────────────────────────────────────────

const SUBCOMMANDS = Object.freeze({
  create: ['create', 'new', 'make', 'generate', 'start'],
  inbox: ['inbox', 'mail', 'mails', 'messages', 'check', 'list'],
  read: ['read', 'open', 'message', 'msg', 'view'],
  delete: ['delete', 'destroy', 'remove', 'close'],
  change: ['change', 'rotate', 'next'],
  setuser: ['setuser', 'setusername', 'user', 'username', 'rename'],
  types: ['types', 'type', 'domains', 'kinds'],
  session: ['session', 'status', 'info', 'mine', 'active'],
  help: ['help', 'providers', 'provider', 'options', 'menu', 'commands']
});

function resolveSubcommand(token) {
  const key = String(token || '').trim().toLowerCase();
  if (!key) return 'help';
  for (const [action, names] of Object.entries(SUBCOMMANDS)) if (names.includes(key)) return action;
  return '';
}

async function runGuarded(context, reply, kind, cooldownMs, task, prefix = '!') {
  const key = sessionKey(context);
  const gate = actionGateStatus(key);
  if (gate.busy) return reply(refusalText({ ...gate, operation: kind }, prefix));
  const reservation = reserveAction(key, kind, cooldownMs);
  if (!reservation.ok) {
    return reply(refusalText({ busy: false, cooldownSeconds: reservation.waitSeconds, operation: kind }, prefix));
  }
  callsInFlight += 1;
  try {
    return await task();
  } finally {
    callsInFlight -= 1;
  }
}

async function handleTempMailCommand(socket, context, command, deps = {}) {
  const prefix = deps.prefix || '!';
  const reply = (text) => socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
  try {
    const tokens = String(command?.text || '').trim().split(/\s+/).filter(Boolean);
    const first = tokens[0] || '';
    const action = resolveSubcommand(first);
    const rest = tokens.slice(1);
    const session = getSession(context);

    if (!action) {
      // `!tempmail guerrilla` is a shortcut for creating on that provider.
      const pinned = resolveProviderKeyword(first);
      if (pinned) return await runCreate({ pinned: pinned.id });
      await reply(`*TEMP MAIL* ❓\n"${safeEcho(first, 30)}" is not a temp mail action.\n\n${helpText(prefix, session)}`);
      return;
    }

    if (action === 'help') {
      await reply(helpText(prefix, session));
      return;
    }

    if (action === 'create') return await runCreate({ pinned: resolveProviderKeyword(rest[0])?.id || '' });

    if (action === 'types') {
      return await runGuarded(context, reply, 'action', ACTION_COOLDOWN_MS, async () => {
        const result = await listTypes();
        await reply(result.success ? typesText(result, prefix) : refusalText({ ...result, operation: 'types' }, prefix));
      }, prefix);
    }

    if (action === 'session') {
      if (!session) return await reply(refusalText({ noSession: true }, prefix));
      if (session.expired) return await reply(refusalText(session, prefix));
      await reply(mailboxCard(session, { created: false, prefix }));
      return;
    }

    // Every remaining action needs the caller's own mailbox (§17, §21).
    if (!session) return await reply(refusalText({ noSession: true, operation: action }, prefix));
    if (session.expired) {
      clearSession(context);
      return await reply(refusalText(session, prefix));
    }

    if (action === 'inbox') {
      return await runGuarded(context, reply, 'inbox', INBOX_COOLDOWN_MS, async () => {
        const result = await checkInbox(session);
        if (!result.success) return await reply(refusalText(result, prefix));
        rememberMessages(session, result.messages);
        await reply(inboxText(result, session, prefix));
      }, prefix);
    }

    if (action === 'read') return await runRead(rest);

    if (action === 'delete') {
      return await runGuarded(context, reply, 'action', ACTION_COOLDOWN_MS, async () => {
        const result = await deleteMailbox(session);
        if (!result.success) {
          if (result.unsupported) {
            clearSession(context);
            return await reply(`*TEMP MAIL* 🗑️\n${result.reason}\nYour local session was cleared.\n\n> ${FOOTER}`);
          }
          return await reply(refusalText(result, prefix));
        }
        // §26: a deleted mailbox is never used again.
        clearSession(context);
        await reply([
          '*TEMP MAIL DELETED* 🗑️',
          '',
          `📧 ${result.email}`,
          `🏷️ ${result.provider}`,
          result.alreadyGone ? 'The provider reported this address is already gone.' : 'The provider confirmed the deletion.',
          '',
          'The local session and its credentials were cleared.',
          `*Create another:* ${prefix}tempmail create`,
          '',
          `> ${FOOTER}`
        ].join('\n'));
      }, prefix);
    }

    if (action === 'change') {
      const rawRequested = String(rest.join(' ')).trim();
      const requested = cleanText(rawRequested, MAX_USERNAME_LENGTH).replace(/^@+/, '');
      if (requested && (rawRequested.length > MAX_USERNAME_LENGTH || !USERNAME_PATTERN.test(requested))) {
        return await reply(`*TEMP MAIL* ❓\n"${safeEcho(rawRequested)}" cannot be used as an address name.\nUse 2–40 characters: letters, numbers, dot, dash or underscore.\n\n> ${FOOTER}`);
      }
      return await runGuarded(context, reply, 'action', ACTION_COOLDOWN_MS, async () => {
        const result = await changeAddress(session, requested);
        if (!result.success) {
          if (result.unsupported) return await reply(`*TEMP MAIL* 🔁\n${result.reason}\n\n> ${FOOTER}`);
          return await reply(refusalText(result, prefix));
        }
        if (result.mailbox) {
          saveSession(context, result.mailbox);
          return await reply(mailboxCard(result.mailbox, { created: false, prefix }));
        }
        await reply(`*TEMP MAIL* 🔁\n${result.provider} accepted the change.\n📧 ${session.email}\n${result.note ? `\n${result.note}` : ''}\n\n> ${FOOTER}`);
      }, prefix);
    }

    if (action === 'setuser') {
      const rawUsername = String(rest.join(' ')).trim();
      const username = cleanText(rawUsername, MAX_USERNAME_LENGTH).replace(/^@+/, '');
      if (!username) {
        return await reply(`*TEMP MAIL* ✍️\nAdd the username to request.\n\n*Usage:* ${prefix}tempmail setuser <name>\n*Example:* ${prefix}tempmail setuser animemd\n\n> ${FOOTER}`);
      }
      if (rawUsername.length > MAX_USERNAME_LENGTH || !USERNAME_PATTERN.test(username)) {
        return await reply(`*TEMP MAIL* ❓\n"${safeEcho(rawUsername)}" cannot be used as a username.\nUse 2–40 characters: letters, numbers, dot, dash or underscore.\n\n> ${FOOTER}`);
      }
      return await runGuarded(context, reply, 'action', ACTION_COOLDOWN_MS, async () => {
        const result = await setUsername(session, username);
        if (!result.success) {
          if (result.unsupported) return await reply(`*TEMP MAIL* 👤\n${result.reason}\n\n> ${FOOTER}`);
          return await reply(refusalText(result, prefix));
        }
        if (result.mailbox) {
          saveSession(context, result.mailbox);
          return await reply(mailboxCard(result.mailbox, { created: false, prefix }));
        }
        await reply(`*TEMP MAIL* 👤\n${result.provider} accepted the username request for ${session.email}.\n${result.note ? `\n${result.note}\n` : ''}\n*Inbox:* ${prefix}tempmail inbox\n\n> ${FOOTER}`);
      }, prefix);
    }

    await reply(helpText(prefix, session));

    // ── inner helpers (share the guard, the reply channel and the session) ──

    async function runCreate({ pinned }) {
      if (pinned && !supports(pinned, 'create')) {
        return await reply(`*TEMP MAIL* ❓\n${PROVIDER_BY_ID[pinned]?.label || pinned} does not offer mailbox creation.\n\n${helpText(prefix, session)}`);
      }
      return await runGuarded(context, reply, 'create', CREATE_COOLDOWN_MS, async () => {
        const previous = session && !session.expired ? session : null;
        await reply(`📮 *Creating a temporary mailbox…*${pinned ? ` (${PROVIDER_BY_ID[pinned].label})` : ''}\n\n> ${FOOTER}`);
        const result = await createMailbox({ providerId: pinned });
        if (!result.success) return await reply(refusalText(result, prefix));
        const stored = saveSession(context, result.mailbox);
        await reply(mailboxCard(stored, { created: true, prefix, replaced: previous && previous.email !== stored.email ? previous.email : '' }));
      }, prefix);
    }

    async function runRead(args) {
      const rawId = cleanText(args.join(' '), 120);
      if (!rawId) {
        return await reply(`*TEMP MAIL* ✍️\nAdd the message id from the inbox list.\n\n*Usage:* ${prefix}tempmail read <message id>\n*Example:* ${prefix}tempmail read 12345\n\n> ${FOOTER}`);
      }
      if (String(args.join(' ')).trim().length > 120 || !MESSAGE_ID_PATTERN.test(rawId)) {
        return await reply(`*TEMP MAIL* ❓\n"${safeEcho(rawId)}" is not a message id from this mailbox.\n\n*List ids:* ${prefix}tempmail inbox\n\n> ${FOOTER}`);
      }
      // §25: an id must belong to THIS provider's mailbox — never replayed to a
      // different provider's message endpoint.
      if (session.knownIds?.size && !session.knownIds.has(rawId)) {
        return await reply(`*TEMP MAIL* 🔎\nThat id is not in this mailbox's inbox list (${session.providerLabel}).\n\n*Refresh the list:* ${prefix}tempmail inbox\n\n> ${FOOTER}`);
      }
      if (!supports(session.providerId, 'message')) {
        const cached = (session.lastMessages || []).find((message) => message.id === rawId);
        return await reply([
          '*TEMP MAIL* ✉️',
          `${session.providerLabel} exposes the inbox list only, so this is everything it returned:`,
          '',
          `*From:* ${cleanText(cached?.from || 'Unknown sender', 60)}`,
          `*Subject:* ${cleanText(cached?.subject || 'No subject', MAX_SUBJECT_LENGTH)}`,
          cached?.intro ? `*Preview:* ${cleanText(cached.intro, 300)}` : '',
          '',
          `> ${FOOTER}`
        ].filter(Boolean).join('\n'));
      }
      return await runGuarded(context, reply, 'action', ACTION_COOLDOWN_MS, async () => {
        const result = await readMessage(session, rawId);
        await reply(result.success ? messageText(result, prefix) : refusalText(result, prefix));
      }, prefix);
    }
  } catch (error) {
    // A temp mail provider must never be able to take the bot down with it.
    console.warn('[tempmail] command guard:', cleanText(String(error?.message || error), 160).replace(/[\r\n]+/g, ' '));
    await reply(`*TEMP MAIL* ❌\nThat request could not be completed. Please try again.\n\n> ${FOOTER}`).catch(() => {});
  }
}

// `!getmail` keeps its registered name: with no argument it checks the active
// mailbox inbox, with an id it reads that message.
async function handleGetMailCommand(socket, context, command, deps = {}) {
  const prefix = deps.prefix || '!';
  const tokens = String(command?.text || '').trim().split(/\s+/).filter(Boolean);
  const sub = tokens.length ? (MESSAGE_ID_PATTERN.test(tokens[0]) ? `read ${tokens.join(' ')}` : 'inbox') : 'inbox';
  return handleTempMailCommand(socket, context, { ...command, text: sub }, deps);
}

// Test/inspection surface — no secrets, only counts and labels.
function inspectSessions() {
  return [...sessions.entries()].map(([key, session]) => ({
    key: key.replace(/@.*/, '@…'),
    provider: session.providerLabel,
    email: session.email,
    minutesLeft: minutesLeft(session),
    knownIds: session.knownIds?.size || 0
  }));
}

module.exports = {
  PROVIDERS,
  CREATE_ORDER,
  OPERATIONS: Object.freeze(['create', 'inbox', 'message', 'delete', 'change', 'setuser', 'types']),
  supports,
  resolveProviderKeyword,
  providerList,
  createMailbox,
  checkInbox,
  readMessage,
  deleteMailbox,
  changeAddress,
  setUsername,
  listTypes,
  getSession,
  saveSession,
  clearSession,
  inspectSessions,
  htmlToText,
  formatWhen,
  handleTempMailCommand,
  handleGetMailCommand
};
