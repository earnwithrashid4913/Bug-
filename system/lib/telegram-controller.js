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

// Public-chat (group / supergroup) pairing abuse protection. A group is a
// shared surface, so on top of the per-user gates (20s sensitive-operation
// cooldown + the pairing manager's own 10s per-controller cooldown) a chat
// gets:
//   * a short spacing window between pairing STARTS, which stops a burst loop
//     or a flood loop from turning the group into spam, and
//   * a cap on how many pairing flows may run inside one chat at once.
// The spacing window is deliberately short so that several members can pair in
// the same group without one member locking everybody else out: one user's
// pairing must never break another user's. The real socket budget, the
// per-number locks and the global concurrency limit stay in the pairing
// manager — these two counters only decide whether a chat may start a flow.
const GROUP_PAIRING_COOLDOWN_MS = 5_000;
const MAX_GROUP_PAIRING_FLOWS = 3;

// Membership verification: a live getChatMember result is cached only briefly
// as a performance optimization. Protected operations always force a fresh
// live check; the cache is never trusted to grant access on its own.
const MEMBERSHIP_CACHE_TTL_MS = 60_000;
// Repeated failed verification attempts only re-notify the owner this often.
const VERIFY_FAILURE_NOTIFY_MS = 5 * 60_000;

// Telegram member states that always count as "joined" for a channel/group.
// `restricted` is handled separately: a restricted user counts as a member
// ONLY while Telegram reports is_member === true. A restricted user with
// is_member === false has been removed from the community and must be rejected.
const MEMBERSHIP_JOINED_STATUSES = new Set(['member', 'administrator', 'creator']);
// Statuses Telegram returns that definitively mean "not a member".
const MEMBERSHIP_NOT_MEMBER_STATUSES = new Set(['left', 'kicked']);

// Bounded retry for transient Telegram API failures (network errors, HTTP 408,
// HTTP 429, and 5xx). Verification never loops forever and never retries
// permission/configuration errors — those fail closed immediately.
const MEMBERSHIP_RETRY_ATTEMPTS = 3;
const MEMBERSHIP_RETRY_BASE_DELAY_MS = 300;
const MEMBERSHIP_RETRY_MAX_DELAY_MS = 1_500;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// Database-driven tier labels (owner/admin/vip/premium/normal). No ID is ever
// hardcoded: the role is resolved from the controller store / premium records.
const TIER_LABELS = Object.freeze({
  owner: Object.freeze({ icon: '👑', label: 'OWNER' }),
  admin: Object.freeze({ icon: '🛡', label: 'ADMIN' }),
  vip: Object.freeze({ icon: '👑', label: 'VIP PREMIUM' }),
  premium: Object.freeze({ icon: '⭐', label: 'PREMIUM' }),
  normal: Object.freeze({ icon: '👤', label: 'FREE' })
});

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

const { formatInternationalNumber, maskInternationalNumber, normalizeWhatsAppNumber } = require('./pairing-number');
const { parseDuration } = require('./premium');
// Real WhatsApp command directory. The Telegram ALL MENU page is a READ-ONLY
// listing of the commands the WhatsApp handler actually registers — nothing is
// invented here, so a command can never appear in the menu without existing.
const { categoriesWithCommands } = require('./menu');
// Canonical project identity (never deployment configuration). Used by the
// DEVELOPER and THANKS TO pages so they always report the project's real
// protected identity instead of a copied one.
const { CANONICAL_IDENTITY } = require('../security');

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

// ---------------------------------------------------------------------------
// Membership verification helpers.
//
// Telegram getChatMember errors are classified so the controller can tell the
// difference between:
//   * the user is not a member (a real, positive "reject" result), and
//   * the bot cannot read membership at all (permission/configuration), and
//   * a transient Telegram failure worth retrying.
// ---------------------------------------------------------------------------

// Maps a thrown Telegram API error to a membership error category:
//   'transient'  — retryable (network failure, HTTP 408/429/5xx)
//   'permission' — bot lacks the permission to read membership (HTTP 403)
//   'config'     — the chat id/username is wrong or inaccessible (HTTP 400/404)
//   'other'      — anything else we cannot confidently classify.
function classifyMemberError(error) {
  const httpStatus = Number(error?.httpStatus);
  const code = error?.telegramErrorCode;
  if (!httpStatus && !code) return { kind: 'transient', retryable: true };
  if (httpStatus >= 500) return { kind: 'transient', retryable: true };
  if (httpStatus === 408 || httpStatus === 429) return { kind: 'transient', retryable: true };
  if (httpStatus === 403) return { kind: 'permission', retryable: false };
  if (httpStatus === 400 || httpStatus === 404) return { kind: 'config', retryable: false };
  return { kind: 'other', retryable: false };
}

// Bounded retry: repeats `operation` only for transient failures, with a short,
// backoff-like delay. Non-transient errors and the final attempt always throw.
async function retryTransient(operation, { attempts = MEMBERSHIP_RETRY_ATTEMPTS, baseDelayMs = MEMBERSHIP_RETRY_BASE_DELAY_MS, maxDelayMs = MEMBERSHIP_RETRY_MAX_DELAY_MS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const { retryable } = classifyMemberError(error);
      if (!retryable || attempt >= attempts) throw error;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// A status is a definitive, non-error "not a member" when Telegram reports a
// left/kicked member, or a restricted member whose is_member is false.
function isExplicitlyNotMember(status, member) {
  if (MEMBERSHIP_NOT_MEMBER_STATUSES.has(status)) return true;
  if (status === 'restricted') return member?.is_member === false;
  return false;
}

// Whether the reported getChatMember status counts as joined. `restricted` is a
// member ONLY while is_member is not explicitly false.
function isJoinedMemberStatus(status, member) {
  if (MEMBERSHIP_JOINED_STATUSES.has(status)) return true;
  if (status === 'restricted') return member?.is_member !== false;
  return false;
}

// Ranks failure categories so the most actionable one wins when several
// communities report different problems (config > permission > other > transient).
function membershipErrorSeverity(kind) {
  switch (kind) {
    case 'config': return 4;
    case 'permission': return 3;
    case 'other': return 2;
    case 'transient': return 1;
    default: return 0;
  }
}

function commandFromUpdate(update) {
  const message = update?.message;
  const text = message?.text?.trim();
  if (!text?.startsWith('/')) return undefined;
  const [token, ...args] = text.split(/\s+/);
  const name = token.slice(1).split('@')[0].toLowerCase();
  return { chatId: message.chat?.id, senderId: message.from?.id, name, args, text: args.join(' ') };
}

// Resolves the Telegram actor (id + optional username / display name) from a
// message or callback `from` object. The numeric id is the only identity used
// for access control; username/name are display-only metadata for activity
// notifications.
function actorFrom(from) {
  const id = from?.id;
  if (id == null) return undefined;
  const username = typeof from?.username === 'string' && from.username.trim() ? from.username.trim() : undefined;
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim() || undefined;
  return { id, username, name };
}

// Best-effort public join link for a required community. A configured `link`
// wins; otherwise a public @username is turned into its t.me link. Numeric
// (private) chat ids have no public link and simply omit the JOIN button.
function communityLink(community) {
  if (community?.link) return community.link;
  const chatId = String(community?.chatId || '');
  if (chatId.startsWith('@')) return `https://t.me/${chatId.slice(1)}`;
  return undefined;
}

function formatTime(date = new Date()) {
  return `${_two(date.getHours())}:${_two(date.getMinutes())}`;
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

// The ANIME MD intro / main-menu header.
//
// This is deliberately plain Latin text inside the standard ANIME MD box.
// Decorative "fancy font" characters (MATHEMATICAL ALPHANUMERIC SYMBOLS, the
// U+1D400-U+1D7FF block) live in the Unicode supplementary planes: most
// Telegram clients have no font for them, so they render mirrored, inverted or
// as empty boxes — text that reads backwards/garbled on the user's screen.
// Plain ASCII renders identically on every client, which is exactly what the
// ANIME MD style is for.
//
// It never claims a WhatsApp connection: the connected notification is a
// separate, real event.
function startupBox() {
  return box('ANIME MD • MAIN MENU', [
    '',
    '⚡ ANIME MD',
    '🤖 System: Online',
    '⚡ Status: Operational'
  ]);
}

// The action prompt is kept outside the box: it belongs to the dashboard
// render (next to the buttons), not to the status box itself, and keeping it
// in one place avoids the header and the footer repeating the same line.
function menuPrompt(tierLabel, used, limitDisplay) {
  return `👇 Choose an action below, or use /help.\n\n${tierLabel} • Sessions: ${used}/${limitDisplay}`;
}

// The visible acknowledgement posted the moment a pairing request is
// accepted. In a group this is what makes the pairing system look alive: the
// request is seen, then this SAME message is edited through the whole
// lifecycle (PREPARING → CODE → CONNECTED / FAILED).
function pairingStartedBox(numberDisplay) {
  return box('ANIME MD • PAIRING', [
    '',
    '📩 Pairing request received.',
    '',
    `📱 Number: ${numberDisplay}`,
    '⏳ Preparing WhatsApp pairing...',
    '',
    'Please wait.'
  ]);
}

function pairingLoadingBox(numberDisplay, frame, stage = 'PREPARING') {
  // The single pairing message carries the loading animation in its title so
  // it is edited (not re-sent) on every frame. The stage line follows the real
  // socket lifecycle reported by the pairing manager: PREPARING while the
  // WhatsApp handshake runs, GENERATING_CODE once requestPairingCode() is
  // actually being called on the open socket.
  const stageLine = stage === 'GENERATING_CODE'
    ? '🔐 Generating pairing code...'
    : '⏳ Preparing WhatsApp pairing...';
  return box(`ANIME MD • PAIRING ${frame}`, [
    '',
    `📱 Number: ${numberDisplay}`,
    stageLine,
    '',
    'Please wait.'
  ]);
}

// The pairing-code box. `public: true` renders the variant shown inside a
// group/supergroup: the number is already masked by the caller and a short
// single-use warning is added, because a code posted in a public chat is
// visible to every member.
function codeReadyBox({ displayCode, numberDisplay, expiresAt }, { ttlMinutes = 5, public: isPublic = false } = {}) {
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
    isPublic
      ? '⚠️ Single use — link it now. The code works once.'
      : 'This code was issued by WhatsApp itself and is valid once.'
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

// ---------------------------------------------------------------------------
// PUBLIC (group / supergroup) failure box.
//
// A public chat never receives validation detail, Baileys wording, disconnect
// reasons, session paths, tokens or stack traces — those stay in the server
// log. Whatever the real reason was, the group sees one short, clean,
// human-readable line. Note the deliberate title: it is "PAIRING", not
// "PAIRING FAILED", and there is no number-format lecture.
// ---------------------------------------------------------------------------

function publicPairingFailureBox() {
  return box('ANIME MD • PAIRING', [
    '',
    '⚠️ Pairing request could not be started.',
    '',
    'Please check the number and try again.'
  ]);
}

// A non-pairing failure in a public chat: the same rule applies — one short,
// clean line, never internal wording, a path or a stack trace.
function publicErrorBox() {
  return box('ANIME MD • REQUEST', [
    '',
    '⚠️ That request could not be completed.',
    '',
    'Please try again.'
  ]);
}

// Group pacing notices. Short, friendly, and they never explain the internals
// of the rate limiter beyond what the user can act on.
function groupCooldownBox(seconds) {
  const wait = Math.max(1, Math.ceil(Number(seconds) || 1));
  return box('ANIME MD • PAIRING', [
    '',
    '⏳ One pairing at a time here.',
    '',
    `Please wait about ${wait} second${wait === 1 ? '' : 's'} and try again.`
  ]);
}

function groupBusyBox(limit) {
  return box('ANIME MD • PAIRING', [
    '',
    `⏳ ${limit} pairings are already running in this chat.`,
    '',
    'Please wait for one of them to finish.'
  ]);
}

// Duplicate request in a public chat: acknowledged without opening a second
// flow, message, socket or code.
function groupDuplicateBox(numberDisplay) {
  return box('ANIME MD • PAIRING', [
    '',
    `📱 ${numberDisplay}`,
    '⏳ A pairing for this number is already running here.',
    '',
    'Watch the existing pairing message for the code.'
  ]);
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
    'number, without + (923001234567).',
    '',
    'Works from private chats, groups',
    'and supergroups. In a group the',
    'pairing status and the code are',
    'shown in the group itself, with',
    'the number masked.'
  ]);
}

function connectedBox(numberDisplay, username) {
  const lines = [
    '',
    '✅ WhatsApp Connected',
    '',
    `📱 ${numberDisplay}`
  ];
  if (username) lines.push(`👤 @${username}`);
  lines.push(
    '',
    '🟢 Session: ACTIVE',
    '',
    'Your ANIME MD session is ready.',
    '',
    'Roman Urdu: Aapka WhatsApp connect',
    'ho gaya hai — session active hai.'
  );
  return box('ANIME MD • CONNECTED', lines);
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

function verifyRequiredBox(membership) {
  const communities = Array.isArray(membership?.communities) ? membership.communities : [];
  if (!communities.length) return verifyBox();
  // An API/permission failure can never read as "joined": route to the correct
  // error box instead of a misleading per-community "Not Joined" list.
  if (membership?.error) return verificationResultBox(membership);
  const lines = ['', '🔐 Membership required', '', 'Join ALL required communities to unlock:', ''];
  for (const community of communities) {
    const icon = community.kind === 'group' ? '👥 Group' : '📢 Channel';
    lines.push(`${icon}: ${community.joined ? '✅ Joined' : '❌ Not Joined'}`);
  }
  lines.push('', 'Tap 🔄 VERIFY after joining.');
  return box('ANIME MD • VERIFICATION', lines);
}

function verificationLoadingBox() {
  return box('ANIME MD • VERIFICATION', ['', '🔄 Checking your membership…', '']);
}

function verificationSuccessBox(membership) {
  const communities = Array.isArray(membership?.communities) ? membership.communities : [];
  const lines = ['', '✅ Verification Successful', ''];
  if (communities.length) {
    lines.push('You have joined all required communities.', '');
    for (const community of communities) {
      const icon = community.kind === 'group' ? '👥 Group' : '📢 Channel';
      lines.push(`${icon}: ✅ Joined`);
    }
  } else {
    lines.push('Verification complete.', 'Your Telegram account is verified.');
  }
  lines.push('', '🎉 Access unlocked.');
  return box('ANIME MD • VERIFICATION', lines);
}

function verificationFailureBox(membership) {
  const communities = Array.isArray(membership?.communities) ? membership.communities : [];
  const lines = ['', '❌ Verification Failed', '', '⚠️ You have not joined all required', 'communities yet.', ''];
  for (const community of communities) {
    const icon = community.kind === 'group' ? '👥 Group' : '📢 Channel';
    lines.push(`${icon}: ${community.joined ? '✅ Joined' : '❌ Not Joined'}`);
  }
  lines.push('', 'Join ALL communities and press 🔄 VERIFY again.');
  return box('ANIME MD • VERIFICATION', lines);
}

// Shown when Telegram can't tell us whether the user is a member because the
// bot is missing from the community, lacks permission, or the chat id is wrong.
// This is an operator/config problem, not the user failing to join.
function verificationPermissionBox(membership) {
  const communities = Array.isArray(membership?.communities) ? membership.communities : [];
  const unreachable = communities.filter((community) => community.error || !community.joined);
  const lines = ['', '⚠️ Membership verification could not be completed.', ''];
  lines.push('The bot could not read membership status for:');
  for (const community of unreachable.length ? unreachable : communities) {
    lines.push(`• ${community.name}`);
  }
  lines.push('', 'Please make sure:');
  lines.push('• The chat ID/username is correct.');
  lines.push('• The bot is present in the community.');
  lines.push('• The bot has the required Telegram permissions.');
  lines.push('', 'Then press 🔄 VERIFY again.');
  return box('ANIME MD • VERIFICATION', lines);
}

// Shown for transient Telegram failures (after a bounded retry). The user is
// not blamed; the message is retryable and points at the owner as a last resort.
function verificationErrorBox() {
  return box('ANIME MD • VERIFICATION', [
    '',
    '⚠️ The bot could not verify membership right now.',
    '',
    'Please try again shortly.',
    'If the problem continues, contact the owner.'
  ]);
}

// Routes a membership result to the correct user-facing box based on the
// most actionable error category.
function verificationResultBox(membership) {
  if (membership?.noRequirements) return verifyBox();
  const errorType = membership?.errorType;
  if (errorType === 'permission' || errorType === 'config') return verificationPermissionBox(membership);
  if (errorType === 'transient' || errorType === 'other' || membership?.error) return verificationErrorBox();
  return verificationFailureBox(membership);
}

function joinAllBox(communities = []) {
  const lines = ['', '🚀 Join ALL required communities:', ''];
  for (const community of communities) {
    const icon = community.kind === 'group' ? '👥' : '📢';
    lines.push(`${icon} ${community.name}`);
  }
  lines.push('', 'After joining, come back and', 'press 🔄 VERIFY.');
  return box('ANIME MD • JOIN ALL', lines);
}

function activityBox(event) {
  const display = event.username ? `@${event.username}` : (event.name || event.userId || 'Unknown');
  const tierIcon = event.tierIcon || '⭐';
  const lines = [
    '',
    `👤 User: ${display}`,
    `🆔 ID: ${event.userId || '—'}`,
    `${tierIcon} Tier: ${event.tier || 'FREE'}`,
    `🔐 Membership: ${event.membership || 'Unknown'}`
  ];
  lines.push('', `⚡ Action: ${event.action}`);
  for (const line of (event.details || [])) if (line) lines.push(line);
  lines.push(`🕒 Time: ${formatTime(new Date())}`);
  return box('ANIME MD • ACTIVITY', lines);
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

function accountBox({ id, role, verified, premium, vip, owner, pairedNumbers = [], limit, used, blockStatus, publicChat = false }) {
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
        lines.push(` • ${publicChat ? maskInternationalNumber(num) : formatInternationalNumber(num)}`);
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

function systemStatusBox({ uptime, sessions, queued = 0, publicMode, premiumOnly, version = '1.0.0' }) {
  return box('ANIME MD • SYSTEM STATUS', [
    '',
    '🤖 Telegram Bot: 🟢 ONLINE',
    '📡 Controller: 🟢 ONLINE',
    '🔐 Pairing Service: 🟢 READY',
    '',
    `📊 Active Sessions: ${sessions}`,
    `🔄 Queued Pairings: ${queued}`,
    '',
    `⏱ Uptime: ${formatUptime(uptime)}`,
    `🤖 Bot Version: ${version}`,
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

// Public chats render session numbers masked (see maskInternationalNumber).
function displayNumber(session, publicChat = false) {
  if (!publicChat) return session.numberDisplay;
  try {
    return maskInternationalNumber(session.number);
  } catch {
    return session.numberDisplay;
  }
}

function sessionsBox(sessions, publicChat = false) {
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
    return `${icon} ${displayNumber(session, publicChat)} — ${label || session.status}`;
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

function statusBox(session, { ownerId, publicChat = false } = {}) {
  const { icon, label } = badgeParts(session.status);
  const lines = [
    '',
    `📱 Number: ${displayNumber(session, publicChat)}`,
    `${icon} Status: ${label || session.status}`,
    `🔗 Paired: ${session.registered ? 'yes' : 'no'}`,
    `🔄 Reconnects: ${session.reconnects}`
  ];
  if (ownerId) lines.push(`👤 Owner: ${ownerId}`);
  lines.push('', 'Your ANIME MD session.');
  return box('ANIME MD • SESSION STATUS', lines);
}

function overallStatusBox(sessions, controllerUptimeSeconds, user = {}, publicChat = false) {
  const tier = user.tier || TIER_LABELS.normal;
  const membership = user.membership === 'verified'
    ? 'Verified'
    : user.membership === 'not_verified'
      ? 'Not Verified'
      : 'Unknown';
  const lines = [
    '',
    `🤖 Controller: Online (${Math.floor(controllerUptimeSeconds / 60)}m uptime)`,
    `📱 WhatsApp sessions: ${sessions.length}`,
    `${tier.icon} Tier: ${tier.label}`,
    `🔐 Membership: ${membership}`
  ];
  if (sessions.length) {
    lines.push('', ...sessions.map((session) => {
      const { icon, label } = badgeParts(session.status);
      return `${icon} ${displayNumber(session, publicChat)} — ${label || session.status}`;
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

// ---------------------------------------------------------------------------
// ALL MENU — a READ-ONLY directory of the WhatsApp commands this project
// actually registers. Everything here is generated from system/lib/menu.js at
// call time, so a command can never be advertised on Telegram without existing
// in the WhatsApp handler. Telegram does not execute these commands; it shows
// what the WhatsApp side offers.
// ---------------------------------------------------------------------------

function commandCount() {
  return categoriesWithCommands().reduce((total, category) => total + category.commands.length, 0);
}

function allMenuBox(prefix = '!') {
  const categories = categoriesWithCommands();
  const lines = [
    '',
    '📋 WhatsApp command directory',
    '',
    `⌨️ Prefix: ${prefix}`,
    `🧩 Commands: ${commandCount()}`,
    ''
  ];
  for (const category of categories) {
    lines.push(`${category.icon} ${category.label} — ${category.commands.length}`);
  }
  lines.push('', 'Tap a category below to open it.');
  return box('ANIME MD • ALL MENU', lines);
}

function allMenuMarkup() {
  const rows = chunkButtons(categoriesWithCommands().map((category) => ({
    text: `${category.icon} ${category.label}`,
    callback_data: `menu:cat:${category.id}`
  })), 2);
  rows.push([{ text: '🏠 MENU', callback_data: 'home' }]);
  return { inline_keyboard: rows };
}

function menuCategoryBox(category, prefix = '!') {
  const lines = ['', `📋 ${category.commands.length} command${category.commands.length === 1 ? '' : 's'}`, ''];
  for (const command of category.commands) {
    lines.push(`${prefix}${command.name}${command.usage ? ` ${command.usage}` : ''}`);
    lines.push(`   ${command.description}`);
  }
  lines.push('', 'These commands run on WhatsApp.', `Prefix may change with ${prefix}setprefix.`);
  return box(`ANIME MD • ${category.label}`, lines);
}

function menuCategoryMarkup() {
  return { inline_keyboard: [
    [{ text: '↩️ BACK', callback_data: 'nav:allmenu' }],
    [{ text: '🏠 MENU', callback_data: 'home' }]
  ] };
}

// ---------------------------------------------------------------------------
// DEVELOPER / THANKS TO. The names come from the canonical protected identity
// (system/security.js) plus the configured contact link — never from a copied
// reference. No phone number, Telegram ID or session path is ever rendered.
// ---------------------------------------------------------------------------

function developerBox({ owner, developer, channel }) {
  const lines = [
    '',
    '👑 Global Owner',
    `   ${owner}`,
    '',
    '🛠 Developer',
    `   ${developer}`
  ];
  if (channel) lines.push('', '📞 Official Contact', `   ${channel}`);
  lines.push(
    '',
    `📦 Project: ${CANONICAL_IDENTITY.projectName}`,
    `🔖 Identity: v${CANONICAL_IDENTITY.identityVersion}`
  );
  return box('ANIME MD • DEVELOPER', lines);
}

function developerMarkup() {
  return { inline_keyboard: [
    [{ text: '🙏 THANKS TO', callback_data: 'nav:thanks' }],
    [{ text: '↩️ BACK', callback_data: 'home' }]
  ] };
}

function thanksBox({ owner, developer }) {
  return box('ANIME MD • THANKS TO', [
    '',
    '✦ Special thanks to everyone who',
    'contributed to the ANIME MD project.',
    '',
    '⚡ Developers',
    '⚡ Contributors',
    '⚡ Testers',
    '⚡ Supporters',
    '',
    `🙏 Thanks to ${owner} & ${developer}`
  ]);
}

function thanksMarkup() {
  return { inline_keyboard: [
    [{ text: '🛠 DEVELOPER', callback_data: 'nav:developer' }],
    [{ text: '↩️ BACK', callback_data: 'home' }]
  ] };
}

// BUY ACCESS / PREMIUM. The limits below are the same constants the access
// layer enforces (pairingLimitOf), and the caller's own tier/usage come from
// the user database — nothing about pricing or limits is invented here.
function premiumAccessBox({ tier, used, limit, active, expiresAt }) {
  const tierIcon = tier?.icon || TIER_LABELS.normal.icon;
  const tierLabel = tier?.label || TIER_LABELS.normal.label;
  const limitLabel = Number.isFinite(limit) ? String(limit) : '∞';
  const lines = [
    '',
    '✦ Free Access',
    `   • ${NORMAL_PAIRING_LIMIT} pairing session`,
    '',
    '✦ Premium',
    `   • ${PREMIUM_PAIRING_LIMIT} pairing sessions`,
    '   • Priority pairing queue',
    '',
    '✦ VIP Premium',
    '   • Unlimited sessions',
    '   • Extended owner-grade access',
    '',
    `${tierIcon} Your tier: ${tierLabel}`,
    `📱 Your sessions: ${used}/${limitLabel}`
  ];
  if (active && Number.isFinite(expiresAt)) {
    lines.push(`⏳ Premium until: ${new Date(expiresAt).toISOString().slice(0, 10)}`);
  }
  lines.push('', 'Ask the owner to upgrade your access.');
  return box('ANIME MD • PREMIUM', lines);
}

function premiumAccessMarkup() {
  return { inline_keyboard: [
    [{ text: '👤 MY ACCOUNT', callback_data: 'nav:account' }],
    [{ text: '↩️ BACK', callback_data: 'home' }]
  ] };
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
    '┃ /allmenu — WhatsApp command list (read-only)',
    '┃ /developer — owner & developer details',
    '┃ /thanks — thanks page',
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

// Standard ACCESS DENIED box. The required role is always named explicitly so
// the user knows exactly what is missing. Owner denials keep the canonical
// bootstrap-owner wording (config.js source of truth).
function accessDeniedBox(requiredRole = 'ADMIN') {
  const role = String(requiredRole || 'ADMIN').toUpperCase();
  if (role === 'OWNER') {
    return box('ANIME MD • ACCESS DENIED', [
      '',
      '❌ This command requires OWNER access.',
      'Only bootstrap owners (telegram.ownerIds in config.js) can use this command.',
      ''
    ]);
  }
  return box('ANIME MD • ACCESS DENIED', [
    '',
    `❌ This command requires ${role} access.`,
    'Only admins and owners can use this command.',
    ''
  ]);
}

// Uptime formatter: seconds → minutes → hours → days, always human-readable.
function formatUptime(totalSeconds = 0) {
  const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (total < 60) return `${total} second${total === 1 ? '' : 's'}`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes} minute${minutes === 1 ? '' : 's'} ${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  if (total < 86400) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

// Role-filtered help: normal/premium/vip users only ever see user commands.
// Management commands are shown only to the roles that may run them.
function helpTextForRole(role = 'normal') {
  const lines = [
    '╭━━〔 ANIME MD • HELP 〕━╮',
    '┃',
    '┃ 📱 PAIRING',
    '┃ /pair <number> — pair a WhatsApp number',
    '┃ /sessions — list your WhatsApp sessions',
    '┃ /status [number] — session status',
    '┃ /stop <number> — remove an unpaired session',
    '┃ /restart <number> — restart a paired session',
    '┃',
    '┃ 👤 ACCOUNT',
    '┃ /myaccount — your profile and tier',
    '┃ /myid — show your Telegram ID',
    '┃ /premium — premium status',
    '┃ /settings — your settings and limits',
    '┃',
    '┃ 📖 GUIDES',
    '┃ /guide — pairing guide',
    '┃ /help — show this help',
    '┃',
    '┃ ℹ️ PAGES',
    '┃ /allmenu — WhatsApp command list',
    '┃ /developer — owner & developer',
    '┃ /thanks — thanks page',
    '┃ /premium — access & limits',
    '┃',
    '┃ Aliases: /delpair = /stop,',
    '┃ /listsessions = /sessions'
  ];
  if (role === 'admin' || role === 'owner') {
    lines.push(
      '┃',
      '┃ 🛡 ADMIN',
      '┃ /admin — admin panel',
      '┃ /addprem <id> [30d] — grant premium',
      '┃ /delprem <id> — revoke premium',
      '┃ /addvip <id> [30d] — grant VIP',
      '┃ /delvip <id> — revoke VIP',
      '┃ /block <id> [24h] — block a user',
      '┃ /unblock <id> — unblock a user'
    );
  }
  if (role === 'owner') {
    lines.push(
      '┃',
      '┃ 👑 OWNER',
      '┃ /addowner <telegram_id> — authorize a controller',
      '┃ /delowner <telegram_id> — remove a controller',
      '┃ /listpaired — all sessions'
    );
  }
  lines.push(
    '┃',
    '┃ Number format: country code + number,',
    '┃ no + required (example: 923001234567).',
    '╰' + '━'.repeat(23) + '╯'
  );
  return lines.join('\n');
}

// Role-aware main menu — the ANIME MD system dashboard.
//
// Every entry below is a real, handled callback (see handleCallback): the
// pairing flow, the user's own sessions/account, a read-only directory of the
// WhatsApp commands, live status, the developer and thanks pages, the
// access/premium page, the pairing guide, role-filtered help and settings.
// Nothing is decorative and nothing is duplicated.
//
// All dashboard callbacks: pair:new, nav:sessions, nav:account, nav:status,
// nav:allmenu, menu:cat:<id>, nav:developer, nav:thanks, nav:premium,
// nav:guide, nav:help, nav:settings, nav:admin (admin/owner),
// nav:owner (owner only).
function roleHomeMarkup(role) {
  const rows = [
    [
      { text: '🔗 PAIR WHATSAPP', callback_data: 'pair:new' },
      { text: '📱 MY SESSIONS', callback_data: 'nav:sessions' }
    ],
    [
      { text: '📋 ALL MENU', callback_data: 'nav:allmenu' },
      { text: '📊 STATUS', callback_data: 'nav:status' }
    ],
    [
      { text: '👤 MY ACCOUNT', callback_data: 'nav:account' },
      { text: '💎 BUY ACCESS', callback_data: 'nav:premium' }
    ],
    [
      { text: '🛠 DEVELOPER', callback_data: 'nav:developer' },
      { text: '🙏 THANKS TO', callback_data: 'nav:thanks' }
    ],
    [
      { text: '📖 GUIDE', callback_data: 'nav:guide' },
      { text: '❓ HELP', callback_data: 'nav:help' }
    ],
    [
      { text: '⚙️ SETTINGS', callback_data: 'nav:settings' }
    ]
  ];
  if (role === 'owner') {
    rows.push([
      { text: '🛡 ADMIN', callback_data: 'nav:admin' },
      { text: '👑 OWNER MENU', callback_data: 'nav:owner' }
    ]);
  } else if (role === 'admin') {
    rows.push([{ text: '🛡 ADMIN', callback_data: 'nav:admin' }]);
  }
  return { inline_keyboard: rows };
}

// Backward-compatible export name for the dashboard keyboard.
const menuMarkup = homeMarkup;

function verifyMarkup() {
  return { inline_keyboard: [[{ text: '🔄 VERIFY', callback_data: 'verify:me' }]] };
}

// Chunk helper so an arbitrary list of required communities never exceeds a
// single keyboard row (Telegram caps rows at 8 buttons).
function chunkButtons(buttons, size = 2) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += size) rows.push(buttons.slice(index, index + size));
  return rows;
}

// JOIN CHANNEL / JOIN GROUP (URL buttons) + JOIN ALL + VERIFY. The JOIN links
// come from configuration (telegram.requiredChannels[].link / chatId), never
// from hardcoded source values.
function joinVerifyMarkup(communities = []) {
  const rows = [];
  const joinButtons = communities
    .map((community) => ({
      text: community.kind === 'group' ? '👥 JOIN GROUP' : '📢 JOIN CHANNEL',
      url: communityLink(community)
    }))
    .filter((button) => button.url);
  for (const row of chunkButtons(joinButtons, 2)) rows.push(row);
  rows.push([
    { text: '🚀 JOIN ALL', callback_data: 'verify:joinall' },
    { text: '🔄 VERIFY', callback_data: 'verify:me' }
  ]);
  return { inline_keyboard: rows };
}

function joinLinksMarkup(communities = []) {
  const rows = [];
  const joinButtons = communities
    .map((community) => ({
      text: community.kind === 'group' ? '👥 JOIN GROUP' : '📢 JOIN CHANNEL',
      url: communityLink(community)
    }))
    .filter((button) => button.url);
  for (const row of chunkButtons(joinButtons, 2)) rows.push(row);
  rows.push([
    { text: '🔄 VERIFY', callback_data: 'verify:me' },
    { text: '🏠 Home', callback_data: 'home' }
  ]);
  return { inline_keyboard: rows };
}

function verifiedMarkup() {
  return { inline_keyboard: [
    [{ text: '✅ VERIFIED', callback_data: 'verify:done' }],
    [{ text: '🏠 MAIN MENU', callback_data: 'home' }]
  ] };
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

// Shown when a pairing is already in progress for the same number: the repeat
// request is acknowledged without opening a second flow or code.
function pairingInProgressBox(numberDisplay) {
  return box('ANIME MD • PAIRING', [
    '',
    `📱 ${numberDisplay}`,
    '⏳ Pairing is already in progress.',
    '',
    'One request produces exactly one code.',
    'Watch this chat for the current status.'
  ]);
}

// Shown when the pairing code expired without a link.
function pairingExpiredBox(numberDisplay) {
  return box('ANIME MD • CODE EXPIRED', [
    '',
    '⌛ The pairing code has expired.',
    '',
    `📱 ${numberDisplay}`,
    '',
    'Press the button below to start a',
    'fresh pairing.'
  ]);
}

function guideMarkup() {
  return { inline_keyboard: [[
    { text: '🔗 Pair WhatsApp', callback_data: 'pair:new' }
  ], [
    { text: '🏠 Home', callback_data: 'home' }
  ]] };
}

function sessionsMarkup(sessions, publicChat = false) {
  // Button labels are visible in the chat, so they follow the same
  // public-chat masking rule as the box text.
  const rows = sessions.slice(0, MAX_SESSION_BUTTONS).map((session) => [{
    text: `📱 ${displayNumber(session, publicChat)}`,
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
    { text: '➕ Pair Another', callback_data: 'pair:new' },
    { text: '📊 My Sessions', callback_data: 'nav:sessions' }
  ], [
    { text: '🏠 Menu', callback_data: 'home' }
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
    [{ text: '👤 Users', callback_data: 'admin:users' }, { text: '📱 Sessions', callback_data: 'admin:sessions' }],
    [{ text: '⭐ Premium', callback_data: 'admin:premium' }, { text: '👑 VIP', callback_data: 'admin:vip' }],
    [{ text: '🚫 Block', callback_data: 'admin:block' }, { text: '📊 Usage', callback_data: 'admin:usage' }],
    [{ text: '🔎 Lookup', callback_data: 'admin:lookup' }, { text: '🛡 Access', callback_data: 'admin:access' }],
    [{ text: '⚙️ System', callback_data: 'admin:system' }],
    [{ text: '🏠 Home', callback_data: 'home' }]
  ] };
}

function ownerPanelBox({ controllers = 0, premiumUsers = 0, totalUsers = 0, blockedUsers = 0, sessions = 0 }) {
  return box('ANIME MD • OWNER PANEL', [
    '',
    '👑 Owner Control Center',
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

function ownerPanelMarkup() {
  return { inline_keyboard: [
    [{ text: '👥 Users', callback_data: 'owner:users' }, { text: '👑 Owners', callback_data: 'owner:owners' }],
    [{ text: '🛡️ Admins', callback_data: 'owner:admins' }, { text: '⭐ Premium', callback_data: 'owner:premium' }],
    [{ text: '💎 VIP Premium', callback_data: 'owner:vip' }, { text: '📱 Sessions', callback_data: 'owner:sessions' }],
    [{ text: '🚫 Blocks', callback_data: 'owner:blocks' }, { text: '📊 System', callback_data: 'owner:system' }],
    [{ text: '⚙️ Config', callback_data: 'owner:config' }, { text: '🏠 Home', callback_data: 'home' }]
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

const OWNER_COMMANDS = new Set(['addowner', 'delowner', 'listpaired']);
const ADMIN_COMMANDS = new Set(['addprem', 'delprem', 'addvip', 'delvip', 'block', 'unblock']);
// Backward-compatible alias: every owner/admin-restricted command.
const BOOTSTRAP_COMMANDS = new Set([...OWNER_COMMANDS, ...ADMIN_COMMANDS]);
const OPEN_COMMANDS = new Set([
  'start', 'help', 'guide', 'myid', 'verify', 'myaccount', 'account',
  // Pure information pages: no user data, no sessions, no settings.
  'allmenu', 'commands', 'developer', 'dev', 'thanks', 'thanksto'
]);

// Chat-type classification. Pairing and every other command WORK in private
// chats, groups and supergroups alike — the chat type is never a reason to
// reject a request, and a pairing is never silently redirected to a private
// chat. It only decides presentation:
//   * in a group/supergroup the phone number is masked, failure states are a
//     single short clean line (no validation/Baileys detail), and pairing is
//     additionally paced per chat;
//   * credentials, tokens, session files, database paths and stack traces
//     never leave the server in ANY chat type.
// A chat without an explicit type (unit-test fixtures) is treated as private
// so the controller keeps behaving for direct messages.
function chatIsPrivate(chat) {
  return !chat?.type || chat.type === 'private';
}

class TelegramController {
  constructor({
    token, owners = [], controllerStore, pairing, startImage = '', connectedImage = '',
    publicMode = false, premiumOnly = false, requiredChannels = [], sessionLimit = 5, codeSource = '',
    identity = {}, commandPrefix = '!',
    fetchImpl = globalThis.fetch, log = console, activityLogger
  }) {
    this.token = token;
    this.bootstrapOwners = new Set(owners.map(normalizeTelegramId));
    this.controllerStore = controllerStore;
    this.pairing = pairing;
    this.startImage = startImage;
    this.connectedImage = connectedImage;
    this.publicMode = Boolean(publicMode);
    this.premiumOnly = Boolean(premiumOnly);
    // Normalized required communities (channel + group). `link` is an optional
    // public join URL; when absent it is derived from a public @username. The
    // kind drives the JOIN button label and status lines.
    this.requiredCommunities = (Array.isArray(requiredChannels) ? requiredChannels : [])
      .filter((channel) => channel && String(channel.chatId || '').trim())
      .map((channel) => ({
        name: String(channel.name || 'Community').slice(0, 60),
        chatId: String(channel.chatId).trim(),
        link: String(channel.link || '').trim() || undefined,
        kind: channel.kind === 'group' ? 'group' : channel.kind === 'channel' ? 'channel' : undefined
      }));
    // Backward-compatible alias kept for callers/tests that read it directly.
    this.requiredChannels = this.requiredCommunities;
    this.sessionLimit = Number.isSafeInteger(sessionLimit) && sessionLimit > 0 ? sessionLimit : 5;
    this.codeSource = String(codeSource || '');
    // Display identity for the DEVELOPER / THANKS TO pages. Falls back to the
    // canonical protected identity, so these pages are correct even when a
    // caller (or a unit test) supplies nothing. No secret is ever part of it.
    this.identity = Object.freeze({
      owner: String(identity?.owner || CANONICAL_IDENTITY.author),
      developer: String(identity?.developer || CANONICAL_IDENTITY.developer),
      channel: String(identity?.channel || '')
    });
    // WhatsApp command prefix, used only to render the read-only ALL MENU
    // directory. Telegram never executes these commands.
    this.commandPrefix = String(commandPrefix || '!').slice(0, 4);
    this.fetch = fetchImpl;
    this.log = log;
    // Optional owner-activity hook. index.js wires this to the bootstrap owner
    // notification path; when absent (unit tests) activity logging is a no-op.
    this.activityLogger = typeof activityLogger === 'function' ? activityLogger : undefined;
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
    // Public-chat pairing pacing: last pairing start per chat, and the set of
    // flow keys currently running inside each chat. Both are bounded by
    // prunePendingState() so neither map grows without limit.
    this.chatPairingCooldowns = new Map();
    this.chatPairingFlows = new Map();
    // Live membership cache (short TTL) + last-known actor metadata + pending
    // action continuations + verification-failure notify throttling.
    this.membershipCache = new Map();
    this.actors = new Map();
    this.pendingActions = new Map();
    this.verificationFailures = new Map();
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

  // Owner comparison is type-safe: Telegram delivers ctx.from.id as a NUMBER
  // while config.js stores ownerIds as STRINGS. Both are normalized to the
  // canonical digit string first, with a Number-equality fallback, so
  // '123' === 123 can never fail the check. This is the Phase 4 /listpaired
  // root-cause fix: the permission check stays, the comparison is fixed.
  isBootstrapOwner(id) {
    const normalized = normalizeTelegramId(id);
    if (this.bootstrapOwners.has(normalized)) return true;
    const numeric = Number(normalized);
    for (const entry of this.bootstrapOwners) {
      if (Number(entry) === numeric) return true;
    }
    return false;
  }

  async authorized(id) {
    const normalized = normalizeTelegramId(id);
    return this.bootstrapOwners.has(normalized) || await this.controllerStore.has(normalized);
  }

  // ------------------ centralized permission helpers ------------------
  // Single source of truth for role checks. Management hierarchy
  // (OWNER → ADMIN) and subscription hierarchy (NORMAL → PREMIUM → VIP)
  // are never mixed: tier never implies a management role.

  isOwner(id) {
    try {
      return this.isBootstrapOwner(id);
    } catch {
      return false;
    }
  }

  async isAdmin(id) {
    try {
      const access = await this.accessOf(id);
      return access === 'bootstrap' || access === 'controller';
    } catch {
      return false;
    }
  }

  async isVip(id) {
    try {
      return (await this.vipStatusOf(id)).vip === true;
    } catch {
      return false;
    }
  }

  async isPremium(id) {
    try {
      return (await this.premiumStatusOf(id)).premium === true;
    } catch {
      return false;
    }
  }

  async isBlocked(id) {
    try {
      return await this.checkBlocked(id);
    } catch {
      return { blocked: false };
    }
  }

  // Pairing gate: limits come from the database tier (via pairingLimitOf),
  // never from hardcoded per-call values.
  async canPair(id) {
    const limit = await this.pairingLimitOf(id);
    const used = await this.pairingUsageOf(id);
    if (!Number.isFinite(limit)) return { allowed: true, limit, used };
    if (used >= limit) return { allowed: false, reason: 'limit', limit, used };
    return { allowed: true, limit, used };
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

  async markVerified(id) {
    if (typeof this.controllerStore?.markVerified === 'function') {
      await this.controllerStore.markVerified(id);
    }
  }

  async markUnverified(id) {
    const normalized = normalizeTelegramId(id);
    try {
      if (typeof this.controllerStore?.updateUser === 'function') {
        await this.controllerStore.updateUser(normalized, { verified: false, verifiedAt: undefined });
      }
    } catch (error) {
      this.log.warn?.(`[telegram] Could not clear verification for ${normalized}: ${error.message}`);
    }
  }

  // Database-driven tier display (FREE / PREMIUM / VIP PREMIUM / ADMIN / OWNER).
  async tierOf(id) {
    const role = await this.roleOf(id);
    return TIER_LABELS[role] || TIER_LABELS.normal;
  }

  // 'verified' | 'not_verified' | 'unknown' for display. Trusted operators are
  // always 'verified'; everyone else reflects the live (or freshly cached)
  // membership check, never a blindly trusted historical flag.
  async membershipLabelOf(id) {
    if (this.isBootstrapOwner(id)) return 'verified';
    if (await this.authorized(id)) return 'verified';
    const membership = await this.membershipStatusOf(id, { force: false });
    if (membership.noRequirements) return (await this.isVerified(id)) ? 'verified' : 'not_verified';
    if (membership.error) return 'unknown';
    return membership.verified ? 'verified' : 'not_verified';
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

  // ---------------------------------------------------------------------------
  // Centralized membership verification guard.
  //
  // Every protected command/callback funnels through requireMembership() so the
  // channel + group membership logic lives in exactly one place. The check is a
  // LIVE Telegram getChatMember call; a short TTL cache exists only so a single
  // request never repeats the same API call, and protected operations always
  // force a fresh lookup. Errors fail closed.
  // ---------------------------------------------------------------------------

  async checkCommunityMembership(id, community) {
    const result = {
      name: community.name, chatId: community.chatId, link: community.link,
      kind: community.kind, joined: false, status: null,
      error: false, errorType: 'none', httpStatus: undefined
    };
    try {
      const member = await this.getChatMember(community.chatId, id);
      const status = member?.status ?? null;
      result.status = status;
      result.joined = isJoinedMemberStatus(status, member);
      // A definitive non-membership is a positive result, not an error, so the
      // user gets the clear "join the communities" message.
      result.errorType = isExplicitlyNotMember(status, member) ? 'not_member' : 'none';
      return result;
    } catch (error) {
      // Never treat an API error (bot not a member, user not found, rate
      // limit, timeout, network failure) as a successful membership check.
      const { kind } = classifyMemberError(error);
      result.error = true;
      result.joined = false;
      result.errorType = kind;
      result.httpStatus = Number(error?.httpStatus);
      this.log.warn?.(`[telegram] Could not verify membership of ${id} in ${community.chatId}: ${error.message} (class=${kind}, http=${result.httpStatus})`);
      return result;
    }
  }

  async membershipStatusOf(senderId, { force = false } = {}) {
    const id = normalizeTelegramId(senderId);
    const communities = this.requiredCommunities || [];
    if (!communities.length) {
      return { verified: true, noRequirements: true, error: false, errorType: 'none', communities: [] };
    }
    const key = String(id);
    const now = Date.now();
    const cached = this.membershipCache.get(key);
    if (!force && cached && now - cached.checkedAt < MEMBERSHIP_CACHE_TTL_MS) {
      return cached.result;
    }
    const results = await Promise.all(communities.map((community) => this.checkCommunityMembership(id, community)));
    let allJoined = true;
    let error = false;
    let errorType = 'none';
    for (const result of results) {
      if (result.error) {
        error = true;
        // Keep the most actionable failure category when several communities
        // report different problems.
        if (membershipErrorSeverity(result.errorType) > membershipErrorSeverity(errorType)) {
          errorType = result.errorType;
        }
      }
      if (!result.joined) allJoined = false;
    }
    // No API error but the user is missing from at least one community.
    if (!error && !allJoined) errorType = 'not_member';
    const failedCommunities = results
      .filter((result) => result.error || !result.joined)
      .map((result) => result.name);
    const membership = {
      verified: !error && allJoined,
      noRequirements: false,
      error,
      errorType,
      failedCommunities,
      communities: results
    };
    this.membershipCache.set(key, { checkedAt: now, result: membership });
    return membership;
  }

  rememberPending(id, update) {
    if (id == null || !update) return;
    const kind = update?.callback_query ? 'callback' : 'message';
    this.pendingActions.set(normalizeTelegramId(id), { kind, update, expiresAt: Date.now() + PENDING_NUMBER_TTL_MS });
  }

  async continuePending(id) {
    const key = normalizeTelegramId(id);
    const pending = this.pendingActions.get(key);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pendingActions.delete(key);
      return;
    }
    this.pendingActions.delete(key);
    try {
      if (pending.kind === 'callback') await this.handleCallback(pending.update.callback_query);
      else await this.handleUpdate(pending.update);
    } catch (error) {
      this.log.warn?.(`[telegram] Could not continue the pending action for ${key}: ${error.message}`);
    }
  }

  // Shows the Join/Verify UI. When an `update` is supplied it is remembered so
  // a successful verification can continue the originally requested action.
  async showVerifyRequired(actor, { chatId, messageId, membership, update } = {}) {
    if (update) this.rememberPending(actor?.id, update);
    const text = verifyRequiredBox(membership);
    const markup = membership?.noRequirements ? verifyMarkup() : joinVerifyMarkup(this.requiredCommunities || []);
    if (messageId) return this.present(chatId, messageId, text, markup);
    return this.replyPhoto(chatId, this.startImage, `${startupBox()}\n\n${text}`, markup);
  }

  // The single reusable guard. Returns { ok, membership }. When `ok` is false
  // the Join/Verify UI has already been presented and the caller must stop.
  async requireMembership(actor, { chatId, messageId, update } = {}) {
    const id = normalizeTelegramId(actor?.id);
    // Trusted operators (bootstrap owners and runtime controllers) bypass the
    // membership requirement — consistent with the existing access model. The
    // membership result is never consumed on the success path, so no live call
    // is made here.
    if (this.isBootstrapOwner(id)) return { ok: true, membership: undefined };
    if (await this.authorized(id)) return { ok: true, membership: undefined };
    const membership = await this.membershipStatusOf(id, { force: true });

    if (membership.noRequirements) {
      if (await this.isVerified(id)) return { ok: true, membership };
      await this.showVerifyRequired(actor, { chatId, messageId, membership, update });
      return { ok: false, membership };
    }
    if (membership.verified) {
      await this.markVerified(id);
      return { ok: true, membership };
    }
    // Fail closed. A user who was previously verified but has since left the
    // channel/group loses access here. Only a definitive non-membership clears
    // the stale DB flag; a transient/permission failure must not permanently
    // unmark a user who may still be a member.
    if (membership.errorType === 'not_member') {
      await this.markUnverified(id);
    }
    await this.showVerifyRequired(actor, { chatId, messageId, membership, update });
    return { ok: false, membership };
  }

  // ------------------------------ Telegram API ----------------------------

  async api(method, payload) {
    const response = await this.fetch(`${TELEGRAM_API}/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      const error = new Error(result.description || `Telegram API request failed (${response.status}).`);
      error.httpStatus = response.status;
      error.telegramErrorCode = result.error_code;
      throw error;
    }
    return result.result;
  }

  // Live Telegram membership lookup. A bounded retry absorbs transient failures
  // (network errors, HTTP 408/429/5xx). Permission/configuration errors are not
  // retried and still bubble up: callers must fail closed, so an API failure can
  // never read as "joined".
  async getChatMember(chatId, userId) {
    const operation = () => this.api('getChatMember', { chat_id: chatId, user_id: Number(userId) });
    return retryTransient(operation, {
      attempts: MEMBERSHIP_RETRY_ATTEMPTS,
      baseDelayMs: MEMBERSHIP_RETRY_BASE_DELAY_MS,
      maxDelayMs: MEMBERSHIP_RETRY_MAX_DELAY_MS
    });
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

  // Renders a failure for the right surface. A public chat always gets ONE
  // short, clean ANIME MD line — never validation detail, Baileys wording,
  // internal paths or a stack trace. A private chat keeps the actionable
  // detail. The real reason is logged server-side either way.
  async replyWithError(chatId, error, { publicChat = false, messageId, markup } = {}) {
    const isPairingError = Boolean(error?.code && PAIRING_ERROR_TEXTS[error.code]);
    const friendly = friendlyPairingError(error);
    this.log.error?.(`[telegram] ${publicChat ? 'Public' : 'Private'} chat ${chatId} failed (${error?.code || 'UNKNOWN'}): ${error?.message || error}`);
    // Pairing-domain errors edit the message the user was acting on; anything
    // else is a separate short notice. The same split applies in public chats,
    // where the text is the clean public line instead of the detail.
    if (isPairingError) {
      const text = publicChat ? publicPairingFailureBox() : pairingFailedBox(friendly.lines, { retry: friendly.retry });
      return this.present(chatId, messageId, text, publicChat ? homeOnlyMarkup() : (friendly.retry ? retryMarkup() : markup));
    }
    const safeMessage = String(error?.message || 'Unexpected error').slice(0, 200);
    return this.reply(chatId, publicChat ? publicErrorBox() : box('ANIME MD • ERROR', ['', `❌ ${safeMessage}`, '']), markup || homeOnlyMarkup());
  }

  // ----------------------- public-chat pairing pacing ----------------------
  //
  // A group is a shared surface, so pairing there is paced per CHAT in
  // addition to the per-user gates. These checks run before any socket is
  // created and before any Telegram message is sent, so an abusive user can
  // neither open sockets nor spam the group.

  chatFlowKeys(chatId) {
    const key = String(chatId);
    let set = this.chatPairingFlows.get(key);
    if (!set) {
      set = new Set();
      this.chatPairingFlows.set(key, set);
    }
    return set;
  }

  chatFlowCount(chatId) {
    return this.chatPairingFlows.get(String(chatId))?.size || 0;
  }

  // Returns undefined when the chat may start a pairing, or the reason it may
  // not ('cooldown' | 'busy') together with the wait time for a cooldown.
  checkChatPairingPace(chatId) {
    const key = String(chatId);
    const now = Date.now();
    if (this.chatFlowCount(chatId) >= MAX_GROUP_PAIRING_FLOWS) return { allowed: false, reason: 'busy' };
    const last = this.chatPairingCooldowns.get(key) || 0;
    if (now - last < GROUP_PAIRING_COOLDOWN_MS) {
      return { allowed: false, reason: 'cooldown', waitSeconds: (GROUP_PAIRING_COOLDOWN_MS - (now - last)) / 1000 };
    }
    return { allowed: true };
  }

  // Registers a running pairing inside a chat and stamps the cooldown window.
  beginChatPairing(chatId, senderKey) {
    this.chatPairingCooldowns.set(String(chatId), Date.now());
    this.chatFlowKeys(chatId).add(String(senderKey));
  }

  endChatPairing(chatId, senderKey) {
    const key = String(chatId);
    const set = this.chatPairingFlows.get(key);
    if (!set) return;
    set.delete(String(senderKey));
    if (!set.size) this.chatPairingFlows.delete(key);
  }

  prunePendingState() {
    const now = Date.now();
    for (const [key, entry] of this.pendingPairNumbers) {
      if (!entry || entry.expiresAt <= now) this.pendingPairNumbers.delete(key);
    }
    // Drop chat cooldown stamps that have fully elapsed, and chat entries
    // whose flows are all gone (a flow always removes itself, but a chat whose
    // message vanished mid-flow must not keep a stale entry forever).
    for (const [chatId, at] of this.chatPairingCooldowns) {
      if (now - at > GROUP_PAIRING_COOLDOWN_MS * 2) this.chatPairingCooldowns.delete(chatId);
    }
    for (const [chatId, set] of this.chatPairingFlows) {
      for (const senderKey of [...set]) {
        const flow = this.pairingFlows.get(senderKey);
        if (!flow || flow.stopped || String(flow.chatId) !== String(chatId)) set.delete(senderKey);
      }
      if (!set.size) this.chatPairingFlows.delete(chatId);
    }
    // Any pairing flow whose message can no longer be identified is dropped.
    for (const [key, flow] of this.pairingFlows) {
      if (flow?.expiresAt && flow.expiresAt <= now) {
        this.stopSpinner(flow);
        this.pairingFlows.delete(key);
      }
    }
    // Expired pending action continuations and stale verification-failure
    // throttle entries are dropped so the maps never grow without bound.
    for (const [key, pending] of this.pendingActions) {
      if (!pending || pending.expiresAt <= now) this.pendingActions.delete(key);
    }
    for (const [key, at] of this.verificationFailures) {
      if (now - at > VERIFY_FAILURE_NOTIFY_MS * 4) this.verificationFailures.delete(key);
    }
    if (this.membershipCache.size > 1_000) this.membershipCache.clear();
    if (this.actors.size > 5_000) this.actors.clear();
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

  // Every edit of one pairing message is serialized through a per-flow FIFO
  // chain. Combined with the spinner generation (below) this guarantees a
  // loading frame can never land AFTER a state transition (code delivered /
  // connected / failed): a transition is queued behind any frame that is
  // already in flight, and once the spinner is stopped no further frame is
  // ever enqueued. This is what keeps the pairing-code message stable — the
  // old self-rescheduling loop let an in-flight frame overwrite the code box
  // (and even reschedule itself after being "stopped"), which is exactly how
  // the code "appeared and then disappeared".
  queueFlowEdit(flow, editFn) {
    const previous = flow.editChain || Promise.resolve();
    const run = previous.then(editFn);
    flow.editChain = run.then(() => undefined, () => undefined);
    return run;
  }

  spinnerIsCurrent(flow, generation) {
    return !flow.stopped
      && flow.spinnerGeneration === generation
      && this.pairingFlows.get(flow.senderKey) === flow;
  }

  startSpinner(flow) {
    this.stopSpinner(flow);
    const generation = (flow.spinnerGeneration = (flow.spinnerGeneration || 0) + 1);
    flow.spinnerFrame = 0;
    const tick = async () => {
      if (!this.spinnerIsCurrent(flow, generation)) return;
      flow.spinnerFrame = (flow.spinnerFrame + 1) % SPINNER_FRAMES.length;
      const frame = SPINNER_FRAMES[flow.spinnerFrame];
      try {
        await this.queueFlowEdit(flow, async () => {
          // Re-checked inside the queue slot: if the flow moved on to the
          // code/connected/failed state while this frame was waiting its
          // turn, the frame is dropped instead of overwriting the new state.
          if (!this.spinnerIsCurrent(flow, generation)) return;
          const text = pairingLoadingBox(flow.publicDisplay, frame, flow.stage);
          flow.messageId = (await this.editMessage(flow.chatId, flow.messageId, text, undefined))?.message_id || flow.messageId;
        });
      } catch {
        // The spinner must never break the pairing flow.
      }
      if (!this.spinnerIsCurrent(flow, generation)) return;
      flow.spinnerTimer = setTimeout(tick, SPINNER_INTERVAL_MS);
      flow.spinnerTimer.unref?.();
    };
    flow.spinnerTimer = setTimeout(tick, SPINNER_INTERVAL_MS);
    flow.spinnerTimer.unref?.();
  }

  stopSpinner(flow) {
    if (!flow) return;
    // Invalidate every pending, in-flight and queued frame first, then drop
    // the pending timer. An in-flight edit may still complete on the server,
    // but it was queued before any transition, so the transition (queued
    // later) is always the final edit.
    flow.spinnerGeneration = (flow.spinnerGeneration || 0) + 1;
    if (flow.spinnerTimer) {
      clearTimeout(flow.spinnerTimer);
      flow.spinnerTimer = undefined;
    }
  }

  async startPairingAttempt(senderId, number, input, flow, { regenerate = false } = {}) {
    const limit = await this.pairingLimitOf(senderId);
    const request = { sessionLimit: limit };
    if (regenerate) request.regenerate = true;
    // Live stage updates ride on the existing spinner: the next frame renders
    // the new stage line, so no extra Telegram message is ever sent.
    request.onProgress = (stage) => {
      if (!flow.stopped && flow.state === 'PREPARING') flow.stage = stage;
    };
    const result = await this.pairing.requestPairing(senderId, input || number, request);
    if (flow.stopped) return result;
    this.stopSpinner(flow);
    flow.state = 'WAITING';
    flow.code = result.code;
    flow.displayCode = result.displayCode;
    flow.expiresAt = result.expiresAt;
    // ONE message carries the whole lifecycle, in a private chat AND in a
    // group/supergroup: the code box is edited onto the very message that
    // acknowledged the request. A public chat gets the same real WhatsApp
    // code, with the number masked and a single-use warning; nothing is
    // silently redirected to a private chat.
    const codeText = codeReadyBox(
      { ...result, numberDisplay: flow.public ? flow.publicDisplay : result.numberDisplay },
      { public: flow.public }
    );
    const codeMarkup = pairingCodeMarkup(result.displayCode, flow.token);
    try {
      const edited = await this.queueFlowEdit(flow, () => this.editMessage(flow.chatId, flow.messageId, codeText, codeMarkup));
      flow.messageId = edited?.message_id || flow.messageId;
    } catch (error) {
      // A Telegram edit failure (message deleted, too old, API error) must not
      // leave an orphaned socket: the pairing is cancelled and the failure is
      // logged server-side. The user sees the clean public/private box only.
      this.log.error?.(`[telegram] Could not deliver the pairing code message in chat ${flow.chatId}: ${error.message}`);
      await this.queueFlowEdit(flow, () => this.editMessage(
        flow.chatId,
        flow.messageId,
        flow.public ? publicPairingFailureBox() : pairingFailureBox(flow.numberDisplay, ['The pairing message could not be updated.'], { retry: true }),
        retryMarkup()
      )).catch(() => {});
      try {
        if (typeof this.pairing.cancelPairing === 'function') await this.pairing.cancelPairing(senderId, flow.number, {});
      } catch (cancelError) {
        this.log.warn?.(`[telegram] Could not cancel the undeliverable pairing: ${cancelError.message}`);
      }
      flow.state = 'FAILED';
      flow.stopped = true;
      this.pairingFlows.delete(flow.senderKey);
      this.endChatPairing(flow.chatId, flow.senderKey);
      return result;
    }
    // Activity notification: the code itself is a pairing secret and is NEVER
    // included — only the number and the fact that WhatsApp issued a code.
    await this.notifyActivity({
      action: 'Pairing Code Generated',
      actor: flow.actor,
      userId: flow.senderKey,
      details: [`📱 Number: ${flow.numberDisplay}`]
    });
    // Do NOT record paired number here — only on successful WhatsApp connection
    // to avoid consuming slots for failed attempts.
    return result;
  }

  async failPairingAttempt(flow, error) {
    if (flow.stopped) return;
    this.stopSpinner(flow);
    flow.state = 'FAILED';
    this.endChatPairing(flow.chatId, flow.senderKey);
    const friendly = friendlyPairingError(error);
    // Classified errors keep their informative, user-safe reason lines. A bare
    // connection timeout still renders the exact ANIME MD FAILED box.
    const lines = error?.code && friendly.lines?.length ? friendly.lines : [friendlyReasonLine(error)];
    // The real reason is always logged server-side, whatever the chat type.
    this.log.warn?.(`[telegram] Pairing failed for ${flow.numberDisplay} in chat ${flow.chatId}: ${error?.code || 'UNKNOWN'} — ${error?.message || error}`);
    if (flow.public) {
      // PUBLIC ERROR UX: a group/supergroup never receives validation detail,
      // Baileys wording, disconnect reasons or any technical text. It gets one
      // short, clean, human-readable line and nothing else.
      await this.queueFlowEdit(flow, () => this.editMessage(flow.chatId, flow.messageId, publicPairingFailureBox(), pairingFailureMarkup(flow.token))).catch((editError) => {
        this.log.warn?.(`[telegram] Could not update the public pairing failure: ${editError.message}`);
      });
    } else {
      const text = error?.code && friendly.lines?.length
        ? pairingFailureBox(flow.numberDisplay, friendly.lines, { retry: friendly.retry })
        : pairingFailureBox(flow.numberDisplay, friendlyReasonLine(error));
      await this.queueFlowEdit(flow, () => this.editMessage(flow.chatId, flow.messageId, text, pairingFailureMarkup(flow.token))).catch((editError) => {
        this.log.warn?.(`[telegram] Could not update the pairing failure: ${editError.message}`);
      });
    }
    await this.notifyActivity({
      action: 'Pairing Failed',
      actor: flow.actor,
      userId: flow.senderKey,
      details: [`📱 Number: ${flow.numberDisplay}`, `⚠️ ${friendly.lines?.[0] || friendlyReasonLine(error)}`]
    });
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

  // The /pair flow works from private chats, groups and supergroups and uses a
  // SINGLE message per flow. The PREPARING box is sent once and that same
  // message is edited through LOADING → PAIRING CODE → CONNECTED, or FAILED.
  // A group/supergroup is a first-class surface: the request, the loading
  // state, the REAL WhatsApp pairing code and the connected status are all
  // visible there. The phone number is masked and every technical detail
  // (validation reason, Baileys error, disconnect reason, paths, tokens) stays
  // in the server log.
  async handlePairCommand(command) {
    const chatId = command.chatId;
    const senderId = command.senderId;
    const senderKey = String(senderId);
    const publicChat = !chatIsPrivate(command.chat);
    const input = command.args.join('');
    let number;
    try {
      number = normalizeWhatsAppNumber(input);
    } catch (error) {
      // The exact validation reason is logged server-side only. A public chat
      // gets the short clean box — never the number-format lecture; a private
      // chat still gets the actionable detail.
      this.log.warn?.(`[telegram] Invalid pairing number from ${senderId} in chat ${chatId}: ${error.message}`);
      if (publicChat) {
        await this.reply(chatId, publicPairingFailureBox(), retryMarkup());
        return;
      }
      const friendly = friendlyPairingError(error);
      await this.reply(chatId, pairingFailedBox(friendly.lines, { retry: friendly.retry }));
      return;
    }
    const numberDisplay = formatInternationalNumber(number);
    // Public chats only ever see the masked form of the number.
    const publicDisplay = publicChat ? maskInternationalNumber(number) : numberDisplay;

    if (this.premiumOnly) {
      const premium = await this.premiumStatusOf(senderId);
      const vip = await this.vipStatusOf(senderId);
      if (!premium.premium && !vip.vip) {
        await this.reply(chatId, premiumRequiredBox());
        return;
      }
    }

    // Membership was already enforced by the central guard before this handler
    // runs; the DB access/tier gate above is the only pairing-specific check.
    await this.notifyActivity({
      action: 'Pair Request',
      actor: command.actor,
      userId: senderId,
      details: [`📱 Number: ${numberDisplay}`]
    });

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
    try {
      // One request = one pairing flow: while an active flow (preparing or
      // waiting for the link) exists for the SAME number, a repeated /pair is
      // acknowledged without opening a second message, socket or code. (The
      // pairing manager independently shares the in-flight request, so even a
      // request that slips past this check can never produce a second code.)
      const activeFlow = this.getFlow(senderId);
      if (activeFlow && !activeFlow.stopped && activeFlow.number === number
        && (activeFlow.state === 'PREPARING' || activeFlow.state === 'WAITING')) {
        await this.reply(chatId, pairingInProgressBox(publicDisplay));
        return;
      }

      // Duplicate protection across members of the SAME public chat: a second
      // member pairing the SAME number here is acknowledged instead of opening
      // a second flow. The per-number lock inside the pairing manager is the
      // backstop; this is the cheap, message-level guard. It runs BEFORE the
      // pacing check so a duplicate always gets the accurate "already running"
      // notice instead of a misleading "please wait".
      if (publicChat) {
        for (const key of this.chatFlowKeys(chatId)) {
          const other = this.pairingFlows.get(key);
          if (other && !other.stopped && String(other.number) === String(number)
            && (other.state === 'PREPARING' || other.state === 'WAITING')) {
            await this.reply(chatId, groupDuplicateBox(publicDisplay));
            return;
          }
        }
      }

      // Public-chat pacing (group/supergroup only). Checked before any pairing
      // message is sent and before any socket is opened, so an abusive member
      // can neither spam the group nor make the bot create sockets.
      if (publicChat) {
        const pace = this.checkChatPairingPace(chatId);
        if (!pace.allowed) {
          await this.reply(chatId, pace.reason === 'busy' ? groupBusyBox(MAX_GROUP_PAIRING_FLOWS) : groupCooldownBox(pace.waitSeconds));
          return;
        }
      }

      const token = this.newFlowToken();
      let sent;
      try {
        // The ONLY new Telegram message for the whole lifecycle.
        sent = await this.reply(chatId, pairingStartedBox(publicDisplay));
      } catch (error) {
        this.log.error?.(`[telegram] Could not start the pairing view: ${error.message}`);
        return;
      }
      const flow = {
        chatId, senderKey, number, numberDisplay, publicDisplay,
        public: publicChat,
        state: 'PREPARING', token,
        actor: this.actors.get(senderKey) || { id: senderId },
        messageId: sent?.message_id,
        spinnerTimer: undefined, spinnerFrame: 0, spinnerGeneration: 0,
        editChain: undefined,
        code: undefined, displayCode: undefined, expiresAt: undefined,
        stopped: false
      };
      this.pairingFlows.set(senderKey, flow);
      // Public chats are counted for the per-chat concurrency cap; the entry
      // is removed when the flow reaches any terminal state.
      if (publicChat) this.beginChatPairing(chatId, senderKey);
      this.startSpinner(flow);

      try {
        await this.startPairingAttempt(senderId, number, number, flow);
      } catch (error) {
        await this.failPairingAttempt(flow, error);
      }
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
      flow.stage = 'PREPARING';
      flow.code = undefined;
      flow.displayCode = undefined;
      flow.expiresAt = undefined;
      // A regenerated code edits the SAME message — in a private chat and in a
      // group alike — so no second code message is ever stacked in the chat.
      if (flow.public) this.beginChatPairing(chatId, flow.senderKey);
      flow.messageId = (await this.queueFlowEdit(flow, () => this.editMessage(chatId, flow.messageId, pairingStartedBox(flow.publicDisplay), undefined)))?.message_id || flow.messageId;
      this.startSpinner(flow);
      await this.startPairingAttempt(senderId, flow.number, flow.number, flow, { regenerate: true });
    } catch (error) {
      await this.failPairingAttempt(flow, error);
    } finally {
      release();
    }
  }

  async handleVerify(senderId, chatId, { messageId, actor } = {}) {
    const id = normalizeTelegramId(senderId);
    const eventActor = actor || this.actors.get(String(id)) || { id };

    // Loading state is edited onto the existing message when possible (inline
    // VERIFY button). For a /verify command there is no prior message, so the
    // check simply runs and the result is posted.
    if (messageId) {
      try {
        await this.present(chatId, messageId, verificationLoadingBox(), undefined);
      } catch (error) {
        this.log.warn?.(`[telegram] Could not show the verification loading state: ${error.message}`);
      }
    }

    const membership = await this.membershipStatusOf(id, { force: true });

    if (membership.noRequirements || membership.verified) {
      await this.markVerified(id);
      this.verificationFailures.delete(String(id));
      await this.notifyActivity({
        action: 'Verification Success', actor: eventActor, userId: id, membership: 'Verified'
      });
      await this.present(chatId, messageId, verificationSuccessBox(membership), verifiedMarkup());
      await this.continuePending(id);
      return;
    }

    // Fail closed. A previously verified user who definitively left the
    // channel/group is re-marked unverified here. A transient/permission
    // failure never clears the flag (the user may still be a member).
    if (membership.errorType === 'not_member') {
      await this.markUnverified(id);
    }
    const lastFailure = this.verificationFailures.get(String(id)) || 0;
    if (Date.now() - lastFailure > VERIFY_FAILURE_NOTIFY_MS) {
      this.verificationFailures.set(String(id), Date.now());
      await this.notifyActivity({
        action: 'Verification Failed', actor: eventActor, userId: id, membership: 'Not Verified'
      });
    }
    const text = verificationResultBox(membership);
    await this.present(chatId, messageId, text, joinVerifyMarkup(this.requiredCommunities || []));
  }

  async handleJoinAll(senderId, chatId, messageId) {
    const communities = this.requiredCommunities || [];
    await this.present(chatId, messageId, joinAllBox(communities), joinLinksMarkup(communities));
  }

  // ------------------------------ views -----------------------------------

  async sendSessionsView(chatId, senderId, { messageId, admin = false, publicChat = false } = {}) {
    const sessions = await this.pairing.listSessions(senderId);
    return this.present(chatId, messageId, sessionsBox(sessions, publicChat), sessionsMarkup(sessions, publicChat));
  }

  async sendStatusView(chatId, senderId, { messageId, publicChat = false } = {}) {
    const sessions = await this.pairing.listSessions(senderId);
    const tier = await this.tierOf(senderId);
    const membership = await this.membershipLabelOf(senderId);
    const text = overallStatusBox(sessions, (Date.now() - (this.startedAt || Date.now())) / 1000, { tier, membership }, publicChat);
    return this.present(chatId, messageId, text, { inline_keyboard: [[
      { text: '🔄 Refresh', callback_data: 'nav:status' },
      { text: '🏠 Home', callback_data: 'home' }
    ]] });
  }

  async sendSessionMenuView(chatId, senderId, number, { messageId, admin = false, publicChat = false } = {}) {
    const session = await this.pairing.statusOf(senderId, number, { admin });
    const foreign = admin && String(session.ownerId) !== String(senderId);
    return this.present(chatId, messageId, statusBox(session, { ownerId: foreign ? session.ownerId : undefined, publicChat }), sessionMenuMarkup(session.number));
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

  async sendAccountView(chatId, senderId, { messageId, publicChat = false } = {}) {
    const role = await this.roleOf(senderId);
    const verified = (await this.membershipLabelOf(senderId)) === 'verified';
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
      pairedNumbers, limit, used, publicChat,
      blockStatus: blockStatus.blocked ? blockStatus : undefined
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

  async sendSystemStatusView(chatId, senderId, { messageId, owner = false } = {}) {
    const access = await this.accessOf(senderId);
    if (access !== 'bootstrap' && access !== 'controller') throw Object.assign(new Error('Admin only'), { code: 'DENIED' });
    let sessions = 0;
    let queued = 0;
    try {
      if (typeof this.pairing?.listAllSessions === 'function') sessions = (await this.pairing.listAllSessions().catch(() => [])).length;
      else sessions = (await this.pairing.listSessions(senderId).catch(() => [])).length;
    } catch {}
    try {
      if (typeof this.pairing?.queuedPairingCount === 'function') queued = Number(await this.pairing.queuedPairingCount()) || 0;
    } catch {}
    const text = systemStatusBox({
      uptime: (Date.now() - (this.startedAt || Date.now())) / 1000,
      sessions,
      queued,
      publicMode: this.publicMode,
      premiumOnly: this.premiumOnly
    });
    return this.present(chatId, messageId, text, owner ? ownerPanelMarkup() : adminPanelMarkup());
  }

  // Owner-only control center. Distinct from the admin panel: owners manage
  // controllers/owners plus everything admins can see.
  async sendOwnerPanelView(chatId, senderId, { messageId } = {}) {
    const access = await this.accessOf(senderId);
    if (access !== 'bootstrap') {
      throw Object.assign(new Error('Only bootstrap owners can access the Owner Panel.'), { code: 'DENIED' });
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
    const text = ownerPanelBox({ controllers, premiumUsers, totalUsers, blockedUsers, sessions });
    return this.present(chatId, messageId, text, ownerPanelMarkup());
  }

  // Premium tier info + the requesting user's own premium status.
  // BUY ACCESS / PREMIUM page. Limits come from the access model constants and
  // the caller's own tier/usage from the user database — never hardcoded here.
  async sendPremiumView(chatId, senderId, { messageId } = {}) {
    const premium = await this.premiumStatusOf(senderId);
    const vip = await this.vipStatusOf(senderId);
    const tier = await this.tierOf(senderId);
    const limit = await this.pairingLimitOf(senderId);
    const used = await this.pairingUsageOf(senderId);
    const active = (premium.premium && !premium.bootstrap) || vip.vip;
    const text = premiumAccessBox({ tier, used, limit, active, expiresAt: premium.expiresAt });
    return this.present(chatId, messageId, text, premiumAccessMarkup());
  }

  // ALL MENU — read-only directory of the WhatsApp commands (see allMenuBox).
  async sendAllMenuView(chatId, senderId, { messageId } = {}) {
    return this.present(chatId, messageId, allMenuBox(this.commandPrefix), allMenuMarkup());
  }

  async sendMenuCategoryView(chatId, senderId, categoryId, { messageId } = {}) {
    const category = categoriesWithCommands().find((entry) => entry.id === String(categoryId || '').toLowerCase());
    if (!category) {
      // Deliberately NOT 'NOT_FOUND': that code belongs to the pairing error
      // map, and reusing it here would render a "no session found" pairing box
      // for a plain menu navigation error.
      throw Object.assign(new Error('Unknown command category.'), { code: 'UNKNOWN_CATEGORY' });
    }
    return this.present(chatId, messageId, menuCategoryBox(category, this.commandPrefix), menuCategoryMarkup());
  }

  async sendDeveloperView(chatId, senderId, { messageId } = {}) {
    return this.present(chatId, messageId, developerBox(this.identity), developerMarkup());
  }

  async sendThanksView(chatId, senderId, { messageId } = {}) {
    return this.present(chatId, messageId, thanksBox(this.identity), thanksMarkup());
  }

  // Global session list for admin/owner eyes only. Regular users never reach
  // this view: the callbacks enforce the management role first.
  async sendAllSessionsView(chatId, senderId, { messageId, publicChat = false, owner = false } = {}) {
    const access = await this.accessOf(senderId);
    if (access !== 'bootstrap' && access !== 'controller') throw Object.assign(new Error('Admin only'), { code: 'DENIED' });
    const sessions = typeof this.pairing?.listAllSessions === 'function'
      ? await this.pairing.listAllSessions().catch(() => [])
      : [];
    if (!sessions.length) {
      return this.present(chatId, messageId, box('ANIME MD • ALL SESSIONS', ['', '📭 No paired sessions on this bot.', '']), owner ? ownerPanelMarkup() : adminPanelMarkup());
    }
    const lines = sessions.map((session) => `${badgeParts(session.status).icon} ${displayNumber(session, publicChat)} — ${badgeParts(session.status).label || session.status} (user ${session.ownerId ?? '?'})`);
    return this.present(chatId, messageId, box('ANIME MD • ALL SESSIONS', ['', ...lines, '', `Total: ${sessions.length} session${sessions.length === 1 ? '' : 's'}`]), owner ? ownerPanelMarkup() : adminPanelMarkup());
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

    // Chat type drives presentation (masked numbers, private code delivery),
    // never acceptance.
    command.chat = message?.chat;

    const actor = actorFrom(message?.from) || { id: command.senderId };
    if (actor?.id != null) this.actors.set(String(actor.id), actor);

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
      return this.handleVerify(command.senderId, command.chatId, { actor });
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
    if (OWNER_COMMANDS.has(command.name) && access !== 'bootstrap') {
      await this.reply(command.chatId, accessDeniedBox('OWNER'), homeOnlyMarkup());
      return;
    }
    if (ADMIN_COMMANDS.has(command.name) && access !== 'bootstrap' && access !== 'controller') {
      await this.reply(command.chatId, accessDeniedBox('ADMIN'), homeOnlyMarkup());
      return;
    }

    // Group/supergroup support: pairing and every other command are accepted
    // in any chat type. Sensitive data is protected by presentation, not by
    // rejecting the chat — the pairing code is only ever delivered through
    // the initiator's private chat, and numbers are masked in public chats.

    // Centralized membership verification: every restricted command funnels
    // through the same guard, which performs a LIVE channel + group membership
    // check and blocks (with the Join/Verify UI) until BOTH are joined.
    if (!OPEN_COMMANDS.has(command.name)) {
      const guard = await this.requireMembership(actor, { chatId: command.chatId, update });
      if (!guard.ok) return;
    }

    // Public-chat presentation only: numbers rendered into a group/supergroup
    // are masked; the pairing code itself is delivered in the private chat.
    const publicChat = !chatIsPrivate(command.chat);

    try {
      switch (command.name) {
        case 'help': {
          const role = await this.roleOf(command.senderId);
          await this.reply(command.chatId, helpTextForRole(role), homeOnlyMarkup());
          return;
        }
        case 'start': {
          // Registration flow: ensure user exists, check block (already), then
          // re-check membership live (opens the main menu = a re-check trigger).
          await this.ensureUserExists(command.senderId);
          await this.notifyActivity({ action: 'Start', actor, userId: command.senderId });
          const guard = await this.requireMembership(actor, { chatId: command.chatId, update });
          if (!guard.ok) return;
          const role = await this.roleOf(command.senderId);
          const tier = await this.tierOf(command.senderId);
          const limit = await this.pairingLimitOf(command.senderId);
          const used = await this.pairingUsageOf(command.senderId);
          const limitDisplay = Number.isFinite(limit) ? limit : '∞';
          await this.replyPhoto(command.chatId, this.startImage, `${startupBox()}\n\n${menuPrompt(`${tier.icon} Role: ${tier.label}`, used, limitDisplay)}`, roleHomeMarkup(role));
          return;
        }
        case 'guide':
          await this.reply(command.chatId, guideBox(), guideMarkup());
          return;
        case 'allmenu':
        case 'commands':
          await this.sendAllMenuView(command.chatId, command.senderId, {});
          return;
        case 'developer':
        case 'dev':
          await this.sendDeveloperView(command.chatId, command.senderId, {});
          return;
        case 'thanks':
        case 'thanksto':
          await this.sendThanksView(command.chatId, command.senderId, {});
          return;
        case 'myaccount':
        case 'account': {
          await this.sendAccountView(command.chatId, command.senderId, { publicChat });
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
          await this.reply(command.chatId, sessionsBox(sessions, publicChat), sessionsMarkup(sessions, publicChat));
          return;
        }
        case 'status': {
          if (command.args[0]) {
            const session = await this.pairing.statusOf(command.senderId, command.args[0], { admin: access === 'bootstrap' });
            const foreign = access === 'bootstrap' && String(session.ownerId) !== String(command.senderId);
            await this.reply(command.chatId, statusBox(session, { ownerId: foreign ? session.ownerId : undefined, publicChat }), sessionMenuMarkup(session.number));
            return;
          }
          const sessions = await this.pairing.listSessions(command.senderId);
          const anyConnected = sessions.some((session) => session.connected);
          const tier = await this.tierOf(command.senderId);
          const membership = await this.membershipLabelOf(command.senderId);
          const text = overallStatusBox(sessions, (Date.now() - (this.startedAt || Date.now())) / 1000, { tier, membership }, publicChat);
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
            await this.reply(command.chatId, box('ANIME MD • RESTARTING', ['', `📱 ${displayNumber(session, publicChat)}`, `${badgeParts(session.status).icon} Status: ${badgeParts(session.status).label || session.status}`, '', 'The CONNECTED confirmation arrives', 'when WhatsApp reports the session online.']), backHomeMarkup());
            await this.notifyActivity({ action: 'Restart Request', actor, userId: command.senderId, details: [`📱 Number: ${session.numberDisplay}`] });
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
            await this.notifyActivity({ action: 'Controller Added', actor, userId: command.senderId, details: [`👤 Target: ${id}`] });
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
            await this.notifyActivity({ action: 'Controller Removed', actor, userId: command.senderId, details: [`👤 Target: ${id}`] });
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
            await this.notifyActivity({ action: 'Premium Granted', actor, userId: command.senderId, details: [`👤 Target: ${id}`] });
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
            await this.notifyActivity({ action: 'Premium Revoked', actor, userId: command.senderId, details: [`👤 Target: ${id}`] });
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
            await this.notifyActivity({ action: 'VIP Granted', actor, userId: command.senderId, details: [`👤 Target: ${id}`] });
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
            await this.notifyActivity({ action: 'VIP Revoked', actor, userId: command.senderId, details: [`👤 Target: ${id}`] });
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
            await this.notifyActivity({ action: 'User Blocked', actor, userId: command.senderId, details: [`👤 Target: ${id}`] });
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
            await this.notifyActivity({ action: 'User Unblocked', actor, userId: command.senderId, details: [`👤 Target: ${id}`] });
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
          const lines = sessions.map((session) => `${badgeParts(session.status).icon} ${displayNumber(session, publicChat)} — ${badgeParts(session.status).label || session.status} (user ${session.ownerId ?? '?'})`);
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
            await this.notifyActivity({ action: `Premium-Only Pairing ${mode === 'on' ? 'ON' : 'OFF'}`, actor, userId: command.senderId });
            return;
          }
          // Same page as the 💎 BUY ACCESS button, so the /premium command and
          // the dashboard never show two different premium views.
          await this.sendPremiumView(command.chatId, command.senderId, {});
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
            await this.notifyActivity({ action: `Public Pairing ${mode === 'on' ? 'ON' : 'OFF'}`, actor, userId: command.senderId });
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
            const removedDisplay = publicChat
              ? (session.number ? maskInternationalNumber(session.number) : session.numberDisplay || formatInternationalNumber(command.args[0]))
              : (session.numberDisplay || formatInternationalNumber(command.args[0]));
            await this.reply(command.chatId, stoppedBox(removedDisplay), pairAgainMarkup());
            await this.maybeRemovePairedNumber(command.senderId, command.args[0]);
            await this.notifyActivity({ action: 'Session Removed', actor, userId: command.senderId, details: [`📱 Number: ${session.numberDisplay || formatInternationalNumber(command.args[0])}`] });
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
      // Pairing-domain errors render as their friendly box in a private chat;
      // a public chat only ever gets the short clean line. Raw internal errors
      // are logged, never displayed in either surface.
      await this.replyWithError(command.chatId, error, { publicChat });
    }
  }

  // ------------------------------ callbacks -------------------------------

  async handleCallback(callback) {
    const senderId = callback.from?.id;
    const chatId = callback.message?.chat?.id;
    const messageId = callback.message?.message_id;
    const action = String(callback.data || '');
    if (!senderId || !chatId) return;
    const actor = actorFrom(callback.from) || { id: senderId };
    if (actor?.id != null) this.actors.set(String(actor.id), actor);
    // Chat type drives presentation only (masked numbers, one clean public
    // error line) — it never rejects a callback. Declared here, outside the
    // try, so the error handler can apply the same public/private split.
    const publicChat = !chatIsPrivate(callback?.message?.chat);
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
      const [scope, verb, argument] = action.split(':');

      // The regen callback is bound to an unforgeable flow token created inside
      // an already-verified pairing flow, so it is validated by token + owner
      // (in handleRegenerate) BEFORE the membership guard. Running the guard
      // first would otherwise edit a foreign user's pairing message with the
      // wrong user's verify prompt. The flow itself can only exist after the
      // original /pair passed the live membership check.
      if (scope === 'pair' && verb === 'regen') {
        return await this.handleRegenerate(senderId, argument, callback);
      }

      // Centralized membership guard for every protected callback (menu views,
      // session controls, pairing, settings). Verification/join buttons and the
      // informational help/guide stay open. The guard uses the actual callback
      // `from.id` so one user can never verify (or act) on another's behalf.
      // Pure information pages (help, guide, the read-only command directory,
      // developer and thanks) stay open; everything that touches a user's
      // sessions or settings is guarded.
      const OPEN_CALLBACKS = new Set([
        'verify:me', 'verify:joinall', 'verify:done', 'nav:help', 'nav:guide', 'help',
        'nav:allmenu', 'nav:developer', 'nav:thanks'
      ]);
      if (!OPEN_CALLBACKS.has(action)) {
        const guard = await this.requireMembership(actor, { chatId, messageId, update: { callback_query: callback } });
        if (!guard.ok) return;
      }

      // Legacy one-word callbacks kept working for older messages.
      if (action === 'pair_help') return await this.beginPairPrompt(chatId, senderId);
      if (action === 'help') {
        const role = await this.roleOf(senderId);
        return await this.present(chatId, messageId, helpText(), roleHomeMarkup(role));
      }
      if (action === 'status') return await this.sendStatusView(chatId, senderId, { publicChat });
      if (action === 'sessions') return await this.sendSessionsView(chatId, senderId, { publicChat });

      if (action === 'verify:me') {
        return await this.handleVerify(senderId, chatId, { messageId, actor });
      }

      if (action === 'verify:joinall') {
        return await this.handleJoinAll(senderId, chatId, messageId);
      }

      if (action === 'verify:done') {
        // Acknowledges the verified state without changing anything.
        return await this.api('answerCallbackQuery', { callback_query_id: callback.id, text: '✅ Verified', show_alert: false }).catch(() => {});
      }

      if (action === 'home') {
        const role = await this.roleOf(senderId);
        const tier = await this.tierOf(senderId);
        const limit = await this.pairingLimitOf(senderId);
        const used = await this.pairingUsageOf(senderId);
        const limitDisplay = Number.isFinite(limit) ? limit : '∞';
        return await this.present(chatId, messageId, `${startupBox()}\n\n${menuPrompt(`${tier.icon} Role: ${tier.label}`, used, limitDisplay)}`, roleHomeMarkup(role));
      }
      if (action === 'pair:new') {
        return await this.beginPairPrompt(chatId, senderId);
      }
      if (action === 'nav:guide') {
        return await this.present(chatId, messageId, guideBox(), guideMarkup());
      }
      if (action === 'nav:allmenu') {
        return await this.sendAllMenuView(chatId, senderId, { messageId });
      }
      if (action === 'nav:developer') {
        return await this.sendDeveloperView(chatId, senderId, { messageId });
      }
      if (action === 'nav:thanks') {
        return await this.sendThanksView(chatId, senderId, { messageId });
      }
      // ALL MENU → CATEGORY: `menu:cat:<categoryId>` opens the command list of
      // one real category with a BACK to ALL MENU and a way home.
      if (scope === 'menu' && verb === 'cat') {
        return await this.sendMenuCategoryView(chatId, senderId, argument, { messageId });
      }
      if (action === 'nav:help') {
        const role = await this.roleOf(senderId);
        return await this.present(chatId, messageId, helpTextForRole(role), homeOnlyMarkup());
      }
      if (action === 'nav:premium') {
        return await this.sendPremiumView(chatId, senderId, { messageId });
      }
      if (action === 'nav:owner') {
        return await this.sendOwnerPanelView(chatId, senderId, { messageId });
      }
      if (action === 'nav:status') {
        return await this.sendStatusView(chatId, senderId, { messageId, publicChat });
      }
      if (action === 'nav:sessions') {
        return await this.sendSessionsView(chatId, senderId, { messageId, admin: isOwner, publicChat });
      }
      if (action === 'nav:settings') {
        return await this.sendSettingsView(chatId, senderId, { messageId, admin: isOwner });
      }
      if (action === 'nav:account') {
        return await this.sendAccountView(chatId, senderId, { messageId, publicChat });
      }
      if (action === 'nav:admin') {
        return await this.sendAdminPanelView(chatId, senderId, { messageId });
      }
      if (scope === 'owner') {
        if (!isOwner) throw Object.assign(new Error('Only bootstrap owners can access the Owner Panel.'), { code: 'DENIED' });
        if (verb === 'users') return await this.sendUserManagementView(chatId, senderId, { messageId });
        if (verb === 'owners') {
          const runtime = typeof this.controllerStore?.read === 'function' ? await this.controllerStore.read().catch(() => []) : [];
          const lines = ['', '👑 Bootstrap owners (config.js):', ...[...this.bootstrapOwners].map((id) => ` • ${id}`)];
          lines.push('', '🤖 Runtime controllers (/addowner):');
          if (runtime.length) for (const id of runtime) lines.push(` • ${id}`);
          else lines.push(' • none yet');
          lines.push('', 'Use /addowner <id> /delowner <id>');
          return await this.present(chatId, messageId, box('ANIME MD • OWNERS', lines), ownerPanelMarkup());
        }
        if (verb === 'admins') {
          const runtime = typeof this.controllerStore?.read === 'function' ? await this.controllerStore.read().catch(() => []) : [];
          const lines = runtime.length ? runtime.map((id) => ` • ${id}`) : ['No runtime controllers'];
          return await this.present(chatId, messageId, box('ANIME MD • ADMINS', ['', ...lines, '', 'Use /addowner <id> /delowner <id>']), ownerPanelMarkup());
        }
        if (verb === 'premium') {
          const premiumUsers = typeof this.controllerStore?.listPremium === 'function' ? await this.controllerStore.listPremium().catch(() => []) : [];
          const lines = premiumUsers.length ? premiumUsers.map((u) => ` • ${u.id} until ${new Date(u.expiresAt).toISOString().slice(0,10)}`) : ['No premium users'];
          return await this.present(chatId, messageId, box('ANIME MD • PREMIUM MANAGEMENT', ['', ...lines, '', 'Use /addprem <id> [30d] /delprem <id>']), ownerPanelMarkup());
        }
        if (verb === 'vip') {
          let users = {};
          try { if (typeof this.controllerStore?.users === 'function') users = await this.controllerStore.users(); } catch {}
          const vips = Object.entries(users).filter(([, rec]) => rec.vip).map(([id]) => ` • ${id} VIP`);
          const lines = vips.length ? vips : ['No VIP users'];
          return await this.present(chatId, messageId, box('ANIME MD • VIP MANAGEMENT', ['', ...lines, '', 'Use /addvip <id> [30d] /delvip <id>']), ownerPanelMarkup());
        }
        if (verb === 'sessions') return await this.sendAllSessionsView(chatId, senderId, { messageId, publicChat, owner: true });
        if (verb === 'blocks') {
          let users = {};
          try { if (typeof this.controllerStore?.users === 'function') users = await this.controllerStore.users(); } catch {}
          const blocked = Object.entries(users).filter(([, rec]) => rec.blockedUntil && rec.blockedUntil > Date.now()).map(([id, rec]) => ` • ${id} until ${formatUnblockTimestamp(rec.blockedUntil)}`);
          const lines = blocked.length ? blocked : ['No blocked users'];
          return await this.present(chatId, messageId, box('ANIME MD • BLOCK MANAGEMENT', ['', ...lines, '', 'Use /block <id> [24h] /unblock <id>']), ownerPanelMarkup());
        }
        if (verb === 'system') return await this.sendSystemStatusView(chatId, senderId, { messageId, owner: true });
        if (verb === 'config') return await this.sendSettingsView(chatId, senderId, { messageId, admin: true });
        throw Object.assign(new Error('Owner button expired'), { code: 'EXPIRED' });
      }

      if (scope === 'admin') {
        if (!admin) throw Object.assign(new Error('Admin only'), { code: 'DENIED' });
        if (verb === 'users') return await this.sendUserManagementView(chatId, senderId, { messageId });
        if (verb === 'sessions') return await this.sendAllSessionsView(chatId, senderId, { messageId, publicChat });
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
          return await this.sendSessionMenuView(chatId, senderId, number, { messageId, admin: isOwner, publicChat });
        }
        if (verb === 'restart') {
          const release = this.reserveSensitiveRequest(senderId, 'restart');
          try {
            const session = await this.pairing.restartSession(senderId, number, { admin: isOwner });
            return await this.present(chatId, messageId, box('ANIME MD • RESTARTING', ['', `📱 ${displayNumber(session, publicChat)}`, `${badgeParts(session.status).icon} Status: ${badgeParts(session.status).label || session.status}`, '', 'The CONNECTED confirmation arrives', 'when WhatsApp reports the session online.']), backHomeMarkup());
          } finally {
            release();
          }
        }
        if (verb === 'stop') {
          const session = await this.pairing.statusOf(senderId, number, { admin: isOwner });
          return await this.present(chatId, messageId, box('ANIME MD • REMOVE SESSION', [
            '',
            `📱 ${displayNumber(session, publicChat)}`,
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
            return await this.present(chatId, messageId, stoppedBox(displayNumber(session, publicChat)), pairAgainMarkup());
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
      // Same public/private split as the command path: a group never receives
      // technical wording from a button handler either.
      return await this.replyWithError(chatId, error, { publicChat, messageId });
    }
  }

  async pollOnce() {
    const updates = await this.api('getUpdates', { offset: this.offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ['message', 'callback_query'] });
    for (const update of updates) {
      this.offset = Math.max(this.offset, Number(update.update_id) + 1);
      await this.handleUpdate(update);
    }
  }

  // Owner/admin activity monitoring. Events are formatted into a compact
  // ANIME MD • ACTIVITY box and delivered to every configured bootstrap owner.
  // Only non-sensitive data is included: user id/username, database tier,
  // membership status, the action, the WhatsApp number when relevant, and the
  // time. Pairing codes, tokens, session credentials and raw Baileys state are
  // never included.
  async notifyActivity(event) {
    if (typeof this.activityLogger !== 'function') return;
    try {
      await this.activityLogger(event);
    } catch (error) {
      this.log.warn?.(`[telegram] Activity logger failed: ${error.message}`);
    }
  }

  async sendOwnerActivity(event) {
    if (!this.running) return;
    if (!this.bootstrapOwners.size) return;
    const userId = String(event?.userId ?? event?.actor?.id ?? '');
    const actor = event?.actor || (userId ? this.actors.get(userId) : undefined) || {};
    let tier = event?.tier;
    let membership = event?.membership;
    if (!tier && userId) {
      try { tier = await this.tierOf(userId); } catch { tier = undefined; }
    }
    if (!membership && userId) {
      try { membership = await this.membershipLabelOf(userId); } catch { membership = 'Unknown'; }
    }
    const text = activityBox({
      userId: userId || 'unknown',
      username: actor.username,
      name: actor.name,
      tier: tier?.label || tier || 'FREE',
      tierIcon: tier?.icon,
      membership: membership === 'verified' ? 'Verified' : membership === 'not_verified' ? 'Not Verified' : 'Unknown',
      action: event?.action || 'Action',
      details: event?.details || []
    });
    for (const ownerId of this.bootstrapOwners) {
      try {
        await this.api('sendMessage', { chat_id: ownerId, text: escapeTelegramHtml(text), parse_mode: 'HTML' });
      } catch (error) {
        // An owner who never opened the bot cannot receive a proactive message;
        // this must not stop polling for the other owners.
        this.log.warn?.(`[telegram] Could not send activity notification to ${ownerId}: ${error.message}`);
      }
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
  // CONNECTED state instead of posting a new Telegram message. For flows
  // started in a public chat the same message in that group/supergroup is
  // updated, with the number masked.
  async notifySessionConnected(ownerId, session) {
    if (!this.running) return;
    // Record successful pairing only on actual connection, not on code generation
    try {
      const num = String(session?.number || '').replace(/\D/g, '');
      if (/^\d{7,15}$/.test(num)) {
        await this.maybeRecordPairedNumber(ownerId, num);
      }
    } catch {}
    await this.notifyActivity({
      action: 'WhatsApp Session Connected',
      userId: ownerId,
      details: [`📱 Number: ${session?.numberDisplay || session?.number || ''}`]
    });
    const flow = this.getFlow(ownerId);
    const number = String(session?.number || '');
    if (flow && !flow.stopped && (number === String(flow.number) || !number)) {
      this.stopSpinner(flow);
      flow.state = 'SUCCESS';
      flow.stopped = true;
      this.pairingFlows.delete(flow.senderKey);
      this.endChatPairing(flow.chatId, flow.senderKey);
      // One message, edited in place — the group sees the masked number, a
      // private chat sees the full one.
      const successText = connectedBox(flow.public ? flow.publicDisplay : (session?.numberDisplay || flow.numberDisplay), flow.actor?.username);
      await this.queueFlowEdit(flow, () => this.editMessage(flow.chatId, flow.messageId, successText, connectedMarkup())).catch((error) => {
        this.log.warn?.(`[telegram] Could not update the connected state in chat ${flow.chatId}: ${error.message}`);
      });
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
    await this.notifyActivity({
      action: 'WhatsApp Session Disconnected',
      userId: ownerId,
      details: [`📱 Number: ${session?.numberDisplay || session?.number || ''}`]
    });
    const flow = this.getFlow(ownerId);
    const failedBeforeLink = !session?.registered;
    if (flow && !flow.stopped) {
      this.stopSpinner(flow);
      flow.state = 'FAILED';
      flow.stopped = true;
      this.pairingFlows.delete(flow.senderKey);
      this.endChatPairing(flow.chatId, flow.senderKey);
      const reasonLine = classification?.userMessage || 'The WhatsApp connection timed out.';
      // The classified reason is logged; a public chat only ever gets the
      // short clean line.
      this.log.warn?.(`[telegram] Session ${session?.numberDisplay || session?.number || ''} disconnected (${classification?.type || 'UNKNOWN'}) for ${ownerId}: ${reasonLine}`);
      if (flow.public) {
        await this.queueFlowEdit(flow, () => this.editMessage(flow.chatId, flow.messageId, publicPairingFailureBox(), pairingFailureMarkup(flow.token))).catch((error) => {
          this.log.warn?.(`[telegram] Could not update the public failure state: ${error.message}`);
        });
        return;
      }
      await this.queueFlowEdit(flow, () => this.editMessage(flow.chatId, flow.messageId, pairingFailureBox(flow.numberDisplay, reasonLine), pairingFailureMarkup(flow.token)));
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

  // Called by the pairing manager when a pairing code expired without a link
  // (its socket and unregistered credentials are already cleaned up). Updates
  // the pairing message so a stale "code ready" box is never left behind.
  async notifyCodeExpired(ownerId, session) {
    if (!this.running) return;
    const flow = this.getFlow(ownerId);
    const number = String(session?.number || '');
    if (!flow || flow.stopped || (number && number !== String(flow.number))) return;
    if (flow.state !== 'WAITING') return;
    this.stopSpinner(flow);
    flow.state = 'EXPIRED';
    flow.stopped = true;
    this.pairingFlows.delete(flow.senderKey);
    this.endChatPairing(flow.chatId, flow.senderKey);
    // One message, edited in place: a stale "code ready" box is never left
    // behind, in a private chat or in a group.
    await this.queueFlowEdit(flow, () => this.editMessage(flow.chatId, flow.messageId, pairingExpiredBox(flow.publicDisplay), retryMarkup())).catch((error) => {
      this.log.warn?.(`[telegram] Could not update the expired pairing state: ${error.message}`);
    });
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
  ADMIN_COMMANDS,
  CODE_SOURCE_LABEL,
  DEFAULT_BLOCK_DURATION_MS,
  MEMBERSHIP_CACHE_TTL_MS,
  MEMBERSHIP_JOINED_STATUSES,
  MEMBERSHIP_NOT_MEMBER_STATUSES,
  MEMBERSHIP_RETRY_ATTEMPTS,
  MEMBERSHIP_RETRY_BASE_DELAY_MS,
  MEMBERSHIP_RETRY_MAX_DELAY_MS,
  NORMAL_PAIRING_LIMIT,
  OWNER_COMMANDS,
  PREMIUM_PAIRING_LIMIT,
  SENSITIVE_COOLDOWN_MS,
  SENSITIVE_LOCK_TTL_MS,
  SPINNER_FRAMES,
  SESSION_STATE_BADGES,
  TIER_LABELS,
  TRANSIENT_HTTP_STATUSES,
  TelegramController,
  accessDeniedBox,
  activityBox,
  actorFrom,
  badgeParts,
  blockedBox,
  chatIsPrivate,
  classifyMemberError,
  codeReadyBox,
  commandCount,
  commandFromUpdate,
  communityLink,
  connectedBox,
  connectedMarkup,
  escapeTelegramHtml,
  formatRemainingDuration,
  formatUnblockTimestamp,
  formatUptime,
  friendlyPairingError,
  friendlyReasonLine,
  guideBox,
  guideMarkup,
  helpText,
  helpTextForRole,
  homeMarkup,
  isExplicitlyNotMember,
  isJoinedMemberStatus,
  joinAllBox,
  joinLinksMarkup,
  joinVerifyMarkup,
  membershipErrorSeverity,
  retryTransient,
  roleHomeMarkup,
  accountBox,
  adminPanelBox,
  adminPanelMarkup,
  accountMarkup,
  limitBox,
  menuMarkup,
  menuPrompt,
  myIdBox,
  displayNumber,
  normalizeTelegramId,
  normalizeWhatsappNumber: normalizeWhatsAppNumber,
  overallStatusBox,
  ownerPanelBox,
  ownerPanelMarkup,
  pairingCodeMarkup,
  pairingExpiredBox,
  pairingFailedBox,
  pairingFailureBox,
  pairingFailureMarkup,
  pairingInProgressBox,
  pairingLoadingBox,
  pairingStartedBox,
  allMenuBox,
  allMenuMarkup,
  developerBox,
  developerMarkup,
  groupBusyBox,
  groupCooldownBox,
  groupDuplicateBox,
  menuCategoryBox,
  menuCategoryMarkup,
  premiumAccessBox,
  premiumAccessMarkup,
  publicErrorBox,
  publicPairingFailureBox,
  thanksBox,
  thanksMarkup,
  GROUP_PAIRING_COOLDOWN_MS,
  MAX_GROUP_PAIRING_FLOWS,
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
  verificationErrorBox,
  verificationFailureBox,
  verificationLoadingBox,
  verificationPermissionBox,
  verificationResultBox,
  verificationSuccessBox,
  verifiedMarkup,
  verifyBox,
  verifyMarkup,
  verifyRequiredBox
};
