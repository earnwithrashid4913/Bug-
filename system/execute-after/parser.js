'use strict';

// =============================================================================
// EXECUTEAFTER — PROVIDER RESPONSE PARSER
// =============================================================================
// Two layers, in this order:
//
//   1. YOUR CONTRACT (execute-after.config.js → contract.listPath / fields)
//      Exact dot paths. When you know your API, declare the paths and nothing
//      else is consulted.
//
//   2. DOCUMENTED DISCOVERY (framework.discovery.enabled)
//      A bounded, deterministic search for the result array and for the
//      first numeric total. This is a discovery table, not a provider claim:
//      every discovered item is still passed through normalize.js, so a field
//      that does not exist stays null.
//
// Adapters may override either layer with their own parseProviderResponse()
// (see system/execute-after/adapters/provider_01.js).
// =============================================================================

const { isPlainObject, isEmptyResult, normalizeResult, readPath } = require('./normalize');
const { assertAllowed } = require('./policy');
const { ERROR_CODES, ExecuteAfterError } = require('./errors');

const LIST_KEY_PRIORITY = [
  'results', 'result', 'items', 'item', 'data', 'videos', 'video', 'list', 'entries',
  'rows', 'docs', 'records', 'content', 'response', 'payload', 'hits', 'medias', 'media', 'files'
];
const TOTAL_KEYS = ['total', 'totalResults', 'total_results', 'totalCount', 'total_count', 'count', 'resultCount', 'found'];

function rankListKey(key) {
  const index = LIST_KEY_PRIORITY.indexOf(String(key || '').toLowerCase());
  return index === -1 ? LIST_KEY_PRIORITY.length : index;
}

// Deterministic breadth-first search for the most likely result array.
function discoverList(data, { maxDepth = 4, maxArrayScan = 40 } = {}) {
  const queue = [{ value: data, path: '', depth: 0 }];
  const candidates = [];
  const seen = new Set();
  let scanned = 0;
  while (queue.length && scanned < maxArrayScan) {
    const node = queue.shift();
    if (node.value === null || node.value === undefined) continue;
    if (typeof node.value !== 'object') continue;
    if (seen.has(node.value)) continue;
    seen.add(node.value);
    if (Array.isArray(node.value)) {
      scanned += 1;
      const usable = node.value.filter((entry) => isPlainObject(entry) || typeof entry === 'string');
      if (usable.length) {
        const key = node.path.split('.').pop() || '';
        candidates.push({ array: usable, path: node.path, score: rankListKey(key) * 100 - Math.min(99, usable.length) });
      }
      continue;
    }
    if (node.depth >= maxDepth) continue;
    for (const [key, value] of Object.entries(node.value)) {
      if (value === null || value === undefined) continue;
      if (typeof value !== 'object') continue;
      queue.push({ value, path: node.path ? `${node.path}.${key}` : key, depth: node.depth + 1 });
    }
  }
  if (!candidates.length) return { array: [], path: '', discovered: true };
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  return { array: best.array, path: best.path, discovered: true };
}

function discoverTotal(data, { maxDepth = 3 } = {}) {
  if (!isPlainObject(data)) return null;
  const queue = [{ value: data, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!isPlainObject(node.value) || seen.has(node.value)) continue;
    seen.add(node.value);
    for (const [key, value] of Object.entries(node.value)) {
      if (TOTAL_KEYS.includes(key) && (typeof value === 'number' || /^\d+$/.test(String(value)))) {
        const total = Number(value);
        if (Number.isFinite(total)) return total;
      }
    }
    if (node.depth >= maxDepth) continue;
    for (const value of Object.values(node.value)) {
      if (isPlainObject(value)) queue.push({ value, depth: node.depth + 1 });
    }
  }
  return null;
}

/**
 * Resolves the result array of a provider payload.
 * Returns { items, listPath, discovered, total }.
 */
function extractItems(data, { contract = {}, discovery = {} } = {}) {
  const options = {
    maxDepth: Math.max(1, Math.min(Number(discovery?.maxDepth) || 4, 8)),
    maxArrayScan: Math.max(1, Math.min(Number(discovery?.maxArrayScan) || 40, 200))
  };
  const discoveryEnabled = discovery?.enabled !== false;
  const declared = contract?.listPath ? String(contract.listPath) : '';

  if (declared) {
    const value = readDeclared(data, declared);
    const total = contract?.totalPath ? Number(readDeclared(data, contract.totalPath)) : null;
    if (Array.isArray(value)) {
      return { items: value.filter((entry) => isPlainObject(entry) || typeof entry === 'string'), listPath: declared, discovered: false, total: Number.isFinite(total) ? total : discoverTotal(data, options) };
    }
    // The declared path exists but is a wrapper object (e.g. 'data' → { results: [] }).
    if (value !== undefined && discoveryEnabled) {
      const nested = discoverList(value, options);
      if (nested.array.length) return { items: nested.array, listPath: nested.path ? `${declared}.${nested.path}` : declared, discovered: true, total: Number.isFinite(total) ? total : discoverTotal(data, options) };
    }
    if (value === undefined) {
      // Declared path does not exist in this response: never pretend, report it.
      const discovered = discoveryEnabled ? discoverList(data, options) : { array: [], path: '', discovered: true };
      if (discovered.array.length) return { items: discovered.array, listPath: discovered.path, discovered: true, total: discoverTotal(data, options), contractMiss: declared };
      throw new ExecuteAfterError(ERROR_CODES.INVALID_JSON, {
        technical: `contract.listPath "${declared}" does not exist in the response`,
        userMessage: 'The provider response does not match the declared contract.',
        hint: 'Open the real response of YOUR endpoint and correct contract.listPath in execute-after.config.js.'
      });
    }
    return { items: [], listPath: declared, discovered: false, total: Number.isFinite(total) ? total : discoverTotal(data, options) };
  }

  const discovered = discoveryEnabled ? discoverList(data, options) : { array: [], path: '', discovered: true };
  return { items: discovered.array, listPath: discovered.path, discovered: true, total: discoverTotal(data, options) };
}

function readDeclared(data, path) {
  return readPath(data, path);
}

/**
 * Canonical provider parser: payload → normalized results.
 * Adapters override this when their API needs provider-specific parsing.
 */
function parseProviderResponse(data, {
  slot,
  mode = '',
  contract = {},
  discovery = {},
  limit = 8,
  policy = null,
  arrayHint = false
} = {}) {
  const { items, listPath, discovered, total } = extractItems(data, { contract, discovery });
  const results = [];
  let skipped = 0;
  let blocked = 0;
  const scanLimit = Math.max(limit * 3, limit);
  for (const item of items.slice(0, scanLimit)) {
    const result = normalizeResult(item, { slot, mode, index: results.length, contract, discovery: { listPath, discovered }, total });
    if (isEmptyResult(result)) {
      skipped += 1;
      continue;
    }
    try {
      assertAllowed({ title: result.title || '', description: result.description || '', url: result.pageUrl || result.streamUrl || result.embedUrl || '' }, policy, { provider: slot?.id, mode });
    } catch {
      blocked += 1;
      continue;
    }
    results.push(result);
    if (results.length >= limit) break;
  }
  return { blocked, discovered, listPath, results, skipped, total, arrayHint };
}

/**
 * Single-item resolution for info/stream/download modes. The response may be
 * an object, or list-shaped with the wanted id somewhere in the array.
 */
const MAX_SINGLE_SCAN = 200;

function resolveSingleResult(data, {
  slot,
  mode = '',
  contract = {},
  discovery = {},
  policy = null,
  id = ''
} = {}) {
  const wanted = String(id || '').trim().toLowerCase();
  const isUrlLike = /^https?:\/\//i.test(wanted);

  let items = [];
  try {
    const extracted = extractItems(data, { contract, discovery });
    items = extracted.items;
    if (!items.length && isPlainObject(data)) items = [data];
  } catch (error) {
    if (isPlainObject(data)) items = [data];
    else throw error;
  }

  // Only items that survive normalization and the content policy are considered,
  // and an id that the provider does not return is NEVER silently swapped for a
  // different item — a wrong video is worse than a clean "not found".
  const usable = [];
  for (const item of items.slice(0, MAX_SINGLE_SCAN)) {
    const result = normalizeResult(item, { slot, mode, index: 0, contract, discovery: { listPath: contract?.listPath || '', discovered: false }, total: null });
    if (isEmptyResult(result)) continue;
    try {
      assertAllowed({ title: result.title || '', description: result.description || '', url: result.pageUrl || result.streamUrl || result.embedUrl || '' }, policy, { provider: slot?.id, mode });
    } catch {
      continue;
    }
    usable.push(result);
    // No id requested: the first usable item is the answer, no need to scan more.
    if (!wanted) break;
  }
  if (!usable.length) return null;
  if (!wanted) return usable[0];

  const idOf = (result) => String(result.id || '').trim().toLowerCase();
  const exact = usable.find((result) => idOf(result) === wanted);
  if (exact) return exact;
  if (isUrlLike(wanted)) {
    const urlsOf = (result) => [result.pageUrl, result.streamUrl, result.downloadUrl, result.embedUrl].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
    const byUrl = usable.find((result) => urlsOf(result).some((url) => url === wanted || url === `${wanted}/`));
    if (byUrl) return byUrl;
  }
  return usable.find((result) => {
    const candidate = idOf(result);
    return candidate && (candidate.includes(wanted) || wanted.includes(candidate));
  }) || null;
}

module.exports = {
  LIST_KEY_PRIORITY,
  TOTAL_KEYS,
  discoverList,
  discoverTotal,
  extractItems,
  parseProviderResponse,
  resolveSingleResult
};
