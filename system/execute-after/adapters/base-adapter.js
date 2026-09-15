'use strict';

// =============================================================================
// EXECUTEAFTER — ADAPTER SKELETON (shared interface, per-provider identity)
// =============================================================================
// Every provider slot gets its own adapter file (provider_01.js, provider_02.js,
// ...). Each one has its own id, its own parser hook, its own counters and its
// own error handling, so a failure in provider_01 can never reach provider_02.
//
// The skeleton below only implements what every provider needs:
//   request construction → HTTP request → response validation → parsing →
//   normalization → provider-specific errors
//
// Adapter interface (consistent for every provider):
//   adapter.id                        → 'provider_01'
//   adapter.status(slot)              → UNRESOLVED | UNVERIFIED | READY | DISABLED
//   adapter.parseProviderResponse()   → provider-specific parser (overridable)
//   adapter.execute(context)          → Promise<{ mode, request, results, single, meta }>
//   adapter.stats()                   → bounded counters (no memory growth)
// =============================================================================

const { requestJson } = require('../http-client');
const { parseProviderResponse: defaultParseProviderResponse, resolveSingleResult } = require('../parser');
const { ID_MODES } = require('../context');
const { ERROR_CODES, ExecuteAfterError, redactUrl, toExecuteAfterError } = require('../errors');
const { normalizeResult } = require('../normalize');

function configOf(slot) {
  return slot?.config || {};
}

function overrideFor(config, mode) {
  const overrides = config?.modeOverrides && typeof config.modeOverrides === 'object' ? config.modeOverrides : {};
  const entry = overrides[mode];
  return entry && typeof entry === 'object' ? entry : {};
}

/**
 * Request construction. Only parameters that are declared in
 * execute-after.config.js are ever sent — nothing is invented.
 */
function buildRequest(slot, context) {
  const config = configOf(slot);
  const mode = context.mode;
  const override = overrideFor(config, mode);
  const endpoint = String(config.endpoint || '').trim();
  const method = String(override.method || config.method || 'GET').toUpperCase();
  const headers = { ...(config.headers || {}), ...(override.headers || {}) };
  const auth = { ...(config.auth || {}), ...(override.auth || {}) };
  const extraParams = { ...(config.extraParams || {}), ...(override.extraParams || {}) };
  const queryParamName = override.queryParam || config.queryParam || '';
  const idParamName = override.idParam || config.idParam || '';
  const pageParam = override.pageParam || config.pageParam || '';
  const pathTemplate = String(override.pathTemplate || config.pathTemplate || '').trim();
  const templateUsesQuery = pathTemplate.includes('{query}');
  const templateUsesId = pathTemplate.includes('{id}');
  const templateUsesPage = pathTemplate.includes('{page}');

  const params = { ...extraParams };
  let url = endpoint;

  if (pathTemplate) {
    const resolved = pathTemplate
      .replace(/\{query\}/g, encodeURIComponent(context.query || ''))
      .replace(/\{id\}/g, encodeURIComponent(context.id || ''))
      .replace(/\{page\}/g, context.page ? String(context.page) : '');
    url = /^https?:\/\//i.test(resolved)
      ? resolved
      : `${endpoint.replace(/\/+$/, '')}${resolved.startsWith('/') ? '' : '/'}${resolved}`;
  }

  if (mode === 'search') {
    if (queryParamName && !templateUsesQuery) params[queryParamName] = context.query;
  } else if (ID_MODES.includes(mode)) {
    if (idParamName && !templateUsesId) params[idParamName] = context.id;
    else if (queryParamName && !templateUsesId) params[queryParamName] = context.id;
  }
  if (context.page && pageParam && !templateUsesPage) params[pageParam] = context.page;

  const bodyMode = String(override.bodyMode || config.bodyMode || '').toLowerCase();
  const wantsBody = bodyMode === 'body' || (bodyMode !== 'query' && !['GET', 'HEAD'].includes(method));
  const body = wantsBody && Object.keys(params).length ? { ...params } : undefined;
  const queryParams = wantsBody ? {} : params;

  return {
    auth,
    body,
    endpoint,
    headers,
    method,
    paramCount: (body ? Object.keys(body).length : Object.keys(queryParams).length),
    params: queryParams,
    pathTemplate,
    url
  };
}

function createAdapter({ id, slotIndex = 0, notes = '', parseProviderResponse } = {}) {
  if (!id) throw new Error('ExecuteAfter adapter requires an id.');
  const counters = { calls: 0, failures: 0, lastErrorCode: '', lastSuccessAt: 0 };
  const parser = typeof parseProviderResponse === 'function' ? parseProviderResponse : defaultParseProviderResponse;

  const adapter = {
    id,
    slotIndex,
    notes,
    // Providers that return a different structure get their own parser here.
    parseProviderResponse: parser,
    buildRequest: (slot, context) => buildRequest(slot, context),

    status(slot) {
      if (slot && slot.enabled === false) return 'DISABLED';
      const endpoint = String(configOf(slot)?.endpoint || '').trim();
      if (!endpoint) return 'UNRESOLVED';
      const verified = configOf(slot)?.contract?.verified === true;
      return verified ? 'READY' : 'UNVERIFIED';
    },

    stats() {
      return { ...counters };
    },

    /**
     * Executes one provider request end to end.
     * @param {object} context { slot, framework, mode, query, id, page, settings }
     */
    async execute(context) {
      const slot = context.slot;
      const config = configOf(slot);
      counters.calls += 1;
      const started = Date.now();
      try {
        const request = buildRequest(slot, context);
        if (!request.endpoint) {
          throw new ExecuteAfterError(ERROR_CODES.NOT_CONFIGURED, { provider: id, mode: context.mode });
        }
        const http = { ...(context.framework?.http || {}) };
        if (config.timeoutMs) http.timeoutMs = config.timeoutMs;
        const response = await requestJson(request.url, {
          auth: request.auth,
          body: request.body,
          headers: request.headers,
          http,
          method: request.method,
          mode: context.mode,
          params: request.params,
          provider: id
        });

        const parseContext = {
          arrayHint: ID_MODES.includes(context.mode),
          contract: config.contract || {},
          discovery: context.framework?.discovery || {},
          id: context.id,
          limit: Math.max(1, Number(context.framework?.resultLimit) || 8),
          mode: context.mode,
          policy: context.policy || null,
          slot
        };

        let results = [];
        let single = null;
        let parsed = null;
        if (ID_MODES.includes(context.mode)) {
          single = resolveSingleResult(response.data, parseContext);
          if (!single) {
            throw new ExecuteAfterError(ERROR_CODES.NO_RESULTS, {
              provider: id,
              mode: context.mode,
              technical: `no item matched id "${String(context.id || '').slice(0, 60)}" in the provider response`
            });
          }
          results = [single];
        } else {
          parsed = parser(response.data, { ...parseContext, raw: response.data });
          if (parsed?.results) results = parsed.results;
          else if (Array.isArray(parsed)) results = parsed.map((item, index) => normalizeResult(item, { slot, mode: context.mode, index, contract: config.contract || {}, discovery: {}, total: null }));
          else results = [];
          if (!results.length) {
            throw new ExecuteAfterError(ERROR_CODES.NO_RESULTS, {
              provider: id,
              mode: context.mode,
              technical: `parsed 0 usable results (listPath="${parsed?.listPath || ''}", skipped=${parsed?.skipped ?? 0}, blocked=${parsed?.blocked ?? 0})`
            });
          }
        }

        counters.lastSuccessAt = Date.now();
        return {
          mode: context.mode,
          meta: {
            attempts: response.attempts,
            blocked: parsed?.blocked ?? 0,
            contractVerified: config.contract?.verified === true,
            discovered: parsed?.discovered ?? false,
            durationMs: Date.now() - started,
            listPath: parsed?.listPath || '',
            skipped: parsed?.skipped ?? 0,
            status: response.status,
            total: parsed?.total ?? null,
            url: redactUrl(response.url)
          },
          request: { method: request.method, paramCount: request.paramCount, url: redactUrl(request.url) },
          results,
          single,
          source: response.data
        };
      } catch (error) {
        counters.failures += 1;
        const failure = toExecuteAfterError(error, { provider: id, mode: context.mode });
        counters.lastErrorCode = failure.code;
        throw failure;
      }
    }
  };

  return adapter;
}

// A generic adapter for slots that have no provider_XX.js file. It keeps the
// same interface and its own identity, so adding provider_05..provider_99 needs
// no new file.
function createGeneratedAdapter(id, slotIndex = 0) {
  const adapter = createAdapter({
    id,
    notes: 'GENERATED — no adapter file for this slot; the declared contract is used.',
    slotIndex
  });
  adapter.generated = true;
  return adapter;
}

module.exports = {
  buildRequest,
  configOf,
  createAdapter,
  createGeneratedAdapter,
  overrideFor
};
