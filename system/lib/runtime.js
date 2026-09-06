'use strict';

// Process-level restart helper.
//
// When the bot runs under its own supervisor (see index.js) the parent respawns
// it immediately; otherwise the process exits and the host's restart policy
// brings it back.

function isSupervised() {
  return typeof process.send === 'function';
}

function requestRestart() {
  if (isSupervised()) {
    try {
      process.send({ type: 'reset' });
      return 'supervisor';
    } catch {
      /* fall through to a plain exit */
    }
  }

  setTimeout(() => process.exit(0), 250).unref();
  return 'exit';
}

module.exports = { isSupervised, requestRestart };
