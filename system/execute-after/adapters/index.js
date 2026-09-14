'use strict';

// =============================================================================
// EXECUTEAFTER — ADAPTER LOADER
// =============================================================================
// One adapter instance per provider slot, loaded by internal id:
//
//   provider_01 → adapters/provider_01.js
//   provider_02 → adapters/provider_02.js
//   provider_03 → adapters/provider_03.js
//   provider_04 → adapters/provider_04.js
//   provider_05.. (no file) → GENERATED adapter with the same interface
//
// Because a slot without a file still gets its own independent adapter object,
// the number of adapters always equals the number of configured providers and a
// broken adapter file can never take another provider (or AnimeMD) down.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { createGeneratedAdapter } = require('./base-adapter');

const cache = new Map();
const loadErrors = new Map();

function adapterPath(slotId) {
  return path.join(__dirname, `${slotId}.js`);
}

function loadAdapter(slotId, { slotIndex = 0 } = {}) {
  if (cache.has(slotId)) return cache.get(slotId);
  let adapter = null;
  const file = adapterPath(slotId);
  if (fs.existsSync(file)) {
    try {
      // eslint-disable-next-line global-require
      adapter = require(file);
    } catch (error) {
      loadErrors.set(slotId, error?.message || String(error));
      console.warn(`[execute-after:${slotId}] adapter file failed to load — using the generated adapter instead: ${error?.message || error}`);
      adapter = null;
    }
  }
  if (!adapter || typeof adapter.execute !== 'function') {
    if (!adapter && !loadErrors.has(slotId)) loadErrors.set(slotId, 'no adapter file (generated adapter in use)');
    adapter = createGeneratedAdapter(slotId, slotIndex);
  }
  cache.set(slotId, adapter);
  return adapter;
}

function listAdapters() {
  return [...cache.values()].map((adapter) => ({ generated: adapter.generated === true, id: adapter.id, notes: adapter.notes || '' }));
}

function adapterFileCount() {
  try {
    return fs.readdirSync(__dirname).filter((file) => /^provider_\d+\.js$/.test(file)).length;
  } catch {
    return 0;
  }
}

function adapterLoadErrors() {
  return Object.fromEntries(loadErrors);
}

module.exports = { adapterFileCount, adapterLoadErrors, adapterPath, listAdapters, loadAdapter };
