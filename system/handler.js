'use strict';

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
const { PremiumStore } = require('./lib/premium');
const { MAX_STICKER_INPUT_BYTES, convertStickerToImage, createImageSticker } = require('./lib/sticker');

const premiumStore = new PremiumStore(config.premiumDbPath);
const reportCooldowns = new Map();
let publicMode = config.publicMode;

function commandFromText(text) {
  if (!text.startsWith(config.commandPrefix)) return undefined;

  const [name = '', ...args] = text.slice(config.commandPrefix.length).trim().split(/\s+/);
  if (!name) return undefined;

  return {
    name: name.toLowerCase(),
    args,
    text: args.join(' ')
  };
}

function ownerJids(socket) {
  const configuredOwners = config.ownerNumbers.map((number) => `${number}@s.whatsapp.net`);
  const connectedAccount = normalizeJid(socket, socket.user?.id);
  return new Set(connectedAccount ? [...configuredOwners, connectedAccount] : configuredOwners);
}

function isOwner(socket, sender) {
  return ownerJids(socket).has(normalizeJid(socket, sender));
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

function helpText() {
  const p = config.commandPrefix;
  return [
    `*${config.botName}*`,
    '',
    '*General commands*',
    `${p}menu — show this menu`,
    `${p}ping — check bot latency`,
    `${p}status / ${p}alive — show bot status`,
    `${p}owner — owner and channel details`,
    `${p}sticker — reply to an image to create a sticker`,
    `${p}toimg — reply to a sticker to convert it to an image`,
    `${p}getpp — get a group, mentioned, quoted, or supplied profile picture`,
    `${p}setpp — owner-only bot profile picture update from an image`,
    `${p}jid — show the current chat and sender JIDs`,
    `${p}ai <question> — ask the configured AI provider`,
    `${p}request <message> — send a feature request to the owner`,
    '',
    '*Group admin commands*',
    `${p}hidetag <message> — send a hidden mention to the group`,
    `${p}tagall <message> — mention group members`,
    `${p}welcome / ${p}goodbye <on|off|status> — manage group greetings`,
    `${p}gname, ${p}gdesc, ${p}add, ${p}kick, ${p}promote, ${p}demote, ${p}lock, ${p}unlock, ${p}grouplink — safe group management`,
    '',
    '*Owner commands*',
    `${p}public / ${p}self — change message mode`,
    `${p}addprem <number> [30d] — add or extend premium access`,
    `${p}delprem <number> — remove premium access`,
    `${p}listprem — list active premium users`,
    `${p}restart — request a host-managed restart`,
    '',
    `Owner: ${config.ownerName}`,
    `Channel: ${config.whatsappChannel}`
  ].join('\n');
}

async function sendOwnerCard(socket, chatId, quoted) {
  const text = [
    `*${config.botName} owner details*`,
    `Global Owner: ${config.ownerName}`,
    `Developer: ${config.authorName}`,
    `Developer WhatsApp: https://wa.me/${config.authorNumber}`,
    `Owner WhatsApp: ${config.ownerLink}`,
    `WhatsApp Channel: ${config.whatsappChannel}`
  ].join('\n');
  await socket.sendMessage(chatId, { text }, { quoted });
}

async function getGroupInfo(socket, context) {
  if (!context.isGroup) return { participants: [], isAdmin: false };
  const metadata = await socket.groupMetadata(context.chatId);
  const participants = metadata.participants || [];
  const sender = normalizeJid(socket, context.sender);
  let participant = participants.find((entry) => normalizeJid(socket, entry.id) === sender);

  // Baileys v7 can expose group members as privacy LIDs. Resolve those only
  // when a direct phone-number JID comparison did not find the sender.
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
  await socket.sendMessage(
    context.chatId,
    { text: 'The bot must be a group admin to use this command.' },
    { quoted: context.raw }
  );
  return false;
}

async function handleReport(socket, context, message) {
  const now = Date.now();
  const previous = reportCooldowns.get(context.sender) || 0;
  if (now - previous < 60_000) {
    await socket.sendMessage(context.chatId, { text: 'Please wait one minute before sending another request.' }, { quoted: context.raw });
    return;
  }

  if (!message || message.length > 1_500) {
    await socket.sendMessage(context.chatId, { text: `Usage: ${config.commandPrefix}request <message up to 1500 characters>` }, { quoted: context.raw });
    return;
  }

  reportCooldowns.set(context.sender, now);
  setTimeout(() => {
    if (reportCooldowns.get(context.sender) === now) reportCooldowns.delete(context.sender);
  }, 60_000).unref();

  const senderNumber = context.sender?.split('@')[0] || 'unknown';
  const ownerMessage = [
    `*${config.botName} request*`,
    `From: @${senderNumber}`,
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
      `Use ${config.commandPrefix}welcome <on|off|status> or ${config.commandPrefix}goodbye <on|off|status>.`
    ].join('\n');
    await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
    return;
  }

  if (!['on', 'off', 'status'].includes(action)) {
    await socket.sendMessage(
      context.chatId,
      { text: `Usage: ${config.commandPrefix}${command.name} <on|off|status>` },
      { quoted: context.raw }
    );
    return;
  }

  if (action === 'status') {
    const settings = await groupSettings.get(context.chatId);
    await socket.sendMessage(
      context.chatId,
      { text: `${label}: ${settings[settingKey] ? 'ON' : 'OFF'}.` },
      { quoted: context.raw }
    );
    return;
  }

  const settings = await groupSettings.update(context.chatId, { [settingKey]: action === 'on' });
  await socket.sendMessage(
    context.chatId,
    { text: `${label} are now ${settings[settingKey] ? 'ON' : 'OFF'}.` },
    { quoted: context.raw }
  );
}

async function handleGroupManagement(socket, context, command, group) {
  if (command.name === 'group') {
    await socket.sendMessage(
      context.chatId,
      {
        text: [
          '*Safe group management*',
          `${config.commandPrefix}gname <name>`,
          `${config.commandPrefix}gdesc <description>`,
          `${config.commandPrefix}add <international number>`,
          `${config.commandPrefix}kick @user or reply`,
          `${config.commandPrefix}promote @user or reply`,
          `${config.commandPrefix}demote @user or reply`,
          `${config.commandPrefix}lock / ${config.commandPrefix}unlock`,
          `${config.commandPrefix}grouplink`
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
        if (!target) throw new Error(`Mention a user or reply to a message to use ${config.commandPrefix}${command.name}.`);
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
        await socket.sendMessage(
          context.chatId,
          { text: `Group invite link:\nhttps://chat.whatsapp.com/${code}` },
          { quoted: context.raw }
        );
        return;
      }
      default:
        return;
    }

    await socket.sendMessage(
      context.chatId,
      { text: `Group action ${command.name} completed.` },
      { quoted: context.raw }
    );
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Group action failed: ${error.message}` }, { quoted: context.raw });
  }
}

async function handleAiCommand(socket, context, command) {
  const prompt = command.text.trim();
  if (!prompt) {
    await socket.sendMessage(
      context.chatId,
      { text: `Usage: ${config.commandPrefix}ai <question>` },
      { quoted: context.raw }
    );
    return;
  }

  try {
    reserveAiRequest(context.sender);
    const answer = await askGroq({
      apiKey: config.groqApiKey,
      model: config.groqModel,
      prompt,
      botName: config.botName
    });
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
    await socket.sendMessage(
      context.chatId,
      { image: { url: profilePictureUrl }, caption: `Profile picture: ${target.split('@')[0]}` },
      { quoted: context.raw }
    );
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Could not get profile picture: ${error.message}` }, { quoted: context.raw });
  }
}

async function handleSetBotProfilePhoto(socket, context) {
  if (!(await requireOwner(socket, context))) return;
  const imageMessage = getImageMessage(context.raw);
  if (!imageMessage) {
    await socket.sendMessage(
      context.chatId,
      { text: `Reply to an image with ${config.commandPrefix}setpp to update the bot profile picture.` },
      { quoted: context.raw }
    );
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

async function handleMessage(socket, rawMessage) {
  const context = await getMessageContext(socket, rawMessage);
  if (!context.chatId || !context.sender || !context.text) return;

  const command = commandFromText(context.text);
  if (!command) return;

  const owner = isOwner(socket, context.sender);
  if (!publicMode && !owner) return;

  console.info(`[command] ${command.name} from ${context.sender} in ${context.chatId}`);

  switch (command.name) {
    case 'menu':
    case 'help':
      await socket.sendMessage(context.chatId, { text: helpText() }, { quoted: context.raw });
      break;

    case 'ping':
    case 'p': {
      const started = Date.now();
      const sent = await socket.sendMessage(context.chatId, { text: 'Checking latency…' }, { quoted: context.raw });
      await socket.sendMessage(context.chatId, { text: `Pong: ${Date.now() - started}ms`, edit: sent.key });
      break;
    }

    case 'sticker':
    case 's': {
      const imageMessage = getImageMessage(rawMessage);
      if (!imageMessage) {
        await socket.sendMessage(
          context.chatId,
          { text: `Reply to an image with ${config.commandPrefix}sticker to create a sticker.` },
          { quoted: context.raw }
        );
        break;
      }

      try {
        const imageBuffer = await downloadMediaBuffer(imageMessage, 'image');
        const sticker = await createImageSticker(imageBuffer, {
          packname: config.stickerPackname,
          author: config.stickerAuthor
        });
        await socket.sendMessage(context.chatId, { sticker }, { quoted: context.raw });
      } catch (error) {
        console.error('[sticker] Conversion failed:', error);
        await socket.sendMessage(
          context.chatId,
          { text: `Could not create a sticker: ${error.message}` },
          { quoted: context.raw }
        );
      }
      break;
    }

    case 'toimg':
    case 'sticker2img': {
      const stickerMessage = getStickerMessage(rawMessage);
      if (!stickerMessage) {
        await socket.sendMessage(
          context.chatId,
          { text: `Reply to a sticker with ${config.commandPrefix}toimg to convert it to an image.` },
          { quoted: context.raw }
        );
        break;
      }

      try {
        const stickerBuffer = await downloadMediaBuffer(stickerMessage, 'sticker');
        const image = await convertStickerToImage(stickerBuffer);
        await socket.sendMessage(context.chatId, { image, caption: 'Sticker converted to image.' }, { quoted: context.raw });
      } catch (error) {
        console.error('[toimg] Conversion failed:', error);
        await socket.sendMessage(
          context.chatId,
          { text: `Could not convert this sticker: ${error.message}` },
          { quoted: context.raw }
        );
      }
      break;
    }

    case 'jid':
    case 'chatid':
      await socket.sendMessage(
        context.chatId,
        {
          text: [
            `Chat JID: ${context.chatId}`,
            `Sender JID: ${context.sender}`,
            `Type: ${context.isGroup ? 'group' : 'private'}`
          ].join('\n')
        },
        { quoted: context.raw }
      );
      break;

    case 'getpp':
    case 'pp':
    case 'profilepic':
    case 'avatar':
      await handleGetProfilePhoto(socket, context, command);
      break;

    case 'setpp':
      await handleSetBotProfilePhoto(socket, context);
      break;

    case 'ai':
    case 'ask':
    case 'ia':
    case 'groq':
      await handleAiCommand(socket, context, command);
      break;

    case 'status':
    case 'alive':
    case 'runtime':
      await socket.sendMessage(
        context.chatId,
        {
          text: [
            `*${config.botName} status*`,
            `Mode: ${publicMode ? 'public' : 'self'}`,
            `Uptime: ${Math.floor(process.uptime())} seconds`,
            `Premium database: ready`
          ].join('\n')
        },
        { quoted: context.raw }
      );
      break;

    case 'owner':
    case 'creator':
      await sendOwnerCard(socket, context.chatId, context.raw);
      break;

    case 'public':
    case 'self': {
      if (!(await requireOwner(socket, context))) break;
      publicMode = command.name === 'public';
      socket.public = publicMode;
      await socket.sendMessage(context.chatId, { text: `Bot mode is now ${publicMode ? 'public' : 'self'}.` }, { quoted: context.raw });
      break;
    }

    case 'hidetag':
    case 'ht': {
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      const message = context.quotedText || command.text;
      if (!message) {
        await socket.sendMessage(context.chatId, { text: `Usage: ${config.commandPrefix}hidetag <message>` }, { quoted: context.raw });
        break;
      }
      await socket.sendMessage(
        context.chatId,
        { text: message, mentions: group.participants.map((entry) => entry.id) },
        { quoted: context.raw }
      );
      break;
    }

    case 'tagall': {
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      if (!command.text) {
        await socket.sendMessage(context.chatId, { text: `Usage: ${config.commandPrefix}tagall <message>` }, { quoted: context.raw });
        break;
      }
      const mentions = group.participants.map((entry) => entry.id);
      const lines = group.participants.map((entry) => `• @${entry.id.split('@')[0]}`);
      await socket.sendMessage(
        context.chatId,
        { text: `${command.text}\n\n${lines.join('\n')}`, mentions },
        { quoted: context.raw }
      );
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
    case 'grouplink': {
      const group = await requireGroupAdmin(socket, context);
      if (!group) break;
      await handleGroupManagement(socket, context, command, group);
      break;
    }

    case 'idch':
    case 'cekidch': {
      if (!command.text) {
        await socket.sendMessage(context.chatId, { text: `Usage: ${config.commandPrefix}idch <WhatsApp channel URL>` }, { quoted: context.raw });
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
        const details = [
          `ID: ${channel.id}`,
          `Name: ${channel.name}`,
          `Followers: ${channel.subscribers}`,
          `Verified: ${channel.verification === 'VERIFIED' ? 'yes' : 'no'}`
        ].join('\n');
        await socket.sendMessage(context.chatId, { text: details }, { quoted: context.raw });
      } catch (error) {
        await socket.sendMessage(context.chatId, { text: `Could not fetch that channel: ${error.message}` }, { quoted: context.raw });
      }
      break;
    }

    case 'addprem': {
      if (!(await requireOwner(socket, context))) break;
      const [phoneNumber, duration = '30d'] = command.args;
      if (!phoneNumber) {
        await socket.sendMessage(context.chatId, { text: `Usage: ${config.commandPrefix}addprem <number> [30d]` }, { quoted: context.raw });
        break;
      }
      try {
        const record = await premiumStore.add(phoneNumber, duration);
        await socket.sendMessage(
          context.chatId,
          { text: `Premium access saved for ${record.id} until ${formatDate(record.expiresAt)} UTC.` },
          { quoted: context.raw }
        );
      } catch (error) {
        await socket.sendMessage(context.chatId, { text: `Could not add premium access: ${error.message}` }, { quoted: context.raw });
      }
      break;
    }

    case 'delprem': {
      if (!(await requireOwner(socket, context))) break;
      if (!command.args[0]) {
        await socket.sendMessage(context.chatId, { text: `Usage: ${config.commandPrefix}delprem <number>` }, { quoted: context.raw });
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

    case 'request':
    case 'reportbug':
      await handleReport(socket, context, command.text);
      break;

    case 'restart':
    case 'rst': {
      if (!(await requireOwner(socket, context))) break;
      await socket.sendMessage(
        context.chatId,
        { text: 'Restart requested. Ensure your host is configured to restart this process after it exits.' },
        { quoted: context.raw }
      );
      setTimeout(() => process.exit(0), 250).unref();
      break;
    }

    default:
      break;
  }
}

module.exports = handleMessage;
module.exports.commandFromText = commandFromText;
module.exports.helpText = helpText;
