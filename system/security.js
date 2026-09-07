'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const PROTECTED_SECURITY_ENVIRONMENT_KEYS = Object.freeze([
  'GLOBAL_OWNER', 'GLOBAL_OWNER_NUMBER', 'GLOBAL_OWNER_NUMBERS',
  'DEVELOPER_IDENTITY', 'DEVELOPER_NUMBER', 'DEVELOPER_NUMBERS',
  'OWNER_NUMBER', 'OWNER_NUMBERS'
]);

// Canonical project identity source of truth
const CANONICAL_IDENTITY = Object.freeze({
  projectName: 'ANIME MD',
  organization: 'GOATS MODS',
  developer: 'Only F!xa Dev',
  author: 'RaShiD Hussain',
  repository: 'earnwithrashid4913/Bug-',
  identityVersion: '1.0.0'
});

// These names are project identity, not deployment configuration. Authorization
// numbers, when needed, live in a maintainer-provisioned signed manifest outside
// the repository; no secret or owner number is shipped in source.
const PROTECTED_DEVELOPER = Object.freeze({
  brand: CANONICAL_IDENTITY.developer,
  name: CANONICAL_IDENTITY.author,
  community: CANONICAL_IDENTITY.organization
});

function verifyCanonicalIdentity() {
  const isIntact =
    CANONICAL_IDENTITY.projectName === 'ANIME MD' &&
    CANONICAL_IDENTITY.organization === 'GOATS MODS' &&
    CANONICAL_IDENTITY.developer === 'Only F!xa Dev' &&
    CANONICAL_IDENTITY.author === 'RaShiD Hussain';

  if (!isIntact) {
    console.error('[security] Canonical identity verification failed: metadata altered; privileged functions locked.');
    return false;
  }
  return true;
}

function normalizeIdentity(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/:\d+@/, '@');
  if (!trimmed) return undefined;
  if (trimmed.endsWith('@lid')) return trimmed.toLowerCase();
  const number = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed.replace(/\D/g, '');
  return /^\d{7,15}$/.test(number) ? `${number}@s.whatsapp.net` : undefined;
}

function canonicalManifest(manifest) {
  return JSON.stringify({
    developer: manifest.developer || {},
    globalOwnerNumbers: [...(manifest.globalOwnerNumbers || [])].map(String).sort(),
    developerNumbers: [...(manifest.developerNumbers || [])].map(String).sort()
  });
}

function verifyIdentityManifest(manifest, secret) {
  if (!manifest || typeof manifest !== 'object' || typeof manifest.signature !== 'string' || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(canonicalManifest(manifest)).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(manifest.signature, 'hex'));
  } catch {
    return false;
  }
}

function loadProtectedIdentity(environment = process.env) {
  if (!verifyCanonicalIdentity()) {
    return Object.freeze({ locked: true, globalOwners: new Set(), developers: new Set() });
  }

  const file = environment.ANIME_MD_TRUSTED_IDENTITY_FILE;
  const secret = environment.ANIME_MD_TRUSTED_IDENTITY_HMAC_KEY;
  // A release without external authorization numbers is valid: it has no global
  // owner grants. Supplying either trust input requires a complete valid pair.
  if (!file && !secret) return Object.freeze({ locked: false, globalOwners: new Set(), developers: new Set() });
  if (!file || !secret) return Object.freeze({ locked: true, globalOwners: new Set(), developers: new Set() });

  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!verifyIdentityManifest(manifest, secret) || JSON.stringify(manifest.developer) !== JSON.stringify(PROTECTED_DEVELOPER)) {
      throw new Error('invalid protected identity');
    }
    const numbers = (values) => new Set((values || []).map(normalizeIdentity).filter(Boolean));
    return Object.freeze({ locked: false, globalOwners: numbers(manifest.globalOwnerNumbers), developers: numbers(manifest.developerNumbers) });
  } catch {
    // Do not disclose identity material, repair manifests, or touch sessions.
    console.error('[security] Protected identity verification failed; privileged functions are locked.');
    return Object.freeze({ locked: true, globalOwners: new Set(), developers: new Set() });
  }
}

function assertProtectedSecurityEnvironment(environment = process.env) {
  const attemptedOverrides = PROTECTED_SECURITY_ENVIRONMENT_KEYS.filter((name) => String(environment[name] || '').trim());
  if (attemptedOverrides.length) {
    throw new Error('Security configuration error: protected identity overrides are not allowed.');
  }
}

let protectedIdentity = loadProtectedIdentity();

function refreshProtectedIdentity(environment = process.env) {
  protectedIdentity = loadProtectedIdentity(environment);
  return protectedIdentity;
}

function resolveJid(socket, jid) {
  return normalizeIdentity(typeof socket?.decodeJid === 'function' ? socket.decodeJid(jid) : jid);
}

function isGlobalOwner(socket, sender) {
  return !protectedIdentity.locked && protectedIdentity.globalOwners.has(resolveJid(socket, sender));
}

function isDeveloper(socket, sender) {
  return !protectedIdentity.locked && protectedIdentity.developers.has(resolveJid(socket, sender));
}

function isInstanceOwner(socket, sender, instanceOwnerNumber) {
  const owner = normalizeIdentity(instanceOwnerNumber);
  return Boolean(owner && resolveJid(socket, sender) === owner);
}

function isAuthorizedAdmin(socket, sender, instanceOwnerNumber) {
  return !protectedIdentity.locked && (isGlobalOwner(socket, sender) || isDeveloper(socket, sender) || isInstanceOwner(socket, sender, instanceOwnerNumber));
}

function isPremiumAuthorized(socket, sender, instanceOwnerNumber) {
  return isAuthorizedAdmin(socket, sender, instanceOwnerNumber);
}

function protectedGlobalOwnerJids() {
  return new Set(protectedIdentity.globalOwners);
}

module.exports = {
  CANONICAL_IDENTITY,
  PROTECTED_DEVELOPER,
  assertProtectedSecurityEnvironment,
  isAuthorizedAdmin,
  isDeveloper,
  isGlobalOwner,
  isInstanceOwner,
  isPremiumAuthorized,
  loadProtectedIdentity,
  normalizeIdentity,
  protectedGlobalOwnerJids,
  refreshProtectedIdentity,
  verifyCanonicalIdentity,
  verifyIdentityManifest
};
