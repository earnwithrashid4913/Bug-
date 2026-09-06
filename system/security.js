'use strict';

/*
 * This policy is deliberately source-controlled rather than environment-controlled.
 * Project maintainers may set protected Global Owner numbers only in a reviewed,
 * signed release. A public deployment must not be able to replace this policy by
 * changing normal instance configuration.
 */
const PROTECTED_GLOBAL_OWNER_NUMBERS = Object.freeze([]);
const PROTECTED_SECURITY_ENVIRONMENT_KEYS = Object.freeze([
  'GLOBAL_OWNER_NUMBER',
  'GLOBAL_OWNER_NUMBERS',
  'OWNER_NUMBER',
  'OWNER_NUMBERS'
]);

function assertProtectedSecurityEnvironment(environment = process.env) {
  const attemptedOverrides = PROTECTED_SECURITY_ENVIRONMENT_KEYS.filter((name) => {
    const value = environment[name];
    return typeof value === 'string' && value.trim() !== '';
  });

  if (attemptedOverrides.length) {
    throw new Error(
      `Security configuration error: ${attemptedOverrides.join(', ')} cannot configure Global Owner authorization. ` +
      'Use BOT_CONNECTION_NUMBER and BOT_OWNER_NAME for this deployment instead.'
    );
  }
}

function protectedGlobalOwnerJids() {
  return new Set(PROTECTED_GLOBAL_OWNER_NUMBERS.map((number) => `${number}@s.whatsapp.net`));
}

function isProtectedGlobalOwner(socket, jid) {
  const normalized = typeof socket.decodeJid === 'function' ? socket.decodeJid(jid) : jid?.replace(/:\d+@/, '@');
  return protectedGlobalOwnerJids().has(normalized);
}

module.exports = {
  assertProtectedSecurityEnvironment,
  isProtectedGlobalOwner,
  protectedGlobalOwnerJids
};
