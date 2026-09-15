'use strict';

// =============================================================================
// EXECUTEAFTER — ROUTER (execution pipeline)
// =============================================================================
// EXECUTION PIPELINE
//
//   ExecuteAfter command
//          ↓
//   existing AnimeMD dispatcher      (system/handler.js, the only dispatcher)
//          ↓
//   ExecuteAfter router              (this file)
//          ↓
//   provider configuration           (execute-after.config.js → registry.js)
//          ↓
//   provider-specific adapter        (adapters/provider_XX.js)
//          ↓
//   HTTP request                     (http-client.js)
//          ↓
//   response validation              (parser.js + policy.js)
//          ↓
//   provider parser                  (adapter.parseProviderResponse)
//          ↓
//   universal normalization          (normalize.js)
//          ↓
//   result formatter                 (formatter.js)
//          ↓
//   existing AnimeMD sender          (handler sendResult / lib/ui sendList)
//
// There is no second dispatcher and no second command parser: the router is only
// reached through the existing dispatcher branch.
//
// Isolation: every failure is caught here and answered with a clean message.
// A provider error can never throw into AnimeMD, never crash the process and
// never touch another provider (separate adapters, separate counters).
// =============================================================================

const registry = require('./registry');
const mediaEngine = require('./media-engine');
const formatter = require('./formatter');
const { buildContext, usageLine } = require('./context');
const { ERROR_CODES, ExecuteAfterError, isExecuteAfterError, logFailure, toExecuteAfterError } = require('./errors');

const COOLDOWN_MAX_ENTRIES = 500;
const cooldowns = new Map();
let inFlightGlobal = 0;
const inFlightPerSlot = new Map();
const cache = new Map();

function pruneMap(map, max) {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function cacheKey(slot, context) {
  return `${slot.id}:${context.mode}:${context.query || context.id || ''}:${context.page || ''}`;
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { expiresAt: Date.now() + registry.framework.cache.ttlMs, value });
  pruneMap(cache, registry.framework.cache.maxEntries);
}

function owns(name) {
  return Boolean(registry.byCommand(String(name || '').toLowerCase()));
}

function cooldownError(slot, chatId) {
  const cooldown = registry.framework.perChatCooldownMs;
  if (!cooldown) return null;
  const key = `${slot.id}:${chatId}`;
  const last = cooldowns.get(key) || 0;
  const elapsed = Date.now() - last;
  if (elapsed >= cooldown) return null;
  return { remainingMs: cooldown - elapsed, retryIn: Math.ceil((cooldown - elapsed) / 1000) };
}

function inFlightError(slot) {
  if (inFlightGlobal >= registry.framework.maxInFlightGlobal) return true;
  return (inFlightPerSlot.get(slot.id) || 0) >= registry.framework.maxInFlightPerProvider;
}

function enter(slot) {
  inFlightGlobal += 1;
  inFlightPerSlot.set(slot.id, (inFlightPerSlot.get(slot.id) || 0) + 1);
}

function leave(slot) {
  inFlightGlobal = Math.max(0, inFlightGlobal - 1);
  const next = (inFlightPerSlot.get(slot.id) || 1) - 1;
  if (next <= 0) inFlightPerSlot.delete(slot.id);
  else inFlightPerSlot.set(slot.id, next);
}

function isModesRequest(command) {
  const tokens = Array.isArray(command?.args) ? command.args : [];
  return tokens.length === 1 && ['modes', 'mode'].includes(String(tokens[0] || '').toLowerCase());
}

function tooltipHint() {
  return 'Fill command + endpoint in execute-after.config.js.';
}

function buttonList(deps, slot, actions, categoryId) {
  const prefix = deps.getPrefix();
  const buttons = [];
  const seen = new Set();
  for (const button of [...actions, deps.backButton(prefix, categoryId), deps.menuButton(prefix)]) {
    if (!button?.label || !button?.id || seen.has(button.id)) continue;
    seen.add(button.id);
    buttons.push(button);
  }
  return buttons.slice(0, 3);
}

async function sendText(deps, socket, context, command, slot, text, actions = []) {
  const categoryId = slot?.categoryId || registry.framework.category.id;
  await deps.sendResult(socket, context, {
    buttons: buttonList(deps, slot, actions, categoryId),
    command: command.name,
    text
  });
}

async function sendResults(deps, socket, context, command, slot, payload) {
  const prefix = deps.getPrefix();
  const categoryId = registry.framework.category.id;
  const actions = buttonList(deps, slot, payload.actions || [], categoryId);
  if (payload.rows?.length && typeof deps.sendList === 'function') {
    await deps.sendList(socket, context.chatId, {
      actions,
      fallbackText: payload.text,
      footer: deps.footer,
      quoted: context.raw,
      sections: [{ rows: payload.rows, title: 'Results' }],
      text: payload.text,
      title: 'Results'
    });
    return;
  }
  await deps.sendResult(socket, context, { buttons: actions, command: command.name, text: payload.text });
}

function mediaUrlFor(result) {
  return result?.streamUrl || result?.downloadUrl || '';
}

/**
 * An id-based mode (info / stream / download) must never be answered with an
 * unrelated item: the requested id is matched against whatever the provider
 * returned. If the provider does not return that item, the user gets a clean
 * message instead of some other video.
 */
function pickResult(outcome, requestContext, { hint = '', provider = '' } = {}) {
  if (outcome?.single) return outcome.single;
  const results = Array.isArray(outcome?.results) ? outcome.results : [];
  const wanted = String(requestContext?.id || '').trim().toLowerCase();
  if (wanted) {
    const match = results.find((item) => String(item?.id || '').trim().toLowerCase() === wanted);
    if (match) return match;
    if (results.length) {
      throw new ExecuteAfterError(ERROR_CODES.NOT_FOUND, {
        provider,
        mode: requestContext?.mode || '',
        hint: hint || 'Check the id with the search result list.',
        technical: `provider returned ${results.length} result(s) but none with id "${requestContext.id}"`,
        userMessage: `The provider did not return the requested item (id ${requestContext.id}).`
      });
    }
  }
  return results[0] || null;
}

/**
 * Stream/download modes hand a VERIFIED media URL to the media engine:
 * URL validation → content-type validation → streamed download → send →
 * cleanup. A page URL is never treated as a media URL.
 */
async function deliverIfMedia({ socket, context, slot, command, requestContext, result, deps }) {
  const mediaSettings = registry.framework.media;
  const url = mediaUrlFor(result);
  if (!url) {
    throw toExecuteAfterError({
      code: ERROR_CODES.MISSING_MEDIA_URL,
      isExecuteAfterError: true,
      userMessage: 'The provider did not return a playable media URL.',
      hint: result?.pageUrl ? 'This result only has a page link — open it on the provider site.' : tooltipHint(),
      technical: `no streamUrl/downloadUrl for ${slot.id}:${requestContext.mode}`
    }, { provider: slot.id, mode: requestContext.mode });
  }
  if (!mediaSettings.enabled) {
    await sendText(deps, socket, context, command, slot,
      [`🎬 *${formatter.TITLE}*`,
        formatter.providerLine(slot),
        '❌ Media delivery is disabled in execute-after.config.js (framework.media.enabled).',
        '',
        `Direct link: ${url}`].join('\n'));
    return true;
  }
  await deps.react(socket, context, '⬇️').catch(() => {});
  await mediaEngine.deliverMedia({
    caption: formatter.formatMediaCaption({ kind: requestContext.mode, result, slot }),
    chatId: context.chatId,
    kind: requestContext.mode === 'download' ? 'document' : 'auto',
    mode: requestContext.mode,
    provider: slot.id,
    quoted: context.raw,
    rawUrl: url,
    settings: mediaSettings,
    socket
  });
  return true;
}

async function dispatch(socket, context, command, deps) {
  const slotName = String(command?.name || '').toLowerCase();
  const slot = registry.byCommand(slotName);
  if (!slot) return false;
  let entered = false;
  let requestContext = null;
  try {
    if (!slot.enabled || slot.status === 'DISABLED') {
      await sendText(deps, socket, context, command, slot, [
        `🎬 *${formatter.TITLE}*`, formatter.providerLine(slot),
        `❌ This provider slot is disabled in the config.`,
        `💡 ${slot.reason || 'Set enabled to true in execute-after.config.js.'}`
      ].join('\n'));
      return true;
    }

    if (isModesRequest(command)) {
      const status = formatter.formatStatus({ prefix: deps.getPrefix(), slot: { ...slot, contractVerified: slot.config.contract.verified, endpointConfigured: Boolean(slot.config.endpoint), pageParam: slot.config.pageParam } });
      await sendText(deps, socket, context, command, slot, status.text);
      return true;
    }

    if (!slot.config.endpoint) {
      await sendText(deps, socket, context, command, slot, [
        `🎬 *${formatter.TITLE}*`, formatter.providerLine(slot),
        '❌ This provider slot has no endpoint yet.',
        '💡 PUT YOUR PERMITTED API ENDPOINT HERE in execute-after.config.js.',
        `Slot: ${slot.id} (${registry.CONFIG_FILE})`
      ].join('\n'));
      return true;
    }

    if (!slot.adapter || typeof slot.adapter.execute !== 'function') {
      await sendText(deps, socket, context, command, slot, [
        `🎬 *${formatter.TITLE}*`, formatter.providerLine(slot),
        '❌ This provider adapter could not be loaded.',
        `💡 ${slot.reason || 'Check system/execute-after/adapters/ and the console log.'}`
      ].join('\n'));
      return true;
    }

    const cooldown = cooldownError(slot, context.chatId);
    if (cooldown) {
      await sendText(deps, socket, context, command, slot, [
        `🎬 *${formatter.TITLE}*`, formatter.providerLine(slot),
        `⏳ Please wait ${cooldown.retryIn}s before using this provider again.`
      ].join('\n'));
      return true;
    }

    if (inFlightError(slot)) {
      await sendText(deps, socket, context, command, slot, [
        `🎬 *${formatter.TITLE}*`, formatter.providerLine(slot),
        '⏳ This provider is still busy with an earlier request.',
        '💡 Try again in a moment.'
      ].join('\n'));
      return true;
    }

    requestContext = buildContext(slot, command);
    if (requestContext.listModes) {
      const status = formatter.formatStatus({ prefix: deps.getPrefix(), slot: { ...slot, contractVerified: slot.config.contract.verified, endpointConfigured: Boolean(slot.config.endpoint), pageParam: slot.config.pageParam } });
      await sendText(deps, socket, context, command, slot, status.text);
      return true;
    }

    const key = registry.framework.cache.enabled ? cacheKey(slot, requestContext) : '';
    let outcome = key ? cacheGet(key) : null;
    cooldowns.set(`${slot.id}:${context.chatId}`, Date.now());
    pruneMap(cooldowns, COOLDOWN_MAX_ENTRIES);

    if (!outcome) {
      enter(slot);
      entered = true;
      await deps.react(socket, context, '🔎').catch(() => {});
      outcome = await slot.adapter.execute({
        ...requestContext,
        framework: registry.framework,
        policy: registry.policy,
        slot
      });
      if (key) cacheSet(key, outcome);
    }

    if (['stream', 'download'].includes(requestContext.mode)) {
      const result = pickResult(outcome, requestContext, {
        hint: `Use "!${command.name} info ${requestContext.id || '<id>'}" to check the details.`,
        provider: slot.id
      });
      await deliverIfMedia({ command, context, deps, requestContext, result, slot, socket });
      return true;
    }

    const single = outcome.single || (requestContext.id
      ? pickResult(outcome, requestContext, {
        hint: `Use "!${command.name} search <query>" to find the right id.`,
        provider: slot.id
      })
      : null);
    if (single) {
      const formatted = formatter.formatSingle({ context: requestContext, prefix: deps.getPrefix(), result: single, slot });
      await sendText(deps, socket, context, command, slot, formatted.text, formatted.actions);
      return true;
    }

    const formatted = formatter.formatResults({
      context: requestContext,
      prefix: deps.getPrefix(),
      results: outcome.results || [],
      slot,
      total: outcome.meta?.total ?? null
    });
    await sendResults(deps, socket, context, command, slot, formatted);
    return true;
  } catch (error) {
    const failure = logFailure(error, { mode: requestContext?.mode || '', provider: slot.id, verbose: registry.framework.verbose });
    try {
      if (failure.code === ERROR_CODES.NO_RESULTS) {
        await sendText(deps, socket, context, command, slot, [
          `🎬 *${formatter.TITLE}*`, formatter.providerLine(slot),
          `🔍 ${failure.userMessage}`
        ].join('\n'));
      } else {
        const formatted = formatter.formatError({ error, prefix: deps.getPrefix(), slot });
        if (failure.code === ERROR_CODES.UNSUPPORTED_MODE || failure.code === ERROR_CODES.MISSING_QUERY || failure.code === ERROR_CODES.MISSING_PARAMETER) {
          formatted.text += `\n\n${usageLine(deps.getPrefix(), slot, requestContext?.mode || '')}`;
        }
        await sendText(deps, socket, context, command, slot, formatted.text);
      }
    } catch (replyError) {
      console.warn(`[execute-after:${slot.id}] could not deliver the failure notice: ${replyError?.message || replyError}`);
    }
    return true;
  } finally {
    if (entered) leave(slot);
  }
}

function stats() {
  return {
    cacheSize: cache.size,
    cooldowns: cooldowns.size,
    inFlightGlobal,
    inFlightPerSlot: Object.fromEntries(inFlightPerSlot),
    registry: registry.stats()
  };
}

module.exports = { cache, cooldowns, dispatch, owns, stats };
