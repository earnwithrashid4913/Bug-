'use strict';

const { BotTracker } = require('./lib/bot-tracker');
const recovery = require('./lib/message-recovery');
const sourceCommands = require('./lib/source-commands');
const { storedMedia } = require('./lib/stored-media');
const QRCode = require('qrcode');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { config, normalizePhoneNumber } = require('./config');
const { groupSettings } = require('./group-events');
const {
  getImageMessage,
  getQuotedMessage,
  getMessageContext,
  getStickerMessage,
  getTargetJid,
  normalizeJid,
  resolveJid
} = require('./lib/message');
const { askGroq, reserveAiRequest } = require('./lib/ai');
const { BotModeStore } = require('./lib/bot-mode');
const { PremiumStore } = require('./lib/premium');
const { requestRestart } = require('./lib/runtime');
const { RuntimeSettingsStore } = require('./lib/runtime-settings');
const { SudoStore } = require('./lib/sudo');
const { WarningStore } = require('./lib/warnings');
const { AutomationStore, DEFAULT_EMOJIS, handleAutoReact, handleAutowriteMessage, handleAutoStatus } = require('./lib/automation');
const { EconomyStore } = require('./lib/economy');
const { ChatStore } = require('./lib/chats');
const { MAX_STICKER_INPUT_BYTES, convertStickerToImage, createImageSticker, createVideoSticker, takeSticker, convertToVideo } = require('./lib/sticker');
const { sendButtons, sendList } = require('./lib/ui');
const { contextButtons, menuButton, settingButtons } = require('./lib/whatsapp-actions');
const { helpText: buildHelpText, categoriesWithCommands, getCategory, resolveCommand } = require('./lib/menu');
const {
  handleAnimeCommand,
  handleMangaCommand,
  handleCharacterCommand,
  handleProfileCommand,
  handleBadgesCommand,
  handleLeaderboardCommand,
  handleWaifuCommand,
  handleQuoteCommand,
} = require('./lib/anime-otaku');
const quizModule = require('./lib/quiz');
const {
  handleTiktokCommand,
  handleFacebookCommand,
  handleXdlCommand,
} = require('./lib/downloader-extended');
const {
  handleCoupleCommand,
  handleTruthCommand,
  handleDareCommand,
  handleFactCommand,
  handlePickupCommand,
  handleAnimevsCommand,
  handleShipCommand,
  handleMeteoCommand,
  handleLyricsCommand,
} = require('./lib/fun-commands');
const {
  requestCobalt,
  spotifySearch,
  translateText,
  textToSpeech,
  safeMath,
  screenshotUrl,
  shortenUrl,
  downloadRemoteFile,
  uploadToCatbox
} = require('./lib/net-tools');
const { isAuthorizedAdmin } = require('./security');

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

const premiumStore = new PremiumStore(config.premiumDbPath);
const modeStore = new BotModeStore(config.modeDbPath, config.publicMode ? 'public' : 'self');
const sudoStore = new SudoStore(config.sudoDbPath);
const warningStore = new WarningStore(config.warningDbPath);
const automationStore = new AutomationStore(config.automationDbPath);
const economyStore = new EconomyStore(config.economyDbPath);
const settingsStore = new RuntimeSettingsStore(config.settingsDbPath, { prefix: config.commandPrefix });
const botTracker = new BotTracker(settingsStore);
let trackerReady;
const chatStore = new ChatStore(config.chatsDbPath);
const reportCooldowns = new Map();
let publicMode = config.publicMode;
let commandPrefix = config.commandPrefix;

// Simple in-memory guess game state
const guessGames = new Map();
// Group timers for opentime/closetime commands
const groupTimers = new Map();

function parseDuration(text) {
  if (!text || text.toLowerCase() === 'cancel') return null;
  const regex = /(\d+)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)/gi;
  let totalMs = 0;
  let match;
  while ((match = regex.exec(text))) {
    const n = parseInt(match[1], 10);
    const u = match[2].toLowerCase();
    if (u.startsWith('h')) totalMs += n * 3600000;
    else if (u.startsWith('m')) totalMs += n * 60000;
    else if (u.startsWith('s')) totalMs += n * 1000;
  }
  return totalMs > 0 ? totalMs : null;
}

function formatDuration(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const parts = [];
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  if (s) parts.push(s + 's');
  return parts.join(' ') || ms + 'ms';
}

// Anti-delete message cache: chatId:messageId → { text, sender, timestamp }

// Anti-spam per-chat per-user timestamps
const spamTracker = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initializeMode(socket) {
  const mode = await modeStore.get();
  publicMode = mode === 'public';
  const savedPrefix = await settingsStore.get('prefix');
  // Runtime settings are data, not trusted code. Ignore malformed historical
  // values rather than making every command unavailable after an upgrade.
  if (typeof savedPrefix === 'string' && savedPrefix.length > 0 && savedPrefix.length <= 4 && !/\s/.test(savedPrefix)) {
    commandPrefix = savedPrefix;
  }
  if (socket) socket.public = publicMode;
  return mode;
}

function getCommandPrefix() {
  return commandPrefix;
}

function commandFromText(text) {
  const prefix = getCommandPrefix();
  if (!text.startsWith(prefix)) return undefined;
  const [name = '', ...args] = text.slice(prefix.length).trim().split(/\s+/);
  if (!name) return undefined;
  return { name: name.toLowerCase(), args, text: args.join(' ') };
}

// Hidden command: davidcaril.js — accessible ONLY via !h / !H / !hidden / !HIDDEN
// Not exposed in the normal menu. Separate handler.
const HIDDEN_TRIGGERS = new Set(['h', 'hidden']);
function isHiddenCommand(commandName) {
  return HIDDEN_TRIGGERS.has(commandName.toLowerCase());
}

async function handleHiddenCommand(socket, context) {
  const p = getCommandPrefix();
  const text = [
    '╔══════════════════╗',
    '  🌟 *[ ANIME CORE ]*',
    '╠══════════════════╣',
    '',
    '  ⚡ *ANIME MD* — WhatsApp Bot',
    '  🎌 Powered by F!xa Dev',
    '',
    '  🤖 *AI Features:*',
    '  • Groq AI Chat',
    '  • Multi-language support',
    '',
    '  👥 *Group Tools:*',
    '  • Full admin suite',
    '  • Anti-spam / Anti-link',
    '  • Welcome & Goodbye',
    '',
    '  🎮 *Fun & Games:*',
    '  • Quiz system',
    '  • RPG Economy',
    '  • Anime database',
    '',
    '  🛡 *Security:*',
    '  • Protected identity',
    '  • Sudo system',
    '  • Premium access',
    '',
    `  📖 Type *${p}menu* for all commands`,
    '',
    '╚══════════════════╝',
    `> *[ ANIME CORE ]* · ${config.ownerName}`
  ].join('\n');

  await sendButtons(socket, context.chatId, {
    text,
    footer: `${config.botName} · ${config.ownerName}`,
    buttons: [{ label: '📖 MENU', id: `${p}menu home` }],
    fallbackText: text,
    quoted: context.raw
  });
}

function ownerJids(socket) {
  const connectedAccount = normalizeJid(socket, socket.user?.id);
  return new Set(connectedAccount ? [connectedAccount] : []);
}

function isOwner(socket, sender) {
  return ownerJids(socket).has(normalizeJid(socket, sender))
    || isAuthorizedAdmin(socket, sender);
}

function senderNumber(context) {
  return (context.sender || '').split('@')[0];
}

async function isSudo(socket, context) {
  return await sudoStore.has(senderNumber(context)) || isOwner(socket, context.sender);
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(new Date(timestamp));
}

async function downloadMediaBuffer(mediaMessage, mediaType) {
  const stream = await downloadContentFromMessage(mediaMessage, mediaType);
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_STICKER_INPUT_BYTES) {
      throw new Error('Image is too large for sticker conversion. Maximum size is 12 MB.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
}

function helpText(prefix) {
  return buildHelpText(prefix || getCommandPrefix());
}

// Every command reply goes through here: WhatsApp-bold text, the shared
// footer, and the context buttons for the command that produced it. The id of
// each button is built with the live prefix, so buttons survive !setprefix.
async function sendResult(socket, context, { text, command, ctx, buttons, quoted }) {
  const prefix = getCommandPrefix();
  // An interactive message with zero buttons renders as an empty chip row, so a
  // reply that has no command of its own (a permission refusal, for example)
  // always keeps a way back to the menu.
  const resolved = buttons
    || (command ? contextButtons(prefix, command, ctx || {}) : [menuButton(prefix)]);
  await sendButtons(socket, context.chatId, {
    text,
    footer: `${config.botName} • ${sourceCommands.FOOTER}`,
    buttons: resolved,
    fallbackText: text,
    quoted: quoted === undefined ? context.raw : quoted
  });
}

// One-line command tutorial. Kept deliberately short: the full manual lives in
// the menu, not after every command.
function usageLine(name, usage, example) {
  const prefix = getCommandPrefix();
  return [
    '*USAGE*',
    `${prefix}${name}${usage ? ` ${usage}` : ''}`,
    ...(example ? [`*Example:* ${prefix}${example}`] : [])
  ].join('\n');
}

async function sendOwnerCard(socket, chatId, quoted) {
  const text = [
    '👑 *OWNER DETAILS*',
    '',
    '*Global Owner*',
    `➜ ${config.ownerName}`,
    '',
    '*Developer*',
    `➜ ${config.developerName}`,
    '',
    '*Contact*',
    `➜ ${config.whatsappChannel}`
  ].join('\n');
  await sendButtons(socket, chatId, {
    text,
    footer: `${config.botName} • ${config.ownerName}`,
    buttons: contextButtons(getCommandPrefix(), 'owner'),
    fallbackText: text,
    quoted
  });
}

async function getGroupInfo(socket, context) {
  if (!context.isGroup) return { participants: [], isAdmin: false };
  const metadata = await socket.groupMetadata(context.chatId);
  const participants = metadata.participants || [];
  const sender = normalizeJid(socket, context.sender);
  let participant = participants.find((entry) => normalizeJid(socket, entry.id) === sender);
  if (!participant && sender && !sender.endsWith('@lid')) {
    for (const entry of participants) {
      if ((await resolveJid(socket, entry.id)) === sender) {
        participant = entry;
        break;
      }
    }
  }
  const botJid = normalizeJid(socket, socket.user?.id);
  let botParticipant = participants.find((entry) => [entry.id, entry.lid, entry.jid].some(id => id && normalizeJid(socket, id) === botJid));
  if (!botParticipant) {
    for (const entry of participants) {
      if ((await resolveJid(socket, entry.id)) === botJid) { botParticipant = entry; break; }
    }
  }
  return {
    participants,
    isAdmin: Boolean(participant?.admin),
    isBotAdmin: Boolean(botParticipant?.admin)
  };
}

async function requireOwner(socket, context) {
  if (isOwner(socket, context.sender)) return true;
  await sendResult(socket, context, { text: '👑 *OWNER ONLY*\nOnly the bot owner can use this command.' });
  return false;
}

async function requireSudoOrOwner(socket, context) {
  if (isOwner(socket, context.sender) || await sudoStore.has(senderNumber(context))) return true;
  await sendResult(socket, context, { text: '🔐 *ACCESS DENIED*\nThis command requires owner or sudo access.' });
  return false;
}

async function requireGroupAdmin(socket, context) {
  if (!context.isGroup) {
    await socket.sendMessage(context.chatId, { text: 'This command can only be used in a group.' }, { quoted: context.raw });
    return undefined;
  }
  const info = await getGroupInfo(socket, context);
  if (isOwner(socket, context.sender) || info.isAdmin) return info;
  await socket.sendMessage(context.chatId, { text: 'Only a group admin or the bot owner can use this command.' }, { quoted: context.raw });
  return undefined;
}

async function requireBotAdmin(socket, context, group) {
  if (group?.isBotAdmin) return true;
  await socket.sendMessage(context.chatId, { text: 'The bot must be a group admin to use this command.' }, { quoted: context.raw });
  return false;
}

// ---------------------------------------------------------------------------
// Existing handler functions
// ---------------------------------------------------------------------------

async function handleReport(socket, context, message) {
  const now = Date.now();
  const previous = reportCooldowns.get(context.sender) || 0;
  if (now - previous < 60_000) {
    await socket.sendMessage(context.chatId, { text: 'Please wait one minute before sending another request.' }, { quoted: context.raw });
    return;
  }
  if (!message || message.length > 1_500) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}request <message up to 1500 characters>` }, { quoted: context.raw });
    return;
  }
  reportCooldowns.set(context.sender, now);
  setTimeout(() => {
    if (reportCooldowns.get(context.sender) === now) reportCooldowns.delete(context.sender);
  }, 60_000).unref();

  const num = senderNumber(context);
  const ownerMessage = [
    `*${config.botName} request*`,
    `From: @${num}`,
    `Message: ${message}`
  ].join('\n');

  const owner = normalizeJid(socket, socket.user?.id);
  if (!owner) throw new Error('The WhatsApp owner account is not connected yet.');
  await socket.sendMessage(owner, { text: ownerMessage, mentions: context.sender ? [context.sender] : [] });
  await sendResult(socket, context, { text: '*REQUEST SENT* ✅\nThe owner has been notified.', command: 'request' });
}

async function handleGreetingSettings(socket, context, command) {
  const settings = await groupSettings.get(context.chatId);
  const action = command.args[0]?.toLowerCase();
  const updates = {};
  if (command.name === 'greet') {
    if (['welcome', 'both'].includes(action)) updates.welcomeEnabled = !settings.welcomeEnabled;
    if (['goodbye', 'both'].includes(action)) updates.goodbyeEnabled = !settings.goodbyeEnabled;
    if (action && !['welcome', 'goodbye', 'both', 'status'].includes(action)) {
      await sendResult(socket, context, { text: 'Usage: greet <welcome|goodbye|both>', command: 'greet' }); return;
    }
  } else {
    const key = command.name === 'goodbye' ? 'goodbyeEnabled' : 'welcomeEnabled';
    if (!action) updates[key] = !settings[key];
    else if (['on', 'off'].includes(action)) updates[key] = action === 'on';
    else if (action !== 'status') { await sendResult(socket, context, { text: 'Usage: welcome/goodbye <on|off|status>', command: command.name }); return; }
  }
  const next = Object.keys(updates).length ? await groupSettings.update(context.chatId, updates) : settings;
  await sendResult(socket, context, { text: `GREETING SETTINGS\nWelcome: ${next.welcomeEnabled ? 'ON ✅' : 'OFF ❌'}\nGoodbye: ${next.goodbyeEnabled ? 'ON ✅' : 'OFF ❌'}\nUsage: greet both`, command: command.name, buttons: [ { label: 'Welcome', id: `${getCommandPrefix()}welcome status` }, { label: 'Goodbye', id: `${getCommandPrefix()}goodbye status` } ] });
}

async function handleGroupManagement(socket, context, command, group) {
  if (command.name === 'group') {
    const p = getCommandPrefix();
    const text = [
      '👥 *GROUP MANAGEMENT*',
      '',
      `${p}gname <name>`,
      `${p}gdesc <description>`,
      `${p}add <number>`,
      `${p}kick / promote / demote @user`,
      `${p}lock / ${p}unlock`,
      `${p}grouplink`
    ].join('\n');
    await sendResult(socket, context, {
      text,
      command: 'group',
      buttons: [
        { label: '🔗 Group Link', id: `${p}grouplink` },
        { label: '🛡 Security', id: `${p}menu anti` },
        { label: '⬅️ Back', id: `${p}menu group` }
      ]
    });
    return;
  }

  if (!(await requireBotAdmin(socket, context, group))) return;

  const target = getTargetJid(context.raw);
  try {
    switch (command.name) {
      case 'gname': {
        const subject = command.text.trim();
        if (!subject || subject.length > 100) throw new Error('Provide a group name between 1 and 100 characters.');
        await socket.groupUpdateSubject(context.chatId, subject);
        break;
      }
      case 'gdesc': {
        const description = command.text.trim();
        if (!description || description.length > 512) throw new Error('Provide a description between 1 and 512 characters.');
        await socket.groupUpdateDescription(context.chatId, description);
        break;
      }
      case 'add': {
        const number = normalizePhoneNumber(command.args[0], 'Group participant number');
        await socket.groupParticipantsUpdate(context.chatId, [`${number}@s.whatsapp.net`], 'add');
        break;
      }
      case 'kick':
      case 'promote':
      case 'demote': {
        if (!target) throw new Error(`Mention a user or reply to a message to use ${getCommandPrefix()}${command.name}.`);
        const action = command.name === 'kick' ? 'remove' : command.name;
        await socket.groupParticipantsUpdate(context.chatId, [target], action);
        break;
      }
      case 'lock':
        await socket.groupSettingUpdate(context.chatId, 'announcement');
        break;
      case 'unlock':
        await socket.groupSettingUpdate(context.chatId, 'not_announcement');
        break;
      case 'linkgc':
      case 'grouplink': {
        const code = await socket.groupInviteCode(context.chatId);
        if (!code) throw new Error('Unable to retrieve this group invite code.');
        await sendResult(socket, context, {
          text: `*GROUP INVITE LINK* 🔗\n\nhttps://chat.whatsapp.com/${code}`,
          command: 'grouplink'
        });
        return;
      }
      default:
        return;
    }
    await sendResult(socket, context, {
      text: `*GROUP ACTION DONE* ✅\n➜ ${command.name}`,
      command: command.name
    });
  } catch (error) {
    await sendResult(socket, context, {
      text: `*GROUP ACTION FAILED* ❌\n${error.message}`,
      command: command.name
    });
  }
}

async function handleAiCommand(socket, context, command) {
  const prompt = command.text.trim();
  if (!prompt) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}ai <question>` }, { quoted: context.raw });
    return;
  }
  try {
    reserveAiRequest(context.sender);
    const answer = await askGroq({ apiKey: config.groqApiKey, model: config.groqModel, prompt, botName: config.botName, persona: ['loveai', 'love', 'dark'].includes(command.name) ? 'love' : ['ia', 'groq'].includes(command.name) ? 'free' : 'standard' });
    await sendResult(socket, context, { text: `🤖 *${config.botName}*\n\n${answer}`, command: 'ai' });
  } catch (error) {
    console.error('[ai] Request failed:', error);
    await sendResult(socket, context, { text: `*AI UNAVAILABLE* ❌\n${error.message}`, command: 'ai' });
  }
}

async function handleGetProfilePhoto(socket, context, command) {
  let target = getTargetJid(context.raw) || (context.isGroup ? context.chatId : context.sender);
  if (command.args[0] && !getTargetJid(context.raw)) {
    // A malformed number is user input, not a programming error: it must reach
    // the user as a message instead of rejecting the whole handler (which used
    // to leave the command silently unanswered).
    let number;
    try {
      number = normalizePhoneNumber(command.args[0], 'Profile picture number');
    } catch (error) {
      await sendResult(socket, context, { text: `*INVALID NUMBER* ❌\n${error.message}`, command: 'getpp' });
      return;
    }
    target = `${number}@s.whatsapp.net`;
  }
  try {
    const profilePictureUrl = await socket.profilePictureUrl(target, 'image');
    if (!profilePictureUrl) throw new Error('No profile picture is available.');
    await socket.sendMessage(context.chatId, {
      image: { url: profilePictureUrl },
      caption: '*PROFILE PICTURE* 🖼'
    }, { quoted: context.raw });
    await sendResult(socket, context, {
      text: `*PROFILE PICTURE* 🖼\n➜ ${target.split('@')[0]}`,
      command: 'getpp'
    });
  } catch (error) {
    await sendResult(socket, context, { text: `*NO PROFILE PICTURE* ❌\n${error.message}`, command: 'getpp' });
  }
}

async function handleSetBotProfilePhoto(socket, context) {
  if (!(await requireOwner(socket, context))) return;
  const imageMessage = getImageMessage(context.raw);
  if (!imageMessage) {
    await sendResult(socket, context, {
      text: `*REPLY TO AN IMAGE* 🖼\nThen send ${getCommandPrefix()}setpp.`,
      command: 'setpp'
    });
    return;
  }
  try {
    const imageBuffer = await downloadMediaBuffer(imageMessage, 'image');
    if (context.isGroup) {
      const group = await getGroupInfo(socket, context);
      if (!(await requireBotAdmin(socket, context, group))) return;
    }
    await socket.updateProfilePicture(context.isGroup ? context.chatId : socket.user.id, imageBuffer);
    await sendResult(socket, context, { text: '*PROFILE PICTURE UPDATED* ✅', command: 'setpp' });
  } catch (error) {
    console.error('[setpp] Profile picture update failed:', error);
    await sendResult(socket, context, { text: `*UPDATE FAILED* ❌\n${error.message}`, command: 'setpp' });
  }
}

// ---------------------------------------------------------------------------
// NEW HANDLER FUNCTIONS
// ---------------------------------------------------------------------------

// --- MENU ---

async function handleMenuCommand(socket, context, command) {
  const botName = await settingsStore.get('bot_name') || config.botName;
  const p = getCommandPrefix();
  const categoryId = command.args[0]?.toLowerCase();

  if (!categoryId || categoryId === 'home') {
    const categories = categoriesWithCommands();
    try {
      await sendList(socket, context.chatId, {
        text: `*${botName}*\n\nChoose a category:`,
        footer: `Developer: ${config.developerName}`,
        title: 'Browse Categories',
        sections: [{
          title: 'Categories',
          rows: categories.map((cat) => ({
            header: cat.icon,
            title: cat.label,
            description: `${cat.commands.length} commands`,
            id: `${p}menu ${cat.id}`
          }))
        }],
        actions: [
          { label: '📊 Status', id: `${p}status` },
          { label: '👑 Owner', id: `${p}owner` }
        ],
        fallbackText: [
          '*ANIME MD*',
          `Name: ${botName}`,
          '',
          '*Categories:*',
          ...categories.map((cat, i) => `${i + 1}. ${cat.icon} ${cat.label}  → ${p}menu ${cat.id}`),
          '',
          `Reply with the number to open a category.`,
          '',
          `Developer: ${config.developerName}`
        ].join('\n'),
        quoted: context.raw
      });
    } catch (error) {
      await socket.sendMessage(context.chatId, { text: helpText(p) }, { quoted: context.raw });
    }
    return;
  }

  // Category view: interactive list where every row runs a real command.
  const category = getCategory(categoryId);
  if (!category) {
    await socket.sendMessage(context.chatId, { text: `Unknown category. Type ${p}menu to see all categories.` }, { quoted: context.raw });
    return;
  }

  // One shared rendering includes every execute alias in both interactive
  // bodies and the plain-text fallback; list rows keep canonical actions.
  const text = buildHelpText(p, category.id);

  try {
    await sendList(socket, context.chatId, {
      text,
      footer: `Developer: ${config.developerName}`,
      title: category.label,
      sections: [{
        title: category.label,
        rows: category.commands.map((cmd) => ({
          header: category.icon,
          title: `${p}${cmd.name}`,
          description: cmd.description,
          id: `${p}${cmd.name}`
        }))
      }],
      actions: [
        { label: '☰ All Categories', id: `${p}menu` },
        { label: '🏠 Main Menu', id: `${p}menu home` }
      ],
      fallbackText: text,
      quoted: context.raw
    });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
  }
}

// --- DOWNLOADER ---

async function handleSpotifyCommand(socket, context, command) {
  if (!command.text) {
    await sendResult(socket, context, { text: usageLine('spotify', '<song name>', 'spotify Faded'), command: 'spotify' });
    return;
  }
  await socket.sendMessage(context.chatId, { text: '⏳ *Searching Spotify…*' }, { quoted: context.raw });
  try {
    const results = await spotifySearch(command.text, 5);
    if (!results.length) throw new Error('No results found.');

    const lines = results.map((track, i) => {
      const duration = track.duration ? `${Math.floor(track.duration / 60_000)}:${String(Math.floor((track.duration % 60_000) / 1000)).padStart(2, '0')}` : '';
      return `${i + 1}. *${track.title}*\n➜ ${track.artist}${duration ? ` · ${duration}` : ''}\n${track.url}`;
    });

    await sendResult(socket, context, {
      text: `*SPOTIFY RESULTS* 🎧\n*Query:* ${command.text}\n\n${lines.join('\n\n')}`,
      command: 'spotify',
      // The Download button re-runs the downloader with the top track name.
      ctx: { track: `${results[0].title} ${results[0].artist || ''}`.trim() }
    });
  } catch (error) {
    console.error('[spotify] Search failed:', error);
    await sendResult(socket, context, {
      text: `*SPOTIFY FAILED* ❌\n${error.message}`,
      command: 'spotify',
      ctx: { track: command.text }
    });
  }
}

async function handleMediaCommand(socket, context, command) {
  if (!command.text) {
    await sendResult(socket, context, { text: usageLine('media', '<url>', 'media https://vm.tiktok.com/…'), command: 'media' });
    return;
  }
  await socket.sendMessage(context.chatId, { text: '⏳ *Downloading…*' }, { quoted: context.raw });
  const url = command.text.trim();
  try {
    const result = await requestCobalt(config.cobaltApiUrl, url);
    if (!result?.url) throw new Error('The download service returned no file for that link.');
    const { buffer, type } = await downloadRemoteFile(result.url);
    const isVideo = type.includes('video');
    const isAudio = type.includes('audio');
    const isImage = type.includes('image');
    const format = (type.split(';')[0] || 'file').trim();
    const size = `${(buffer.length / 1024).toFixed(1)} KB`;
    const caption = '*DOWNLOAD COMPLETE* ✅';
    const details = `${caption}\n\n*Size:* ${size}\n*Format:* ${format}`;

    if (isImage) {
      await socket.sendMessage(context.chatId, { image: buffer, caption }, { quoted: context.raw });
    } else if (isVideo) {
      await socket.sendMessage(context.chatId, { video: buffer, mimetype: type, caption }, { quoted: context.raw });
    } else if (isAudio) {
      await socket.sendMessage(context.chatId, { audio: buffer, mimetype: type, ptt: false }, { quoted: context.raw });
    } else {
      await socket.sendMessage(context.chatId, { document: buffer, mimetype: type, caption, fileName: result.filename || 'download.bin' }, { quoted: context.raw });
    }
    await sendResult(socket, context, { text: details, command: 'media', ctx: { url } });
  } catch (error) {
    console.error('[media] Download failed:', error);
    await sendResult(socket, context, {
      text: `*DOWNLOAD FAILED* ❌\n${error.message}`,
      command: 'media',
      ctx: { url }
    });
  }
}

// --- STICKER (VV) ---

async function handleVVCommand(socket, context) {
  await recovery.revealViewOnce(socket, context, downloadMediaBuffer);
}

// --- CONVERTER ---

async function handleTTSCommand(socket, context, command) {
  if (!command.text) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}tts <text>` }, { quoted: context.raw });
    return;
  }
  try {
    const { buffer, mimetype } = await textToSpeech(command.text);
    if (!buffer?.length) throw new Error('The speech service returned no audio.');
    await socket.sendMessage(context.chatId, { audio: buffer, mimetype, ptt: false }, { quoted: context.raw });
    await sendResult(socket, context, { text: `*SPEECH READY* 🔊\n*Format:* ${(mimetype || 'audio').split(';')[0]}`, command: 'tts' });
  } catch (error) {
    await sendResult(socket, context, { text: `*TTS FAILED* ❌\n${error.message}`, command: 'tts' });
  }
}

async function handleQRCommand(socket, context, command) {
  if (!command.text) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}qr <text or URL>` }, { quoted: context.raw });
    return;
  }
  try {
    const buffer = await QRCode.toBuffer(command.text, { type: 'png', margin: 2, width: 512 });
    await socket.sendMessage(context.chatId, { image: buffer, caption: '*QR CODE READY* ✅' }, { quoted: context.raw });
    await sendResult(socket, context, { text: '*QR CODE READY* ✅', command: 'qr' });
  } catch (error) {
    await sendResult(socket, context, { text: `*QR FAILED* ❌\n${error.message}`, command: 'qr' });
  }
}

// --- UPLOAD ---

async function handleTourlCommand(socket, context) {
  const media = getImageMessage(context.raw) || getStickerMessage(context.raw);
  if (!media) {
    const quoted = getQuotedMessage(context.raw);
    const docOrVideo = context.raw?.message?.documentMessage || context.raw?.message?.videoMessage || context.raw?.message?.audioMessage || quoted.documentMessage || quoted.videoMessage || quoted.audioMessage;
    if (!docOrVideo) {
      await sendResult(socket, context, {
        text: `*REPLY TO MEDIA* 📤\nImage, video, sticker or document,\nthen send ${getCommandPrefix()}tourl.`,
        command: 'tourl'
      });
      return;
    }
    try {
      const type = docOrVideo.mimetype?.includes('audio') ? 'audio' : docOrVideo.mimetype?.includes('video') ? 'video' : docOrVideo.mimetype?.includes('image') ? 'image' : 'document';
      const buffer = await downloadMediaBuffer(docOrVideo, type);
      const ext = docOrVideo.mimetype?.split('/')[1] || 'bin';
      const url = await uploadToCatbox(config.uploadApiUrl, buffer, { filename: `upload.${ext}`, mimetype: docOrVideo.mimetype });
      await sendResult(socket, context, {
        text: `*UPLOAD COMPLETE* ✅\n\n*URL:* ${url}\n*Size:* ${(buffer.length / 1024).toFixed(1)} KB`,
        command: 'tourl'
      });
    } catch (error) {
      await sendResult(socket, context, { text: `*UPLOAD FAILED* ❌\n${error.message}`, command: 'tourl' });
    }
    return;
  }

  try {
    const mediaType = media.mimetype?.includes('video') ? 'video' : media.mimetype?.includes('image') ? 'image' : 'sticker';
    const buffer = await downloadMediaBuffer(media, mediaType);
    const ext = media.mimetype?.split('/')[1] || 'jpg';
    const url = await uploadToCatbox(config.uploadApiUrl, buffer, { filename: `upload.${ext}`, mimetype: media.mimetype });
    await sendResult(socket, context, {
      text: `*UPLOAD COMPLETE* ✅\n\n*URL:* ${url}\n*Size:* ${(buffer.length / 1024).toFixed(1)} KB`,
      command: 'tourl'
    });
  } catch (error) {
    await sendResult(socket, context, { text: `*UPLOAD FAILED* ❌\n${error.message}`, command: 'tourl' });
  }
}

// --- TOOLS ---

async function handleCalcCommand(socket, context, command) {
  if (!command.text) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}calc <expression>` }, { quoted: context.raw });
    return;
  }
  try {
    const result = safeMath(command.text);
    await sendResult(socket, context, {
      text: `*CALCULATOR* 🧮\n\n${command.text} = *${result}*`,
      command: 'calc'
    });
  } catch (error) {
    await sendResult(socket, context, { text: `*CALCULATION ERROR* ❌\n${error.message}`, command: 'calc' });
  }
}

async function handleSSCommand(socket, context, command) {
  if (!command.text) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}ss <URL>` }, { quoted: context.raw });
    return;
  }
  let url = command.text.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  await socket.sendMessage(context.chatId, { text: 'Capturing screenshot…' }, { quoted: context.raw });
  try {
    const { buffer, mimetype } = await screenshotUrl(url);
    if (!buffer?.length) throw new Error('The screenshot service returned no image.');
    await socket.sendMessage(context.chatId, { image: buffer, mimetype, caption: '*SCREENSHOT* 📸' }, { quoted: context.raw });
    await sendResult(socket, context, { text: `*SCREENSHOT READY* 📸\n➜ ${url}`, command: 'ss' });
  } catch (error) {
    await sendResult(socket, context, { text: `*SCREENSHOT FAILED* ❌\n${error.message}`, command: 'ss' });
  }
}

async function handleShortCommand(socket, context, command) {
  if (!command.text) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}short <URL>` }, { quoted: context.raw });
    return;
  }
  try {
    const short = await shortenUrl(command.text);
    await sendResult(socket, context, { text: `*SHORTENED URL* ✂️\n\n➜ ${short}`, command: 'short' });
  } catch (error) {
    await sendResult(socket, context, { text: `*SHORTENING FAILED* ❌\n${error.message}`, command: 'short' });
  }
}

// --- AI / TRANSLATE ---

async function handleTranslateCommand(socket, context, command) {
  if (!command.text) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}translate [target-lang] <text>\nExample: ${getCommandPrefix()}translate fr hello` }, { quoted: context.raw });
    return;
  }
  try {
    const parts = command.text.split(/\s+/);
    let target = 'en';
    let text = command.text;
    if (parts.length > 1 && parts[0].length <= 5 && /^[a-z]{2,5}$/i.test(parts[0])) {
      target = parts[0].toLowerCase();
      text = parts.slice(1).join(' ');
    }
    if (!text) {
      await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}translate [target-lang] <text>` }, { quoted: context.raw });
      return;
    }
    const { translated, source } = await translateText(text, target);
    await sendResult(socket, context, {
      text: `*TRANSLATION* 🌐 (${source} → ${target})\n\n${translated}`,
      command: 'translate'
    });
  } catch (error) {
    await sendResult(socket, context, { text: `*TRANSLATION FAILED* ❌\n${error.message}`, command: 'translate' });
  }
}

// --- ANTI / GROUP SECURITY ---

async function handleAntiToggleCommand(socket, context, command) {
  const settingsMap = {
    antilink: 'antilink',
    antispam: 'antispam',
    antimention: 'antimention',
    antitag: 'antitag',
    antidelete: 'antidelete'
  };
  const settingKey = settingsMap[command.name];
  if (!settingKey) return;

  const current = await groupSettings.get(context.chatId);
  const inputAction = command.args[0]?.toLowerCase();
  const action = (inputAction === 'enable' ? 'on' : inputAction === 'disable' ? 'off' : inputAction) || (['antilink', 'antispam', 'antitag'].includes(command.name) ? (current[settingKey] ? 'off' : 'on') : 'status');
  const labels = {
    antilink: 'Link protection',
    antispam: 'Spam protection',
    antimention: 'Mention protection',
    antitag: 'Tag protection',
    antidelete: 'Anti-delete'
  };
  const label = labels[settingKey] || settingKey;

  if (!['on', 'off', 'status'].includes(action)) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}${command.name} <on|off|status>` }, { quoted: context.raw });
    return;
  }

  if (action === 'status') {
    const settings = await groupSettings.get(context.chatId);
    await sendResult(socket, context, {
      text: `${label}: *${settings[settingKey] ? 'ON ✅' : 'OFF ❌'}*`,
      command: command.name,
      buttons: settingButtons(getCommandPrefix(), command.name, { showStatus: true })
    });
    return;
  }

  const settings = await groupSettings.update(context.chatId, { [settingKey]: action === 'on' });
  await sendResult(socket, context, {
    text: `${label}: *${settings[settingKey] ? 'ON ✅' : 'OFF ❌'}*`,
    command: command.name,
    buttons: settingButtons(getCommandPrefix(), command.name, { enabled: settings[settingKey], showStatus: false })
  });
}

async function handleWarnCommand(socket, context, command, group) {
  const target = getTargetJid(context.raw);
  if (!target) {
    await sendResult(socket, context, {
      text: `*MENTION OR REPLY TO A USER* 👤\nThen send ${getCommandPrefix()}warn <reason>.`,
      command: 'warn'
    });
    return;
  }
  const reason = command.text || 'rule violation';
  const record = await warningStore.add(context.chatId, target, reason);
  const num = target.split('@')[0];

  if (record.count >= 3) {
    try {
      await socket.groupParticipantsUpdate(context.chatId, [target], 'remove');
      await socket.sendMessage(context.chatId, { text: `@${num} was removed for reaching ${record.count} warnings.\nLast reason: ${reason}` }, { quoted: context.raw, mentions: [target] });
      await warningStore.remove(context.chatId, target);
    } catch (error) {
      await socket.sendMessage(context.chatId, { text: `@${num} has ${record.count} warnings but could not be removed: ${error.message}` }, { quoted: context.raw, mentions: [target] });
    }
  } else {
    await socket.sendMessage(context.chatId, { text: `@${num} warned (${record.count}/3).\nReason: ${reason}` }, { quoted: context.raw, mentions: [target] });
  }
}

async function handleUnwarnCommand(socket, context, command) {
  const target = getTargetJid(context.raw);
  if (!target) {
    await sendResult(socket, context, {
      text: `*MENTION OR REPLY TO A USER* 👤\nThen send ${getCommandPrefix()}unwarn.`,
      command: 'unwarn'
    });
    return;
  }
  await warningStore.remove(context.chatId, target);
  const num = target.split('@')[0];
  await socket.sendMessage(context.chatId, { text: `Warnings cleared for @${num}.` }, { quoted: context.raw, mentions: [target] });
}

async function handleWarnsCommand(socket, context, command) {
  if (!context.isGroup) { await sendResult(socket, context, { text: 'This command is only available in groups.', command: 'warns' }); return; }
  if (!(await requireGroupAdmin(socket, context))) return;
  const target = getTargetJid(context.raw);
  if (command.args[0]?.toLowerCase() === 'reset') {
    if (!(await requireGroupAdmin(socket, context))) return;
    if (target) await warningStore.remove(context.chatId, target);
    else for (const record of await warningStore.list(context.chatId)) await warningStore.remove(context.chatId, record.userJid);
    await sendResult(socket, context, { text: 'Warnings reset in this group.', command: 'warns' }); return;
  }
  if (target) {
    const data = await warningStore.read();
    const record = data.groups?.[warningStore.key(context.chatId, target)];
    const history = record?.history || [];
    await socket.sendMessage(context.chatId, { text: `Warnings for @${target.split('@')[0]}\nAnti-Link: ${history.filter(w => w.reason === 'antilink').length}/3\nAnti-Spam: ${history.filter(w => w.reason === 'antispam').length}/3\nTotal: ${record?.count || 0}`, mentions: [target] }, { quoted: context.raw });
    return;
  }
  const records = await warningStore.list(context.chatId);
  await sendResult(socket, context, { text: `GROUP WARNINGS\n${records.length ? records.map(r => `${r.userJid}: ${r.count}`).join('\n') : 'No active warnings.'}\nUsage: warnings @user | warnings reset [@user]`, command: 'warns' });
}

async function applyGroupProtections(socket, context) {
  const settings = await groupSettings.get(context.chatId);
  if (!['antilink', 'antispam', 'antimention', 'antitag'].some(key => settings[key])) return;
  if (isOwner(socket, context.sender)) return;
  const group = await getGroupInfo(socket, context);
  if (group.isAdmin || !group.isBotAdmin) return;
  const body = context.text || '';
  const { getContextInfo } = require('./lib/message');
  const mentions = getContextInfo(context.raw.message)?.mentionedJid || [];
  const violations = [];
  if (settings.antilink && /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\/[^\s]*)/i.test(body)) violations.push('antilink');
  if (settings.antispam) {
    const key = `${socket.user?.id}:${context.chatId}:${context.sender}`;
    const now = Date.now();
    for (const [id, times] of spamTracker) if (now - times.at(-1) > 5000) spamTracker.delete(id);
    const times = (spamTracker.get(key) || []).filter(time => now - time < 5000);
    times.push(now); spamTracker.set(key, times.slice(-6));
    if (times.length > 5) violations.push('antispam');
  }
  if (settings.antimention && (mentions.length >= 3 || /@everyone|@all/.test(body))) violations.push('antimention');
  if (settings.antitag && mentions.length >= 5) violations.push('antitag');
  if (!violations.length) return;
  await socket.sendMessage(context.chatId, { delete: context.raw.key });
  let remove = false;
  for (const type of violations) {
    let count = 0;
    if (['antilink', 'antispam'].includes(type)) {
      const record = await warningStore.add(context.chatId, context.sender, type);
      count = record.history.filter(w => w.reason === type).length;
      if (count >= 3) remove = true;
    }
    await socket.sendMessage(context.chatId, { text: `@${context.sender.split('@')[0]} — ${type} violation${count ? ` (${count}/3)` : ''}`, mentions: [context.sender] });
  }
  if (remove) await socket.groupParticipantsUpdate(context.chatId, [context.sender], 'remove');
}

// --- AUTOMATION ---

async function handleAutomationToggle(socket, context, command, group) {
  const canonical = resolveCommand(command.name)?.name || command.name;
  const key = canonical === 'autoreact' ? 'autoreact' : canonical === 'autowrite' ? 'autowrite' : 'autostatus';
  let action = command.args[0]?.toLowerCase() || 'status';
  if (key === 'autostatus') {
    if (!(await requireOwner(socket, context))) return;
    const data = await automationStore.read();
    const current = data.global || {};
    if (action === 'status') {
      await sendResult(socket, context, { text: `AutoStatus Settings\nView: ${current.autostatus ? 'ON' : 'OFF'}\nReact: ${current.statusReact ? 'ON' : 'OFF'}\nEmoji: ${current.statusEmoji || '❤️'}`, command: key });
      return;
    }
    let field = 'autostatus';
    let sub = action;
    if (action === 'view' || action === 'react') {
      field = action === 'view' ? 'autostatus' : 'statusReact';
      sub = command.args[1]?.toLowerCase();
    }
    if (action === 'react' && sub === 'emoji' && command.args[2]) {
      await automationStore.update(data => { data.global = { ...data.global, statusEmoji: command.args[2] }; });
    } else if (['on', 'off'].includes(sub)) await automationStore.setGlobal(field, sub === 'on');
    else { await sendResult(socket, context, { text: 'Usage: autostatus <view|react> <on|off> | autostatus react emoji <emoji> | autostatus status', command: key }); return; }
    await sendResult(socket, context, { text: 'AutoStatus settings updated. Status delivery requires the main message route to forward status events.', command: key });
    return;
  }
  if (key === 'autoreact' && !group) return;
  const data = await automationStore.read();
  const current = data.chats?.[context.chatId] || {};
  if (action === 'emojis' && key === 'autoreact') {
    const emojis = command.args.slice(1);
    if (!emojis.length) { await sendResult(socket, context, { text: 'Usage: autoreact emojis 😂 👍 ❤️', command: key }); return; }
    await automationStore.update(data => { data.chats = data.chats || {}; data.chats[context.chatId] = { ...data.chats[context.chatId], emojis }; });
    await sendResult(socket, context, { text: `AutoReact emojis updated: ${emojis.join(' ')}`, command: key });
    return;
  }
  if (!['on', 'off', 'status'].includes(action)) { await sendResult(socket, context, { text: `Usage: ${key} <on|off|status${key === 'autoreact' ? '|emojis' : ''}>`, command: key }); return; }
  if (action !== 'status') await automationStore.setChat(context.chatId, key, action === 'on');
  const enabled = action === 'status' ? current[key] : action === 'on';
  await sendResult(socket, context, { text: `${key}: ${enabled ? 'ON ✅' : 'OFF ❌'}${key === 'autoreact' ? '\nEmojis: ' + (current.emojis || DEFAULT_EMOJIS).join(' ') : ''}`, command: key, buttons: settingButtons(getCommandPrefix(), key, { showStatus: true }) });
}

// --- GAMES ---

async function handleDiceCommand(socket, context) {
  const result = Math.floor(Math.random() * 6) + 1;
  const emoji = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][result - 1];
  await sendResult(socket, context, { text: `${emoji} *YOU ROLLED* ${result}`, command: 'dice' });
}

async function handleCoinCommand(socket, context) {
  const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
  await sendResult(socket, context, { text: `🪙 *COIN FLIP*\n➜ *${result}*`, command: 'coin' });
}

async function handleRPSCommand(socket, context, command) {
  const choices = ['rock', 'paper', 'scissors'];
  const pick = choices.indexOf((command.args[0] || '').toLowerCase());
  if (pick < 0) {
    await sendResult(socket, context, { text: usageLine('rps', '<rock|paper|scissors>', 'rps rock'), command: 'rps' });
    return;
  }
  const bot = Math.floor(Math.random() * 3);
  const icons = { rock: '🪨', paper: '📄', scissors: '✂️' };
  const diff = (pick - bot + 3) % 3;
  const result = diff === 0 ? "It's a draw!" : diff === 1 ? 'You win!' : 'I win!';
  await sendResult(socket, context, {
    text: `${icons[choices[pick]]} vs ${icons[choices[bot]]}\n\n*${result.toUpperCase()}*`,
    command: 'rps'
  });
}

// --- RPG / ECONOMY ---

async function handleBalanceCommand(socket, context) {
  const user = await economyStore.get(context.sender);
  await sendResult(socket, context, {
    text: [
      '💰 *BALANCE*',
      '',
      `*Wallet:* ${user.balance.toLocaleString()} coins`,
      `*Bank:* ${user.bank.toLocaleString()} coins`,
      `*XP:* ${user.xp}`
    ].join('\n'),
    command: 'balance'
  });
}

async function handleDailyCommand(socket, context) {
  const result = await economyStore.daily(context.sender);
  if (!result.ok) {
    const minutes = Math.ceil(result.waitMs / 60_000);
    await sendResult(socket, context, { text: `*ALREADY CLAIMED* ⏳\nTry again in ${minutes} minutes.`, command: 'daily' });
    return;
  }
  await sendResult(socket, context, {
    text: `*DAILY REWARD CLAIMED* 🎁\n\n*+${result.amount}* coins\n*Balance:* ${result.user.balance.toLocaleString()}`,
    command: 'daily'
  });
}

async function handleWorkCommand(socket, context) {
  const result = await economyStore.work(context.sender);
  if (!result.ok) {
    const minutes = Math.ceil(result.waitMs / 60_000);
    await sendResult(socket, context, { text: `*YOU NEED TO REST* ⏳\nWork again in ${minutes} minutes.`, command: 'work' });
    return;
  }
  await sendResult(socket, context, {
    text: `*WORK COMPLETE* 🛠\n\n*+${result.amount}* coins\n*Balance:* ${result.user.balance.toLocaleString()}`,
    command: 'work'
  });
}

async function handleGiveCommand(socket, context, command) {
  const target = getTargetJid(context.raw);
  const amount = Number(command.args[command.args.length - 1]);
  if (!target || !Number.isInteger(amount) || amount <= 0) {
    await sendResult(socket, context, { text: usageLine('give', '@user <amount>', 'give @user 100'), command: 'give' });
    return;
  }
  try {
    const result = await economyStore.transfer(context.sender, target, amount);
    await socket.sendMessage(context.chatId, {
      text: `*TRANSFER SENT* ✅\n\n*${result.amount}* coins ➜ @${target.split('@')[0]}`,
      mentions: [target]
    }, { quoted: context.raw });
    await sendResult(socket, context, { text: `*TRANSFER SENT* ✅\n*Balance updated.*`, command: 'give' });
  } catch (error) {
    await sendResult(socket, context, { text: `*TRANSFER FAILED* ❌\n${error.message}`, command: 'give' });
  }
}

// --- OWNER ---

async function handleBroadcastCommand(socket, context, command) {
  if (!command.text) {
    await sendResult(socket, context, {
      text: usageLine('broadcast', '<message>', 'broadcast Maintenance at 9pm'),
      command: 'broadcast'
    });
    return;
  }
  // Delivered to every chat the bot has actually seen (tracked in
  // data/chats.json). The reply reports the real delivery counts — it never
  // claims success for messages that were not sent.
  const targets = (await chatStore.list()).filter((chatId) => chatId !== context.chatId);
  let delivered = 0;
  let failed = 0;
  for (const chatId of targets) {
    try {
      await socket.sendMessage(chatId, { text: `📢 *${config.botName} Announcement*\n\n${command.text}` });
      delivered += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[broadcast] Could not deliver to ${chatId}: ${error.message}`);
    }
  }
  await sendResult(socket, context, {
    text: [
      '*BROADCAST FINISHED* ✅',
      '',
      `*Delivered:* ${delivered}`,
      `*Failed:* ${failed}`,
      ...(targets.length ? [] : ['', 'No other chats are known yet. The bot learns a', 'chat the first time it receives a message in it.'])
    ].join('\n'),
    command: 'broadcast'
  });
}

async function handleSetPrefixCommand(socket, context, command) {
  const prefix = command.args[0];
  if (!prefix || prefix.length > 4 || /\s/.test(prefix)) {
    await socket.sendMessage(context.chatId, { text: 'Prefix must be 1-4 non-whitespace characters.' }, { quoted: context.raw });
    return;
  }
  await setCommandPrefix(prefix);
  // Buttons are rebuilt from the live prefix, so the next reply already uses it.
  await sendResult(socket, context, { text: `*PREFIX UPDATED* ✅\n➜ *${prefix}*`, command: 'setprefix' });
}

async function setCommandPrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix || prefix.length > 4 || /\s/.test(prefix)) {
    throw new Error('Prefix must be 1-4 non-whitespace characters.');
  }
  commandPrefix = prefix;
  await settingsStore.set('prefix', prefix);
}

async function handleSetNameCommand(socket, context, command) {
  const name = command.text.trim();
  if (!name || name.length < 2 || name.length > 30) {
    await socket.sendMessage(context.chatId, { text: 'Name must be 2-30 characters.' }, { quoted: context.raw });
    return;
  }
  try {
    await socket.updateProfileName(name);
    await settingsStore.set('bot_name', name);
    await sendResult(socket, context, { text: `*NAME UPDATED* ✅\n➜ ${name}`, command: 'setname' });
  } catch (error) {
    await sendResult(socket, context, { text: `*NAME UPDATE FAILED* ❌\n${error.message}`, command: 'setname' });
  }
}

// --- SUDO ---

async function handleSudoCommand(socket, context, command) {
  const target = getTargetJid(context.raw);
  const resolved = target ? await resolveJid(socket, target) : undefined;
  const number = resolved?.endsWith('@s.whatsapp.net') ? resolved.split('@')[0] : target ? undefined : command.args[0];
  if (!number) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}sudo <number|mention|reply>. LID targets must resolve to a phone JID.` }, { quoted: context.raw });
    return;
  }
  try {
    if (await sudoStore.has(number)) { await sendResult(socket, context, { text: 'User already has sudo privileges.', command: 'sudo' }); return; }
    const result = await sudoStore.add(number);
    await sendResult(socket, context, { text: `*SUDO GRANTED* ✅\n➜ ${result.id}`, command: 'sudo' });
  } catch (error) {
    await sendResult(socket, context, { text: `*SUDO FAILED* ❌\n${error.message}`, command: 'sudo' });
  }
}

async function handleDelsudoCommand(socket, context, command) {
  const target = getTargetJid(context.raw);
  const resolved = target ? await resolveJid(socket, target) : undefined;
  const number = resolved?.endsWith('@s.whatsapp.net') ? resolved.split('@')[0] : target ? undefined : command.args[0];
  if (!target && !number) return handleSudolistCommand(socket, context);
  if (!number) { await sendResult(socket, context, { text: 'Cannot resolve this LID to a phone number.', command: 'delsudo' }); return; }
  try {
    const result = await sudoStore.remove(number);
    await sendResult(socket, context, {
      text: result.removed ? `*SUDO REMOVED* ✅\n➜ ${result.id}` : '*NOT A SUDO USER* ❌',
      command: 'delsudo'
    });
  } catch (error) {
    await sendResult(socket, context, { text: `*SUDO FAILED* ❌\n${error.message}`, command: 'delsudo' });
  }
}

async function handleSudolistCommand(socket, context) {
  const users = await sudoStore.list();
  const text = users.length
    ? `🔐 *SUDO USERS*\n\n${users.map((u, i) => `${i + 1}. ➜ ${u}`).join('\n')}`
    : '🔐 *SUDO USERS*\n\n➜ None yet.';
  await sendResult(socket, context, { text, command: 'sudolist' });
}

// --- MODE ---

async function handleModeCommand(socket, context, command) {
  const arg = command.args[0]?.toLowerCase();
  const p = getCommandPrefix();
  if (arg === 'public' || arg === 'self') {
    if (!(await requireOwner(socket, context))) return;
    publicMode = arg === 'public';
    socket.public = publicMode;
    await modeStore.set(arg);
    await sendResult(socket, context, { text: `*BOT MODE* 💬\n➜ *${arg.toUpperCase()}*`, command: 'mode' });
    return;
  }
  await sendResult(socket, context, {
    text: `*BOT MODE* 💬\n➜ *${publicMode ? 'PUBLIC 🌍' : 'SELF 👤'}*`,
    command: 'mode'
  });
}

// --- PREMIUM ---

async function handlePremiumCommand(socket, context, command) {
  const number = command.args[0] || senderNumber(context);
  try {
    const normalized = normalizePhoneNumber(number, 'User number');
    const store = await premiumStore.list();
    const record = store.find((r) => r.id === normalized);
    const premiumText = record
      ? `💎 *PREMIUM STATUS*\n\n➜ ${record.id}\n*Expires:* ${formatDate(record.expiresAt)} UTC`
      : `💎 *PREMIUM STATUS*\n\n➜ ${normalized} has no premium access.`;
    await sendResult(socket, context, { text: premiumText, command: 'premium' });
  } catch (error) {
    await sendResult(socket, context, { text: `*PREMIUM CHECK FAILED* ❌\n${error.message}`, command: 'premium' });
  }
}

// --- SESSIONS ---

async function handleSessionsCommand(socket, context) {
  const text = [
    `🧩 *${config.botName.toUpperCase()} SESSION*`,
    '',
    `*Bot:* ${socket.user?.id?.split(':')[0] || 'unknown'}`,
    `*Uptime:* ${Math.floor(process.uptime())}s`
  ].join('\n');
  await sendResult(socket, context, { text, command: 'sessions' });
}

async function handleStopSessionCommand(socket, context, command) {
  if (!command.args[0]) {
    await sendResult(socket, context, {
      text: usageLine('stopsession', '<number>', 'stopsession 923001234567'),
      command: 'stopsession'
    });
    return;
  }
  await sendResult(socket, context, {
    text: '*SESSION CLEANUP* 🧹\n\nUse the Telegram controller\n`/stop <number>` to remove an\nunpaired session safely.',
    command: 'stopsession'
  });
}

// --- DELETE CACHE (anti-delete) ---

// ---------------------------------------------------------------------------
// MAIN MESSAGE HANDLER
// ---------------------------------------------------------------------------

async function handleMessage(socket, rawMessage) {
  const context = await getMessageContext(socket, rawMessage);
  if (!context.chatId || !context.sender) return;

  // Feeds the !broadcast target list. Errors are swallowed on purpose: the
  // registry is a convenience and must never break message handling.
  void chatStore.track(context.chatId).catch(() => {});

  if (context.chatId === 'status@broadcast') {
    await handleAutoStatus(socket, rawMessage, automationStore);
    return;
  }
  const antiEnabled = context.isGroup
    ? (await groupSettings.get(context.chatId)).antidelete
    : await automationStore.getGlobal('antidelete');
  if (rawMessage?.message?.protocolMessage?.type === 0) {
    if (antiEnabled) await recovery.handleMessageRevocation(socket, rawMessage, [...ownerJids(socket)][0]);
    return;
  }
  if (antiEnabled) await recovery.storeMessage(socket, rawMessage, { download: downloadMediaBuffer, ownerJid: [...ownerJids(socket)][0] });
  if (!context.fromMe && context.isGroup) await applyGroupProtections(socket, context);

  const command = commandFromText(context.text);
  if (!command) {
    // The existing quiz advertises plain "join" and A/B/C/D answers. Keep
    // numeric answers compatible without stealing idle menu-number replies.
    if (context.isGroup && /^join$/i.test(context.text.trim()) && (publicMode || isOwner(socket, context.sender))) {
      if (await quizModule.joinQuiz(socket, context)) return;
    }
    if (context.isGroup && /^[a-d1-4]$/i.test(context.text.trim())) {
      const quizHandled = await quizModule.handleGroupAnswer(socket, context);
      if (quizHandled) return;
    }

    // Numeric reply for menu category selection
    if (/^\d+$/.test(context.text.trim()) && context.text.trim().length <= 2) {
      const categories = categoriesWithCommands();
      const index = Number(context.text.trim()) - 1;
      if (index >= 0 && index < categories.length) {
        const fakeCommand = { name: 'menu', args: [categories[index].id], text: '' };
        await handleMenuCommand(socket, context, fakeCommand);
        return;
      }
    }

    if (!context.fromMe) {
      await handleAutoReact(socket, context, automationStore).catch(error => console.warn('[autoreact]', error.message));
      await handleAutowriteMessage(socket, context, automationStore).catch(error => console.warn('[autowrite]', error.message));
    }
    return;
  }

  const owner = isOwner(socket, context.sender);
  const sudo = owner || await sudoStore.has(senderNumber(context));
  if (!publicMode && !owner) return;

  console.info(`[command] ${command.name} from ${context.sender} in ${context.chatId}`);

  // No command may ever fail silently. Anything that escapes a handler's own
  // try/catch is reported to the user with a short message, logged here, and
  // then re-thrown so the caller (index.js / the pairing manager) still sees
  // the failure — a transport outage must never be swallowed.
  try {
    // Hidden command: !h / !H / !hidden / !HIDDEN — not in normal menu
    if (isHiddenCommand(command.name)) {
      await handleHiddenCommand(socket, context);
      return;
    }
    if (resolveCommand(command.name) && !['ping', 'p'].includes(command.name)) {
      await sourceCommands.react(socket, context, '⭐');
    }
    await dispatchCommand(socket, context, command, rawMessage);
    if (resolveCommand(command.name)) {
      try {
        if (!trackerReady) botTracker.stats.phoneNumber = normalizeJid(socket, socket.user?.id)?.split('@')[0] || 'unknown';
        trackerReady ||= botTracker.start();
        await trackerReady;
        botTracker.incrementCommands(command.name);
        await botTracker.saveStats();
      } catch (error) { console.warn('[tracker]', error.message); }
    }
  } catch (error) {
    console.error(`[command] ${command.name} failed:`, error);
    await socket.sendMessage(context.chatId, {
      text: `*COMMAND FAILED* ❌\n${error?.message || 'Unexpected error.'}`
    }, { quoted: context.raw }).catch(() => {});
    throw error;
  }
}

async function dispatchCommand(socket, context, command, rawMessage) {
  switch (command.name) {
    case 'fancy':
    case 'encrypt':
    case 'encrypt2':
    case 'tempmail':
    case 'getmail':
      await sourceCommands.tools(socket, context, command);
      break;
    case 'store':
    case 'ad':
    case 'vd':
    case 'list':
    case 'del':
      // Personal collection uses the existing owner gate and settings store.
      if (!(await requireOwner(socket, context))) break;
      await storedMedia(socket, context, command, { settings: settingsStore, download: downloadMediaBuffer });
      break;
    case 'upload':
    case 'mirror':
    case 'host':
      await sourceCommands.upload(socket, context, command, handleTourlCommand);
      break;
    // --- GENERAL ---
    case 'menu':
    case 'help':
      await handleMenuCommand(socket, context, command);
      break;

    case 'ping':
    case 'p': {
      await sourceCommands.ping(socket, context);
      break;
    }

    case 'request':
    case 'reportbug':
      await handleReport(socket, context, command.text);
      break;

    // --- MESSAGE MODE ---
    case 'public':
    case 'private':
    case 'self': {
      if (!(await requireOwner(socket, context))) break;
      publicMode = command.name === 'public';
      socket.public = publicMode;
      await modeStore.set(publicMode ? 'public' : 'self');
      await sendResult(socket, context, {
        text: `*BOT MODE* 💬\n➜ *${publicMode ? 'PUBLIC 🌍' : 'SELF 👤'}*`,
        command: command.name
      });
      break;
    }

    case 'mode':
    case 'botmode': {
      // menu.js declares this command owner-only; the bare `!mode` view used to
      // skip that gate. `!status` still shows the mode to everyone.
      if (!(await requireOwner(socket, context))) break;
      await handleModeCommand(socket, context, command);
      break;
    }

    // --- DOWNLOADER ---
    case 'play':
      await sourceCommands.download(socket, context, command);
      break;

    case 'ytmp3':
    case 'mp3':
    case 'audio':
      await sourceCommands.download(socket, context, command);
      break;

    case 'video':
    case 'ytmp4':
    case 'ytvideo':
    case 'mp4':
      await sourceCommands.download(socket, context, command);
      break;

    case 'spotify':
      await handleSpotifyCommand(socket, context, command);
      break;

    case 'media':
    case 'download':
    case 'dl':
      await handleMediaCommand(socket, context, command);
      break;

    // --- MEDIA ---
    case 'getpp':
    case 'pp':
    case 'profilepic':
    case 'avatar':
      await handleGetProfilePhoto(socket, context, command);
      break;

    case 'setpp':
      await handleSetBotProfilePhoto(socket, context);
      break;

    case 'save':
    case 'savestatus':
    case 'downloadstatus':
      await recovery.saveStatus(socket, context, downloadMediaBuffer, [...ownerJids(socket)][0]);
      break;
    case 'hey':
    case 'revealonce':
    case 'vv':
    case 'retrieve':
    case 'viewonce':
      await handleVVCommand(socket, context);
      break;

    // --- CONVERTER ---
    case 'sticker':
    case 's':
    case 'stiker': {
      const videoMessage = rawMessage.message?.videoMessage || getQuotedMessage(rawMessage).videoMessage;
      const imageMessage = videoMessage || getImageMessage(rawMessage);
      if (!imageMessage) {
        await sendResult(socket, context, {
          text: `*REPLY TO AN IMAGE* 🖼\nThen send ${getCommandPrefix()}sticker.`,
          command: 'sticker'
        });
        break;
      }
      try {
        const imageBuffer = await downloadMediaBuffer(imageMessage, videoMessage ? 'video' : 'image');
        const sticker = await (videoMessage ? createVideoSticker : createImageSticker)(imageBuffer, { packname: 'ANIME-MD', author: 'GoatMods' });
        await socket.sendMessage(context.chatId, { sticker }, { quoted: context.raw });
        await sendResult(socket, context, { text: '*STICKER READY* 🎨', command: 'sticker' });
      } catch (error) {
        console.error('[sticker] Conversion failed:', error);
        await sendResult(socket, context, { text: `*STICKER FAILED* ❌\n${error.message}`, command: 'sticker' });
      }
      break;
    }

    case 'take':
    case 'steal':
    case 'tovid':
    case 'sticker2vid': {
      const sticker = getStickerMessage(rawMessage);
      if (!sticker) { await sendResult(socket, context, { text: 'Reply to a sticker.', command: command.name }); break; }
      try {
        const buffer = await downloadMediaBuffer(sticker, 'sticker');
        if (['take', 'steal'].includes(command.name)) {
          const [packname, author] = command.text.split('|').map(value => value.trim());
          const result = await takeSticker(buffer, { packname: packname || 'ANIME-MD', author: author || 'GoatMods' });
          await socket.sendMessage(context.chatId, { sticker: result }, { quoted: context.raw });
        } else {
          await socket.sendMessage(context.chatId, { video: await convertToVideo(buffer), mimetype: 'video/mp4', caption: sourceCommands.FOOTER }, { quoted: context.raw });
        }
        await sourceCommands.react(socket, context, '✅');
      } catch (error) { await sendResult(socket, context, { text: `Conversion failed: ${error.message}`, command: command.name }); }
      break;
    }
    case 'toimg':
    case 'sticker2img':
    case 'img': {
      const stickerMessage = getStickerMessage(rawMessage);
      if (!stickerMessage) {
        await sendResult(socket, context, {
          text: `*REPLY TO A STICKER* 🎨\nThen send ${getCommandPrefix()}toimg.`,
          command: 'toimg'
        });
        break;
      }
      try {
        const stickerBuffer = await downloadMediaBuffer(stickerMessage, 'sticker');
        const image = await convertStickerToImage(stickerBuffer);
        await socket.sendMessage(context.chatId, { image, caption: '*CONVERTED TO IMAGE* ✅' }, { quoted: context.raw });
        await sendResult(socket, context, { text: '*CONVERTED TO IMAGE* ✅', command: 'toimg' });
      } catch (error) {
        console.error('[toimg] Conversion failed:', error);
        await sendResult(socket, context, { text: `*CONVERSION FAILED* ❌\n${error.message}`, command: 'toimg' });
      }
      break;
    }

    case 'convert':
    case 'converter': {
      const p = getCommandPrefix();
      const text = [
        '🧰 *CONVERTER*',
        '',
        `${p}sticker — image ➜ sticker`,
        `${p}toimg — sticker ➜ image`,
        `${p}tts <text> — text ➜ audio`,
        `${p}qr <text> — text ➜ QR`
      ].join('\n');
      await sendResult(socket, context, { text, command: 'convert' });
      break;
    }

    case 'tts':
      await handleTTSCommand(socket, context, command);
      break;

    case 'qr':
    case 'qrcode':
      await handleQRCommand(socket, context, command);
      break;

    // --- UPLOAD ---
    case 'tourl':
    case 'uploader':
    case 'imgtourl':
    case 'imageurl':
    case 'url':
      await handleTourlCommand(socket, context);
      break;

    // --- AI ---
    case 'loveai':
    case 'love':
    case 'dark':
    case 'ai':
    case 'ask':
    case 'ia':
    case 'groq':
      await handleAiCommand(socket, context, command);
      break;

    case 'translate':
    case 'tr':
    case 'trans':
      await handleTranslateCommand(socket, context, command);
      break;

    // --- TOOLS ---
    case 'jid':
    case 'chatid': {
      const metadata = context.isGroup ? await socket.groupMetadata(context.chatId) : undefined;
      await sendResult(socket, context, {
        text: [
          '🔎 *JID INFO*',
          '',
          `*Chat:* ${context.chatId}`,
          `*Sender:* ${context.sender}`,
          `*Type:* ${context.isGroup ? 'group' : 'private'}`,
          ...(metadata ? [`*Name:* ${metadata.subject}`, `*Members:* ${metadata.participants.length}`, `*Admins:* ${metadata.participants.filter(p => p.admin).length}`, `*Owner:* ${metadata.owner || 'Not defined'}`, ...(metadata.creation ? [`*Created:* ${new Date(metadata.creation * 1000).toLocaleDateString('fr-FR')}`] : [])] : [])
        ].join('\n'),
        command: 'jid'
      });
      break;
    }

    case 'idch':
    case 'cekidch': {
      if (!command.text && context.chatId.endsWith('@newsletter')) {
        const info = await socket.newsletterMetadata('jid', context.chatId).catch(() => ({}));
        await sendResult(socket, context, { text: `CHANNEL INFO\nID: ${context.chatId}\nName: ${info.name || 'WhatsApp Channel'}`, command: 'idch' });
        break;
      }
      if (!command.text) {
        await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}idch <WhatsApp channel URL>` }, { quoted: context.raw });
        break;
      }
      let inviteCode;
      try {
        const url = new URL(command.text);
        if (url.hostname !== 'whatsapp.com' || !url.pathname.startsWith('/channel/')) throw new Error('invalid channel URL');
        inviteCode = url.pathname.split('/').filter(Boolean).at(-1);
      } catch {
        await socket.sendMessage(context.chatId, { text: 'Please provide a valid https://whatsapp.com/channel/... URL.' }, { quoted: context.raw });
        break;
      }
      try {
        const channel = await socket.newsletterMetadata('invite', inviteCode);
        await sendResult(socket, context, {
          text: [
            '📣 *CHANNEL INFO*',
            '',
            `*ID:* ${channel.id}`,
            `*Name:* ${channel.name}`,
            `*Followers:* ${channel.subscribers}`,
            `*Verified:* ${channel.verification === 'VERIFIED' ? 'yes ✅' : 'no ❌'}`
          ].join('\n'),
          command: 'idch'
        });
      } catch (error) {
        await sendResult(socket, context, { text: `*CHANNEL FETCH FAILED* ❌\n${error.message}`, command: 'idch' });
      }
      break;
    }

    case 'calc':
    case 'calculate':
    case 'math':
      await handleCalcCommand(socket, context, command);
      break;

    case 'ss':
    case 'screenshot':
      await handleSSCommand(socket, context, command);
      break;

    case 'short':
    case 'shorten':
    case 'tinyurl':
      await handleShortCommand(socket, context, command);
      break;

    case 'tools':
    case 'utils': {
      const p = getCommandPrefix();
      const text = [
        '🛠 *TOOLS*',
        '',
        `${p}jid — show JIDs`,
        `${p}idch <url> — channel info`,
        `${p}calc <expr> — calculator`,
        `${p}ss <url> — screenshot`,
        `${p}short <url> — shorten URL`,
        `${p}translate [lang] <text> — translate`
      ].join('\n');
      await sendResult(socket, context, { text, command: 'tools' });
      break;
    }

    // --- GROUP ---
    case 'hidetag':
    case 'ht':
    case 'tag':
    case 'tagall':
    case 'everyone': {
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      const metadata = await socket.groupMetadata(context.chatId);
      const groupPic = await socket.profilePictureUrl(context.chatId, 'image').catch(() => 'https://i.ibb.co/SDd09XR9/425104bcd93b.jpg');
      const mentions = group.participants.map(p => p.id);
      const visible = ['tagall', 'everyone'].includes(command.name);
      let text;
      if (visible) {
        text = `*ANIME-MD*\n${command.text ? `Message: ${command.text}\n` : ''}Total: ${mentions.length} Members\n${new Date().toLocaleString('fr-FR')}\n`;
        text += group.participants.slice(0, 30).map((p, i) => `${p.admin ? '👑' : '👤'} ${i + 1}. @${p.id.split('@')[0]}`).join('\n');
        if (mentions.length > 30) text += `\n... +${mentions.length - 30} others`;
      } else {
        text = `*ANIME-MD HIDETAG*\n${context.quotedText || command.text || 'Attention all members!'}\n${mentions.length} Members`;
        await socket.sendMessage(context.chatId, { delete: context.raw.key }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      text += `\n\n> ${sourceCommands.FOOTER}`;
      await socket.sendMessage(context.chatId, { text, mentions, contextInfo: { externalAdReply: { title: metadata.subject, thumbnailUrl: groupPic, mediaType: 1, renderLargerThumbnail: true } } }, visible ? { quoted: context.raw } : {});
      break;
    }

    case 'welcome':
    case 'goodbye':
    case 'greet': {
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      await handleGreetingSettings(socket, context, command, group);
      break;
    }

    case 'group':
    case 'gname':
    case 'gdesc':
    case 'add':
    case 'kick':
    case 'promote':
    case 'demote':
    case 'lock':
    case 'unlock':
    case 'grouplink':
    case 'linkgc': {
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      await handleGroupManagement(socket, context, command, group);
      break;
    }

    case 'warn':
    case 'warning': {
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      await handleWarnCommand(socket, context, command, group);
      break;
    }

    case 'unwarn':
    case 'delwarn': {
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      await handleUnwarnCommand(socket, context, command);
      break;
    }

    case 'warns':
    case 'warnings': {
      await handleWarnsCommand(socket, context, command);
      break;
    }

    // --- ANTI / SECURITY ---
    case 'antilink':
    case 'antispam':
    case 'antimention':
    case 'antitag':
    case 'antigroupmention':
    case 'antisupp':
    case 'antidelete': {
      command = { ...command, name: resolveCommand(command.name)?.name || command.name };
      if (command.name === 'antidelete' && !context.isGroup) {
        if (!(await requireOwner(socket, context))) break;
        const action = command.args[0]?.toLowerCase() || 'status';
        if (['on', 'enable', 'off', 'disable'].includes(action)) await automationStore.setGlobal('antidelete', ['on', 'enable'].includes(action));
        await sendResult(socket, context, { text: `Anti-delete: ${await automationStore.getGlobal('antidelete') ? 'ON' : 'OFF'}`, command: 'antidelete' });
        break;
      }
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      await handleAntiToggleCommand(socket, context, command);
      break;
    }

    // --- AUTOMATION ---
    case 'autoreaction':
    case 'autotype':
    case 'fakewrite':
    case 'autoreact':
    case 'autowrite': {
      command = { ...command, name: resolveCommand(command.name)?.name || command.name };
      const group = context.isGroup ? await requireGroupAdmin(socket, context) : undefined;
      if (context.isGroup && !group) break;
      if (!context.isGroup && command.name !== 'autowrite') { await sendResult(socket, context, { text: 'This command is only available in groups.', command: command.name }); break; }
      await handleAutomationToggle(socket, context, command, group);
      break;
    }

    case 'autostatusview':
    case 'autostatusreact':
    case 'autostatus':
      await handleAutomationToggle(socket, context, command);
      break;

    // --- GAMES ---
    case 'dice':
    case 'roll':
      await handleDiceCommand(socket, context);
      break;

    case 'coin':
    case 'flip':
      await handleCoinCommand(socket, context);
      break;

    case 'rps':
      await handleRPSCommand(socket, context, command);
      break;

    // --- RPG / ECONOMY ---
    case 'balance':
    case 'bal':
    case 'wallet':
      await handleBalanceCommand(socket, context);
      break;

    case 'daily':
    case 'claim':
      await handleDailyCommand(socket, context);
      break;

    case 'work':
    case 'earn':
      await handleWorkCommand(socket, context);
      break;

    case 'give':
      await handleGiveCommand(socket, context, command);
      break;

    case 'rpg':
    case 'economy': {
      const p = getCommandPrefix();
      const text = [
        '💰 *RPG & ECONOMY*',
        '',
        `${p}balance — wallet / bank`,
        `${p}daily — daily reward`,
        `${p}work — earn coins`,
        `${p}give @user <amount> — transfer`
      ].join('\n');
      await sendResult(socket, context, {
        text,
        command: 'rpg',
        buttons: [
          { label: '💰 Balance', id: `${p}balance` },
          { label: '🎁 Daily', id: `${p}daily` },
          { label: '🛠 Work', id: `${p}work` }
        ]
      });
      break;
    }

    // --- OWNER ---
    case 'alive':
      await sourceCommands.alive(socket, context);
      break;
    case 'status':
    case 'runtime': {
      const text = [
        `📊 *${config.botName.toUpperCase()} STATUS*`,
        '',
        `*Mode:* ${publicMode ? 'public 🌍' : 'self 👤'}`,
        `*Uptime:* ${Math.floor(process.uptime())}s`,
        `*Commands:* ${categoriesWithCommands().reduce((total, category) => total + category.commands.length, 0)}`,
        `*Developer:* ${config.developerName}`
      ].join('\n');
      await sendResult(socket, context, { text, command: 'status' });
      break;
    }

    case 'owner':
    case 'creator':
      await sendOwnerCard(socket, context.chatId, context.raw);
      break;

    case 'pairing':
    case 'tgpair':
    case 'telegram':
    case 'tg': {
      const pairText = config.telegramBotLink
        ? `✈️ *TELEGRAM PAIRING*\n\n➜ ${config.telegramBotLink}\n\nThen send *\/pair <number>*.`
        : '✈️ *TELEGRAM PAIRING*\n\n➜ Not configured. Ask the owner to set\ntelegram.botLink in config.js.';
      await sendResult(socket, context, { text: pairText, command: 'pairing' });
      break;
    }

    case 'restart':
    case 'rst': {
      if (!(await requireOwner(socket, context))) break;
      const mode = requestRestart();
      await sendResult(socket, context, {
        text: mode === 'supervisor'
          ? '🔄 *RESTARTING*\nThe supervisor will bring the bot back in a few seconds.'
          : '🔄 *RESTART REQUESTED*\nYour host must restart this process.',
        command: 'restart'
      });
      break;
    }

    case 'setname': {
      if (!(await requireOwner(socket, context))) break;
      await handleSetNameCommand(socket, context, command);
      break;
    }

    case 'setprefix': {
      if (!(await requireOwner(socket, context))) break;
      await handleSetPrefixCommand(socket, context, command);
      break;
    }

    case 'broadcast':
    case 'bc': {
      if (!(await requireOwner(socket, context))) break;
      await handleBroadcastCommand(socket, context, command);
      break;
    }

    // --- SUDO ---
    case 'addsudo':
    case 'makesudo':
    case 'sudo': {
      if (!(await requireOwner(socket, context))) break;
      await handleSudoCommand(socket, context, command);
      break;
    }

    case 'removesudo':
    case 'unsudo':
    case 'delsudo': {
      if (!(await requireOwner(socket, context))) break;
      await handleDelsudoCommand(socket, context, command);
      break;
    }

    case 'sudolist':
    case 'sudos':
    case 'listsudo': {
      if (!(await requireSudoOrOwner(socket, context))) break;
      await handleSudolistCommand(socket, context);
      break;
    }

    // --- PREMIUM ---
    case 'addprem': {
      if (!(await requireOwner(socket, context))) break;
      const [phoneNumber, duration = '30d'] = command.args;
      if (!phoneNumber) {
        await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}addprem <number> [30d]` }, { quoted: context.raw });
        break;
      }
      try {
        const record = await premiumStore.add(phoneNumber, duration);
        await sendResult(socket, context, {
          text: `*PREMIUM GRANTED* 💎\n\n➜ ${record.id}\n*Until:* ${formatDate(record.expiresAt)} UTC`,
          command: 'addprem'
        });
      } catch (error) {
        await sendResult(socket, context, { text: `*PREMIUM FAILED* ❌\n${error.message}`, command: 'addprem' });
      }
      break;
    }

    case 'delprem': {
      if (!(await requireOwner(socket, context))) break;
      if (!command.args[0]) {
        await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}delprem <number>` }, { quoted: context.raw });
        break;
      }
      try {
        const phoneNumber = normalizePhoneNumber(command.args[0], 'Premium user number');
        const removed = await premiumStore.remove(phoneNumber);
        await sendResult(socket, context, {
          text: removed ? `*PREMIUM REMOVED* ✅\n➜ ${phoneNumber}` : '*NO ACTIVE PREMIUM* ❌',
          command: 'delprem'
        });
      } catch (error) {
        await sendResult(socket, context, { text: `*PREMIUM FAILED* ❌\n${error.message}`, command: 'delprem' });
      }
      break;
    }

    case 'listprem': {
      if (!(await requireOwner(socket, context))) break;
      try {
        const records = await premiumStore.list();
        const text = records.length
          ? `💎 *PREMIUM USERS*\n\n${records.map((record, index) => `${index + 1}. ➜ ${record.id} — ${formatDate(record.expiresAt)} UTC`).join('\n')}`
          : '💎 *PREMIUM USERS*\n\n➜ None active.';
        await sendResult(socket, context, { text, command: 'listprem' });
      } catch (error) {
        await sendResult(socket, context, { text: `*PREMIUM READ FAILED* ❌\n${error.message}`, command: 'listprem' });
      }
      break;
    }

    case 'premium':
      await handlePremiumCommand(socket, context, command);
      break;

    // --- SESSIONS ---
    case 'sessions':
      await handleSessionsCommand(socket, context);
      break;

    case 'stopsession':
    case 'stop':
      if (!(await requireOwner(socket, context))) break;
      await handleStopSessionCommand(socket, context, command);
      break;

    // --- GUESS GAME ---
    case 'guess':
    case 'guessthenumber': {
      // Simple number-guess game inline
      if (command.args[0] === 'start') {
        const num = Math.floor(Math.random() * 100) + 1;
        guessGames.set(context.sender, { number: num, attempts: 0, started: Date.now() });
        await sendResult(socket, context, {
          text: `🎮 *GUESS THE NUMBER*\n\n➜ 1 - 100. Reply with your guess.`,
          command: 'guess'
        });
      } else if (/^\d+$/.test(command.args[0])) {
        const game = guessGames.get(context.sender);
        if (!game) {
          await socket.sendMessage(context.chatId, { text: `No active game. Start one with ${getCommandPrefix()}guess start` }, { quoted: context.raw });
          break;
        }
        const guess = Number(command.args[0]);
        game.attempts++;
        if (guess === game.number) {
          guessGames.delete(context.sender);
          await sendResult(socket, context, {
            text: `🎉 *CORRECT!*\nThe number was *${game.number}* in ${game.attempts} attempts.`,
            command: 'guess'
          });
        } else if (guess < game.number) {
          await sendResult(socket, context, { text: '⬆️ *HIGHER!*', command: 'guess' });
        } else {
          await sendResult(socket, context, { text: '⬇️ *LOWER!*', command: 'guess' });
        }
      } else if (command.args[0] === 'stop') {
        guessGames.delete(context.sender);
        await socket.sendMessage(context.chatId, { text: 'Game ended.' }, { quoted: context.raw });
      } else {
        await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}guess <start|stop|1-100>` }, { quoted: context.raw });
      }
      break;
    }

    // ═══════════════════════════════════════════════════════════════
    //  ANIME / OTAKU COMMANDS
    // ═══════════════════════════════════════════════════════════════

    case 'uid':
      await sendResult(socket, context, {
        text: '🔎 *YOUR UID*\n\n' + context.sender,
        command: 'uid'
      });
      break;

    case 'anime':
      await handleAnimeCommand(socket, context, command.args);
      break;

    case 'manga':
      await handleMangaCommand(socket, context, command.args);
      break;

    case 'character':
    case 'char':
      await handleCharacterCommand(socket, context, command.args);
      break;

    case 'quote':
    case 'animequote':
      await handleQuoteCommand(socket, context);
      break;

    case 'animevs':
      await handleAnimevsCommand(socket, context, command.args);
      break;

    case 'ship':
      await handleShipCommand(socket, context, command.args);
      break;

    case 'waifu':
    case 'husbando':
    case 'dailywaifu':
      await handleWaifuCommand(socket, context, command.name);
      break;

    case 'profile':
    case 'otakuprofile':
      await handleProfileCommand(socket, context);
      break;

    case 'badges':
    case 'badge':
      await handleBadgesCommand(socket, context);
      break;

    case 'leaderboard':
    case 'lb':
    case 'topplayers':
      await handleLeaderboardCommand(socket, context);
      break;

    // ═══════════════════════════════════════════════════════════════
    //  QUIZ SYSTEM
    // ═══════════════════════════════════════════════════════════════

    case 'quiz':
    case 'startquiz':
      if (command.args[0] === 'stop') {
        await quizModule.stopQuiz(socket, context);
      } else if (command.args[0] === 'join') {
        if (!(await quizModule.joinQuiz(socket, context, context.sender))) {
          await socket.sendMessage(context.chatId, { text: `No joinable quiz lobby. Start one with ${getCommandPrefix()}quiz.` }, { quoted: context.raw });
        }
      } else {
        await quizModule.startQuiz(socket, context, command.args);
      }
      break;

    case 'quizjoin':
      if (!(await quizModule.joinQuiz(socket, context, context.sender))) {
        await socket.sendMessage(context.chatId, { text: `No joinable quiz lobby. Start one with ${getCommandPrefix()}quiz.` }, { quoted: context.raw });
      }
      break;

    case 'quizstop':
      await quizModule.stopQuiz(socket, context);
      break;

    // ═══════════════════════════════════════════════════════════════
    //  EXTENDED DOWNLOADERS
    // ═══════════════════════════════════════════════════════════════

    case 'tiktok':
    case 'tt':
    case 'ttdl':
      await handleTiktokCommand(socket, context, command.text);
      break;

    case 'facebook':
    case 'fb':
    case 'fbdl':
      await handleFacebookCommand(socket, context, command.text);
      break;

    case 'xdl':
    case 'twdl':
    case 'twitter':
      await handleXdlCommand(socket, context, command.text);
      break;

    // ═══════════════════════════════════════════════════════════════
    //  FUN COMMANDS
    // ═══════════════════════════════════════════════════════════════

    case 'couple':
    case 'lovemeter':
      await handleCoupleCommand(socket, context);
      break;

    case 'truth':
      await handleTruthCommand(socket, context);
      break;

    case 'dare':
      await handleDareCommand(socket, context);
      break;

    case 'fact':
    case 'randomfact':
      await handleFactCommand(socket, context);
      break;

    case 'pickup':
    case 'pickupline':
      await handlePickupCommand(socket, context);
      break;

    case 'meteo':
    case 'weather':
      await handleMeteoCommand(socket, context, command.args);
      break;

    case 'lyrics':
    case 'lyric':
      await handleLyricsCommand(socket, context, command.args);
      break;

    // ═══════════════════════════════════════════════════════════════
    //  ADVANCED GROUP MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    case 'purge':
    case 'kickall':
    case 'kickall2':
    case 'demoteall':
    case 'promoteall':
    case 'autopromote': {
      const group = await requireGroupAdmin(socket, context);
      if (!group || !(await requireBotAdmin(socket, context, group))) break;
      const demote = command.name === 'demoteall';
      const promote = ['promoteall', 'autopromote'].includes(command.name);
      const bot = normalizeJid(socket, socket.user?.id);
      const targets = command.name === 'autopromote' ? [context.sender] : group.participants
        .filter(p => demote ? p.admin === 'admin' && normalizeJid(socket, p.id) !== context.sender && normalizeJid(socket, p.id) !== bot : !p.admin)
        .map(p => p.id);
      if (!targets.length) { await sendResult(socket, context, { text: 'No eligible members.', command: command.name }); break; }
      const action = demote ? 'demote' : promote ? 'promote' : 'remove';
      if (['purge', 'demoteall', 'autopromote'].includes(command.name)) {
        await socket.groupParticipantsUpdate(context.chatId, targets, action);
      } else {
        let completed = 0;
        for (const target of targets) {
          try { await socket.groupParticipantsUpdate(context.chatId, [target], action); completed++; }
          catch (error) { console.warn('[group action]', error.message); }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        await sendResult(socket, context, { text: `Completed ${completed}/${targets.length} actions.`, command: command.name });
      }
      await sourceCommands.react(socket, context, '✅');
      break;
    }
    case 'antidemote':
    case 'antipromote': {
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      const action = command.args[0]?.toLowerCase() || 'status';
      if (['on', 'off'].includes(action)) await automationStore.setChat(context.chatId, command.name, action === 'on');
      else if (action !== 'status') { await sendResult(socket, context, { text: `Usage: ${command.name} <on|off|status>`, command: command.name }); break; }
      await sendResult(socket, context, { text: `${command.name}: ${await automationStore.getChat(context.chatId, command.name) ? 'ON' : 'OFF'}`, command: command.name });
      break;
    }

    case 'opentime': {
      const go = await requireGroupAdmin(socket, context);
      if (!go) break;
      if (!(await requireBotAdmin(socket, context, go))) break;
      if (command.args[0] === 'cancel') {
        if (groupTimers.has(context.chatId + ':open')) { clearTimeout(groupTimers.get(context.chatId + ':open')); groupTimers.delete(context.chatId + ':open'); }
        await socket.sendMessage(context.chatId, { text: '✅ Open timer cancelled.' }, { quoted: context.raw });
        break;
      }
      const duration = parseDuration(command.args.join(' '));
      if (!duration) {
        await socket.sendMessage(context.chatId, { text: '❌ Invalid duration.\nUsage: !opentime <30s|5m|1h|1h30m>\nCancel: !opentime cancel' }, { quoted: context.raw });
        break;
      }

      await socket.sendMessage(context.chatId, { text: '🔓 Group will open in *' + formatDuration(duration) + '*' }, { quoted: context.raw });
      const timer = setTimeout(async () => {
        try {
          await socket.groupSettingUpdate(context.chatId, 'not_announcement');
          await socket.sendMessage(context.chatId, { text: '🔓 *Auto-open triggered!*\nThe group is now open.' });
        } catch (e) { console.error('[opentime] Error:', e.message); }
        groupTimers.delete(context.chatId + ':open');
      }, duration);
      groupTimers.set(context.chatId + ':open', timer);
      break;
    }

    case 'closetime': {
      const gc = await requireGroupAdmin(socket, context);
      if (!gc) break;
      if (!(await requireBotAdmin(socket, context, gc))) break;
      if (command.args[0] === 'cancel') {
        if (groupTimers.has(context.chatId + ':close')) { clearTimeout(groupTimers.get(context.chatId + ':close')); groupTimers.delete(context.chatId + ':close'); }
        await socket.sendMessage(context.chatId, { text: '✅ Close timer cancelled.' }, { quoted: context.raw });
        break;
      }
      const duration2 = parseDuration(command.args.join(' '));
      if (!duration2) {
        await socket.sendMessage(context.chatId, { text: '❌ Invalid duration.\nUsage: !closetime <30s|5m|1h|1h30m>\nCancel: !closetime cancel' }, { quoted: context.raw });
        break;
      }

      await socket.sendMessage(context.chatId, { text: '🔒 Group will close in *' + formatDuration(duration2) + '*' }, { quoted: context.raw });
      const timer2 = setTimeout(async () => {
        try {
          await socket.groupSettingUpdate(context.chatId, 'announcement');
          await socket.sendMessage(context.chatId, { text: '🔒 *Auto-close triggered!*\nThe group is now locked.' });
        } catch (e) { console.error('[closetime] Error:', e.message); }
        groupTimers.delete(context.chatId + ':close');
      }, duration2);
      groupTimers.set(context.chatId + ':close', timer2);
      break;
    }

    default:
      break;
  }
}

// Handle protocol message (delete events)
module.exports = handleMessage;
module.exports.commandFromText = commandFromText;
module.exports.helpText = helpText;
module.exports.initializeMode = initializeMode;
module.exports.modeStore = modeStore;
module.exports.getCommandPrefix = getCommandPrefix;
module.exports.setCommandPrefix = setCommandPrefix;
