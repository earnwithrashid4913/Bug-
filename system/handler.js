'use strict';

const { config, normalizePhoneNumber } = require('./config');
const { getMessageContext, normalizeJid, resolveJid } = require('./lib/message');
const { PremiumStore } = require('./lib/premium');
const { selectImage } = require('./images');

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

async function sendCommandResponse(socket, context, imageKey, text, messageOptions = {}) {
  if (config.imageResponses) {
    try {
      const image = selectImage(imageKey);
      return await socket.sendMessage(
        context.chatId,
        { image: { url: image.url }, caption: text, ...messageOptions },
        { quoted: context.raw }
      );
    } catch (error) {
      // A remote wallpaper should never make a command unavailable. Fall back
      // to the original text reply if Baileys cannot fetch or upload it.
      console.warn(`[images] ${imageKey} image failed; sending text fallback: ${error.message}`);
    }
  }

  return socket.sendMessage(context.chatId, { text, ...messageOptions }, { quoted: context.raw });
}

function helpText() {
  const p = config.commandPrefix;
  return [
    `*${config.botName}*`,
    '',
    '*General commands*',
    `${p}menu — show this menu`,
    `${p}ping — check bot latency`,
    `${p}status — show bot status`,
    `${p}owner — owner and channel details`,
    `${p}request <message> — send a feature request to the owner`,
    '',
    '*Group admin commands*',
    `${p}hidetag <message> — send a hidden mention to the group`,
    `${p}tagall <message> — mention group members`,
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

async function sendOwnerCard(socket, context, imageKey) {
  const text = [
    `*${config.botName} owner details*`,
    `Global Owner: ${config.ownerName}`,
    `Developer: ${config.authorName}`,
    `Developer WhatsApp: https://wa.me/${config.authorNumber}`,
    `Owner WhatsApp: ${config.ownerLink}`,
    `WhatsApp Channel: ${config.whatsappChannel}`
  ].join('\n');
  await sendCommandResponse(socket, context, imageKey, text);
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

  return { participants, isAdmin: Boolean(participant?.admin) };
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
  await sendCommandResponse(socket, context, 'report', 'Your request has been sent to the owner.');
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
      await sendCommandResponse(socket, context, 'menu', helpText());
      break;

    case 'help':
      await sendCommandResponse(socket, context, 'help', helpText());
      break;

    case 'ping':
    case 'p': {
      const started = Date.now();
      await sendCommandResponse(socket, context, 'ping', `Pong: ${Date.now() - started}ms`);
      break;
    }

    case 'status':
      await sendCommandResponse(
        socket,
        context,
        'status',
        [
          `*${config.botName} status*`,
          `Mode: ${publicMode ? 'public' : 'self'}`,
          `Uptime: ${Math.floor(process.uptime())} seconds`,
          'Premium database: ready'
        ].join('\n')
      );
      break;

    case 'owner':
      await sendOwnerCard(socket, context, 'owner');
      break;

    case 'creator':
      await sendOwnerCard(socket, context, 'creator');
      break;

    case 'public':
    case 'self': {
      if (!(await requireOwner(socket, context))) break;
      publicMode = command.name === 'public';
      socket.public = publicMode;
      await sendCommandResponse(
        socket,
        context,
        publicMode ? 'public' : 'self',
        `Bot mode is now ${publicMode ? 'public' : 'self'}.`
      );
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
      await sendCommandResponse(
        socket,
        context,
        'hidetag',
        message,
        { mentions: group.participants.map((entry) => entry.id) }
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
      const tagText = `${command.text}\n\n${lines.join('\n')}`;

      // WhatsApp image captions are shorter than a large group mention list.
      // Preserve every mention with a text follow-up only when the list cannot
      // safely fit in the single selected image caption.
      if (!config.imageResponses || tagText.length <= 1_000) {
        await sendCommandResponse(socket, context, 'tagall', tagText, { mentions });
      } else {
        await sendCommandResponse(socket, context, 'tagall', `*Group announcement*\n${command.text}`);
        await socket.sendMessage(context.chatId, { text: tagText, mentions }, { quoted: context.raw });
      }
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
        await sendCommandResponse(socket, context, 'channelInfo', details);
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
        await sendCommandResponse(
          socket,
          context,
          'premiumAdd',
          `Premium access saved for ${record.id} until ${formatDate(record.expiresAt)} UTC.`
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
        await sendCommandResponse(
          socket,
          context,
          'premiumDelete',
          removed ? `Premium access removed for ${phoneNumber}.` : 'That number has no active premium record.'
        );
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
        await sendCommandResponse(socket, context, 'premiumList', text);
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
