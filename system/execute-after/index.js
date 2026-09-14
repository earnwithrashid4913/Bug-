'use strict';

// =============================================================================
// EXECUTEAFTER — FRAMEWORK ENTRY
// =============================================================================
// Public façade of the ExecuteAfter provider framework. AnimeMD only needs two
// touch points (both marked in system/lib/menu.js and system/handler.js):
//
//   menu.js     → registry.registerInto(menu)     (one bridge block)
//   handler.js  → router.owns(name) / router.dispatch(...)  (one route branch)
//
// Everything else lives inside this folder, so the framework can be removed
// again by deleting:
//
//   system/execute-after/
//   execute-after.config.js
//   the two marked bridge blocks
//   test/execute-after*.test.js
// =============================================================================

const registry = require('./registry');
const router = require('./router');
const mediaEngine = require('./media-engine');
const { loadAdapter, listAdapters, adapterFileCount } = require('./adapters');
const { usageLine, supportedModes, MODE_NAMES } = require('./context');
const { ERROR_CODES, ExecuteAfterError, toExecuteAfterError } = require('./errors');

function owns(name) {
  return router.owns(name);
}

function dispatch(socket, context, command, deps) {
  return router.dispatch(socket, context, command, deps);
}

/**
 * Machine-readable audit of the whole framework. Used by the test suite, the
 * registry check script and the final report.
 */
function audit() {
  const slots = registry.slots.map((slot) => ({
    adapter: slot.adapter ? (slot.adapter.generated ? 'GENERATED' : 'FILE') : 'MISSING',
    command: slot.command,
    commandDisplay: slot.commandDisplay,
    configKey: slot.configKey,
    contractVerified: slot.config.contract.verified,
    endpointConfigured: Boolean(slot.config.endpoint),
    hidden: (slot.menuHidden ?? slot.hidden) === true,
    id: slot.id,
    modes: supportedModes({ modes: slot.modes }),
    registered: slot.registered,
    reason: slot.reason,
    status: slot.status
  }));
  const counters = registry.stats();
  return {
    adapters: slots.filter((slot) => slot.adapter !== 'MISSING').length,
    adapterFiles: adapterFileCount(),
    commands: slots.filter((slot) => slot.registered).length,
    configFile: registry.CONFIG_FILE,
    enabled: registry.framework.enabled,
    framework: registry.framework,
    providers: slots.length,
    registryEntries: registry.entries().length,
    slots,
    stats: counters,
    statuses: {
      DISABLED: counters.DISABLED || 0,
      READY: counters.READY || 0,
      UNRESOLVED: counters.UNRESOLVED || 0,
      UNVERIFIED: counters.UNVERIFIED || 0
    },
    unusedModes: MODE_NAMES.filter((mode) => mode !== 'auto')
  };
}

module.exports = {
  ERROR_CODES,
  ExecuteAfterError,
  MODE_NAMES,
  adapterFileCount,
  audit,
  dispatch,
  framework: registry.framework,
  listAdapters,
  loadAdapter,
  mediaEngine,
  owns,
  registry,
  router,
  stats: router.stats,
  supportedModes,
  toExecuteAfterError,
  usageLine
};
