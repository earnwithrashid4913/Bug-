'use strict';

// =============================================================================
// EXECUTEAFTER — ADAPTER provider_01
// =============================================================================
// Independent adapter for slot provider_01 (config key: execute-after.config.js →
// EXECUTE_AFTER_PROVIDERS.provider_01).
//
// This file is OPTIONAL. It exists so provider_01 can have provider-specific parsing
// without touching any other provider or any AnimeMD file.
//
// You do NOT need to edit this file to go live. Doing nothing here is correct:
//   1. open execute-after.config.js
//   2. provider_01 → command:  'Exec1'          (CHANGE COMMAND NAME HERE)
//   3. provider_01 → endpoint: 'https://...'      (PUT YOUR PERMITTED API ENDPOINT HERE)
//   4. provider_01 → modes / queryParam / contract  (only what your API documents)
//
// Only replace parseProviderResponse() below when provider_01 returns a structure
// the declared contract cannot describe (a nested array of qualities, a base64
// encoded link, several servers per item, ...). The function receives the raw
// JSON payload and must return the framework parser result shape:
//
//   { results: [ ... ], listPath, discovered, total, skipped, blocked }
//
// or a plain array of items, which the framework normalizes for you.
// =============================================================================

const { createAdapter } = require('./base-adapter');
const { parseProviderResponse: frameworkParser } = require('../parser');

/**
 * provider_01 — PROVIDER-SPECIFIC PARSER (UNRESOLVED until you inspect the real API).
 *
 * This is deliberately NOT a guess about an unknown API: it delegates to the
 * framework parser, which uses the contract you declare in
 * execute-after.config.js and never invents a field.
 */
function parseProviderResponse(data, context) {
  // Example of a provider-specific override (keep it here, not in the core):
  //   if (context.mode === 'search' && Array.isArray(data?.custom?.hits)) {
  //     const items = data.custom.hits.map((hit) => ({ id: hit.key, title: hit.label, streamUrl: hit.file }));
  //     return { results: items, listPath: 'custom.hits', discovered: false };
  //   }
  return frameworkParser(data, context);
}

module.exports = createAdapter({
  id: 'provider_01',
  slotIndex: 0,
  notes: 'PUT YOUR PERMITTED API ENDPOINT + RESPONSE CONTRACT in execute-after.config.js; inspect the real response before setting contract.verified to true.',
  parseProviderResponse
});
