'use strict';

// ---------------------------------------------------------------------------
// Session (SESSION_ID) handling — migrated from the reference bot.
//
// Cloud hosts with an ephemeral filesystem lose `session/` on every deploy, so
// the credentials are supplied through the `SESSION_ID` environment variable
// and written to `AUTH_DIR/creds.json` before Baileys starts. The dashboard can
// also hand the SESSION_ID back after a successful pairing so it can be pasted
// into the host's environment (that is the reference bot's pairing-web flow,
// kept inside this project instead of an external site).
//
// Credentials never leave this module in plain text: they are never logged.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const CREDS_FILE = 'creds.json';

// A parsed creds.json always carries at least one of these keys.
const CREDS_MARKERS = ['noiseKey', 'signedIdentityKey', 'signedPreKey', 'registrationId', 'me'];

const SESSION_ID_HINT =
  'SESSION_ID must be the contents of creds.json: raw JSON or its base64 form, optionally prefixed like "MYBOT~~<base64>".';

class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionError';
  }
}

function isCredsObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && CREDS_MARKERS.some((marker) => value[marker] !== undefined);
}

function decodeBase64Json(text) {
  const cleaned = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=_-]+$/.test(cleaned)) return undefined;

  try {
    const json = Buffer.from(cleaned.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return isCredsObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalizes a SESSION_ID value into a credentials object.
 * Accepts raw JSON, base64 JSON, and "<prefix>~~<base64>" wrapper forms.
 */
function parseSessionId(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new SessionError(`SESSION_ID is empty. ${SESSION_ID_HINT}`);

  // "<anything>~~<payload>" is the common copy/paste form produced by pairing sites.
  const wrapped = value.includes('~~') ? value.slice(value.indexOf('~~') + 2).trim() : value;

  if (wrapped.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(wrapped);
    } catch (error) {
      throw new SessionError(`SESSION_ID is not valid JSON (${error.message}). ${SESSION_ID_HINT}`);
    }
    if (!isCredsObject(parsed)) {
      throw new SessionError(`SESSION_ID does not look like WhatsApp credentials. ${SESSION_ID_HINT}`);
    }
    return parsed;
  }

  const decoded = decodeBase64Json(wrapped) || decodeBase64Json(value);
  if (decoded) return decoded;

  throw new SessionError(`SESSION_ID could not be decoded. ${SESSION_ID_HINT}`);
}

function credsPath(authDir) {
  return path.join(authDir, CREDS_FILE);
}

function hasSession(authDir) {
  try {
    return fs.statSync(credsPath(authDir)).isFile();
  } catch {
    return false;
  }
}

/**
 * Writes SESSION_ID to AUTH_DIR/creds.json when the session is missing.
 * Returns a status string for logging (never the credentials themselves).
 */
function prepareSession({ authDir, sessionId, overwrite = false, log = console.log }) {
  const target = credsPath(authDir);

  if (hasSession(authDir) && !overwrite) {
    return 'existing';
  }
  if (!sessionId) {
    return hasSession(authDir) ? 'existing' : 'empty';
  }

  const creds = parseSessionId(sessionId);

  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const tempPath = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, target);

  log(`[session] Wrote credentials from SESSION_ID to ${target}`);
  return overwrite ? 'overwritten' : 'created';
}

/**
 * Reads the stored credentials back as a SESSION_ID string (raw JSON) so the
 * owner can move a paired session to another host. Returns null when there is
 * no session or it cannot be read.
 */
function readSessionId(authDir) {
  try {
    const raw = fs.readFileSync(credsPath(authDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!isCredsObject(parsed)) return null;
    // Re-serialize so a compact, portable string is always returned.
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

module.exports = {
  CREDS_FILE,
  SESSION_ID_HINT,
  SessionError,
  credsPath,
  hasSession,
  isCredsObject,
  parseSessionId,
  prepareSession,
  readSessionId
};
