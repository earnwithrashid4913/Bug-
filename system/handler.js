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
const { MAX_STICKER_INPUT_BYTES, convertStickerToImage, createImageSticker } = require('./lib/sticker');
const { sendButtons, sendList, cleanText } = require('./lib/ui');
const { helpText: buildHelpText, categoriesWithCommands, getCategory, resolveCommand } = require('./lib/menu');
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
  const configuredOwners = config.ownerNumbers.map((number) => `${number}@s.whatsapp.net`);
  const connectedAccount = normalizeJid(socket, socket.user?.id);
  return new Set(connectedAccount ? [...configuredOwners, connectedAccount] : configuredOwners);
}

function isOwner(socket, sender) {
  return ownerJids(socket).has(normalizeJid(socket, sender))
    || isAuthorizedAdmin(socket, sender, config.botNumber);
}

function senderNumber(context) {
  return (context.sender || '').split('@')[0];
}

async function isSudo(socket, context) {
  return await sudoStore.has(senderNumber(context)) || isOwner(socket, context.sender);
}

function permissionLevel(socket, context, entry) {
  if (!entry) return false;
  if (entry.permission === 'owner') return isOwner(socket, context.sender);
  if (entry.permission === 'sudo') return isOwner(socket, context.sender) || isSudoSync(socket, context);
  if (entry.permission === 'admin') return true; // checked per-command later
  return true;
}

function isSudoSync(socket, context) {
  // Quick inline check for sudo-eligible senders cached in a small map for the session
  // Used only for permission gating (non-async).
  return false; // Will be improved; async check done in main dispatch.
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

async function sendOwnerCard(socket, chatId, quoted) {
  const text = [
    `*${config.botName}*`,
    '',
    `Owner: ${config.ownerName}`,
    `Developer: ${config.developerName}`,
    `WhatsApp: ${config.ownerLink}`,
    `Channel: ${config.whatsappChannel}`
  ].join('\n');
  await socket.sendMessage(chatId, { text }, { quoted });
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
  await socket.sendMessage(context.chatId, { text: 'Only the bot owner can use this command.' }, { quoted: context.raw });
  return false;
}

async function requireSudoOrOwner(socket, context) {
  if (isOwner(socket, context.sender) || await sudoStore.has(senderNumber(context))) return true;
  await socket.sendMessage(context.chatId, { text: 'This command requires owner or sudo access.' }, { quoted: context.raw });
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

  await Promise.all(
    config.ownerNumbers.map((number) =>
      socket.sendMessage(`${number}@s.whatsapp.net`, { text: ownerMessage, mentions: context.sender ? [context.sender] : [] })
    )
  );
  await socket.sendMessage(context.chatId, { text: 'Your request has been sent to the owner.' }, { quoted: context.raw });
}

async function handleGreetingSettings(socket, context, command, group) {
  const action = command.args[0]?.toLowerCase() || 'status';
  const settingKey = command.name === 'goodbye' ? 'goodbyeEnabled' : 'welcomeEnabled';
  const label = command.name === 'goodbye' ? 'Goodbye messages' : 'Welcome messages';

  if (command.name === 'greet') {
    const settings = await groupSettings.get(context.chatId);
    const text = [
      '*Group greeting settings*',
      `Welcome: ${settings.welcomeEnabled ? 'ON' : 'OFF'}`,
      `Goodbye: ${settings.goodbyeEnabled ? 'ON' : 'OFF'}`,
      '',
      `Use ${getCommandPrefix()}welcome <on|off|status> or ${getCommandPrefix()}goodbye <on|off|status>.`
    ].join('\n');
    await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
    return;
  }

  if (!['on', 'off', 'status'].includes(action)) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}${command.name} <on|off|status>` }, { quoted: context.raw });
    return;
  }
  if (action === 'status') {
    const settings = await groupSettings.get(context.chatId);
    await socket.sendMessage(context.chatId, { text: `${label}: ${settings[settingKey] ? 'ON' : 'OFF'}.` }, { quoted: context.raw });
    return;
  }
  const settings = await groupSettings.update(context.chatId, { [settingKey]: action === 'on' });
  await socket.sendMessage(context.chatId, { text: `${label} are now ${settings[settingKey] ? 'ON' : 'OFF'}.` }, { quoted: context.raw });
}

async function handleGroupManagement(socket, context, command, group) {
  if (command.name === 'group') {
    await socket.sendMessage(
      context.chatId,
      {
        text: [
          '*Safe group management*',
          `${getCommandPrefix()}gname <name>`,
          `${getCommandPrefix()}gdesc <description>`,
          `${getCommandPrefix()}add <international number>`,
          `${getCommandPrefix()}kick @user or reply`,
          `${getCommandPrefix()}promote @user or reply`,
          `${getCommandPrefix()}demote @user or reply`,
          `${getCommandPrefix()}lock / ${getCommandPrefix()}unlock`,
          `${getCommandPrefix()}grouplink`
        ].join('\n')
      },
      { quoted: context.raw }
    );
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
        await socket.sendMessage(context.chatId, { text: `Group invite link:\nhttps://chat.whatsapp.com/${code}` }, { quoted: context.raw });
        return;
      }
      default:
        return;
    }
    await socket.sendMessage(context.chatId, { text: `Group action ${command.name} completed.` }, { quoted: context.raw });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Group action failed: ${error.message}` }, { quoted: context.raw });
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
    await socket.sendMessage(context.chatId, { text: answer }, { quoted: context.raw });
  } catch (error) {
    console.error('[ai] Request failed:', error);
    await socket.sendMessage(context.chatId, { text: `AI unavailable: ${error.message}` }, { quoted: context.raw });
  }
}

async function handleGetProfilePhoto(socket, context, command) {
  let target = getTargetJid(context.raw) || (context.isGroup ? context.chatId : context.sender);
  if (command.args[0]) {
    const number = normalizePhoneNumber(command.args[0], 'Profile picture number');
    target = `${number}@s.whatsapp.net`;
  }
  try {
    const profilePictureUrl = await socket.profilePictureUrl(target, 'image');
    if (!profilePictureUrl) throw new Error('No profile picture is available.');
    await socket.sendMessage(context.chatId, { image: { url: profilePictureUrl }, caption: `Profile picture: ${target.split('@')[0]}` }, { quoted: context.raw });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Could not get profile picture: ${error.message}` }, { quoted: context.raw });
  }
}

async function handleSetBotProfilePhoto(socket, context) {
  if (!(await requireOwner(socket, context))) return;
  const imageMessage = getImageMessage(context.raw);
  if (!imageMessage) {
    await socket.sendMessage(context.chatId, { text: `Reply to an image with ${getCommandPrefix()}setpp to update the bot profile picture.` }, { quoted: context.raw });
    return;
  }
  try {
    const imageBuffer = await downloadMediaBuffer(imageMessage, 'image');
    await socket.updateProfilePicture(socket.user.id, imageBuffer);
    await socket.sendMessage(context.chatId, { text: 'Bot profile picture updated.' }, { quoted: context.raw });
  } catch (error) {
    console.error('[setpp] Profile picture update failed:', error);
    await socket.sendMessage(context.chatId, { text: `Could not update profile picture: ${error.message}` }, { quoted: context.raw });
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
          rows: categories.map((cat, i) => ({
            header: cat.icon,
            title: cat.label,
            description: `${cat.commands.length} commands`,
            id: `!menu ${cat.id}`
          }))
        }],
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

  // Category view
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

  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

// --- DOWNLOADER ---

async function handlePlayCommand(socket, context, command) {
  if (!command.text) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}play <song name or URL>` }, { quoted: context.raw });
    return;
  }
  await socket.sendMessage(context.chatId, { text: 'Searching…' }, { quoted: context.raw });
  try {
    const query = command.text;
    let videoUrl = query;
    let title = query;

    if (!/^https?:\/\//.test(query)) {
      const results = await youtubeSearch(query, 1);
      videoUrl = results[0].url;
      title = results[0].title;
    }

    const result = await requestCobalt(config.cobaltApiUrl, videoUrl, { audio: true });
    await socket.sendMessage(context.chatId, {
      audio: { url: result.url },
      mimetype: 'audio/mpeg',
      fileName: result.filename || `${title}.mp3`,
      ptt: false
    }, { quoted: context.raw });
  } catch (error) {
    console.error('[play] Download failed:', error);
    await socket.sendMessage(context.chatId, { text: `Download failed: ${error.message}` }, { quoted: context.raw });
  }
}

async function handleYtmp3Command(socket, context, command) {
  await handlePlayCommand(socket, context, command);
}

async function handleVideoCommand(socket, context, command) {
  if (!command.text) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}video <query or URL>` }, { quoted: context.raw });
    return;
  }
  await socket.sendMessage(context.chatId, { text: 'Searching…' }, { quoted: context.raw });
  try {
    const query = command.text;
    let videoUrl = query;
    let title = query;

    if (!/^https?:\/\//.test(query)) {
      const results = await youtubeSearch(query, 1);
      videoUrl = results[0].url;
      title = results[0].title;
    }

    const result = await requestCobalt(config.cobaltApiUrl, videoUrl, { audio: false });
    await socket.sendMessage(context.chatId, {
      video: { url: result.url },
      mimetype: 'video/mp4',
      caption: `*${title}*`,
      fileName: result.filename || `${title}.mp4`
    }, { quoted: context.raw });
  } catch (error) {
    console.error('[video] Download failed:', error);
    await socket.sendMessage(context.chatId, { text: `Download failed: ${error.message}` }, { quoted: context.raw });
  }
}

async function handleSpotifyCommand(socket, context, command) {
  if (!command.text) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}spotify <song name>` }, { quoted: context.raw });
    return;
  }
  await socket.sendMessage(context.chatId, { text: 'Searching Spotify…' }, { quoted: context.raw });
  try {
    const results = await spotifySearch(command.text, 5);
    if (!results.length) throw new Error('No results found.');

    const lines = results.map((track, i) => {
      const duration = track.duration ? `${Math.floor(track.duration / 60_000)}:${String(Math.floor((track.duration % 60_000) / 1000)).padStart(2, '0')}` : '';
      return `${i + 1}. *${track.title}*\nby ${track.artist}${duration ? ` · ${duration}` : ''}\n${track.url}`;
    });

    await socket.sendMessage(context.chatId, {
      text: `*Spotify Results for:* ${command.text}\n\n${lines.join('\n\n')}`,
      contextInfo: {
        externalAdReply: {
          title: results[0].title,
          body: results[0].artist,
          mediaType: 2,
          mediaUrl: results[0].url,
          sourceUrl: results[0].url,
          thumbnailUrl: results[0].album?.images?.[0]?.url
        }
      }
    }, { quoted: context.raw });
  } catch (error) {
    console.error('[spotify] Search failed:', error);
    await socket.sendMessage(context.chatId, { text: `Spotify search failed: ${error.message}` }, { quoted: context.raw });
  }
}

async function handleMediaCommand(socket, context, command) {
  if (!command.text) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}media <URL>` }, { quoted: context.raw });
    return;
  }
  await socket.sendMessage(context.chatId, { text: 'Downloading…' }, { quoted: context.raw });
  try {
    const result = await requestCobalt(config.cobaltApiUrl, command.text);
    const { buffer, type } = await downloadRemoteFile(result.url);
    const isVideo = type.includes('video');
    const isAudio = type.includes('audio');
    const isImage = type.includes('image');

    if (isImage) {
      await socket.sendMessage(context.chatId, { image: buffer, caption: 'Media downloaded.' }, { quoted: context.raw });
    } else if (isVideo) {
      await socket.sendMessage(context.chatId, { video: buffer, mimetype: type, caption: 'Media downloaded.' }, { quoted: context.raw });
    } else if (isAudio) {
      await socket.sendMessage(context.chatId, { audio: buffer, mimetype: type, ptt: false }, { quoted: context.raw });
    } else {
      await socket.sendMessage(context.chatId, { document: buffer, mimetype: type, fileName: result.filename || 'download.bin' }, { quoted: context.raw });
    }
  } catch (error) {
    console.error('[media] Download failed:', error);
    await socket.sendMessage(context.chatId, { text: `Download failed: ${error.message}` }, { quoted: context.raw });
  }
}

// --- STICKER (VV) ---

async function handleVVCommand(socket, context) {
  const viewOnce = context.raw?.message?.viewOnceMessage?.message || context.raw?.message?.viewOnceMessageV2?.message;
  const quotedViewOnce = context.raw?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.viewOnceMessage?.message
    || context.raw?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.viewOnceMessageV2?.message;

  const source = viewOnce || quotedViewOnce;
  if (!source) {
    await socket.sendMessage(context.chatId, { text: `Reply to a view-once photo or video with ${getCommandPrefix()}vv to reveal it.` }, { quoted: context.raw });
    return;
  }

  try {
    if (source.imageMessage) {
      const buffer = await downloadMediaBuffer(source.imageMessage, 'image');
      await socket.sendMessage(context.chatId, { image: buffer, caption: source.imageMessage.caption || 'View-once revealed.' }, { quoted: context.raw });
    } else if (source.videoMessage) {
      const buffer = await downloadMediaBuffer(source.videoMessage, 'video');
      await socket.sendMessage(context.chatId, { video: buffer, caption: source.videoMessage.caption || 'View-once revealed.' }, { quoted: context.raw });
    } else {
      await socket.sendMessage(context.chatId, { text: 'No supported view-once media found.' }, { quoted: context.raw });
    }
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Could not reveal: ${error.message}` }, { quoted: context.raw });
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
    await socket.sendMessage(context.chatId, { audio: buffer, mimetype, ptt: false }, { quoted: context.raw });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `TTS failed: ${error.message}` }, { quoted: context.raw });
  }
}

async function handleQRCommand(socket, context, command) {
  if (!command.text) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}qr <text or URL>` }, { quoted: context.raw });
    return;
  }
  try {
    const buffer = await QRCode.toBuffer(command.text, { type: 'png', margin: 2, width: 512 });
    await socket.sendMessage(context.chatId, { image: buffer, caption: 'QR code generated.' }, { quoted: context.raw });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `QR generation failed: ${error.message}` }, { quoted: context.raw });
  }
}

// --- UPLOAD ---

async function handleTourlCommand(socket, context) {
  const media = getImageMessage(context.raw) || getStickerMessage(context.raw);
  if (!media) {
    const docOrVideo = context.raw?.message?.documentMessage || context.raw?.message?.videoMessage;
    if (!docOrVideo) {
      await socket.sendMessage(context.chatId, { text: `Reply to an image, video, sticker, or document with ${getCommandPrefix()}tourl.` }, { quoted: context.raw });
      return;
    }
    try {
      const type = docOrVideo.mimetype?.includes('video') ? 'video' : docOrVideo.mimetype?.includes('image') ? 'image' : 'document';
      const buffer = await downloadMediaBuffer(docOrVideo, type);
      const ext = docOrVideo.mimetype?.split('/')[1] || 'bin';
      const url = await uploadToCatbox(config.uploadApiUrl, buffer, { filename: `upload.${ext}`, mimetype: docOrVideo.mimetype });
      await socket.sendMessage(context.chatId, { text: `*Upload complete*\n\n${url}\n\nSize: ${(buffer.length / 1024).toFixed(1)} KB` }, { quoted: context.raw });
    } catch (error) {
      await socket.sendMessage(context.chatId, { text: `Upload failed: ${error.message}` }, { quoted: context.raw });
    }
    return;
  }

  try {
    const mediaType = media.mimetype?.includes('video') ? 'video' : media.mimetype?.includes('image') ? 'image' : 'sticker';
    const buffer = await downloadMediaBuffer(media, mediaType);
    const ext = media.mimetype?.split('/')[1] || 'jpg';
    const url = await uploadToCatbox(config.uploadApiUrl, buffer, { filename: `upload.${ext}`, mimetype: media.mimetype });
    await socket.sendMessage(context.chatId, { text: `*Upload complete*\n\n${url}\n\nSize: ${(buffer.length / 1024).toFixed(1)} KB` }, { quoted: context.raw });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Upload failed: ${error.message}` }, { quoted: context.raw });
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
    await socket.sendMessage(context.chatId, { text: `*Calc*\n\n${command.text} = ${result}` }, { quoted: context.raw });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Calculation error: ${error.message}` }, { quoted: context.raw });
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
    await socket.sendMessage(context.chatId, { image: buffer, mimetype, caption: `Screenshot of ${url}` }, { quoted: context.raw });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Screenshot failed: ${error.message}` }, { quoted: context.raw });
  }
}

async function handleShortCommand(socket, context, command) {
  if (!command.text) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}short <URL>` }, { quoted: context.raw });
    return;
  }
  try {
    const short = await shortenUrl(command.text);
    await socket.sendMessage(context.chatId, { text: `*Shortened URL*\n\n${short}` }, { quoted: context.raw });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Shortening failed: ${error.message}` }, { quoted: context.raw });
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
    await socket.sendMessage(context.chatId, { text: `*Translation* (${source} → ${target})\n\n${translated}` }, { quoted: context.raw });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Translation failed: ${error.message}` }, { quoted: context.raw });
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
    await socket.sendMessage(context.chatId, { text: `${label}: ${settings[settingKey] ? 'ON' : 'OFF'}.` }, { quoted: context.raw });
    return;
  }

  const settings = await groupSettings.update(context.chatId, { [settingKey]: action === 'on' });
  await socket.sendMessage(context.chatId, { text: `${label} is now ${settings[settingKey] ? 'ON' : 'OFF'}.` }, { quoted: context.raw });
}

async function handleWarnCommand(socket, context, command, group) {
  const target = getTargetJid(context.raw);
  if (!target) {
    await socket.sendMessage(context.chatId, { text: `Mention or reply to a user with ${getCommandPrefix()}warn <reason>` }, { quoted: context.raw });
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
    await socket.sendMessage(context.chatId, { text: `Mention or reply to a user with ${getCommandPrefix()}unwarn.` }, { quoted: context.raw });
    return;
  }
  await warningStore.remove(context.chatId, target);
  const num = target.split('@')[0];
  await socket.sendMessage(context.chatId, { text: `Warnings cleared for @${num}.` }, { quoted: context.raw, mentions: [target] });
}

async function handleWarnsCommand(socket, context) {
  const records = await warningStore.list(context.chatId);
  if (!records.length) {
    await socket.sendMessage(context.chatId, { text: 'No active warnings in this group.' }, { quoted: context.raw });
    return;
  }
  const lines = records.map((record, i) => `${i + 1}. @${record.userJid.split('@')[0]} — ${record.count} warning(s)`);
  await socket.sendMessage(context.chatId, { text: `*Group warnings*\n\n${lines.join('\n')}` }, { quoted: context.raw, mentions: records.map((r) => r.userJid) });
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
      await socket.sendMessage(context.chatId, { text: `Auto-status: ${current ? 'ON' : 'OFF'}.` }, { quoted: context.raw });
      return;
    }
    await automationStore.setGlobal('autostatus', action === 'on');
    await socket.sendMessage(context.chatId, { text: `Auto-status is now ${action === 'on' ? 'ON' : 'OFF'}.` }, { quoted: context.raw });
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
    await socket.sendMessage(context.chatId, { text: `${label}: ${current ? 'ON' : 'OFF'}.` }, { quoted: context.raw });
    return;
  }

  if (settingKey !== 'autowrite' && !group) {
    await socket.sendMessage(context.chatId, { text: 'This automation is only available in groups.' }, { quoted: context.raw });
    return;
  }

  await automationStore.setChat(context.chatId, settingKey, action === 'on');
  await socket.sendMessage(context.chatId, { text: `${label} is now ${action === 'on' ? 'ON' : 'OFF'}.` }, { quoted: context.raw });
}

// --- GAMES ---

function handleDiceCommand(socket, context) {
  const result = Math.floor(Math.random() * 6) + 1;
  const emoji = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][result - 1];
  socket.sendMessage(context.chatId, { text: `${emoji}  You rolled a *${result}*` }, { quoted: context.raw });
}

function handleCoinCommand(socket, context) {
  const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
  socket.sendMessage(context.chatId, { text: `🪙  *${result}*` }, { quoted: context.raw });
}

async function handleRPSCommand(socket, context, command) {
  const choices = ['rock', 'paper', 'scissors'];
  const pick = choices.indexOf((command.args[0] || '').toLowerCase());
  if (pick < 0) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}rps <rock|paper|scissors>` }, { quoted: context.raw });
    return;
  }
  const bot = Math.floor(Math.random() * 3);
  const icons = { rock: '🪨', paper: '📄', scissors: '✂️' };
  const diff = (pick - bot + 3) % 3;
  const result = diff === 0 ? "It's a draw!" : diff === 1 ? 'You win!' : 'I win!';
  await socket.sendMessage(context.chatId, { text: `${icons[choices[pick]]} vs ${icons[choices[bot]]}\n\n*${result}*` }, { quoted: context.raw });
}

// --- RPG / ECONOMY ---

async function handleBalanceCommand(socket, context) {
  const user = await economyStore.get(context.sender);
  await socket.sendMessage(context.chatId, {
    text: `*${config.botName} Balance*\n\nWallet: ${user.balance.toLocaleString()} coins\nBank: ${user.bank.toLocaleString()} coins\nXP: ${user.xp}`
  }, { quoted: context.raw });
}

async function handleDailyCommand(socket, context) {
  const result = await economyStore.daily(context.sender);
  if (!result.ok) {
    const minutes = Math.ceil(result.waitMs / 60_000);
    await socket.sendMessage(context.chatId, { text: `You already claimed your daily reward. Wait ${minutes} minutes.` }, { quoted: context.raw });
    return;
  }
  await socket.sendMessage(context.chatId, { text: `*Daily reward claimed!*\n\n+${result.amount} coins\nBalance: ${result.user.balance.toLocaleString()}` }, { quoted: context.raw });
}

async function handleWorkCommand(socket, context) {
  const result = await economyStore.work(context.sender);
  if (!result.ok) {
    const minutes = Math.ceil(result.waitMs / 60_000);
    await socket.sendMessage(context.chatId, { text: `You need to rest. Wait ${minutes} minutes before working again.` }, { quoted: context.raw });
    return;
  }
  await socket.sendMessage(context.chatId, { text: `*Work complete!*\n\n+${result.amount} coins\nBalance: ${result.user.balance.toLocaleString()}` }, { quoted: context.raw });
}

async function handleGiveCommand(socket, context, command) {
  const target = getTargetJid(context.raw);
  const amount = Number(command.args[command.args.length - 1]);
  if (!target || !Number.isInteger(amount) || amount <= 0) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}give @user <amount>` }, { quoted: context.raw });
    return;
  }
  try {
    const result = await economyStore.transfer(context.sender, target, amount);
    await socket.sendMessage(context.chatId, { text: `Transferred ${result.amount} coins to @${target.split('@')[0]}.` }, { quoted: context.raw, mentions: [target] });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: error.message }, { quoted: context.raw });
  }
}

// --- OWNER ---

async function handleBroadcastCommand(socket, context, command) {
  if (!command.text) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}broadcast <message>` }, { quoted: context.raw });
    return;
  }
  await socket.sendMessage(context.chatId, { text: `*Broadcast sent.*\n\n${command.text}` }, { quoted: context.raw });
}

async function handleSetPrefixCommand(socket, context, command) {
  const prefix = command.args[0];
  if (!prefix || prefix.length > 4 || /\s/.test(prefix)) {
    await socket.sendMessage(context.chatId, { text: 'Prefix must be 1-4 non-whitespace characters.' }, { quoted: context.raw });
    return;
  }
  await setCommandPrefix(prefix);
  await socket.sendMessage(context.chatId, { text: `Command prefix is now: ${prefix}` }, { quoted: context.raw });
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
    await socket.sendMessage(context.chatId, { text: `Profile name updated to: ${name}` }, { quoted: context.raw });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Could not update name: ${error.message}` }, { quoted: context.raw });
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
    await socket.sendMessage(context.chatId, { text: `Sudo access granted to ${result.id}.` }, { quoted: context.raw });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Could not add sudo: ${error.message}` }, { quoted: context.raw });
  }
}

async function handleDelsudoCommand(socket, context, command) {
  if (!command.args[0]) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}delsudo <number>` }, { quoted: context.raw });
    return;
  }
  try {
    const result = await sudoStore.remove(command.args[0]);
    await socket.sendMessage(context.chatId, { text: result.removed ? `Sudo access removed from ${result.id}.` : 'That number is not a sudo user.' }, { quoted: context.raw });
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Could not remove sudo: ${error.message}` }, { quoted: context.raw });
  }
}

async function handleSudolistCommand(socket, context) {
  const users = await sudoStore.list();
  const text = users.length
    ? `*Sudo users*\n${users.map((u, i) => `${i + 1}. ${u}`).join('\n')}`
    : 'There are no sudo users.';
  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

// --- MODE ---

async function handleModeCommand(socket, context, command) {
  const arg = command.args[0]?.toLowerCase();
  if (arg === 'public' || arg === 'self') {
    if (!(await requireOwner(socket, context))) return;
    publicMode = arg === 'public';
    socket.public = publicMode;
    await modeStore.set(arg);
    await socket.sendMessage(context.chatId, { text: `Bot mode is now ${arg}.` }, { quoted: context.raw });
    return;
  }
  await socket.sendMessage(context.chatId, { text: `Current mode: ${publicMode ? 'public' : 'self'}\n\nUse ${getCommandPrefix()}mode <public|self> to change.` }, { quoted: context.raw });
}

// --- PREMIUM ---

async function handlePremiumCommand(socket, context, command) {
  const number = command.args[0] || senderNumber(context);
  try {
    const normalized = normalizePhoneNumber(number, 'User number');
    const store = await premiumStore.list();
    const record = store.find((r) => r.id === normalized);
    if (record) {
      await socket.sendMessage(context.chatId, { text: `*Premium status*\n\n${record.id} — expires ${formatDate(record.expiresAt)} UTC` }, { quoted: context.raw });
    } else {
      await socket.sendMessage(context.chatId, { text: `${normalized} does not have premium access.` }, { quoted: context.raw });
    }
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Could not check premium: ${error.message}` }, { quoted: context.raw });
  }
}

// --- SESSIONS ---

async function handleSessionsCommand(socket, context) {
  await socket.sendMessage(context.chatId, {
    text: [
      `*${config.botName} Session*`,
      '',
      `Bot: ${socket.user?.id?.split(':')[0] || 'unknown'}`,
      `Uptime: ${Math.floor(process.uptime())} seconds`,
      `Auth directory: ${config.authDir}`,
      `Data directory: ${config.dataDir}`
    ].join('\n')
  }, { quoted: context.raw });
}

async function handleStopSessionCommand(socket, context, command) {
  if (!command.args[0]) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}stopsession <number>` }, { quoted: context.raw });
    return;
  }
  await socket.sendMessage(context.chatId, { text: 'Use the Telegram controller `/stop <number>` to remove an unpaired session safely.' }, { quoted: context.raw });
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

  switch (command.name) {
    // --- GENERAL ---
    case 'menu':
    case 'help':
      await handleMenuCommand(socket, context, command);
      break;

    case 'ping':
    case 'p': {
      const started = Date.now();
      const sent = await socket.sendMessage(context.chatId, { text: 'Checking latency…' }, { quoted: context.raw });
      await socket.sendMessage(context.chatId, { text: `Pong: ${Date.now() - started}ms`, edit: sent.key });
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
      await socket.sendMessage(context.chatId, { text: `Bot mode is now ${publicMode ? 'public' : 'self'}.` }, { quoted: context.raw });
      break;
    }

    case 'mode':
    case 'botmode':
      await handleModeCommand(socket, context, command);
      break;

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
        await socket.sendMessage(context.chatId, { text: `Reply to an image with ${getCommandPrefix()}sticker to create a sticker.` }, { quoted: context.raw });
        break;
      }
      try {
        const imageBuffer = await downloadMediaBuffer(imageMessage, 'image');
        const sticker = await createImageSticker(imageBuffer, { packname: config.stickerPackname, author: config.stickerAuthor });
        await socket.sendMessage(context.chatId, { sticker }, { quoted: context.raw });
      } catch (error) {
        console.error('[sticker] Conversion failed:', error);
        await socket.sendMessage(context.chatId, { text: `Could not create a sticker: ${error.message}` }, { quoted: context.raw });
      }
      break;
    }

    case 'toimg':
    case 'sticker2img':
    case 'img': {
      const stickerMessage = getStickerMessage(rawMessage);
      if (!stickerMessage) {
        await socket.sendMessage(context.chatId, { text: `Reply to a sticker with ${getCommandPrefix()}toimg to convert it to an image.` }, { quoted: context.raw });
        break;
      }
      try {
        const stickerBuffer = await downloadMediaBuffer(stickerMessage, 'sticker');
        const image = await convertStickerToImage(stickerBuffer);
        await socket.sendMessage(context.chatId, { image, caption: 'Sticker converted to image.' }, { quoted: context.raw });
      } catch (error) {
        console.error('[toimg] Conversion failed:', error);
        await socket.sendMessage(context.chatId, { text: `Could not convert this sticker: ${error.message}` }, { quoted: context.raw });
      }
      break;
    }

    case 'convert':
    case 'converter':
      await socket.sendMessage(context.chatId, {
        text: [
          '*Converter commands*',
          '',
          `${getCommandPrefix()}sticker — Create a sticker from an image`,
          `${getCommandPrefix()}toimg — Convert a sticker to an image`,
          `${getCommandPrefix()}tts <text> — Text to speech`,
          `${getCommandPrefix()}qr <text> — Generate a QR code`
        ].join('\n')
      }, { quoted: context.raw });
      break;

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
      await socket.sendMessage(context.chatId, {
        text: [`Chat JID: ${context.chatId}`, `Sender JID: ${context.sender}`, `Type: ${context.isGroup ? 'group' : 'private'}`].join('\n')
      }, { quoted: context.raw });
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
        const details = [`ID: ${channel.id}`, `Name: ${channel.name}`, `Followers: ${channel.subscribers}`, `Verified: ${channel.verification === 'VERIFIED' ? 'yes' : 'no'}`].join('\n');
        await socket.sendMessage(context.chatId, { text: details }, { quoted: context.raw });
      } catch (error) {
        await socket.sendMessage(context.chatId, { text: `Could not fetch that channel: ${error.message}` }, { quoted: context.raw });
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
    case 'utils':
      await socket.sendMessage(context.chatId, {
        text: [
          '*Tools commands*',
          '',
          `${getCommandPrefix()}jid — Show JIDs`,
          `${getCommandPrefix()}idch <url> — Channel info`,
          `${getCommandPrefix()}calc <expr> — Calculator`,
          `${getCommandPrefix()}ss <url> — Screenshot`,
          `${getCommandPrefix()}short <url> — Shorten URL`,
          `${getCommandPrefix()}translate [lang] <text> — Translate`
        ].join('\n')
      }, { quoted: context.raw });
      break;

    // --- GROUP ---
    case 'hidetag':
    case 'ht': {
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      const message = context.quotedText || command.text;
      if (!message) {
        await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}hidetag <message>` }, { quoted: context.raw });
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
        await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}tagall <message>` }, { quoted: context.raw });
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
      handleDiceCommand(socket, context);
      break;

    case 'coin':
    case 'flip':
      handleCoinCommand(socket, context);
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
    case 'economy':
      await socket.sendMessage(context.chatId, {
        text: [
          '*RPG & Economy commands*',
          '',
          `${getCommandPrefix()}balance — Check your wallet/bank`,
          `${getCommandPrefix()}daily — Claim daily reward`,
          `${getCommandPrefix()}work — Earn coins`,
          `${getCommandPrefix()}give @user <amount> — Transfer coins`
        ].join('\n')
      }, { quoted: context.raw });
      break;

    // --- OWNER ---
    case 'status':
    case 'alive':
    case 'runtime':
      await socket.sendMessage(context.chatId, {
        text: [
          `*${config.botName} status*`,
          `Mode: ${publicMode ? 'public' : 'self'}`,
          `Uptime: ${Math.floor(process.uptime())} seconds`,
          `Premium database: ready`
        ].join('\n')
      }, { quoted: context.raw });
      break;

    case 'owner':
    case 'creator':
      await sendOwnerCard(socket, context.chatId, context.raw);
      break;

    case 'pairing':
    case 'tgpair':
    case 'telegram':
    case 'tg':
      await socket.sendMessage(context.chatId, {
        text: config.telegramBotLink
          ? `*Telegram pairing*\nOpen the authorized controller: ${config.telegramBotLink}\nThen use /pair <number>.`
          : 'Telegram pairing is not configured. Ask the bot owner to set TELEGRAM_BOT_LINK and TELEGRAM_BOT_TOKEN.'
      }, { quoted: context.raw });
      break;

    case 'theme':
    case 'settheme': {
      if (!(await requireOwner(socket, context))) break;
      const themeId = command.args[0]?.toLowerCase();
      if (!themeId) {
        await socket.sendMessage(context.chatId, { text: `Usage: ${getCommandPrefix()}theme <makima|nami|nezuko|shinobu|gojo|sukuna|asta>` }, { quoted: context.raw });
        break;
      }
      try {
        const { setActiveTheme } = require('../index');
        const theme = setActiveTheme(themeId);
        await socket.sendMessage(context.chatId, { text: `*Theme changed*\n${theme.icon} ${theme.name} is now active on the pairing dashboard.` }, { quoted: context.raw });
      } catch (error) {
        await socket.sendMessage(context.chatId, { text: `Could not change theme: ${error.message}` }, { quoted: context.raw });
      }
      break;
    }

    case 'restart':
    case 'rst': {
      if (!(await requireOwner(socket, context))) break;
      const mode = requestRestart();
      await socket.sendMessage(context.chatId, {
        text: mode === 'supervisor'
          ? 'Restarting now. The built-in supervisor will bring the bot back in a few seconds.'
          : 'Restart requested. Ensure your host is configured to restart this process after it exits.'
      }, { quoted: context.raw });
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
        await socket.sendMessage(context.chatId, { text: `Premium access saved for ${record.id} until ${formatDate(record.expiresAt)} UTC.` }, { quoted: context.raw });
      } catch (error) {
        await socket.sendMessage(context.chatId, { text: `Could not add premium access: ${error.message}` }, { quoted: context.raw });
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
        await socket.sendMessage(context.chatId, { text: removed ? `Premium access removed for ${phoneNumber}.` : 'That number has no active premium record.' }, { quoted: context.raw });
      } catch (error) {
        await socket.sendMessage(context.chatId, { text: `Could not remove premium access: ${error.message}` }, { quoted: context.raw });
      }
      break;
    }

    case 'listprem': {
      if (!(await requireOwner(socket, context))) break;
      try {
        const records = await premiumStore.list();
        const text = records.length
          ? `*Active premium users*\n${records.map((record, index) => `${index + 1}. ${record.id} — ${formatDate(record.expiresAt)} UTC`).join('\n')}`
          : 'There are no active premium users.';
        await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
      } catch (error) {
        await socket.sendMessage(context.chatId, { text: `Could not read premium access: ${error.message}` }, { quoted: context.raw });
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
        await socket.sendMessage(context.chatId, { text: 'I picked a number between 1 and 100. Reply with your guess!' }, { quoted: context.raw });
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
          await socket.sendMessage(context.chatId, { text: `🎉 Correct! The number was ${game.number}. It took you ${game.attempts} attempts.` }, { quoted: context.raw });
        } else if (guess < game.number) {
          await socket.sendMessage(context.chatId, { text: '⬆️ Higher!' }, { quoted: context.raw });
        } else {
          await socket.sendMessage(context.chatId, { text: '⬇️ Lower!' }, { quoted: context.raw });
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
