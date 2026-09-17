'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { font } = require('./presentation');
const { cleanText, publicHttpsUrl } = require('./anime-library');
const { readLimitedBuffer } = require('./net-tools');
const { UNKNOWN_VALUE, formatSessionNumber, sessionDashboard, sessionDigits } = require('./session-status');

function normalizeWelcomeConfig(value = {}) {
  return Object.freeze({
    enabled: value?.enabled === true,
    source: value?.source === 'url' ? 'url' : 'local',
    path: typeof value?.path === 'string' ? value.path.trim() : './media/connection/welcome.mp4',
    url: typeof value?.url === 'string' ? value.url.trim() : '',
    timeoutMs: Number.isInteger(value?.timeoutMs) ? Math.max(100, Math.min(60000, value.timeoutMs)) : 15000
  });
}
function authenticatedSelfJid(socket) {
  if (typeof socket?.user?.id !== 'string') return undefined;
  const jid = socket.user.id.replace(/:\d+@/, '@');
  return /^\d+@(s\.whatsapp\.net|lid)$/.test(jid) ? jid : undefined;
}
function welcomeCaption(socket, status, { dashboard = 'compact' } = {}) {
  const jid = authenticatedSelfJid(socket);
  // The ACTUAL number of this connected session, read from that socket's own
  // authenticated identity: never masked, never hardcoded and never taken from
  // a shared global that another session could overwrite. A LID identity is a
  // real WhatsApp identity but not a phone number, so it stays "Unavailable".
  const number = formatSessionNumber(sessionDigits(jid));
  const name = cleanText(socket?.user?.name, 80) || 'WhatsApp User';
  // Real runtime session state (status mirror of THIS socket, or a view derived
  // from it). Media captions stay bounded, so the compact dashboard travels with
  // the video/image; the full dashboard is used by the text card.
  const live = status || socket?.animeSessionStatus;
  const lines = [
    `╭━━━〔 🌀 ${font('LIMITLESS • ACTIVE')} 〕━━━╮`,
    '',
    `          ✦ ${font('CONNECTED')} ✦`,
    `       ${font('SUCCESSFULLY')} ✓`,
    '',
    '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯',
    '',
    `👤 ${font('USER')} : ${name}`,
    `📱 ${font('NUMBER')} : ${number}`,
    '',
    `╭─〔 🌀 ${font("GOJO'S SYSTEM")} 〕─╮`,
    '│',
    `│  ∞  ${font('LIMITLESS')}     ✓ ${font('ON')}`,
    `│  ◉  ${font('INFINITY')}      ✓ ${font('ON')}`,
    `│  ⚡  ${font('ANIME-MD')}      ✓ ${font('READY')}`,
    '│',
    '╰────────────────────────────╯',
    '',
    `╭━━〔 🌌 ${font("TODAY'S THOUGHT")} 〕━━╮`,
    '',
    `❝ ${font("You don't need to be")}`,
    `${font('the strongest from the start.')}`,
    '',
    font('Keep moving.'),
    `${font('Your own power will catch up.')} ❞`,
    '',
    `             — ${font('ANIME MD')} ⚡`,
    '',
    `╭━━〔 💙 ${font('SYSTEM')} 〕━━╮`,
    '│ 🟢 Online & Ready',
    '│ ⚡ Fast Response',
    '│ 🔐 Secure Session',
    '│ ♾️ Anime Power Unlocked',
    '╰━━━━━━━━━━━━━━━━━━╯',
    '',
    `        「 ${font('GOJO IS HERE')} 」`,
    '             The system is alive. 🌀',
    '',
    sessionDashboard(live, {
      socket,
      number: number === UNKNOWN_VALUE ? undefined : sessionDigits(jid),
      compact: dashboard !== 'full'
    })
  ];
  return lines.join('\n');
}

/**
 * The full connected-dashboard caption used by the WhatsApp text card that
 * follows the optional welcome video/image. Same renderer, same real values,
 * no second source of truth.
 */
function connectionCardCaption(socket, status) {
  return welcomeCaption(socket, status, { dashboard: 'full' });
}

/** Media captions are bounded by WhatsApp; this keeps the welcome deliverable. */
const MAX_MEDIA_CAPTION_LENGTH = 1024;

function safeMediaCaption(caption) {
  const text = String(caption ?? '');
  return text.length <= MAX_MEDIA_CAPTION_LENGTH ? text : `${text.slice(0, MAX_MEDIA_CAPTION_LENGTH - 1).trimEnd()}…`;
}
// A notification helper only: callers keep the EXISTING connection lifecycle
// flags/sets. No listener, socket, timer loop, history database or retry worker.
async function sendWelcomeVideo(socket, options, { log = console, fetchImpl = globalThis.fetch } = {}) {
  const settings = normalizeWelcomeConfig(options);
  if (!settings.enabled) return { status: 'off' };
  const target = authenticatedSelfJid(socket);
  if (!target) { log.warn?.('[connection-welcome] Video skipped (NO_AUTHENTICATED_SELF_JID).'); return { status: 'failed' }; }
  let stage = 'VIDEO_SOURCE_UNAVAILABLE';
  let timeout;
  try {
    let source;
    if (settings.source === 'url') {
      const url = publicHttpsUrl(settings.url);
      // Baileys' remote getter does not forward an abort signal/redirect policy.
      // Fetch this user-configured welcome ourselves into a bounded transient
      // buffer: no redirect, no credentials, no temporary/permanent file.
      const response = await fetchImpl(url.href, { signal: AbortSignal.timeout(settings.timeoutMs), redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Remote video unavailable'); }
      try { source = await readLimitedBuffer(response); }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
      if (!source.length) throw new Error('Empty video');
    }
    else {
      if (!settings.path || path.extname(settings.path).toLowerCase() !== '.mp4') throw new Error('Invalid local MP4 path');
      source = path.resolve(settings.path);
      const stat = await fs.stat(source);
      if (!stat.isFile() || stat.size === 0 || stat.size > 50 * 1024 * 1024) throw new Error('Invalid local MP4 size');
    }
    stage = 'VIDEO_SEND_FAILED';
    // Baileys handles the local path or transient remote buffer. Its upload timeout is
    // supplemented with a bounded await so a failed optional video cannot hold
    // up the existing fallback text/menu. No retry creates a duplicate video.
    await Promise.race([
      socket.sendMessage(target, { video: Buffer.isBuffer(source) ? source : { url: source }, mimetype: 'video/mp4', caption: safeMediaCaption(welcomeCaption(socket)) }, { mediaUploadTimeoutMs: settings.timeoutMs }),
      new Promise((_, reject) => { timeout = setTimeout(() => { stage = 'VIDEO_TIMEOUT'; reject(new Error('timeout')); }, settings.timeoutMs); })
    ]);
    return { status: 'sent' };
  } catch {
    // Do not log arbitrary socket errors, signed URLs, private local paths or
    // credentials. The existing welcome text/menu will still be delivered.
    log.warn?.(`[connection-welcome] Video skipped (${stage}).`);
    return { status: 'failed' };
  } finally { clearTimeout(timeout); }
}
module.exports = { MAX_MEDIA_CAPTION_LENGTH, normalizeWelcomeConfig, authenticatedSelfJid, connectionCardCaption, safeMediaCaption, welcomeCaption, sendWelcomeVideo };
