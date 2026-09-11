'use strict';

// ---------------------------------------------------------------------------
// Test-only preload, injected into every process with NODE_OPTIONS.
//
// It forces the ANIME MD worker to exit immediately so the REAL supervisor in
// index.js can be exercised against a crash loop without needing WhatsApp,
// Telegram or network access. The supervisor code itself is never stubbed.
// ---------------------------------------------------------------------------

if (process.argv.includes('--child')) {
  setImmediate(() => process.exit(3));
}
