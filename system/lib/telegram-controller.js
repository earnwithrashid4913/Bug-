'use strict';

// A small Telegram Bot API client used for remote *control* of the WhatsApp
// pairing system. It deliberately has no WhatsApp implementation of its own:
// the TelegramPairingManager owns every socket and session.
//
// All user-facing text uses the ANIME MD box style. Raw technical errors stay
// in the internal log; Telegram users only ever see friendly messages.
//
// Access levels (checked server-side on EVERY command and callback):
//   bootstrap — telegram.ownerIds from config.js. Full control, may manage
//               every session and change settings.
//   controller— added at runtime with /addowner. Manages only own sessions.
//   public    — any Telegram user (normal/premium/vip) may pair and manage
//               their OWN sessions after verification. Never anyone else's.
//
// The pairing lifecycle uses a SINGLE Telegram message. The PREPARING box is
// sent once, then that same message is edited through LOADING → PAIRING CODE →
// WAITING → SUCCESS, or FAILED. Only the /start intro is a separate message.
// This avoids Telegram message spam and keeps the chat clean.
//
// Interactive surface: a dashboard with inline buttons, a guided single-message
// pairing flow, per-session management, and a settings page. Every button has a
// real handler; ownership is always re-resolved through the pairing manager.

const crypto = require('node:crypto');
const TELEGRAM_API = 'https://api.telegram.org';
const POLL_TIMEOUT_SECONDS = 25;
const SENSITIVE_COOLDOWN_MS = 20_000;
const SENSITIVE_LOCK_TTL_MS = 2 * 60_000;
const PENDING_NUMBER_TTL_MS = 5 * 60_000;
const MAX_SESSION_BUTTONS = 8;

// Temporary block for a normal user is 24 hours. Never permanent, never
// extended automatically: a fresh block is only set by the owner.
const DEFAULT_BLOCK_DURATION_MS = 24 * 60 * 60 * 1000;
// Premium users may pair up to this many unique numbers; VIP is unlimited.
// Normal users = 1, Premium = 3, VIP = unlimited
const NORMAL_PAIRING_LIMIT = 1;
const PREMIUM_PAIRING_LIMIT = 3;

// Lightweight Telegram loading animation frames. The single pairing message is
// edited with these until the code is ready, the link succeeds, or it fails.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 800;

const { formatInternationalNumber, normalizeWhatsAppNumber } = require('./pairing-number');
const { parseDuration } = require('./premium');

// Telegram treats Markdown parsing errors as a failed API request. Keep all
// controller output in HTML and escape untrusted values at the boundary.
function escapeTelegramHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function normalizeTelegramId(value) {
  const id = String(value ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('Telegram IDs must be numeric.');
  return id;
}

function commandFromUpdate(update) {
  const message = update?.message;
  const text = message?.text?.trim();
  if (!text?.startsWith('/')) return undefined;
  const [token, ...args] = text.split(/\s+/);
  const name = token.slice(1).split('@')[0].toLowerCase();
  return { chatId: message.chat?.id, senderId: message.from?.id, name, args, text: args.join(' ') };
}

// ---------------------------------------------------------------------------
// ANIME MD box rendering.
// ---------------------------------------------------------------------------

function box(title, lines) {
  const body = lines.map((line) => (line ? `┃ ${line}` : '┃')).join('\n');
  return `╭━━〔 ${title} 〕━╮\n${body}\n╰${'━'.repeat(24)}╯`;
}

const CODE_SOURCE_LABEL = 'WhatsApp-generated';

const _two = (value) => String(value).padStart(2, '0');
const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatUnblockTimestamp(timestamp) {
  const date = new Date(timestamp);
  return `${_two(date.getDate())} ${_MONTHS[date.getMonth()]} ${date.getFullYear()} • ${_two(date.getHours())}:${_two(date.getMinutes())}`;
}

function formatRemainingDuration(milliseconds) {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${_two(hours)}h ${_two(minutes)}m`;
}

// The ANIME MD intro. Gojo-style, no server-dashboard jargon. It never claims
// a WhatsApp connection: the connected notification is a separate, real event.
function startupBox() {
  return [
    '╰┈➤ ⚡ 𝘼𝙉𝙄𝙈𝙀 𝙈𝘿',
    '',
    '𝙂𝙊𝙅𝙊 𝙄𝙎 𝙃𝙀𝙍𝙀.',
    '🟢 𝙎𝙔𝙎𝙏𝙀𝙈 𝙍𝙀𝘼𝘿𝙔',
    '',
    "𝙒𝙝𝙖𝙩'𝙨 𝙣𝙚𝙭𝙩? 𝙔𝙤𝙪 𝙘𝙝𝙤𝙤𝙨𝙚. 👇"
  ].join('\n');
}

function pairingStartedBox(numberDisplay) {
  return box('ANIME MD • PAIRING', [
    '',
    `📱 Number: ${numberDisplay}`,
    '⏳ Preparing WhatsApp pairing...',
    '',
    'Please wait.'
  ]);
}

function pairingLoadingBox(numberDisplay, frame) {
  // The single pairing message carries the loading animation in its title so
  // it is edited (not re-sent) on every frame.
  return box(`ANIME MD • PAIRING ${frame}`, [
    '',
    `📱 Number: ${numberDisplay}`,
    '⏳ Preparing WhatsApp pairing...',
    '',
    'Please wait.'
  ]);
}

function codeReadyBox({ displayCode, numberDisplay, expiresAt }, { ttlMinutes = 5 } = {}) {
  const minutes = Number.isFinite(expiresAt)
    ? Math.max(1, Math.ceil((expiresAt - Date.now()) / 60_000))
    : ttlMinutes;
  return box('ANIME MD • PAIRING CODE', [
    '',
    '✅ Pairing Code Ready',
    '',
    `🔐 CODE: ${displayCode}`,
    `📱 Number: ${numberDisplay}`,
    `⏳ Valid: about ${minutes} minute${minutes === 1 ? '' : 's'}`,
    '',
    'WhatsApp → Linked Devices →',
    'Link a Device →',
    'Link with phone number',
    '',
    `This code was issued by WhatsApp itself and is valid once.`
  ]);
}

function pairingFailureBox(numberDisplay, reason = 'The WhatsApp connection timed out.', { retry = true } = {}) {
  const lines = ['', `📱 ${numberDisplay}`];
  if (Array.isArray(reason)) {
    for (const line of reason) {
      if (line) lines.push(`⚠️ ${line}`);
    }
    if (!reason.length) lines.push('⚠️ The WhatsApp connection timed out.');
  } else {
    lines.push(`⚠️ ${reason || 'The WhatsApp connection timed out.'}`);
  }
  lines.push('', '❌ Pairing could not be completed.', '');
  if (retry) lines.push('Pair again anytime with /pair.');
  return box('ANIME MD • PAIRING FAILED', lines);
}

function blockedBox(blockUntil, remainingMs) {
  return box('ANIME MD • ACCESS BLOCKED', [
    '',
    '🚫 Your access is temporarily blocked.',
    '',
    `⏳ Unblocks: ${formatUnblockTimestamp(blockUntil)}`,
    `🕐 Remaining: ${formatRemainingDuration(remainingMs)}`,
    '',
    'Please try again after the block expires.'
  ]);
}

function verifyBox() {
  return box('ANIME MD • VERIFICATION', [
    '',
    '🔐 Please verify your Telegram account',
    'to unlock the bot.',
    '',
    'Tap the Verify button below to confirm.',
    '',
    'Aapki account verify karna zaroori hai.'
  ]);
}

function limitBox(used, limit) {
  return box('ANIME MD • PAIRING LIMIT', [
    '',
    `📱 You have paired ${used}/${limit} numbers.`,
    '',
    'Stop an unused session with /stop first,',
    'or contact the owner for a higher limit.'
  ]);
}

function guideBox() {
  return box('ANIME MD • PAIRING GUIDE', [
    '',
    '📱 How to pair your WhatsApp',
    '',
    '1. Tap 🔗 Pair WhatsApp, or send',
    '   /pair <your number>',
    '2. Wait — your pairing code',
    '   arrives in this same message',
    '3. Open WhatsApp → Settings →',
    '   Linked Devices',
    '4. Tap "Link a Device"',
    '5. Tap "Link with phone number"',
    '6. Enter the code',
    '7. Wait for ✅ WhatsApp Connected',
    '',
    '── Roman Urdu ──',
    '',
    '1. 🔗 Pair WhatsApp par tap karein',
    '   ya /pair <number> bhejein',
    '2. Pairing code ka intezar karein',
    '3. WhatsApp khol kar Settings →',
    '   Linked Devices par jayein',
    '4. "Link a Device" par tap karein',
    '5. "Link with phone number" chunein',
    '6. Code daal kar confirm karein',
    '7. ✅ WhatsApp Connected ka',
    '   intezar karein',
    '',
    'Number format: country code +',
    'number, without + (923001234567).'
  ]);
}

function connectedBox(numberDisplay) {
  return box('ANIME MD • CONNECTED', [
    '',
    '✅ WhatsApp Connected',
    '',
    `📱 ${numberDisplay}`,
    '',
    '🟢 Session: ACTIVE',
    '',
    'Your ANIME MD session is ready.',
    '',
    'Roman Urdu: Aapka WhatsApp connect',
    'ho gaya hai — session active hai.'
  ]);
}

function pairingFailedBox(reasonLines, { retry = true } = {}) {
  return box('ANIME MD • PAIRING FAILED', [
    '',
    '❌ Pairing could not be completed.',
    '',
    ...reasonLines,
    ...(retry ? ['', 'Please try /pair again.'] : [])
  ]);
}

function stoppedBox(numberDisplay) {
  return box('ANIME MD • SESSION REMOVED', [
    '',
    `📱 ${numberDisplay}`,
    '',
    '🧹 Session stopped and its credentials removed.',
    '',
    'Pair again anytime with /pair.'
  ]);
}

function channelsBox(channels) {
  const lines = ['', '❌ These channels must be joined first:', ''];
  for (const channel of channels) lines.push(`🚀 ${channel.name}: ${channel.chatId}`);
  lines.push('', 'Join karein, phir /pair <number> dobara bhejein.');
  return box('ANIME MD • JOIN REQUIRED', lines);
}

function premiumRequiredBox() {
  return box('ANIME MD • PREMIUM', [
    '',
    '💎 Pairing is currently limited to',
    'premium users.',
    '',
    'Contact the bot owner to get premium access.'
  ]);
}

function myIdBox({ id, premium, vip, owner, verified }) {
  return box('ANIME MD • MY ID', [
    '',
    `👤 Telegram ID: ${id}`,
    `✅ Verified: ${verified ? 'Yes ✅' : 'No ❌'}`,
    `💎 Premium: ${premium ? 'Active ✅' : 'Inactive ❌'}`,
    `👑 VIP: ${vip ? 'Active ✅' : 'Inactive ❌'}`,
    `👑 Owner: ${owner ? 'Yes ✅' : 'No ❌'}`,
    '',
    'Use this ID if the owner adds you as',
    'a controller or premium user.'
  ]);
}

function premiumBox({ id, expiresAt, active }) {
  const lines = [
    '',
    `👤 User: ${id}`,
    `💎 Premium: ${active ? 'Active ✅' : 'Inactive ❌'}`
  ];
  if (active && Number.isFinite(expiresAt)) {
    lines.push(`⏳ Expires: ${new Date(expiresAt).toISOString().slice(0, 10)}`);
  }
  if (!active) lines.push('', 'Premium lene ke liye owner se rabta karein.');
  return box('ANIME MD • PREMIUM', lines);
}

function accountBox({ id, role, verified, premium, vip, owner, pairedNumbers = [], limit, used, blockStatus }) {
  const roleLabel = role ? role.toUpperCase() : 'NORMAL';
  const lines = [
    '',
    `👤 Telegram ID: ${id}`,
    `🎭 Role: ${roleLabel}`,
    `✅ Verified: ${verified ? 'Yes ✅' : 'No ❌'}`,
    `💎 Premium: ${premium?.premium ? 'Active ✅' : 'Inactive ❌'}`,
    `👑 VIP: ${vip?.vip ? 'Active ✅' : 'Inactive ❌'}`,
    `👑 Owner: ${owner ? 'Yes ✅' : 'No ❌'}`,
    '',
    `📱 Paired: ${used}/${Number.isFinite(limit) ? limit : '∞'}`,
  ];
  if (pairedNumbers.length) {
    lines.push('', '📱 Numbers:');
    for (const num of pairedNumbers.slice(0, 5)) {
      try {
        lines.push(` • ${formatInternationalNumber(num)}`);
      } catch {
        lines.push(` • ${num}`);
      }
    }
    if (pairedNumbers.length > 5) lines.push(` • +${pairedNumbers.length - 5} more`);
  } else {
    lines.push('', '📭 No numbers paired yet.');
  }
  if (blockStatus?.blocked) {
    lines.push('', `🚫 Blocked until: ${formatUnblockTimestamp(blockStatus.blockedUntil)}`);
    lines.push(`🕐 Remaining: ${formatRemainingDuration(blockStatus.remainingMs)}`);
  }
  lines.push('', 'Use /pair <number> to pair WhatsApp.');
  return box('ANIME MD • MY ACCOUNT', lines);
}

function adminPanelBox({ controllers = 0, premiumUsers = 0, totalUsers = 0, blockedUsers = 0, sessions = 0 }) {
  return box('ANIME MD • ADMIN PANEL', [
    '',
    '🛡 Admin Control Center',
    '',
    `👤 Total Users: ${totalUsers}`,
    `🤖 Controllers: ${controllers}`,
    `💎 Premium Users: ${premiumUsers}`,
    `🚫 Blocked: ${blockedUsers}`,
    `📱 Active Sessions: ${sessions}`,
    '',
    'Select a section below:'
  ]);
}

function userManagementBox({ total, recent = [] }) {
  const lines = [
    '',
    `👤 Total Users: ${total}`,
    '',
  ];
  if (recent.length) {
    lines.push('Recent Users:');
    for (const u of recent.slice(0, 5)) {
      lines.push(` • ${u.id} — ${u.role || 'normal'} ${u.verified ? '✅' : '❌'}`);
    }
  } else {
    lines.push('No users yet.');
  }
  lines.push('', 'Use /block <id> /unblock <id>');
  lines.push('/addprem <id> /addvip <id>');
  return box('ANIME MD • USER MANAGEMENT', lines);
}

function pairingUsageBox({ users = [] }) {
  const lines = ['', '📊 Pairing Usage:', ''];
  if (!users.length) {
    lines.push('📭 No usage data yet.');
  } else {
    for (const u of users.slice(0, 10)) {
      lines.push(` • ${u.id}: ${u.count} number(s)`);
    }
    if (users.length > 10) lines.push(` • +${users.length - 10} more`);
  }
  return box('ANIME MD • PAIRING USAGE', lines);
}

function systemStatusBox({ uptime, sessions, publicMode, premiumOnly, version = '1.0.0' }) {
  return box('ANIME MD • SYSTEM STATUS', [
    '',
    `🤖 Bot Version: ${version}`,
    `⏱ Uptime: ${Math.floor(uptime / 60)}m`,
    `📱 Sessions: ${sessions}`,
    `🌍 Public Mode: ${publicMode ? 'ON' : 'OFF'}`,
    `💎 Premium Only: ${premiumOnly ? 'ON' : 'OFF'}`,
    '',
    '✅ System Operational'
  ]);
}

// Session states shown to users. CONNECTED is only ever reported after the
// WhatsApp socket actually reached connection open.
const SESSION_STATE_BADGES = Object.freeze({
  CONNECTED: '🟢 CONNECTED',
  PAIRING_READY: '🟡 PAIRING',
  CODE_GENERATED: '🟡 PAIRING',
  WAITING_FOR_LINK: '🟡 PAIRING',
  CONNECTING: '🔵 CONNECTING',
  INITIALIZING: '🔵 CONNECTING',
  LOCKING: '🔵 CONNECTING',
  VALIDATING: '🔵 CONNECTING',
  NORMALIZING: '🔵 CONNECTING',
  RECEIVED: '🔵 CONNECTING',
  RECONNECTING: '🟠 RECONNECTING',
  OFFLINE: '🔴 OFFLINE',
  FAILED: '⚠️ FAILED',
  EXPIRED: '⚠️ FAILED',
  LOGGED_OUT: '⚠️ FAILED',
  CLEANUP: '⚠️ FAILED'
});

function stateBadge(status) {
  return SESSION_STATE_BADGES[status] || `⚠️ ${status}`;
}

function badgeParts(status) {
  const badge = stateBadge(status);
  const space = badge.indexOf(' ');
  return space === -1 ? { icon: badge, label: '' } : { icon: badge.slice(0, space), label: badge.slice(space + 1) };
}

function sessionsBox(sessions) {
  if (!sessions.length) {
    return box('ANIME MD • SESSIONS', [
      '',
      '📭 No sessions yet.',
      '',
      'Use /pair <number> to pair a WhatsApp number.'
    ]);
  }
  const lines = sessions.map((session) => {
    const { icon, label } = badgeParts(session.status);
    return `${icon} ${session.numberDisplay} — ${label || session.status}`;
  });
  return box('ANIME MD • SESSIONS', [
    '',
    ...lines,
    '',
    `Total: ${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
    '',
    'Tap a session below to manage it.'
  ]);
}

function statusBox(session, { ownerId } = {}) {
  const { icon, label } = badgeParts(session.status);
  const lines = [
    '',
    `📱 Number: ${session.numberDisplay}`,
    `${icon} Status: ${label || session.status}`,
    `🔗 Paired: ${session.registered ? 'yes' : 'no'}`,
    `🔄 Reconnects: ${session.reconnects}`
  ];
  if (ownerId) lines.push(`👤 Owner: ${ownerId}`);
  lines.push('', 'Your ANIME MD session.');
  return box('ANIME MD • SESSION STATUS', lines);
}

function overallStatusBox(sessions, controllerUptimeSeconds) {
  const lines = [
    '',
    `🤖 Controller: Online (${Math.floor(controllerUptimeSeconds / 60)}m uptime)`,
    `📱 WhatsApp sessions: ${sessions.length}`
  ];
  if (sessions.length) {
    lines.push('', ...sessions.map((session) => {
      const { icon, label } = badgeParts(session.status);
      return `${icon} ${session.numberDisplay} — ${label || session.status}`;
    }));
  } else {
    lines.push('', 'No WhatsApp sessions yet.', 'Telegram online ≠ WhatsApp connected.', 'Use /pair <number> to pair.');
  }
  return box('ANIME MD • STATUS', lines);
}

function settingsBox({ id, premium, owner, sessionsUsed, sessionLimit, publicMode, premiumOnly, brand, controllers, premiumUsers }) {
  if (owner) {
    return box('ANIME MD • SETTINGS', [
      '',
      '👑 Master Control',
      `🤖 Controllers: ${controllers}`,
      `💎 Premium users: ${premiumUsers}`,
      `🌍 Public pairing: ${publicMode ? 'ON 🌍' : 'OFF 🔒'}`,
      `💎 Premium-only pairing: ${premiumOnly ? 'ON 🔒' : 'OFF 🌍'}`,
      `🔐 Pairing code: ${brand || 'WhatsApp-generated'}`,
      '',
      'Toggle with the buttons below.'
    ]);
  }
  return box('ANIME MD • SETTINGS', [
    '',
    `👤 User: ${id}`,
    `💎 Premium: ${premium ? 'Active ✅' : 'Inactive ❌'}`,
    `📱 Sessions: ${sessionsUsed}/${Number.isFinite(sessionLimit) ? sessionLimit : '∞'}`,
    `🌍 Public pairing: ${publicMode ? 'ON 🌍' : 'OFF 🔒'}`,
    `💎 Premium-only pairing: ${premiumOnly ? 'ON 🔒' : 'OFF 🌍'}`
  ]);
}

// Map stable pairing error codes to friendly user-facing reasons. Unknown
// errors never leak their raw text to Telegram.
const PAIRING_ERROR_TEXTS = Object.freeze({
  INVALID_NUMBER: { lines: ['The number format is invalid.', 'Use the full international number with', 'country code, without + (example: 923001234567).'], retry: true },
  ALREADY_PAIRED: { lines: ['This number is already paired on this controller.', 'Use /status <number> or /restart <number>.'], retry: false },
  LOCKED: { lines: ['This number already has an active pairing', 'or session on another controller.'], retry: false },
  BUSY: { lines: ['The pairing system is busy right now.'], retry: true },
  QUEUE_TIMEOUT: { lines: ['The pairing system is busy right now.'], retry: true },
  COOLDOWN: { lines: ['You are starting pairings too quickly.'], retry: true },
  LIMIT: { lines: ['The session limit for this controller is reached.', 'Stop an unused session with /stop first.'], retry: false },
  PAIRING_TIMEOUT: { lines: ['WhatsApp did not become ready for pairing in time.', 'This is usually a network issue — try again.'], retry: true },
  CONNECTION_CLOSED: { lines: ['WhatsApp closed the connection before', 'pairing was completed.'], retry: true },
  NOT_FOUND: { lines: ['No session found for that number', 'on this controller.'], retry: false },
  NOT_PAIRED: { lines: ['That number is not paired yet.', 'Use /pair first.'], retry: false },
  CONNECTED: { lines: ['This session is connected.', 'Remove it from WhatsApp → Linked Devices first, then /stop again.'], retry: false },
  SHUTDOWN: { lines: ['The pairing system is restarting. Please try again shortly.'], retry: true },
  CANCELLED: { lines: ['The pairing request was cancelled.'], retry: true }
});

function friendlyPairingError(error) {
  const mapped = error?.code ? PAIRING_ERROR_TEXTS[error.code] : undefined;
  if (mapped) return { lines: mapped.lines, retry: mapped.retry };
  return { lines: ['An unexpected error occurred while pairing.'], retry: true };
}

function friendlyReasonLine(error) {
  if (error?.code === 'PAIRING_TIMEOUT') return 'The WhatsApp connection timed out.';
  if (error?.code) {
    const friendly = friendlyPairingError(error);
    if (friendly.lines?.length) return friendly.lines[0];
  }
  return 'The WhatsApp connection timed out.';
}

function helpText() {
  return [
    '╭━━〔 ANIME MD • HELP 〕━╮',
    '┃',
    '┃ /start — open the bot',
    '┃ /verify — complete verification',
    '┃ /pair <number> — pair a WhatsApp number',
    '┃ /myaccount — your account info',
    '┃ /sessions — list your WhatsApp sessions',
    '┃ /status [number] — session status',
    '┃ /stop <number> — remove an unpaired session',
    '┃ /restart <number> — bring a paired session back online',
    '┃ /guide — pairing guide (English + Roman Urdu)',
    '┃ /settings — your settings and limits',
    '┃ /myid — show your Telegram ID',
    '┃ /premium — premium status',
    '┃ /admin — admin panel (admin/owner)',
    '┃ /addowner <telegram_id> — authorize a controller',
    '┃ /delowner <telegram_id> — remove a controller',
    '┃ /addprem <id> [30d] — grant premium (owner)',
    '┃ /delprem <id> — revoke premium (owner)',
    '┃ /addvip <id> [30d] — grant VIP (owner)',
    '┃ /delvip <id> — revoke VIP (owner)',
    '┃ /block <id> [24h] — block a user (owner)',
    '┃ /unblock <id> — unblock a user (owner)',
    '┃ /listpaired — all sessions (owner)',
    '┃ /help — show this help',
    '┃',
    '┃ Aliases: /delpair = /stop,',
    '┃ /listsessions = /sessions',
    '┃',
    '┃ Number format: country code + number,',
    '┃ no + required (example: 923001234567).',
    '╰' + '━'.repeat(23) + '╯'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Inline keyboards. Every button below has a handler in handleCallback().
// ---------------------------------------------------------------------------

function homeMarkup() {
  return { inline_keyboard: [[
    { text: '🔗 Pair WhatsApp', callback_data: 'pair:new' },
    { text: '📱 My Sessions', callback_data: 'nav:sessions' }
  ], [
    { text: '📊 Status', callback_data: 'nav:status' },
    { text: '📖 Pairing Guide', callback_data: 'nav:guide' }
  ], [
    { text: '⚙️ Settings', callback_data: 'nav:settings' },
    { text: '❓ Help', callback_data: 'nav:help' }
  ]] };
}

// Role-aware home markup
function roleHomeMarkup(role) {
  const isPrivileged = role === 'owner' || role === 'admin';
  const rows = [
    [
      { text: '📱 Pair WhatsApp', callback_data: 'pair:new' },
      { text: '📊 My Account', callback_data: 'nav:account' }
    ],
    [
      { text: '📱 My Sessions', callback_data: 'nav:sessions' },
      { text: '📊 Status', callback_data: 'nav:status' }
    ],
    [
      { text: '📖 Commands', callback_data: 'nav:help' },
      { text: 'ℹ️ Guide', callback_data: 'nav:guide' }
    ],
    [
      { text: '⚙️ Settings', callback_data: 'nav:settings' }
    ]
  ];
  if (isPrivileged) {
    rows.push([{ text: '🛡 Admin Panel', callback_data: 'nav:admin' }]);
  }
  // Always add home for consistency in callback edits
  return { inline_keyboard: rows };
}

// Backward-compatible export name for the dashboard keyboard.
const menuMarkup = homeMarkup;

function verifyMarkup() {
  return { inline_keyboard: [[{ text: '✅ Verify', callback_data: 'verify:me' }]] };
}

// The Copy Code button uses Telegram's native copy-text. It copies ONLY the
// code — never the number, the instructions, or the surrounding text. A
// regenerate (callback) and home (callback) button accompany it.
function pairingCodeMarkup(code, flowToken) {
  return { inline_keyboard: [
    [{ text: '📋 Copy Code', copy_text: { text: code } }],
    [{ text: '🔄 Generate New Code', callback_data: `pair:regen:${flowToken}` }, { text: '🏠 Home', callback_data: 'home' }]
  ] };
}

function pairingFailureMarkup(flowToken) {
  return { inline_keyboard: [
    [{ text: '🔄 Generate New Code', callback_data: `pair:regen:${flowToken}` }],
    [{ text: '🏠 Home', callback_data: 'home' }]
  ] };
}

function guideMarkup() {
  return { inline_keyboard: [[
    { text: '🔗 Pair WhatsApp', callback_data: 'pair:new' }
  ], [
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

function sessionsMarkup(sessions) {
  const rows = sessions.slice(0, MAX_SESSION_BUTTONS).map((session) => [{
    text: `📱 ${session.numberDisplay}`,
    callback_data: `ses:menu:${session.number}`
  }]);
  rows.push([
    { text: '🔄 Refresh', callback_data: 'nav:sessions' },
    { text: '🏠 Home', callback_data: 'home' }
  ]);
  return { inline_keyboard: rows };
}

function sessionMenuMarkup(number) {
  return { inline_keyboard: [[
    { text: '🔄 Restart', callback_data: `ses:restart:${number}` },
    { text: '🗑 Remove', callback_data: `ses:stop:${number}` }
  ], [
    { text: '⬅️ Back', callback_data: 'nav:sessions' },
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

function stopConfirmMarkup(number) {
  return { inline_keyboard: [[
    { text: '🗑 Yes, remove it', callback_data: `ses:stopok:${number}` },
    { text: '❌ Cancel', callback_data: `ses:menu:${number}` }
  ]] };
}

function connectedMarkup() {
  return { inline_keyboard: [[
    { text: '📱 My Sessions', callback_data: 'nav:sessions' },
    { text: '📊 Status', callback_data: 'nav:status' }
  ]] };
}

function retryMarkup() {
  return { inline_keyboard: [[
    { text: '🔄 Try Again', callback_data: 'pair:new' },
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

function pairAgainMarkup() {
  return { inline_keyboard: [[
    { text: '🔗 Pair Again', callback_data: 'pair:new' },
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

function backHomeMarkup() {
  return { inline_keyboard: [[
    { text: '⬅️ Back', callback_data: 'nav:sessions' },
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

function homeOnlyMarkup() {
  return { inline_keyboard: [[{ text: '🏠 Home', callback_data: 'home' }]] };
}

function accountMarkup() {
  return { inline_keyboard: [[
    { text: '🔗 Pair WhatsApp', callback_data: 'pair:new' },
    { text: '📱 My Sessions', callback_data: 'nav:sessions' }
  ], [
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

function adminPanelMarkup() {
  return { inline_keyboard: [
    [{ text: '👤 Users', callback_data: 'admin:users' }, { text: '⭐ Premium', callback_data: 'admin:premium' }],
    [{ text: '👑 VIP', callback_data: 'admin:vip' }, { text: '🚫 Block', callback_data: 'admin:block' }],
    [{ text: '🔎 Lookup', callback_data: 'admin:lookup' }, { text: '📊 Usage', callback_data: 'admin:usage' }],
    [{ text: '🛡 Access', callback_data: 'admin:access' }, { text: '⚙️ System', callback_data: 'admin:system' }],
    [{ text: '🏠 Home', callback_data: 'home' }]
  ] };
}

function settingsMarkup({ owner, publicMode, premiumOnly }) {
  if (!owner) return { inline_keyboard: [[{ text: '🏠 Home', callback_data: 'home' }]] };
  return { inline_keyboard: [[
    { text: publicMode ? '🔒 Public OFF' : '🌍 Public ON', callback_data: `set:public:${publicMode ? 'off' : 'on'}` },
    { text: premiumOnly ? '💎 Premium OFF' : '💎 Premium ON', callback_data: `set:prem:${premiumOnly ? 'off' : 'on'}` }
  ], [
    { text: '🔄 Refresh', callback_data: 'nav:settings' },
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

const BOOTSTRAP_COMMANDS = new Set(['addowner', 'delowner', 'addprem', 'delprem', 'addvip', 'delvip', 'block', 'unblock', 'listpaired']);
const OPEN_COMMANDS = new Set(['start', 'help', 'guide', 'myid', 'verify', 'myaccount', 'account']);

// Public-chat safety: number-revealing and management operations must never
// leak a user's phone number (or the bot's internals) into a group/supergroup.
// A chat without an explicit type (our unit-test fixtures) is treated as
// private so the controller keeps behaving for direct messages.
function chatIsPrivate(chat) {
  return !chat?.type || chat.type === 'private';
}

class TelegramController {
  constructor({
    token, owners = [], controllerStore, pairing, startImage = '', connectedImage = '',
    publicMode = false, premiumOnly = false, requiredChannels = [], sessionLimit = 5, codeSource = '',
    fetchImpl = globalThis.fetch, log = console
  }) {
    this.token = token;
    this.bootstrapOwners = new Set(owners.map(normalizeTelegramId));
    this.controllerStore = controllerStore;
    this.pairing = pairing;
    this.startImage = startImage;
    this.connectedImage = connectedImage;
    this.publicMode = Boolean(publicMode);
    this.premiumOnly = Boolean(premiumOnly);
    this.requiredChannels = requiredChannels
      .filter((channel) => channel && String(channel.chatId || '').trim())
      .map((channel) => ({ name: String(channel.name || 'Channel').slice(0, 60), chatId: String(channel.chatId).trim() }));
    this.sessionLimit = Number.isSafeInteger(sessionLimit) && sessionLimit > 0 ? sessionLimit : 5;
    this.codeSource = String(codeSource || '');
    this.fetch = fetchImpl;
    this.log = log;
    this.offset = 0;
    this.running = false;
    this.startedAt = undefined;
    this.bot = undefined;
    this.pollPromise = undefined;
    this.settingsLoaded = false;
    this.sensitiveRequests = new Map();
    this.sensitiveLocks = new Map();
    this.pendingPairNumbers = new Map();
    // One active single-message pairing flow per Telegram user.
    this.pairingFlows = new Map();
  }

  // ------------------------------ access ----------------------------------

  async loadSettings() {
    if (this.settingsLoaded) return;
    this.settingsLoaded = true;
    if (typeof this.controllerStore?.getSettings !== 'function') return;
    try {
      const persisted = await this.controllerStore.getSettings();
      if (typeof persisted?.publicMode === 'boolean') this.publicMode = persisted.publicMode;
      if (typeof persisted?.premiumOnly === 'boolean') this.premiumOnly = persisted.premiumOnly;
    } catch (error) {
      this.log.warn?.(`[telegram] Could not load persisted settings: ${error.message}`);
    }
  }

  async persistSetting(key, value) {
    this[key] = Boolean(value);
    if (typeof this.controllerStore?.setSetting !== 'function') return;
    try {
      await this.controllerStore.setSetting(key, Boolean(value));
    } catch (error) {
      this.log.warn?.(`[telegram] Could not persist the ${key} setting: ${error.message}`);
    }
  }

  isBootstrapOwner(id) {
    return this.bootstrapOwners.has(normalizeTelegramId(id));
  }

  async authorized(id) {
    const normalized = normalizeTelegramId(id);
    return this.bootstrapOwners.has(normalized) || await this.controllerStore.has(normalized);
  }

  // bootstrap > controller > public (any user) — never 'none' for normal users
  // This fixes the /start ACCESS DENIED bug: normal users must be able to register.
  async accessOf(id) {
    await this.loadSettings();
    if (this.isBootstrapOwner(id)) return 'bootstrap';
    if (await this.authorized(id)) return 'controller';
    // Any Telegram user is at least public/normal — publicMode no longer blocks /start
    return 'public';
  }

  // owner > admin > vip > premium > normal, driven entirely by the database.
  async roleOf(id) {
    const access = await this.accessOf(id);
    if (access === 'bootstrap') return 'owner';
    if (access === 'controller') return 'admin';
    const vip = await this.vipStatusOf(id);
    if (vip.vip) return 'vip';
    const premium = await this.premiumStatusOf(id);
    if (premium.premium) return 'premium';
    return 'normal';
  }

  async pairingLimitOf(id) {
    const role = await this.roleOf(id);
    if (role === 'owner' || role === 'admin' || role === 'vip') return Infinity;
    if (role === 'premium') return PREMIUM_PAIRING_LIMIT;
    return NORMAL_PAIRING_LIMIT;
  }

  async pairingUsageOf(id) {
    let pairedNumbers = [];
    if (typeof this.controllerStore?.pairedNumbersOf === 'function') {
      try {
        pairedNumbers = await this.controllerStore.pairedNumbersOf(id) || [];
      } catch (error) {
        this.log.warn?.(`[telegram] Could not read paired-number usage for ${id}: ${error.message}`);
      }
    }
    let sessions = [];
    try {
      sessions = await this.pairing.listSessions(id) || [];
    } catch {
      sessions = [];
    }
    // Merge unique numbers from both sources for backward compatibility
    const unique = new Set();
    for (const n of pairedNumbers) {
      const canonical = String(n).replace(/\D/g, '');
      if (/^\d{7,15}$/.test(canonical)) unique.add(canonical);
    }
    for (const s of sessions) {
      const canonical = String(s.number || '').replace(/\D/g, '');
      if (/^\d{7,15}$/.test(canonical)) unique.add(canonical);
    }
    // If pairedNumbers empty but sessions exist, count sessions
    if (unique.size === 0 && sessions.length) return sessions.length;
    // If we have pairedNumbers, return its size (or merged size)
    if (pairedNumbers.length) {
      // Return merged size to avoid undercounting
      return unique.size;
    }
    return sessions.length;
  }

  async premiumStatusOf(id) {
    const normalized = normalizeTelegramId(id);
    if (this.isBootstrapOwner(normalized)) return { premium: true, bootstrap: true, expiresAt: undefined };
    if (typeof this.controllerStore?.hasPremium !== 'function') return { premium: false };
    try {
      const record = await this.controllerStore.hasPremium(normalized);
      if (record && typeof record === 'object') return { premium: Boolean(record.premium), expiresAt: record.expiresAt };
      return { premium: Boolean(record) };
    } catch (error) {
      this.log.warn?.(`[telegram] Could not read premium status for ${normalized}: ${error.message}`);
      return { premium: false };
    }
  }

  async vipStatusOf(id) {
    if (this.isBootstrapOwner(id)) return { vip: true };
    if (typeof this.controllerStore?.vipStatus === 'function') {
      try {
        return await this.controllerStore.vipStatus(id);
      } catch (error) {
        this.log.warn?.(`[telegram] Could not read VIP status for ${id}: ${error.message}`);
        return { vip: false };
      }
    }
    return { vip: false };
  }

  async isVerified(id) {
    if (this.isBootstrapOwner(id)) return true;
    if (await this.authorized(id)) return true;
    if (typeof this.controllerStore?.isVerified === 'function') {
      try {
        return await this.controllerStore.isVerified(id);
      } catch (error) {
        this.log.warn?.(`[telegram] Could not read verification for ${id}: ${error.message}`);
        return false;
      }
    }
    return false;
  }

  async mustVerify(id) {
    const access = await this.accessOf(id);
    if (access === 'bootstrap' || access === 'controller') return false;
    return !(await this.isVerified(id));
  }

  async markVerified(id) {
    if (typeof this.controllerStore?.markVerified === 'function') {
      await this.controllerStore.markVerified(id);
    }
  }

  async ensureUserExists(id) {
    const normalized = normalizeTelegramId(id);
    try {
      if (typeof this.controllerStore?.getUser === 'function') {
        const existing = await this.controllerStore.getUser(normalized);
        if (existing) return existing;
      }
      if (typeof this.controllerStore?.updateUser === 'function') {
        // Preserve existing, create if missing with verified false
        return await this.controllerStore.updateUser(normalized, { verified: false });
      }
    } catch (error) {
      this.log.warn?.(`[telegram] Could not ensure user exists for ${normalized}: ${error.message}`);
    }
    return undefined;
  }

  async checkBlocked(id) {
    if (this.isBootstrapOwner(id)) return { blocked: false };
    if (typeof this.controllerStore?.blockStatus === 'function') {
      try {
        return await this.controllerStore.blockStatus(id);
      } catch (error) {
        this.log.warn?.(`[telegram] Could not read block status for ${id}: ${error.message}`);
        return { blocked: false };
      }
    }
    return { blocked: false };
  }

  // Optional channel-join verification before pairing. Bootstrap owners skip
  // it. Fails closed (with a clear log) when the membership cannot be checked.
  async joinedRequiredChannels(senderId) {
    if (!this.requiredChannels.length) return { ok: true };
    if (this.isBootstrapOwner(senderId)) return { ok: true };
    for (const channel of this.requiredChannels) {
      try {
        const member = await this.api('getChatMember', { chat_id: channel.chatId, user_id: Number(senderId) });
        if (!['member', 'administrator', 'creator'].includes(member?.status)) {
          return { ok: false, channel };
        }
      } catch (error) {
        this.log.warn?.(`[telegram] Could not verify membership of ${senderId} in ${channel.chatId}: ${error.message}`);
        return { ok: false, channel };
      }
    }
    return { ok: true };
  }

  // ------------------------------ Telegram API ----------------------------

  async api(method, payload) {
    const response = await this.fetch(`${TELEGRAM_API}/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API request failed (${response.status}).`);
    return result.result;
  }

  async reply(chatId, text, replyMarkup) {
    return this.api('sendMessage', { chat_id: chatId, text: escapeTelegramHtml(text), parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  async replyPhoto(chatId, image, caption, replyMarkup) {
    if (!image) return this.reply(chatId, caption, replyMarkup);
    return this.api('sendPhoto', { chat_id: chatId, photo: image, caption: escapeTelegramHtml(caption), parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  // Edits an existing message when it is still editable; otherwise sends a
  // new one. Used by the inline navigation so the chat stays clean.
  async present(chatId, messageId, text, replyMarkup) {
    if (messageId) {
      try {
        return await this.api('editMessageText', {
          chat_id: chatId, message_id: messageId,
          text: escapeTelegramHtml(text), parse_mode: 'HTML',
          ...(replyMarkup ? { reply_markup: replyMarkup } : {})
        });
      } catch (error) {
        if (/not modified/i.test(String(error?.message))) return undefined;
        // fall through to sending a new message (too old, deleted, etc.)
      }
    }
    return this.reply(chatId, text, replyMarkup);
  }

  // Edits the single pairing message. Falls back to a new message when the id
  // is missing or the message can no longer be edited (deleted / too old).
  async editMessage(chatId, messageId, text, replyMarkup) {
    if (messageId) {
      try {
        return await this.api('editMessageText', {
          chat_id: chatId, message_id: messageId,
          text: escapeTelegramHtml(text), parse_mode: 'HTML',
          ...(replyMarkup ? { reply_markup: replyMarkup } : {})
        });
      } catch (error) {
        if (/not modified/i.test(String(error?.message))) return undefined;
        // fall through to sending a new message (too old, deleted, etc.)
      }
    }
    return this.reply(chatId, text, replyMarkup);
  }

  reserveSensitiveRequest(senderId, scope = 'global') {
    const key = `${String(senderId)}:${String(scope)}`;
    const now = Date.now();
    const active = this.sensitiveLocks.get(key);
    if (active && now - active < SENSITIVE_LOCK_TTL_MS) {
      throw Object.assign(new Error('That sensitive operation is already in progress. Please wait for it to finish.'), { code: 'BUSY' });
    }
    const previous = this.sensitiveRequests.get(key) || 0;
    if (now - previous < SENSITIVE_COOLDOWN_MS) {
      throw Object.assign(new Error(`Please wait ${Math.ceil((SENSITIVE_COOLDOWN_MS - (now - previous)) / 1000)} seconds before another sensitive operation.`), { code: 'COOLDOWN' });
    }
    this.sensitiveRequests.set(key, now);
    this.sensitiveLocks.set(key, now);
    return () => this.sensitiveLocks.delete(key);
  }

  prunePendingState() {
    const now = Date.now();
    for (const [key, entry] of this.pendingPairNumbers) {
      if (!entry || entry.expiresAt <= now) this.pendingPairNumbers.delete(key);
    }
    // Any pairing flow whose message can no longer be identified is dropped.
    for (const [key, flow] of this.pairingFlows) {
      if (flow?.expiresAt && flow.expiresAt <= now) {
        this.stopSpinner(flow);
        this.pairingFlows.delete(key);
      }
    }
  }

  newFlowToken() {
    return crypto.randomBytes(12).toString('hex');
  }

  flowKey(senderId) {
    return String(senderId);
  }

  getFlow(senderId) {
    return this.pairingFlows.get(this.flowKey(senderId));
  }

  // ------------------------------ pairing flow ----------------------------

  startSpinner(flow) {
    this.stopSpinner(flow);
    flow.spinnerFrame = 0;
    const tick = async () => {
      if (flow.stopped || this.pairingFlows.get(flow.senderKey) !== flow) return;
      flow.spinnerFrame = (flow.spinnerFrame + 1) % SPINNER_FRAMES.length;
      const frame = SPINNER_FRAMES[flow.spinnerFrame];
      try {
        const text = pairingLoadingBox(flow.numberDisplay, frame);
        flow.messageId = (await this.editMessage(flow.chatId, flow.messageId, text, undefined))?.message_id || flow.messageId;
      } catch (error) {
        // The spinner must never break the pairing flow.
      }
      if (!flow.stopped && this.pairingFlows.get(flow.senderKey) === flow) {
        flow.spinnerTimer = setTimeout(tick, SPINNER_INTERVAL_MS);
        flow.spinnerTimer.unref?.();
      }
    };
    flow.spinnerTimer = setTimeout(tick, SPINNER_INTERVAL_MS);
    flow.spinnerTimer.unref?.();
  }

  stopSpinner(flow) {
    if (flow?.spinnerTimer) {
      clearTimeout(flow.spinnerTimer);
      flow.spinnerTimer = undefined;
    }
  }

  async startPairingAttempt(senderId, number, input, flow) {
    const limit = await this.pairingLimitOf(senderId);
    const result = await this.pairing.requestPairing(senderId, input || number, { sessionLimit: limit });
    if (flow.stopped) return result;
    this.stopSpinner(flow);
    flow.state = 'WAITING';
    flow.code = result.code;
    flow.displayCode = result.displayCode;
    flow.expiresAt = result.expiresAt;
    flow.messageId = (await this.editMessage(flow.chatId, flow.messageId, codeReadyBox(result), pairingCodeMarkup(result.displayCode, flow.token)))?.message_id || flow.messageId;
    // Do NOT record paired number here — only on successful WhatsApp connection
    // to avoid consuming slots for failed attempts.
    return result;
  }

  async failPairingAttempt(flow, error) {
    if (flow.stopped) return;
    this.stopSpinner(flow);
    flow.state = 'FAILED';
    const friendly = friendlyPairingError(error);
    // Classified errors keep their informative, user-safe reason lines. A bare
    // connection timeout still renders the exact ANIME MD FAILED box.
    const text = error?.code && friendly.lines?.length
      ? pairingFailureBox(flow.numberDisplay, friendly.lines, { retry: friendly.retry })
      : pairingFailureBox(flow.numberDisplay, friendlyReasonLine(error));
    await this.editMessage(flow.chatId, flow.messageId, text, pairingFailureMarkup(flow.token));
  }

  async maybeRecordPairedNumber(senderId, number) {
    if (typeof this.controllerStore?.addPairedNumber === 'function') {
      try {
        await this.controllerStore.addPairedNumber(senderId, number);
      } catch (error) {
        this.log.warn?.(`[telegram] Could not record a paired number for ${senderId}: ${error.message}`);
      }
    }
  }

  async maybeRemovePairedNumber(senderId, number) {
    if (typeof this.controllerStore?.removePairedNumber === 'function') {
      try {
        await this.controllerStore.removePairedNumber(senderId, number);
      } catch (error) {
        this.log.warn?.(`[telegram] Could not clear a paired number for ${senderId}: ${error.message}`);
      }
    }
  }

  // ------------------------------ pairing ---------------------------------

  async beginPairPrompt(chatId, senderId) {
    this.pendingPairNumbers.set(String(senderId), { chatId, expiresAt: Date.now() + PENDING_NUMBER_TTL_MS });
    return this.reply(chatId, [
      '📱 Send your WhatsApp number with country code, for example 923001234567. Do not include a plus sign.',
      '',
      'Roman Urdu: Country code ke sath apna WhatsApp number bhejein, plus (+) ke baghair — misal: 923001234567.'
    ].join('\n'), { force_reply: true, input_field_placeholder: '923001234567' });
  }

  // The /pair flow uses a SINGLE Telegram message. The PREPARING box is sent
  // once and the same message is edited through LOADING → CODE → WAITING, or
  // FAILED. No second Telegram message is ever sent for the pairing lifecycle.
  async handlePairCommand(command) {
    const chatId = command.chatId;
    const senderId = command.senderId;
    const senderKey = String(senderId);
    const input = command.args.join('');
    let number;
    try {
      number = normalizeWhatsAppNumber(input);
    } catch (error) {
      const friendly = friendlyPairingError(error);
      await this.reply(chatId, pairingFailedBox(friendly.lines, { retry: friendly.retry }));
      return;
    }
    const numberDisplay = formatInternationalNumber(number);

    if (this.premiumOnly) {
      const premium = await this.premiumStatusOf(senderId);
      const vip = await this.vipStatusOf(senderId);
      if (!premium.premium && !vip.vip) {
        await this.reply(chatId, premiumRequiredBox());
        return;
      }
    }

    const joined = await this.joinedRequiredChannels(senderId);
    if (!joined.ok) {
      await this.reply(chatId, channelsBox(this.requiredChannels));
      return;
    }

    // Check if number already paired — same number must not consume additional slot
    let alreadyPaired = false;
    try {
      if (typeof this.controllerStore?.pairedNumbersOf === 'function') {
        const paired = await this.controllerStore.pairedNumbersOf(senderId);
        alreadyPaired = paired.includes(number);
      }
      if (!alreadyPaired) {
        const sessions = await this.pairing.listSessions(senderId);
        alreadyPaired = sessions.some((s) => String(s.number) === String(number));
      }
    } catch {
      alreadyPaired = false;
    }

    const limit = await this.pairingLimitOf(senderId);
    const used = await this.pairingUsageOf(senderId);
    if (!alreadyPaired && Number.isFinite(limit) && used >= limit) {
      const release = this.reserveSensitiveRequest(senderKey, 'pair');
      try {
        await this.reply(chatId, limitBox(used, limit));
      } finally {
        release();
      }
      return;
    }

    const release = this.reserveSensitiveRequest(senderKey, 'pair');
    const token = this.newFlowToken();
    let sent;
    try {
      // The ONLY new Telegram message for the whole lifecycle.
      sent = await this.reply(chatId, pairingStartedBox(numberDisplay));
    } catch (error) {
      release();
      this.log.error?.(`[telegram] Could not start the pairing view: ${error.message}`);
      return;
    }
    const flow = {
      chatId, senderKey, number, numberDisplay,
      state: 'PREPARING', token,
      messageId: sent?.message_id,
      spinnerTimer: undefined, spinnerFrame: 0,
      code: undefined, displayCode: undefined, expiresAt: undefined,
      stopped: false
    };
    this.pairingFlows.set(senderKey, flow);
    this.startSpinner(flow);

    try {
      await this.startPairingAttempt(senderId, number, number, flow);
    } catch (error) {
      await this.failPairingAttempt(flow, error);
    } finally {
      release();
    }
  }

  async handleRegenerate(senderId, token, callback) {
    const flow = this.getFlow(senderId);
    if (!flow || flow.token !== token || flow.stopped || flow.senderKey !== String(senderId)) {
      throw Object.assign(new Error('This pairing code is no longer valid. Send /pair again.'), { code: 'EXPIRED' });
    }
    if (flow.state !== 'WAITING' && flow.state !== 'CODE' && flow.state !== 'FAILED') {
      throw Object.assign(new Error('This pairing code is no longer valid. Send /pair again.'), { code: 'EXPIRED' });
    }
    const chatId = flow.chatId;
    // Regeneration has its own rate-limit scope so a freshly generated code can
    // be regenerated immediately, while still throttling spam.
    const release = this.reserveSensitiveRequest(senderId, 'regen');
    try {
      this.stopSpinner(flow);
      // Cancel the previous (possibly still-open) pairing attempt and its
      // socket so a brand-new code is generated rather than returned.
      if (typeof this.pairing.cancelPairing === 'function') {
        await this.pairing.cancelPairing(senderId, flow.number, {});
      }
      flow.state = 'PREPARING';
      flow.code = undefined;
      flow.displayCode = undefined;
      flow.expiresAt = undefined;
      flow.messageId = (await this.editMessage(chatId, flow.messageId, pairingStartedBox(flow.numberDisplay), undefined))?.message_id || flow.messageId;
      this.startSpinner(flow);
      await this.startPairingAttempt(senderId, flow.number, flow.number, flow);
    } catch (error) {
      await this.failPairingAttempt(flow, error);
    } finally {
      release();
    }
  }

  async handleVerify(senderId, chatId, { messageId } = {}) {
    await this.markVerified(senderId);
    const role = await this.roleOf(senderId);
    return this.present(chatId, messageId, `${startupBox()}\n\n✅ Verification complete! Choose an action below, or use /help.`, roleHomeMarkup(role));
  }

  // ------------------------------ views -----------------------------------

  async sendSessionsView(chatId, senderId, { messageId, admin = false } = {}) {
    const sessions = await this.pairing.listSessions(senderId);
    return this.present(chatId, messageId, sessionsBox(sessions), sessionsMarkup(sessions));
  }

  async sendStatusView(chatId, senderId, { messageId } = {}) {
    const sessions = await this.pairing.listSessions(senderId);
    const text = overallStatusBox(sessions, (Date.now() - (this.startedAt || Date.now())) / 1000);
    return this.present(chatId, messageId, text, { inline_keyboard: [[
      { text: '🔄 Refresh', callback_data: 'nav:status' },
      { text: '🏠 Home', callback_data: 'home' }
    ]] });
  }

  async sendSessionMenuView(chatId, senderId, number, { messageId, admin = false } = {}) {
    const session = await this.pairing.statusOf(senderId, number, { admin });
    const foreign = admin && String(session.ownerId) !== String(senderId);
    return this.present(chatId, messageId, statusBox(session, { ownerId: foreign ? session.ownerId : undefined }), sessionMenuMarkup(session.number));
  }

  async sendSettingsView(chatId, senderId, { messageId, admin = false } = {}) {
    const premium = await this.premiumStatusOf(senderId);
    if (admin) {
      const controllers = typeof this.controllerStore?.read === 'function'
        ? (await this.controllerStore.read().catch(() => [])).length
        : 0;
      const premiumUsers = typeof this.controllerStore?.listPremium === 'function'
        ? (await this.controllerStore.listPremium().catch(() => [])).length
        : 0;
      const text = settingsBox({
        id: senderId, premium: premium.premium, owner: true,
        publicMode: this.publicMode, premiumOnly: this.premiumOnly,
        brand: this.codeSource || CODE_SOURCE_LABEL, controllers, premiumUsers
      });
      return this.present(chatId, messageId, text, settingsMarkup({ owner: true, publicMode: this.publicMode, premiumOnly: this.premiumOnly }));
    }
    const sessionsUsed = await this.pairingUsageOf(senderId);
    const limit = await this.pairingLimitOf(senderId);
    const text = settingsBox({
      id: senderId, premium: premium.premium, owner: false,
      sessionsUsed, sessionLimit: limit,
      publicMode: this.publicMode, premiumOnly: this.premiumOnly
    });
    return this.present(chatId, messageId, text, settingsMarkup({ owner: false }));
  }

  async sendAccountView(chatId, senderId, { messageId } = {}) {
    const role = await this.roleOf(senderId);
    const verified = await this.isVerified(senderId);
    const premium = await this.premiumStatusOf(senderId);
    const vip = await this.vipStatusOf(senderId);
    const owner = this.isBootstrapOwner(senderId);
    const pairedNumbers = typeof this.controllerStore?.pairedNumbersOf === 'function'
      ? await this.controllerStore.pairedNumbersOf(senderId).catch(() => [])
      : [];
    const limit = await this.pairingLimitOf(senderId);
    const used = await this.pairingUsageOf(senderId);
    const blockStatus = await this.checkBlocked(senderId);
    const text = accountBox({
      id: senderId, role, verified, premium, vip, owner,
      pairedNumbers, limit, used, blockStatus: blockStatus.blocked ? blockStatus : undefined
    });
    return this.present(chatId, messageId, text, accountMarkup());
  }

  async sendAdminPanelView(chatId, senderId, { messageId } = {}) {
    const access = await this.accessOf(senderId);
    if (access !== 'bootstrap' && access !== 'controller') {
      throw Object.assign(new Error('Only Admin/Owner can access Admin Panel.'), { code: 'DENIED' });
    }
    let totalUsers = 0;
    let controllers = 0;
    let premiumUsers = 0;
    let blockedUsers = 0;
    let sessions = 0;
    try {
      if (typeof this.controllerStore?.users === 'function') {
        const users = await this.controllerStore.users();
        totalUsers = Object.keys(users).length;
        blockedUsers = Object.values(users).filter((u) => u.blockedUntil && u.blockedUntil > Date.now()).length;
      }
      if (typeof this.controllerStore?.read === 'function') {
        controllers = (await this.controllerStore.read().catch(() => [])).length;
      }
      if (typeof this.controllerStore?.listPremium === 'function') {
        premiumUsers = (await this.controllerStore.listPremium().catch(() => [])).length;
      }
      if (typeof this.pairing?.listAllSessions === 'function') {
        sessions = (await this.pairing.listAllSessions().catch(() => [])).length;
      } else {
        sessions = (await this.pairing.listSessions(senderId).catch(() => [])).length;
      }
    } catch {}
    const text = adminPanelBox({ controllers, premiumUsers, totalUsers, blockedUsers, sessions });
    return this.present(chatId, messageId, text, adminPanelMarkup());
  }

  async sendUserManagementView(chatId, senderId, { messageId } = {}) {
    const access = await this.accessOf(senderId);
    if (access !== 'bootstrap' && access !== 'controller') throw Object.assign(new Error('Admin only'), { code: 'DENIED' });
    let users = {};
    try {
      if (typeof this.controllerStore?.users === 'function') users = await this.controllerStore.users();
    } catch {}
    const total = Object.keys(users).length;
    const recent = Object.entries(users).slice(-10).map(([id, rec]) => ({
      id,
      role: rec.vip ? 'vip' : rec.verified ? 'verified' : 'normal',
      verified: rec.verified
    }));
    const text = userManagementBox({ total, recent });
    return this.present(chatId, messageId, text, adminPanelMarkup());
  }

  async sendPairingUsageView(chatId, senderId, { messageId } = {}) {
    const access = await this.accessOf(senderId);
    if (access !== 'bootstrap' && access !== 'controller') throw Object.assign(new Error('Admin only'), { code: 'DENIED' });
    let users = {};
    try {
      if (typeof this.controllerStore?.users === 'function') users = await this.controllerStore.users();
    } catch {}
    const list = Object.entries(users).map(([id, rec]) => ({
      id,
      count: Array.isArray(rec.pairedNumbers) ? rec.pairedNumbers.length : 0
    })).filter((u) => u.count > 0).sort((a, b) => b.count - a.count);
    const text = pairingUsageBox({ users: list });
    return this.present(chatId, messageId, text, adminPanelMarkup());
  }

  async sendSystemStatusView(chatId, senderId, { messageId } = {}) {
    const access = await this.accessOf(senderId);
    if (access !== 'bootstrap' && access !== 'controller') throw Object.assign(new Error('Admin only'), { code: 'DENIED' });
    let sessions = 0;
    try {
      if (typeof this.pairing?.listAllSessions === 'function') sessions = (await this.pairing.listAllSessions().catch(() => [])).length;
      else sessions = (await this.pairing.listSessions(senderId).catch(() => [])).length;
    } catch {}
    const text = systemStatusBox({
      uptime: (Date.now() - (this.startedAt || Date.now())) / 1000,
      sessions,
      publicMode: this.publicMode,
      premiumOnly: this.premiumOnly
    });
    return this.present(chatId, messageId, text, adminPanelMarkup());
  }

  // ------------------------------ update routing --------------------------

  async handleUpdate(update) {
    if (update?.callback_query) return this.handleCallback(update.callback_query);
    this.prunePendingState();
    let command = commandFromUpdate(update);
    const message = update?.message;
    if (!command && message?.text?.trim() && message.from?.id != null && message.chat?.id != null) {
      const pending = this.pendingPairNumbers.get(String(message.from.id));
      if (pending && pending.expiresAt > Date.now() && String(pending.chatId) === String(message.chat.id)) {
        this.pendingPairNumbers.delete(String(message.from.id));
        command = { chatId: message.chat.id, senderId: message.from.id, name: 'pair', args: [message.text.trim()], text: message.text.trim() };
      }
    }
    if (!command?.chatId || !command.senderId) return;

    // Block check for ALL commands including open ones (except bootstrap owners bypass)
    if (!this.isBootstrapOwner(command.senderId)) {
      const block = await this.checkBlocked(command.senderId);
      if (block.blocked) {
        await this.reply(command.chatId, blockedBox(block.blockedUntil, block.remainingMs), homeOnlyMarkup());
        return;
      }
    }

    // Open, unauthenticated commands are always available.
    if (command.name === 'verify') {
      return this.handleVerify(command.senderId, command.chatId, {});
    }

    // /myid is intentionally open: a user needs their ID to be granted access.
    if (command.name === 'myid') {
      const premium = await this.premiumStatusOf(command.senderId);
      const vip = await this.vipStatusOf(command.senderId);
      const verified = await this.isVerified(command.senderId);
      return this.reply(command.chatId, myIdBox({
        id: command.senderId, premium: premium.premium, vip: vip.vip,
        owner: this.isBootstrapOwner(command.senderId), verified
      }), homeOnlyMarkup());
    }

    const access = await this.accessOf(command.senderId);
    if (access === 'none') {
      await this.reply(command.chatId, box('ANIME MD • ACCESS DENIED', ['', '❌ You are not authorized to control this bot.', '']));
      return;
    }
    if (BOOTSTRAP_COMMANDS.has(command.name) && access !== 'bootstrap') {
      await this.reply(command.chatId, box('ANIME MD • DENIED', ['', '❌ Only bootstrap owners (telegram.ownerIds in config.js) can use this command.', '']));
      return;
    }

    // Public-chat safety: private numbers and session details are never shared
    // in a group. Management/pairing commands are refused with a privacy-safe
    // notice so nothing sensitive leaks to third parties in the group.
    if (!chatIsPrivate(update?.message?.chat) && !OPEN_COMMANDS.has(command.name)) {
      await this.reply(command.chatId, box('ANIME MD • PRIVACY', ['', '🔒 This bot only works in a private chat.', '', 'Phone numbers and session details are', 'never shared in public chats.', '']));
      return;
    }

    // Functional verification enforcement. Restricted commands are denied until verified.
    if (!OPEN_COMMANDS.has(command.name)) {
      if (await this.mustVerify(command.senderId)) {
        await this.replyPhoto(command.chatId, this.startImage, `${startupBox()}\n\n${verifyBox()}`, verifyMarkup());
        return;
      }
    }

    try {
      switch (command.name) {
        case 'help':
          await this.reply(command.chatId, helpText(), homeOnlyMarkup());
          return;
        case 'start': {
          // Registration flow: ensure user exists, check block (already), check verification
          await this.ensureUserExists(command.senderId);
          if (await this.mustVerify(command.senderId)) {
            await this.replyPhoto(command.chatId, this.startImage, `${startupBox()}\n\n${verifyBox()}`, verifyMarkup());
            return;
          }
          const role = await this.roleOf(command.senderId);
          await this.replyPhoto(command.chatId, this.startImage, `${startupBox()}\n\nChoose an action below, or use /help.`, roleHomeMarkup(role));
          return;
        }
        case 'guide':
          await this.reply(command.chatId, guideBox(), guideMarkup());
          return;
        case 'myaccount':
        case 'account': {
          await this.sendAccountView(command.chatId, command.senderId, {});
          return;
        }
        case 'admin':
        case 'adminpanel': {
          await this.sendAdminPanelView(command.chatId, command.senderId, {});
          return;
        }
        case 'pair': {
          if (!command.args.length) {
            await this.beginPairPrompt(command.chatId, command.senderId);
            return;
          }
          await this.handlePairCommand(command);
          return;
        }
        case 'sessions':
        case 'listsessions': {
          const sessions = await this.pairing.listSessions(command.senderId);
          await this.reply(command.chatId, sessionsBox(sessions), sessionsMarkup(sessions));
          return;
        }
        case 'status': {
          if (command.args[0]) {
            const session = await this.pairing.statusOf(command.senderId, command.args[0], { admin: access === 'bootstrap' });
            const foreign = access === 'bootstrap' && String(session.ownerId) !== String(command.senderId);
            await this.reply(command.chatId, statusBox(session, { ownerId: foreign ? session.ownerId : undefined }), sessionMenuMarkup(session.number));
            return;
          }
          const sessions = await this.pairing.listSessions(command.senderId);
          const anyConnected = sessions.some((session) => session.connected);
          const text = overallStatusBox(sessions, (Date.now() - (this.startedAt || Date.now())) / 1000);
          if (anyConnected) await this.replyPhoto(command.chatId, this.connectedImage, text);
          else await this.reply(command.chatId, text);
          return;
        }
        case 'restart': {
          if (!command.args[0]) {
            await this.reply(command.chatId, box('ANIME MD • RESTART', ['', 'Usage: /restart <number>', '']));
            return;
          }
          const release = this.reserveSensitiveRequest(command.senderId, 'restart');
          try {
            const session = await this.pairing.restartSession(command.senderId, command.args[0], { admin: access === 'bootstrap' });
            await this.reply(command.chatId, box('ANIME MD • RESTARTING', ['', `📱 ${session.numberDisplay}`, `${badgeParts(session.status).icon} Status: ${badgeParts(session.status).label || session.status}`, '', 'The CONNECTED confirmation arrives', 'when WhatsApp reports the session online.']), backHomeMarkup());
          } finally {
            release();
          }
          return;
        }
        case 'addowner': {
          const release = this.reserveSensitiveRequest(command.senderId, 'addowner');
          try {
            const id = normalizeTelegramId(command.args[0]);
            await this.controllerStore.add(id);
            await this.reply(command.chatId, box('ANIME MD • CONTROLLER ADDED', ['', `✅ Telegram controller ${id} authorized.`, '']));
          } finally {
            release();
          }
          return;
        }
        case 'delowner': {
          const release = this.reserveSensitiveRequest(command.senderId, 'delowner');
          try {
            const id = normalizeTelegramId(command.args[0]);
            if (this.bootstrapOwners.has(id)) throw Object.assign(new Error('Bootstrap owners are configured through telegram.ownerIds in config.js and cannot be removed at runtime.'), { code: 'PROTECTED' });
            const removed = await this.controllerStore.remove(id);
            await this.reply(command.chatId, removed
              ? box('ANIME MD • CONTROLLER REMOVED', ['', `✅ Telegram controller ${id} removed.`, ''])
              : box('ANIME MD • INFO', ['', `Telegram controller ${id} was not stored.`, '']));
          } finally {
            release();
          }
          return;
        }
        case 'addprem': {
          const release = this.reserveSensitiveRequest(command.senderId, 'addprem');
          try {
            const id = normalizeTelegramId(command.args[0]);
            const duration = command.args[1] || '30d';
            const record = await this.controllerStore.addPremium(id, duration);
            await this.reply(command.chatId, box('ANIME MD • PREMIUM GRANTED', ['', `✅ ${id} is premium until`, `${new Date(record.expiresAt).toISOString().slice(0, 10)}.`, '']));
          } finally {
            release();
          }
          return;
        }
        case 'delprem': {
          const release = this.reserveSensitiveRequest(command.senderId, 'delprem');
          try {
            const id = normalizeTelegramId(command.args[0]);
            const removed = typeof this.controllerStore.removePremium === 'function' && await this.controllerStore.removePremium(id);
            await this.reply(command.chatId, removed
              ? box('ANIME MD • PREMIUM REMOVED', ['', `✅ Premium access removed from ${id}.`, ''])
              : box('ANIME MD • INFO', ['', `${id} has no active premium access.`, '']));
          } finally {
            release();
          }
          return;
        }
        case 'addvip': {
          const release = this.reserveSensitiveRequest(command.senderId, 'addvip');
          try {
            const id = normalizeTelegramId(command.args[0]);
            const duration = command.args[1] || '30d';
            const durationMs = parseDuration(duration);
            if (typeof this.controllerStore?.setVip !== 'function') throw Object.assign(new Error('VIP is not available.'), { code: 'PROTECTED' });
            await this.controllerStore.setVip(id, Date.now() + durationMs);
            await this.reply(command.chatId, box('ANIME MD • VIP GRANTED', ['', `✅ ${id} is VIP premium until`, `${new Date(Date.now() + durationMs).toISOString().slice(0, 10)}.`, '']));
          } finally {
            release();
          }
          return;
        }
        case 'delvip': {
          const release = this.reserveSensitiveRequest(command.senderId, 'delvip');
          try {
            const id = normalizeTelegramId(command.args[0]);
            const removed = typeof this.controllerStore?.removeVip === 'function' && await this.controllerStore.removeVip(id);
            await this.reply(command.chatId, removed
              ? box('ANIME MD • VIP REMOVED', ['', `✅ VIP access removed from ${id}.`, ''])
              : box('ANIME MD • INFO', ['', `${id} has no active VIP access.`, '']));
          } finally {
            release();
          }
          return;
        }
        case 'block': {
          const release = this.reserveSensitiveRequest(command.senderId, 'block');
          try {
            const id = normalizeTelegramId(command.args[0]);
            let durationMs = DEFAULT_BLOCK_DURATION_MS;
            if (command.args[1]) durationMs = parseDuration(command.args[1]);
            await this.controllerStore.setBlocked(id, durationMs);
            await this.reply(command.chatId, box('ANIME MD • USER BLOCKED', ['', `🚫 ${id} is blocked temporarily.`, '', `⏳ Unblocks: ${formatUnblockTimestamp(Date.now() + durationMs)}`, `🕐 Duration: ${formatRemainingDuration(durationMs)}`]));
          } finally {
            release();
          }
          return;
        }
        case 'unblock': {
          const release = this.reserveSensitiveRequest(command.senderId, 'unblock');
          try {
            const id = normalizeTelegramId(command.args[0]);
            await this.controllerStore.clearBlocked(id);
            await this.reply(command.chatId, box('ANIME MD • USER UNBLOCKED', ['', `✅ ${id} access has been restored.`, '']));
          } finally {
            release();
          }
          return;
        }
        case 'listpaired': {
          const sessions = typeof this.pairing.listAllSessions === 'function' ? await this.pairing.listAllSessions() : [];
          if (!sessions.length) {
            await this.reply(command.chatId, box('ANIME MD • ALL SESSIONS', ['', '📭 No paired sessions on this bot.', '']));
            return;
          }
          const lines = sessions.map((session) => `${badgeParts(session.status).icon} ${session.numberDisplay} — ${badgeParts(session.status).label || session.status} (user ${session.ownerId ?? '?'})`);
          await this.reply(command.chatId, box('ANIME MD • ALL SESSIONS', ['', ...lines, '', `Total: ${sessions.length} session${sessions.length === 1 ? '' : 's'}`]), homeOnlyMarkup());
          return;
        }
        case 'premium': {
          const mode = command.args[0]?.toLowerCase();
          if (mode === 'on' || mode === 'off') {
            if (access !== 'bootstrap') {
              await this.reply(command.chatId, box('ANIME MD • DENIED', ['', '❌ Only bootstrap owners can change this setting.', '']));
              return;
            }
            await this.persistSetting('premiumOnly', mode === 'on');
            await this.reply(command.chatId, box('ANIME MD • SETTINGS', ['', `💎 Premium-only pairing: ${mode === 'on' ? 'ON 🔒' : 'OFF 🌍'}`, '']), settingsMarkup({ owner: true, publicMode: this.publicMode, premiumOnly: this.premiumOnly }));
            return;
          }
          const premium = await this.premiumStatusOf(command.senderId);
          await this.reply(command.chatId, premiumBox({ id: command.senderId, expiresAt: premium.expiresAt, active: premium.premium && !premium.bootstrap }), homeOnlyMarkup());
          return;
        }
        case 'public': {
          const mode = command.args[0]?.toLowerCase();
          if (mode === 'on' || mode === 'off') {
            if (access !== 'bootstrap') {
              await this.reply(command.chatId, box('ANIME MD • DENIED', ['', '❌ Only bootstrap owners can change this setting.', '']));
              return;
            }
            await this.persistSetting('publicMode', mode === 'on');
            await this.reply(command.chatId, box('ANIME MD • SETTINGS', ['', `🌍 Public pairing: ${mode === 'on' ? 'ON 🌍' : 'OFF 🔒'}`, '', mode === 'on' ? 'Any Telegram user can now pair their own number.' : 'Only authorized controllers can pair.']), settingsMarkup({ owner: true, publicMode: this.publicMode, premiumOnly: this.premiumOnly }));
            return;
          }
          await this.reply(command.chatId, box('ANIME MD • INFO', ['', `🌍 Public pairing: ${this.publicMode ? 'ON 🌍' : 'OFF 🔒'}`, this.publicMode ? 'Any Telegram user can pair their own number.' : 'Only authorized controllers can pair.', '']));
          return;
        }
        case 'settings': {
          await this.sendSettingsView(command.chatId, command.senderId, { admin: access === 'bootstrap' });
          return;
        }
        case 'stop':
        case 'delpair': {
          if (!command.args[0]) {
            await this.reply(command.chatId, box('ANIME MD • STOP', ['', 'Usage: /stop <number>', '', 'Removes an unpaired session and its credentials.', '']));
            return;
          }
          const release = this.reserveSensitiveRequest(command.senderId, 'stop');
          try {
            const session = await this.pairing.stopSession(command.senderId, command.args[0], { admin: access === 'bootstrap' });
            await this.reply(command.chatId, stoppedBox(session.numberDisplay || formatInternationalNumber(command.args[0])), pairAgainMarkup());
            await this.maybeRemovePairedNumber(command.senderId, command.args[0]);
          } finally {
            release();
          }
          return;
        }
        default:
          await this.reply(command.chatId, `${box('ANIME MD • UNKNOWN COMMAND', ['', '❌ Unknown command.', ''])}\n\n${helpText()}`, homeOnlyMarkup());
      }
    } catch (error) {
      // Rate-limit style errors show a small "please wait" box first.
      if (error?.code === 'BUSY' || error?.code === 'COOLDOWN') {
        await this.reply(command.chatId, box('ANIME MD • PLEASE WAIT', ['', `⏳ ${error.message}`, '']));
        return;
      }
      // Pairing-domain errors render as their friendly box; other messages
      // (input validation) are shown directly because they are already
      // user-facing. Raw internal errors are logged, never displayed.
      const friendly = friendlyPairingError(error);
      if (error?.code && PAIRING_ERROR_TEXTS[error.code]) {
        this.log.error?.(`[telegram] Command /${command.name} failed: ${error.message}`);
        await this.reply(command.chatId, pairingFailedBox(friendly.lines, { retry: friendly.retry }), friendly.retry ? retryMarkup() : undefined);
        return;
      }
      // Never expose raw stack traces or internal paths to users
      const safeMessage = String(error?.message || 'Unexpected error').slice(0, 200);
      await this.reply(command.chatId, box('ANIME MD • ERROR', ['', `❌ ${safeMessage}`, '']), homeOnlyMarkup());
    }
  }

  // ------------------------------ callbacks -------------------------------

  async handleCallback(callback) {
    const senderId = callback.from?.id;
    const chatId = callback.message?.chat?.id;
    const messageId = callback.message?.message_id;
    const action = String(callback.data || '');
    if (!senderId || !chatId) return;
    const answer = () => this.api('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
    try {
      await answer();

      // Block check for callbacks as well
      if (!this.isBootstrapOwner(senderId)) {
        const block = await this.checkBlocked(senderId);
        if (block.blocked) {
          return await this.reply(chatId, blockedBox(block.blockedUntil, block.remainingMs), homeOnlyMarkup());
        }
      }

      const access = await this.accessOf(senderId);
      if (access === 'none') throw Object.assign(new Error('You are not authorized to control this bot.'), { code: 'DENIED' });
      const admin = access === 'bootstrap' || access === 'controller';
      const isOwner = access === 'bootstrap';
      // Public-chat safety for callbacks: a number/session button tapped in a
      // group must never broadcast that users' number to everyone there.
      const safeInPublic = new Set(['verify:me', 'home', 'nav:help', 'nav:guide', 'nav:account']);
      if (!chatIsPrivate(callback?.message?.chat) && !safeInPublic.has(action)) {
        return await this.reply(chatId, box('ANIME MD • PRIVACY', ['', '🔒 This bot only works in a private chat.', '', 'Phone numbers and session details are', 'never shared in public chats.', '']), homeOnlyMarkup());
      }
      const [scope, verb, argument] = action.split(':');

      // Legacy one-word callbacks kept working for older messages.
      if (action === 'pair_help') return await this.beginPairPrompt(chatId, senderId);
      if (action === 'help') {
        const role = await this.roleOf(senderId);
        return await this.present(chatId, messageId, helpText(), roleHomeMarkup(role));
      }
      if (action === 'status') return await this.sendStatusView(chatId, senderId, {});
      if (action === 'sessions') return await this.sendSessionsView(chatId, senderId, {});

      if (action === 'verify:me') {
        return await this.handleVerify(senderId, chatId, { messageId });
      }

      if (action === 'home') {
        if (await this.mustVerify(senderId)) {
          return await this.present(chatId, messageId, `${startupBox()}\n\n${verifyBox()}`, verifyMarkup());
        }
        const role = await this.roleOf(senderId);
        return await this.present(chatId, messageId, `${startupBox()}\n\nChoose an action below, or use /help.`, roleHomeMarkup(role));
      }
      if (action === 'pair:new') {
        // Blocked users cannot begin a new pairing.
        const block = await this.checkBlocked(senderId);
        if (block.blocked) return await this.reply(chatId, blockedBox(block.blockedUntil, block.remainingMs), homeOnlyMarkup());
        if (await this.mustVerify(senderId)) return await this.handleVerify(senderId, chatId, { messageId });
        return await this.beginPairPrompt(chatId, senderId);
      }
      if (scope === 'pair' && verb === 'regen') {
        // Only the owner of this exact pairing flow (validated by token) may
        // regenerate. The caller cannot forge another user's flow.
        return await this.handleRegenerate(senderId, argument, callback);
      }
      if (action === 'nav:guide') {
        return await this.present(chatId, messageId, guideBox(), guideMarkup());
      }
      if (action === 'nav:help') {
        return await this.present(chatId, messageId, helpText(), homeOnlyMarkup());
      }
      if (action === 'nav:status') {
        return await this.sendStatusView(chatId, senderId, { messageId });
      }
      if (action === 'nav:sessions') {
        return await this.sendSessionsView(chatId, senderId, { messageId, admin: isOwner });
      }
      if (action === 'nav:settings') {
        return await this.sendSettingsView(chatId, senderId, { messageId, admin: isOwner });
      }
      if (action === 'nav:account') {
        return await this.sendAccountView(chatId, senderId, { messageId });
      }
      if (action === 'nav:admin') {
        return await this.sendAdminPanelView(chatId, senderId, { messageId });
      }
      if (scope === 'admin') {
        if (!admin) throw Object.assign(new Error('Admin only'), { code: 'DENIED' });
        if (verb === 'users') return await this.sendUserManagementView(chatId, senderId, { messageId });
        if (verb === 'premium') {
          const premiumUsers = typeof this.controllerStore?.listPremium === 'function' ? await this.controllerStore.listPremium().catch(() => []) : [];
          const lines = premiumUsers.length ? premiumUsers.map((u) => ` • ${u.id} until ${new Date(u.expiresAt).toISOString().slice(0,10)}`) : ['No premium users'];
          return await this.present(chatId, messageId, box('ANIME MD • PREMIUM MANAGEMENT', ['', ...lines, '', 'Use /addprem <id> [30d] /delprem <id>']), adminPanelMarkup());
        }
        if (verb === 'vip') {
          let users = {};
          try { if (typeof this.controllerStore?.users === 'function') users = await this.controllerStore.users(); } catch {}
          const vips = Object.entries(users).filter(([, rec]) => rec.vip).map(([id]) => ` • ${id} VIP`);
          const lines = vips.length ? vips : ['No VIP users'];
          return await this.present(chatId, messageId, box('ANIME MD • VIP MANAGEMENT', ['', ...lines, '', 'Use /addvip <id> [30d] /delvip <id>']), adminPanelMarkup());
        }
        if (verb === 'block') {
          let users = {};
          try { if (typeof this.controllerStore?.users === 'function') users = await this.controllerStore.users(); } catch {}
          const blocked = Object.entries(users).filter(([, rec]) => rec.blockedUntil && rec.blockedUntil > Date.now()).map(([id, rec]) => ` • ${id} until ${formatUnblockTimestamp(rec.blockedUntil)}`);
          const lines = blocked.length ? blocked : ['No blocked users'];
          return await this.present(chatId, messageId, box('ANIME MD • BLOCK MANAGEMENT', ['', ...lines, '', 'Use /block <id> [24h] /unblock <id>']), adminPanelMarkup());
        }
        if (verb === 'lookup') {
          return await this.present(chatId, messageId, box('ANIME MD • USER LOOKUP', ['', '🔎 Send /myid to get your ID', 'Admin: /block <id> /unblock <id>', '/addprem <id> /addvip <id>', 'User data is private and only visible to owner.']), adminPanelMarkup());
        }
        if (verb === 'usage') return await this.sendPairingUsageView(chatId, senderId, { messageId });
        if (verb === 'access') {
          return await this.present(chatId, messageId, box('ANIME MD • ACCESS MANAGEMENT', ['', '🛡 Roles: OWNER > ADMIN > VIP > PREMIUM > NORMAL', '', 'NORMAL: 1 number', 'PREMIUM: 3 numbers', 'VIP: unlimited', 'ADMIN/OWNER: unlimited', '', 'Use /addowner, /addprem, /addvip to manage.']), adminPanelMarkup());
        }
        if (verb === 'system') return await this.sendSystemStatusView(chatId, senderId, { messageId });
        throw Object.assign(new Error('Admin button expired'), { code: 'EXPIRED' });
      }

      if (scope === 'ses') {
        // Numbers are re-validated; ownership is resolved server-side by the
        // pairing manager, never trusted from the callback data.
        const number = normalizeWhatsAppNumber(argument);
        if (verb === 'menu') {
          return await this.sendSessionMenuView(chatId, senderId, number, { messageId, admin: isOwner });
        }
        if (verb === 'restart') {
          const release = this.reserveSensitiveRequest(senderId, 'restart');
          try {
            const session = await this.pairing.restartSession(senderId, number, { admin: isOwner });
            return await this.present(chatId, messageId, box('ANIME MD • RESTARTING', ['', `📱 ${session.numberDisplay}`, `${badgeParts(session.status).icon} Status: ${badgeParts(session.status).label || session.status}`, '', 'The CONNECTED confirmation arrives', 'when WhatsApp reports the session online.']), backHomeMarkup());
          } finally {
            release();
          }
        }
        if (verb === 'stop') {
          const session = await this.pairing.statusOf(senderId, number, { admin: isOwner });
          return await this.present(chatId, messageId, box('ANIME MD • REMOVE SESSION', [
            '',
            `📱 ${session.numberDisplay}`,
            '',
            'This stops the session and deletes its',
            'stored credentials. The WhatsApp bot',
            'for this number goes offline.',
            '',
            'Remove it?'
          ]), stopConfirmMarkup(number));
        }
        if (verb === 'stopok') {
          const release = this.reserveSensitiveRequest(senderId, 'stop');
          try {
            const session = await this.pairing.stopSession(senderId, number, { admin: isOwner });
            await this.maybeRemovePairedNumber(senderId, number);
            return await this.present(chatId, messageId, stoppedBox(session.numberDisplay), pairAgainMarkup());
          } finally {
            release();
          }
        }
        throw Object.assign(new Error('This button is no longer valid. Open My Sessions again.'), { code: 'EXPIRED' });
      }

      if (scope === 'set') {
        if (!isOwner) throw Object.assign(new Error('You don\'t have permission to change this setting.'), { code: 'DENIED' });
        if (verb === 'public' && (argument === 'on' || argument === 'off')) {
          await this.persistSetting('publicMode', argument === 'on');
          return await this.sendSettingsView(chatId, senderId, { messageId, admin: isOwner });
        }
        if (verb === 'prem' && (argument === 'on' || argument === 'off')) {
          await this.persistSetting('premiumOnly', argument === 'on');
          return await this.sendSettingsView(chatId, senderId, { messageId, admin: isOwner });
        }
        throw Object.assign(new Error('This button is no longer valid. Open Settings again.'), { code: 'EXPIRED' });
      }

      throw Object.assign(new Error('This button is no longer valid. Send /help.'), { code: 'EXPIRED' });
    } catch (error) {
      const friendly = friendlyPairingError(error);
      if (error?.code && PAIRING_ERROR_TEXTS[error.code]) {
        return await this.present(chatId, messageId, pairingFailedBox(friendly.lines, { retry: friendly.retry }), friendly.retry ? retryMarkup() : undefined);
      }
      const safeMessage = String(error?.message || 'Unexpected error').slice(0, 200);
      return await this.reply(chatId, box('ANIME MD • ERROR', ['', `❌ ${safeMessage}`, '']), homeOnlyMarkup());
    }
  }

  async pollOnce() {
    const updates = await this.api('getUpdates', { offset: this.offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ['message', 'callback_query'] });
    for (const update of updates) {
      this.offset = Math.max(this.offset, Number(update.update_id) + 1);
      await this.handleUpdate(update);
    }
  }

  async notifyBootstrapOwners(image, caption) {
    for (const ownerId of this.bootstrapOwners) {
      try {
        const role = await this.roleOf(ownerId);
        await this.replyPhoto(ownerId, image, caption, roleHomeMarkup(role));
      } catch (error) {
        // A Telegram user must open the bot before it can receive a proactive
        // message. This must not stop polling for the other authorized owners.
        this.log.warn?.(`[telegram] Could not notify configured owner ${ownerId}: ${error.message}`);
      }
    }
  }

  // Called by the pairing manager when an owner's WhatsApp session actually
  // reaches connection open. It is never called earlier. If an active
  // single-message pairing flow exists, that same message is edited to the
  // CONNECTED state instead of posting a new Telegram message.
  async notifySessionConnected(ownerId, session) {
    if (!this.running) return;
    // Record successful pairing only on actual connection, not on code generation
    try {
      const num = String(session?.number || '').replace(/\D/g, '');
      if (/^\d{7,15}$/.test(num)) {
        await this.maybeRecordPairedNumber(ownerId, num);
      }
    } catch {}
    const flow = this.getFlow(ownerId);
    const number = String(session?.number || '');
    if (flow && !flow.stopped && (number === String(flow.number) || !number)) {
      this.stopSpinner(flow);
      flow.state = 'SUCCESS';
      flow.stopped = true;
      this.pairingFlows.delete(flow.senderKey);
      await this.editMessage(flow.chatId, flow.messageId, connectedBox(session?.numberDisplay || flow.numberDisplay), connectedMarkup());
      return;
    }
    try {
      await this.replyPhoto(ownerId, this.connectedImage, connectedBox(session?.numberDisplay || session?.number || ''), connectedMarkup());
    } catch (error) {
      this.log.warn?.(`[telegram] Could not deliver the connected notification to ${ownerId}: ${error.message}`);
    }
  }

  async notifySessionDisconnected(ownerId, session, classification) {
    if (!this.running) return;
    const flow = this.getFlow(ownerId);
    const failedBeforeLink = !session?.registered;
    if (flow && !flow.stopped) {
      this.stopSpinner(flow);
      flow.state = 'FAILED';
      flow.stopped = true;
      this.pairingFlows.delete(flow.senderKey);
      const reasonLine = classification?.userMessage || 'The WhatsApp connection timed out.';
      await this.editMessage(flow.chatId, flow.messageId, pairingFailureBox(flow.numberDisplay, reasonLine), pairingFailureMarkup(flow.token));
      return;
    }
    // A session that never finished pairing reads as a failed pairing, not
    // as an ended session; the reason line comes straight from the
    // disconnect classification, so failures are never generic.
    const title = failedBeforeLink ? 'ANIME MD • PAIRING FAILED' : 'ANIME MD • SESSION ENDED';
    const lines = [
      '',
      `📱 ${session?.numberDisplay || session?.number || ''}`,
      `⚠️ ${classification?.userMessage || 'The WhatsApp session ended.'}`
    ];
    if (failedBeforeLink) lines.push('', '❌ Pairing could not be completed.');
    lines.push('', 'Pair again anytime with /pair.');
    try {
      await this.reply(ownerId, box(title, lines), pairAgainMarkup());
    } catch (error) {
      this.log.warn?.(`[telegram] Could not deliver the disconnect notification to ${ownerId}: ${error.message}`);
    }
  }

  async notifyConnected() {
    if (!this.running) return;
    await this.notifyBootstrapOwners(this.connectedImage, box('ANIME MD • CONNECTED', ['', '✅ Primary WhatsApp session connected.', '']));
  }

  async start() {
    if (!this.token || this.running) return false;
    if (typeof this.fetch !== 'function') throw new Error('Telegram controller requires Node.js fetch support.');

    // Long polling cannot receive updates while a webhook is registered. Clear
    // a stale webhook explicitly before polling, while retaining queued updates.
    this.bot = await this.api('getMe', {});
    await this.api('deleteWebhook', { drop_pending_updates: false });
    await this.loadSettings();
    this.running = true;
    this.startedAt = Date.now();
    this.pollPromise = (async () => {
      while (this.running) {
        try {
          await this.pollOnce();
          // Telegram long polling normally blocks for up to 25 seconds. Yield
          // here as well so an immediately returning proxy/API cannot spin a
          // microtask loop and starve startup, shutdown, or other bot work.
          await new Promise((resolve) => setImmediate(resolve));
        } catch (error) {
          this.log.error?.(`[telegram] Poll failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
    })();
    const username = this.bot?.username ? `@${this.bot.username}` : 'the configured Telegram bot';
    this.log.info?.(`[telegram] Controller verified as ${username}; long polling started for ${this.bootstrapOwners.size} bootstrap owner(s).`);
    // The intro describes the Telegram-side subsystems only. It never claims
    // a WhatsApp session is connected.
    await this.notifyBootstrapOwners(this.startImage, `${startupBox()}\n\nSend /help to view commands, or use the buttons below.`);
    return true;
  }

  stop() {
    this.running = false;
    // Stop every active spinner so no orphaned timer keeps editing a message
    // after the controller is shut down.
    for (const flow of this.pairingFlows.values()) this.stopSpinner(flow);
    this.pairingFlows.clear();
  }
}

module.exports = {
  CODE_SOURCE_LABEL,
  DEFAULT_BLOCK_DURATION_MS,
  NORMAL_PAIRING_LIMIT,
  PREMIUM_PAIRING_LIMIT,
  SENSITIVE_COOLDOWN_MS,
  SENSITIVE_LOCK_TTL_MS,
  SPINNER_FRAMES,
  SESSION_STATE_BADGES,
  TelegramController,
  badgeParts,
  blockedBox,
  channelsBox,
  codeReadyBox,
  commandFromUpdate,
  connectedBox,
  connectedMarkup,
  escapeTelegramHtml,
  formatRemainingDuration,
  formatUnblockTimestamp,
  friendlyPairingError,
  friendlyReasonLine,
  guideBox,
  guideMarkup,
  helpText,
  homeMarkup,
  roleHomeMarkup,
  accountBox,
  adminPanelBox,
  adminPanelMarkup,
  accountMarkup,
  limitBox,
  menuMarkup,
  myIdBox,
  normalizeTelegramId,
  normalizeWhatsappNumber: normalizeWhatsAppNumber,
  pairingCodeMarkup,
  pairingFailedBox,
  pairingFailureBox,
  pairingFailureMarkup,
  pairingLoadingBox,
  pairingStartedBox,
  premiumBox,
  premiumRequiredBox,
  sessionsBox,
  sessionsMarkup,
  sessionMenuMarkup,
  settingsBox,
  settingsMarkup,
  startupBox,
  stateBadge,
  statusBox,
  stopConfirmMarkup,
  verifyBox,
  verifyMarkup
};
