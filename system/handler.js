'use strict';

const QRCode = require('qrcode');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { config, normalizePhoneNumber } = require('./config');
const { groupSettings } = require('./group-events');
const {
  getImageMessage,
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
const { AutomationStore } = require('./lib/automation');
const { EconomyStore } = require('./lib/economy');
const { ChatStore } = require('./lib/chats');
const { MAX_STICKER_INPUT_BYTES, convertStickerToImage, createImageSticker } = require('./lib/sticker');
const { sendButtons, sendList } = require('./lib/ui');
const { contextButtons, menuButton, settingButtons } = require('./lib/whatsapp-actions');
const { helpText: buildHelpText, categoriesWithCommands, getCategory } = require('./lib/menu');
const {
  requestCobalt,
  youtubeSearch,
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
const chatStore = new ChatStore(config.chatsDbPath);
const reportCooldowns = new Map();
let publicMode = config.publicMode;
let commandPrefix = config.commandPrefix;

// Anti-delete message cache: chatId:messageId → { text, sender, timestamp }
const deletedMessageCache = new Map();
const MAX_CACHED_MESSAGES = 2_000;
// Anti-spam per-chat per-user timestamps
const spamTracker = new Map();
const SPAM_THRESHOLD = 5;
const SPAM_WINDOW_MS = 8_000;

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
    footer: `${config.botName} • ${config.ownerName}`,
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
  const botParticipant = participants.find((entry) => normalizeJid(socket, entry.id) === botJid);
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

async function handleGreetingSettings(socket, context, command, group) {
  const action = command.args[0]?.toLowerCase() || 'status';
  const settingKey = command.name === 'goodbye' ? 'goodbyeEnabled' : 'welcomeEnabled';
  const label = command.name === 'goodbye' ? 'Goodbye messages' : 'Welcome messages';

  if (command.name === 'greet') {
    const settings = await groupSettings.get(context.chatId);
    await sendResult(socket, context, {
      text: [
        '👋 *GREETING SETTINGS*',
        '',
        `*Welcome:* ${settings.welcomeEnabled ? 'ON ✅' : 'OFF ❌'}`,
        `*Goodbye:* ${settings.goodbyeEnabled ? 'ON ✅' : 'OFF ❌'}`
      ].join('\n'),
      command: 'greet',
      buttons: [
        { label: '👋 Welcome', id: `${getCommandPrefix()}welcome status` },
        { label: '👋 Goodbye', id: `${getCommandPrefix()}goodbye status` },
        { label: '⬅️ Back', id: `${getCommandPrefix()}menu group` }
      ]
    });
    return;
  }

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
    const answer = await askGroq({ apiKey: config.groqApiKey, model: config.groqModel, prompt, botName: config.botName });
    await sendResult(socket, context, { text: `🤖 *${config.botName}*\n\n${answer}`, command: 'ai' });
  } catch (error) {
    console.error('[ai] Request failed:', error);
    await sendResult(socket, context, { text: `*AI UNAVAILABLE* ❌\n${error.message}`, command: 'ai' });
  }
}

async function handleGetProfilePhoto(socket, context, command) {
  let target = getTargetJid(context.raw) || (context.isGroup ? context.chatId : context.sender);
  if (command.args[0]) {
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
    await socket.updateProfilePicture(socket.user.id, imageBuffer);
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
  const p = getCommandPrefix();
  const categoryId = command.args[0]?.toLowerCase();

  if (!categoryId || categoryId === 'home') {
    const categories = categoriesWithCommands();
    try {
      await sendList(socket, context.chatId, {
        text: `*${config.botName}*\n\nChoose a category:`,
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
          `*${config.botName}*`,
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

  const lines = category.commands.map((cmd) => {
    const parts = [`${p}${cmd.name}`];
    if (cmd.usage) parts.push(cmd.usage);
    return parts.join(' ');
  });

  const text = [
    `*${category.icon} ${category.label}*`,
    '',
    ...lines,
    '',
    `Type ${p}menu for the full menu.`
  ].join('\n');

  try {
    await sendList(socket, context.chatId, {
      text: `*${category.icon} ${category.label}*`,
      footer: `Developer: ${config.developerName}`,
      title: category.label,
      sections: [{
        title: category.label,
        rows: category.commands.map((cmd) => ({
          header: category.icon,
          title: `${p}${cmd.name}${cmd.usage ? ` ${cmd.usage}` : ''}`,
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

async function handlePlayCommand(socket, context, command) {
  if (!command.text) {
    await sendResult(socket, context, { text: usageLine('play', '<song name | url>', 'play Faded'), command: 'play' });
    return;
  }
  await socket.sendMessage(context.chatId, { text: '⏳ *Searching…*' }, { quoted: context.raw });
  const query = command.text;
  try {
    let videoUrl = query;
    let title = query;

    if (!/^https?:\/\//.test(query)) {
      const results = await youtubeSearch(query, 1);
      videoUrl = results[0].url;
      title = results[0].title;
    }

    const result = await requestCobalt(config.cobaltApiUrl, videoUrl, { audio: true });
    if (!result?.url) throw new Error('No audio stream was returned for that link.');
    await socket.sendMessage(context.chatId, {
      audio: { url: result.url },
      mimetype: 'audio/mpeg',
      fileName: result.filename || `${title}.mp3`,
      ptt: false
    }, { quoted: context.raw });
    await sendResult(socket, context, {
      text: ['*AUDIO READY* ✅', '', `*Title:* ${title}`, '*Format:* mp3'].join('\n'),
      command: 'play',
      ctx: { query }
    });
  } catch (error) {
    console.error('[play] Download failed:', error);
    await sendResult(socket, context, {
      text: `*DOWNLOAD FAILED* ❌\n${error.message}`,
      command: 'play',
      ctx: { query }
    });
  }
}

async function handleYtmp3Command(socket, context, command) {
  await handlePlayCommand(socket, context, command);
}

async function handleVideoCommand(socket, context, command) {
  if (!command.text) {
    await sendResult(socket, context, { text: usageLine('video', '<query | url>', 'video Faded'), command: 'video' });
    return;
  }
  await socket.sendMessage(context.chatId, { text: '⏳ *Searching…*' }, { quoted: context.raw });
  const query = command.text;
  try {
    let videoUrl = query;
    let title = query;

    if (!/^https?:\/\//.test(query)) {
      const results = await youtubeSearch(query, 1);
      videoUrl = results[0].url;
      title = results[0].title;
    }

    const result = await requestCobalt(config.cobaltApiUrl, videoUrl, { audio: false });
    if (!result?.url) throw new Error('No video stream was returned for that link.');
    await socket.sendMessage(context.chatId, {
      video: { url: result.url },
      mimetype: 'video/mp4',
      caption: '*VIDEO READY* ✅',
      fileName: result.filename || `${title}.mp4`
    }, { quoted: context.raw });
    await sendResult(socket, context, {
      text: `*VIDEO READY* ✅\n\n*Title:* ${title}\n*Format:* mp4`,
      command: 'video',
      ctx: { query }
    });
  } catch (error) {
    console.error('[video] Download failed:', error);
    await sendResult(socket, context, {
      text: `*DOWNLOAD FAILED* ❌\n${error.message}`,
      command: 'video',
      ctx: { query }
    });
  }
}

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
  const viewOnce = context.raw?.message?.viewOnceMessage?.message || context.raw?.message?.viewOnceMessageV2?.message;
  const quotedViewOnce = context.raw?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.viewOnceMessage?.message
    || context.raw?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.viewOnceMessageV2?.message;

  const source = viewOnce || quotedViewOnce;
  if (!source) {
    await sendResult(socket, context, {
      text: `*REPLY TO A VIEW-ONCE MEDIA* 👁\nThen send ${getCommandPrefix()}vv.`,
      command: 'vv'
    });
    return;
  }

  try {
    if (source.imageMessage) {
      const buffer = await downloadMediaBuffer(source.imageMessage, 'image');
      await socket.sendMessage(context.chatId, { image: buffer, caption: source.imageMessage.caption || '*VIEW-ONCE REVEALED* ✅' }, { quoted: context.raw });
    } else if (source.videoMessage) {
      const buffer = await downloadMediaBuffer(source.videoMessage, 'video');
      await socket.sendMessage(context.chatId, { video: buffer, caption: source.videoMessage.caption || '*VIEW-ONCE REVEALED* ✅' }, { quoted: context.raw });
    } else {
      await sendResult(socket, context, { text: '*NO VIEW-ONCE MEDIA FOUND* ❌', command: 'vv' });
      return;
    }
    await sendResult(socket, context, { text: '*VIEW-ONCE REVEALED* ✅', command: 'vv' });
  } catch (error) {
    await sendResult(socket, context, { text: `*COULD NOT REVEAL* ❌\n${error.message}`, command: 'vv' });
  }
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
    const docOrVideo = context.raw?.message?.documentMessage || context.raw?.message?.videoMessage;
    if (!docOrVideo) {
      await sendResult(socket, context, {
        text: `*REPLY TO MEDIA* 📤\nImage, video, sticker or document,\nthen send ${getCommandPrefix()}tourl.`,
        command: 'tourl'
      });
      return;
    }
    try {
      const type = docOrVideo.mimetype?.includes('video') ? 'video' : docOrVideo.mimetype?.includes('image') ? 'image' : 'document';
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

  const action = command.args[0]?.toLowerCase() || 'status';
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

async function handleWarnsCommand(socket, context) {
  const records = await warningStore.list(context.chatId);
  if (!records.length) {
    await sendResult(socket, context, { text: '🛡 *GROUP WARNINGS*\n\n➜ No active warnings.', command: 'warns' });
    return;
  }
  const lines = records.map((record, i) => `${i + 1}. @${record.userJid.split('@')[0]} — ${record.count} warning(s)`);
  await socket.sendMessage(context.chatId, {
    text: `🛡 *GROUP WARNINGS*\n\n${lines.join('\n')}`,
    mentions: records.map((r) => r.userJid)
  }, { quoted: context.raw });
}

// --- AUTOMATION ---

async function handleAutomationToggle(socket, context, command, group) {
  const settingKey = command.name;
  if (settingKey === 'autostatus') {
    if (!(await requireOwner(socket, context))) return;
    const action = command.args[0]?.toLowerCase() || 'status';
    if (!['on', 'off', 'status'].includes(action)) {
      await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}autostatus <on|off|status>` }, { quoted: context.raw });
      return;
    }
    if (action === 'status') {
      const current = await automationStore.getGlobal('autostatus');
      await sendResult(socket, context, {
        text: `Auto-status: *${current ? 'ON ✅' : 'OFF ❌'}*`,
        command: 'autostatus',
        buttons: settingButtons(getCommandPrefix(), 'autostatus', { showStatus: true })
      });
      return;
    }
    await automationStore.setGlobal('autostatus', action === 'on');
    await sendResult(socket, context, {
      text: `Auto-status: *${action === 'on' ? 'ON ✅' : 'OFF ❌'}*`,
      command: 'autostatus',
      buttons: settingButtons(getCommandPrefix(), 'autostatus', { enabled: action === 'on', showStatus: false })
    });
    return;
  }

  // Group-level automation
  const action = command.args[0]?.toLowerCase() || 'status';
  const labels = { autoreact: 'Auto-react', autowrite: 'Auto-write' };
  const label = labels[settingKey] || settingKey;

  if (!['on', 'off', 'status'].includes(action)) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}${command.name} <on|off|status>` }, { quoted: context.raw });
    return;
  }

  if (action === 'status') {
    const current = await automationStore.getChat(context.chatId, settingKey);
    await sendResult(socket, context, {
      text: `${label}: *${current ? 'ON ✅' : 'OFF ❌'}*`,
      command: command.name,
      buttons: settingButtons(getCommandPrefix(), command.name, { showStatus: true })
    });
    return;
  }

  if (settingKey !== 'autowrite' && !group) {
    await socket.sendMessage(context.chatId, { text: 'This automation is only available in groups.' }, { quoted: context.raw });
    return;
  }

  await automationStore.setChat(context.chatId, settingKey, action === 'on');
  await sendResult(socket, context, {
    text: `${label}: *${action === 'on' ? 'ON ✅' : 'OFF ❌'}*`,
    command: command.name,
    buttons: settingButtons(getCommandPrefix(), command.name, { enabled: action === 'on', showStatus: false })
  });
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
  if (!name || name.length > 25) {
    await socket.sendMessage(context.chatId, { text: 'Name must be 1-25 characters.' }, { quoted: context.raw });
    return;
  }
  try {
    await socket.updateProfileName(name);
    await sendResult(socket, context, { text: `*NAME UPDATED* ✅\n➜ ${name}`, command: 'setname' });
  } catch (error) {
    await sendResult(socket, context, { text: `*NAME UPDATE FAILED* ❌\n${error.message}`, command: 'setname' });
  }
}

// --- SUDO ---

async function handleSudoCommand(socket, context, command) {
  if (!command.args[0]) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}sudo <number>` }, { quoted: context.raw });
    return;
  }
  try {
    const result = await sudoStore.add(command.args[0]);
    await sendResult(socket, context, { text: `*SUDO GRANTED* ✅\n➜ ${result.id}`, command: 'sudo' });
  } catch (error) {
    await sendResult(socket, context, { text: `*SUDO FAILED* ❌\n${error.message}`, command: 'sudo' });
  }
}

async function handleDelsudoCommand(socket, context, command) {
  if (!command.args[0]) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}delsudo <number>` }, { quoted: context.raw });
    return;
  }
  try {
    const result = await sudoStore.remove(command.args[0]);
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

function cacheMessageForAntiDelete(socket, rawMessage) {
  const chatId = rawMessage?.key?.remoteJid;
  const messageId = rawMessage?.key?.id;
  if (!chatId || !messageId || chatId.endsWith('@g.us') === false) return;

  // Manage cache size
  if (deletedMessageCache.size > MAX_CACHED_MESSAGES) {
    const oldest = deletedMessageCache.keys().next().value;
    deletedMessageCache.delete(oldest);
  }

  const text = rawMessage?.message?.conversation || rawMessage?.message?.extendedTextMessage?.text || '';
  if (text) {
    deletedMessageCache.set(`${chatId}:${messageId}`, {
      text,
      sender: normalizeJid(socket, rawMessage.key?.participant || rawMessage.key?.remoteJid),
      timestamp: Date.now()
    });
  }
}

// ---------------------------------------------------------------------------
// MAIN MESSAGE HANDLER
// ---------------------------------------------------------------------------

async function handleMessage(socket, rawMessage) {
  const context = await getMessageContext(socket, rawMessage);
  if (!context.chatId || !context.sender) return;

  // Feeds the !broadcast target list. Errors are swallowed on purpose: the
  // registry is a convenience and must never break message handling.
  void chatStore.track(context.chatId).catch(() => {});

  // Cache incoming messages for anti-delete feature
  if (context.chatId.endsWith('@g.us')) {
    cacheMessageForAntiDelete(socket, rawMessage);
  }

  // Process protocol messages (deletes)
  if (rawMessage?.message?.protocolMessage?.type === 0) {
    await handleProtocolDelete(socket, rawMessage);
    return;
  }

  if (!context.text) return;

  const command = commandFromText(context.text);
  if (!command) {
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

    // Auto-write presence
    if (context.chatId.endsWith('@g.us')) {
      const autoWrite = await automationStore.getChat(context.chatId, 'autowrite');
      if (autoWrite && !context.fromMe) {
        await socket.sendPresenceUpdate('composing', context.chatId).catch(() => {});
      }
    }
    return;
  }

  const owner = isOwner(socket, context.sender);
  const sudo = owner || await sudoStore.has(senderNumber(context));
  if (!publicMode && !owner) return;

  console.info(`[command] ${command.name} from ${context.sender} in ${context.chatId}`);

  // Auto-write presence for commands
  if (context.chatId.endsWith('@g.us')) {
    const autoWrite = await automationStore.getChat(context.chatId, 'autowrite');
    if (autoWrite) {
      await socket.sendPresenceUpdate('composing', context.chatId).catch(() => {});
    }
  }

  // No command may ever fail silently. Anything that escapes a handler's own
  // try/catch is reported to the user with a short message, logged here, and
  // then re-thrown so the caller (index.js / the pairing manager) still sees
  // the failure — a transport outage must never be swallowed.
  try {
    await dispatchCommand(socket, context, command, rawMessage);
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
    // --- GENERAL ---
    case 'menu':
    case 'help':
      await handleMenuCommand(socket, context, command);
      break;

    case 'ping':
    case 'p': {
      const started = Date.now();
      await socket.sendMessage(context.chatId, { text: '⏳ *Measuring…*' }, { quoted: context.raw });
      await sendResult(socket, context, {
        text: `🏓 *PONG*\n➜ *${Date.now() - started}ms*`,
        command: 'ping'
      });
      break;
    }

    case 'request':
    case 'reportbug':
      await handleReport(socket, context, command.text);
      break;

    // --- MESSAGE MODE ---
    case 'public':
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
      await handlePlayCommand(socket, context, command);
      break;

    case 'ytmp3':
    case 'audio':
      await handleYtmp3Command(socket, context, command);
      break;

    case 'video':
    case 'ytmp4':
    case 'mp4':
      await handleVideoCommand(socket, context, command);
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

    case 'vv':
    case 'save':
    case 'retrieve':
    case 'viewonce':
      await handleVVCommand(socket, context);
      break;

    // --- CONVERTER ---
    case 'sticker':
    case 's':
    case 'stiker': {
      const imageMessage = getImageMessage(rawMessage);
      if (!imageMessage) {
        await sendResult(socket, context, {
          text: `*REPLY TO AN IMAGE* 🖼\nThen send ${getCommandPrefix()}sticker.`,
          command: 'sticker'
        });
        break;
      }
      try {
        const imageBuffer = await downloadMediaBuffer(imageMessage, 'image');
        const sticker = await createImageSticker(imageBuffer, { packname: config.stickerPackname, author: config.stickerAuthor });
        await socket.sendMessage(context.chatId, { sticker }, { quoted: context.raw });
        await sendResult(socket, context, { text: '*STICKER READY* 🎨', command: 'sticker' });
      } catch (error) {
        console.error('[sticker] Conversion failed:', error);
        await sendResult(socket, context, { text: `*STICKER FAILED* ❌\n${error.message}`, command: 'sticker' });
      }
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
    case 'upload':
    case 'url':
      await handleTourlCommand(socket, context);
      break;

    // --- AI ---
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
    case 'chatid':
      await sendResult(socket, context, {
        text: [
          '🔎 *JID INFO*',
          '',
          `*Chat:* ${context.chatId}`,
          `*Sender:* ${context.sender}`,
          `*Type:* ${context.isGroup ? 'group' : 'private'}`
        ].join('\n'),
        command: 'jid'
      });
      break;

    case 'idch':
    case 'cekidch': {
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
    case 'ht': {
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      const message = context.quotedText || command.text;
      if (!message) {
        await sendResult(socket, context, { text: usageLine('hidetag', '<message>', 'hidetag Meeting at 8'), command: 'hidetag' });
        break;
      }
      await socket.sendMessage(context.chatId, { text: message, mentions: group.participants.map((entry) => entry.id) }, { quoted: context.raw });
      break;
    }

    case 'tagall':
    case 'tag': {
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      if (!command.text) {
        await sendResult(socket, context, { text: usageLine('tagall', '<message>', 'tagall Attendance'), command: 'tagall' });
        break;
      }
      const mentions = group.participants.map((entry) => entry.id);
      const lines = group.participants.map((entry) => `• @${entry.id.split('@')[0]}`);
      await socket.sendMessage(context.chatId, { text: `${command.text}\n\n${lines.join('\n')}`, mentions }, { quoted: context.raw });
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
      await handleWarnsCommand(socket, context);
      break;
    }

    // --- ANTI / SECURITY ---
    case 'antilink':
    case 'antispam':
    case 'antimention':
    case 'antitag':
    case 'antidelete': {
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      await handleAntiToggleCommand(socket, context, command);
      break;
    }

    // --- AUTOMATION ---
    case 'autoreact':
    case 'autowrite': {
      const group = await requireGroupAdmin(socket, context);
      if (!group && command.name !== 'autowrite') break;
      await handleAutomationToggle(socket, context, command, group);
      break;
    }

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
    case 'status':
    case 'alive':
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
    case 'sudo': {
      if (!(await requireOwner(socket, context))) break;
      await handleSudoCommand(socket, context, command);
      break;
    }

    case 'delsudo': {
      if (!(await requireOwner(socket, context))) break;
      await handleDelsudoCommand(socket, context, command);
      break;
    }

    case 'sudolist':
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

    default:
      break;
  }
}

// Simple in-memory guess game state
const guessGames = new Map();

// Handle protocol message (delete events)
async function handleProtocolDelete(socket, rawMessage) {
  const chatId = rawMessage?.key?.remoteJid;
  if (!chatId?.endsWith('@g.us')) return;

  const settings = await groupSettings.get(chatId);
  if (!settings.antidelete) return;

  const deletedKey = rawMessage.message?.protocolMessage?.key;
  if (!deletedKey?.id) return;

  const cached = deletedMessageCache.get(`${chatId}:${deletedKey.id}`);
  if (!cached) return;
  deletedMessageCache.delete(`${chatId}:${deletedKey.id}`);

  // Skip if too old (>5 min)
  if (Date.now() - cached.timestamp > 5 * 60 * 1000) return;

  const senderNum = cached.sender?.split('@')[0] || 'unknown';
  await socket.sendMessage(chatId, {
    text: `*Anti-delete*\n\nFrom: @${senderNum}\n\n${cached.text}`,
    mentions: cached.sender ? [cached.sender] : []
  }).catch(() => {});
}

module.exports = handleMessage;
module.exports.commandFromText = commandFromText;
module.exports.helpText = helpText;
module.exports.initializeMode = initializeMode;
module.exports.modeStore = modeStore;
module.exports.getCommandPrefix = getCommandPrefix;
module.exports.setCommandPrefix = setCommandPrefix;
