'use strict';

// =============================================================================
// EXECUTEAFTER — RESULT FORMATTER
// =============================================================================
// Turns normalized results (and errors) into chat messages.
//
// Rules:
//   * only fields that really exist are printed (null is skipped, never
//     "undefined" / "null" / "NaN")
//   * every command id offered in a button or a list row is a real command of
//     the SAME provider command, so tapping it re-enters the normal dispatcher
//   * the sender is always the existing AnimeMD sender (sendResult / sendList)
// =============================================================================

const { isExecuteAfterError, toExecuteAfterError } = require('./errors');
const { supportedModes } = require('./context');

const TITLE = 'EXECUTE AFTER';

function short(value, limit = 60) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function providerLine(slot) {
  const label = slot?.label && slot.label !== slot.id ? ` • ${short(slot.label, 40)}` : '';
  return `➜ ${slot?.id || 'provider'}${label} • ${slot?.command || ''}`.trim();
}

function header(slot) {
  return [`🎬 *${TITLE}*`, providerLine(slot)].join('\n');
}

function bulletFields(result) {
  const parts = [];
  if (result.duration !== null && result.duration !== undefined) parts.push(`⏱ ${short(result.duration, 20)}`);
  if (result.quality) parts.push(`🎚 ${short(result.quality, 20)}`);
  if (result.type) parts.push(`🗂 ${short(result.type, 20)}`);
  return parts;
}

function resultBlock(result, index) {
  const lines = [`${index}. ${short(result.title || result.id || 'Result', 90)}`];
  const fields = bulletFields(result);
  if (fields.length) lines.push(`   ${fields.join(' • ')}`);
  if (result.id) lines.push(`   🆔 ${short(result.id, 40)}`);
  if (result.streamUrl || result.downloadUrl) lines.push('   ✅ direct media link available');
  else if (result.pageUrl) lines.push('   🔗 page link only');
  return lines.join('\n');
}

/**
 * Search/list answer: short text + single_select rows (each row id is
 * "!<command> info <id>" so a tap continues the same pipeline).
 */
function formatResults({ slot, context, results, prefix, total = null }) {
  const command = slot?.command || context?.command || '';
  const mode = context?.mode || '';
  const lines = [
    header(slot),
    `🔎 *MODE:* ${mode}`,
    context?.query ? `🔤 Query: ${short(context.query, 80)}` : '',
    context?.page ? `📄 Page: ${context.page}` : '',
    `📦 Results: ${results.length}${total ? ` of ${total}` : ''}`,
    '',
    ...results.map((result, index) => resultBlock(result, index + 1))
  ].filter((line) => line !== '');
  if (!results.length) lines.push('No results were returned for that query.');

  const actions = [];
  const rows = results.slice(0, 25).map((result) => ({
    header: slot?.label || slot?.id || 'Provider',
    title: short(result.title || result.id || 'Result', 80),
    description: short([...bulletFields(result), result.id ? `id ${result.id}` : ''].filter(Boolean).join(' • ') || 'Open result', 120),
    id: `${prefix}${command} info ${result.id || result.title || ''}`.trim()
  }));

  const first = results[0];
  if (first?.id || first?.pageUrl) {
    if (supportedModes(slot).includes('stream') || supportedModes(slot).includes('download')) {
      actions.push({ label: '⬇️ Download first', id: `${prefix}${command} ${supportedModes(slot).includes('download') ? 'download' : 'stream'} ${first.id || first.pageUrl}`.trim() });
    }
    actions.push({ label: 'ℹ️ Details', id: `${prefix}${command} info ${first.id || first.pageUrl}`.trim() });
  }

  return { actions, rows, text: lines.join('\n') };
}

function formatSingle({ slot, context, result, prefix }) {
  const command = slot?.command || context?.command || '';
  const modes = supportedModes(slot);
  const lines = [header(slot), `🔎 *MODE:* ${context?.mode || ''}`, '', `🎞 ${short(result.title || result.id || 'Result', 120)}`];
  const fields = bulletFields(result);
  if (fields.length) lines.push(fields.join(' • '));
  if (result.id) lines.push(`🆔 ${short(result.id, 60)}`);
  if (result.description) lines.push('', short(result.description, 400));
  const links = [];
  if (result.pageUrl) links.push(`🔗 Page: ${result.pageUrl}`);
  if (result.embedUrl) links.push(`🖼 Embed: ${result.embedUrl}`);
  if (result.streamUrl) links.push(`▶️ Stream: ${result.streamUrl}`);
  if (result.downloadUrl) links.push(`⬇️ Download: ${result.downloadUrl}`);
  if (links.length) lines.push('', ...links);

  const actions = [];
  const target = result.id || result.pageUrl || result.streamUrl || '';
  if (modes.includes('stream')) actions.push({ label: '▶️ Stream', id: `${prefix}${command} stream ${target}`.trim() });
  if (modes.includes('download')) actions.push({ label: '⬇️ Download', id: `${prefix}${command} download ${target}`.trim() });
  if (modes.includes('info')) actions.push({ label: 'ℹ️ Details', id: `${prefix}${command} info ${target}`.trim() });
  return { actions, text: lines.filter((line) => line !== '').join('\n') };
}

/** Status answer for "!Exec1 modes" — what this slot really supports. */
function formatStatus({ slot, prefix }) {
  const modes = supportedModes(slot);
  const lines = [
    header(slot),
    `📡 Status: ${slot?.status || 'UNKNOWN'}`,
    `🧩 Modes: ${modes.join(', ')}`,
    `🔗 Endpoint: ${slot?.endpointConfigured ? 'configured' : 'not configured yet'}`,
    `📄 Contract: ${slot?.contractVerified ? 'verified' : slot?.endpointConfigured ? 'unverified' : 'not configured'}`,
    `👁 Menu: ${slot?.hidden ? 'hidden (still usable)' : 'listed'}`,
    '',
    '*USAGE*',
    ...modes.map((mode) => {
      if (mode === 'search') return `${prefix}${slot?.command} search <query>`;
      if (['random', 'trending', 'latest'].includes(mode)) return `${prefix}${slot?.command} ${mode}${slot?.pageParam ? ' [page]' : ''}`;
      return `${prefix}${slot?.command} ${mode} <id|url>`;
    })
  ];
  return { text: lines.join('\n') };
}

/** Clean, user-facing error text. Technical detail stays in the logs. */
function formatError({ error, slot, prefix }) {
  const info = isExecuteAfterError(error) ? toExecuteAfterError(error) : toExecuteAfterError(error);
  const modes = supportedModes(slot);
  const lines = [header(slot), `❌ ${info.userMessage}`];
  if (info.hint) lines.push(`💡 ${info.hint}`);
  if (info.code === 'EUNSUPPORTEDMODE' || info.code === 'ENOQUERY' || info.code === 'ENOPARAM') {
    lines.push('', '*USAGE*', ...modes.map((mode) => {
      if (mode === 'search') return `${prefix}${slot?.command} search <query>`;
      if (['random', 'trending', 'latest'].includes(mode)) return `${prefix}${slot?.command} ${mode}`;
      return `${prefix}${slot?.command} ${mode} <id|url>`;
    }));
  }
  if (info.code === 'ENOTCONFIGURED' || info.code === 'EUNRESOLVED') {
    lines.push('', `Slot: ${slot?.id || 'provider'} (${slot?.configPath || 'execute-after.config.js'})`);
  }
  return { text: lines.join('\n') };
}

function formatMediaCaption({ slot, result, kind = 'video' }) {
  return [
    `✅ ${short(result?.title || result?.id || 'Media', 80)}`,
    `➜ ${slot?.id || 'provider'} • ${kind}`,
    result?.quality ? `🎚 ${short(result.quality, 20)}` : ''
  ].filter(Boolean).join('\n');
}

module.exports = {
  TITLE,
  formatError,
  formatMediaCaption,
  formatResults,
  formatSingle,
  formatStatus,
  header,
  providerLine,
  short
};
