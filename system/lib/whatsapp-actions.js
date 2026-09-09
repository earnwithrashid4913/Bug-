'use strict';

// ---------------------------------------------------------------------------
// Context-aware WhatsApp button layer.
//
// This module is the ONLY place WhatsApp command buttons are defined. Telegram
// has its own inline keyboards in system/lib/telegram-controller.js and the two
// never share markup.
//
// Invariants enforced here and covered by test/whatsapp-actions.test.js:
//
//   1. Never more than MAX_QUICK_BUTTONS (3) quick-reply buttons per message.
//      WhatsApp and WhatsApp Business both render the interactive-message
//      quick replies as a chip row; 3 is the count that renders reliably on
//      both clients, so richer navigation goes through the single_select list.
//   2. Every button id is a real command string the dispatcher in
//      system/handler.js understands, built with the LIVE runtime prefix
//      (!setprefix changes it), so buttons keep working after a prefix change
//      and after a reconnect.
//   3. A button either carries the full argument it needs or navigates the
//      menu. There are no decorative buttons that only echo a usage line.
//   4. Every id only contains characters WhatsApp accepts in a
//      nativeFlowMessage paramsJson payload (printable text, no control
//      characters) and stays inside the 200-character limit.
// ---------------------------------------------------------------------------

const { MAX_QUICK_BUTTONS } = require('./ui');
const { resolveCommand } = require('./menu');

const MENU_LABEL = '☷ Menu';
const BACK_LABEL = '⬅️ Back';

// A command id may never contain a control character or a line break: the id is
// serialized into paramsJson and echoed back verbatim by the client. The prefix
// and the command name are joined WITHOUT a separator so the dispatcher's
// commandFromText() parses the id exactly like a typed command.
function safeCommandId(prefix, name, arg = '') {
  const head = `${String(prefix || '')}${String(name || '')}`;
  const argument = String(arg ?? '').trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ');
  return `${head}${argument ? ` ${argument}` : ''}`.trim().slice(0, 200);
}

function commandId(prefix, name, arg = '') {
  return safeCommandId(prefix, name, arg);
}

// MAIN MENU entry. `categoryId` navigates straight to a category view.
function menuButton(prefix, categoryId = 'home') {
  return categoryId && categoryId !== 'home'
    ? { label: MENU_LABEL, id: commandId(prefix, 'menu', categoryId) }
    : { label: MENU_LABEL, id: commandId(prefix, 'menu', 'home') };
}

// BACK to the category this command belongs to.
function backButton(prefix, categoryId) {
  if (!categoryId) return undefined;
  return { label: BACK_LABEL, id: commandId(prefix, 'menu', categoryId) };
}

// on/off/status toggles. These already carry their full argument, so they are
// real actions rather than prompts.
function toggleButtons(prefix, name) {
  return [
    { label: '✅ ON', id: commandId(prefix, name, 'on') },
    { label: '❌ OFF', id: commandId(prefix, name, 'off') },
    { label: '📊 Status', id: commandId(prefix, name, 'status') }
  ];
}

// ---------------------------------------------------------------------------
// Per-command actions. `ctx` carries whatever the command just resolved
// ({ query }, { url }, { track }) so the action can re-run with real input.
// ---------------------------------------------------------------------------

const CONTEXT_ACTIONS = Object.freeze({
  // --- DOWNLOADER: the audio/video switch re-uses the resolved query/URL. ---
  play: (prefix, ctx) => [
    { label: '🎬 Video', id: commandId(prefix, 'video', ctx.query) },
    { label: '🎧 Spotify', id: commandId(prefix, 'spotify', ctx.query) }
  ],
  ytmp3: (prefix, ctx) => [
    { label: '🎬 Video', id: commandId(prefix, 'video', ctx.query) }
  ],
  video: (prefix, ctx) => [
    { label: '🎵 Audio', id: commandId(prefix, 'ytmp3', ctx.query) }
  ],
  media: (prefix, ctx) => [
    { label: '🎵 Audio', id: commandId(prefix, 'ytmp3', ctx.url) },
    { label: '🎬 Video', id: commandId(prefix, 'video', ctx.url) }
  ],
  spotify: (prefix, ctx) => [
    { label: '⬇️ Download', id: commandId(prefix, 'play', ctx.track) }
  ],

  // --- CONVERTER: sticker/image round trip needs a reply, so these navigate
  //     to the category instead of firing an argument-less command. ---
  sticker: () => [],
  toimg: () => [],

  // --- UPLOAD ---
  tourl: () => [],

  // --- AI ---
  ai: () => [],
  translate: () => [],

  // --- TOOLS ---
  calc: () => [],
  ss: () => [],
  short: () => [],
  jid: () => [],
  idch: () => [],

  // --- MEDIA ---
  getpp: () => [],
  vv: () => [],
  setpp: () => [],

  // --- GAMES: replay / sibling games. ---
  dice: (prefix) => [{ label: '🪙 Coin', id: commandId(prefix, 'coin') }],
  coin: (prefix) => [{ label: '⚀ Dice', id: commandId(prefix, 'dice') }],
  rps: (prefix) => [{ label: '⚀ Dice', id: commandId(prefix, 'dice') }],
  guess: (prefix) => [{ label: '▶️ Start', id: commandId(prefix, 'guess', 'start') }],

  // --- RPG / ECONOMY: all three are complete commands. ---
  balance: (prefix) => [
    { label: '🎁 Daily', id: commandId(prefix, 'daily') },
    { label: '🛠 Work', id: commandId(prefix, 'work') }
  ],
  daily: (prefix) => [
    { label: '💰 Balance', id: commandId(prefix, 'balance') },
    { label: '🛠 Work', id: commandId(prefix, 'work') }
  ],
  work: (prefix) => [
    { label: '💰 Balance', id: commandId(prefix, 'balance') },
    { label: '🎁 Daily', id: commandId(prefix, 'daily') }
  ],
  give: (prefix) => [{ label: '💰 Balance', id: commandId(prefix, 'balance') }],

  // --- OWNER / SUDO / PREMIUM ---
  mode: (prefix) => [
    { label: '🌍 Public', id: commandId(prefix, 'public') },
    { label: '👤 Self', id: commandId(prefix, 'self') }
  ],
  sudolist: (prefix) => [{ label: '🔐 Add Sudo', id: commandId(prefix, 'menu', 'sudo') }],
  premium: (prefix) => [{ label: '💎 Premium', id: commandId(prefix, 'menu', 'premium') }],
  sessions: (prefix) => [{ label: '📊 Status', id: commandId(prefix, 'status') }],
  stopsession: (prefix) => [{ label: '✈️ Telegram', id: commandId(prefix, 'pairing') }],
  pairing: () => [],
  status: (prefix) => [{ label: '🧩 Sessions', id: commandId(prefix, 'sessions') }],
  owner: (prefix) => [{ label: '✈️ Telegram', id: commandId(prefix, 'pairing') }],
  ping: () => [],
  request: () => []
});

/**
 * Builds the button row for a command result.
 *
 * Order: command-specific actions → ⬅️ Back (own category) → ☷ Menu.
 * The row is capped at MAX_QUICK_BUTTONS and duplicate ids are dropped, so a
 * category whose action already is the category view never shows it twice.
 *
 * Returns an empty array when the caller should not attach buttons at all.
 */
function contextButtons(prefix, commandName, ctx = {}) {
  const entry = resolveCommand(commandName);
  const categoryId = entry?.category;
  const actions = CONTEXT_ACTIONS[commandName]?.(prefix, ctx) || [];

  const buttons = [];
  const seen = new Set();
  for (const button of [...actions, backButton(prefix, categoryId), menuButton(prefix)]) {
    if (!button?.label || !button?.id || seen.has(button.id)) continue;
    seen.add(button.id);
    buttons.push(button);
  }
  return buttons.slice(0, MAX_QUICK_BUTTONS);
}

/**
 * Buttons for an on/off/status setting command. The current state is reflected
 * in the labels so the row doubles as a live status readout.
 */
function settingButtons(prefix, commandName, { enabled, showStatus = true } = {}) {
  const buttons = [];
  if (showStatus) {
    buttons.push(...toggleButtons(prefix, commandName));
  } else {
    buttons.push({ label: enabled ? '❌ Turn OFF' : '✅ Turn ON', id: commandId(prefix, commandName, enabled ? 'off' : 'on') });
    const back = backButton(prefix, resolveCommand(commandName)?.category);
    if (back) buttons.push(back);
    buttons.push(menuButton(prefix));
  }
  return buttons.slice(0, MAX_QUICK_BUTTONS);
}

module.exports = {
  BACK_LABEL,
  CONTEXT_ACTIONS,
  MAX_QUICK_BUTTONS,
  MENU_LABEL,
  backButton,
  commandId,
  contextButtons,
  menuButton,
  safeCommandId,
  settingButtons,
  toggleButtons
};
