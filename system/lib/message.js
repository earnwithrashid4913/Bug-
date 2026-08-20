'use strict';

function unwrapMessage(message) {
  let current = message;
  const wrappers = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];

  while (current && typeof current === 'object') {
    const wrapper = wrappers.find((key) => current[key]?.message);
    if (!wrapper) break;
    current = current[wrapper].message;
  }

  return current || {};
}

function safeInteractiveId(message) {
  const params = message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (!params) return '';

  try {
    const parsed = JSON.parse(params);
    return typeof parsed.id === 'string' ? parsed.id : '';
  } catch {
    return '';
  }
}

function getContextInfo(message) {
  const unwrapped = unwrapMessage(message);
  for (const value of Object.values(unwrapped)) {
    if (value && typeof value === 'object' && value.contextInfo) return value.contextInfo;
  }
  return undefined;
}

function getImageMessage(rawMessage) {
  const message = unwrapMessage(rawMessage?.message);
  if (message.imageMessage) return message.imageMessage;

  const quotedMessage = getContextInfo(message)?.quotedMessage;
  const quoted = unwrapMessage(quotedMessage);
  return quoted.imageMessage || undefined;
}

function extractText(rawMessage) {
  const message = unwrapMessage(rawMessage);
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedButtonId ||
    message.listResponseMessage?.singleSelectReply?.selectedRowId ||
    message.templateButtonReplyMessage?.selectedId ||
    safeInteractiveId(message) ||
    ''
  ).trim();
}

function normalizeJid(socket, jid) {
  if (!jid) return jid;
  if (typeof socket.decodeJid === 'function') return socket.decodeJid(jid);
  return jid.replace(/:\d+@/, '@');
}

async function resolveJid(socket, jid) {
  const normalized = normalizeJid(socket, jid);
  if (!normalized?.endsWith('@lid')) return normalized;

  try {
    const phoneJid = await socket.signalRepository?.lidMapping?.getPNForLID?.(normalized);
    return phoneJid ? normalizeJid(socket, phoneJid) : normalized;
  } catch {
    // LID-to-phone mappings are populated by Baileys when WhatsApp provides them.
    // Leave an unknown LID unchanged instead of failing command processing.
    return normalized;
  }
}

async function getMessageContext(socket, rawMessage) {
  const chatId = rawMessage?.key?.remoteJid;
  const isGroup = Boolean(chatId?.endsWith('@g.us'));
  const sender = await resolveJid(
    socket,
    rawMessage?.key?.fromMe ? socket.user?.id : rawMessage?.key?.participant || rawMessage?.participant || chatId
  );

  return {
    raw: rawMessage,
    chatId,
    sender,
    fromMe: Boolean(rawMessage?.key?.fromMe),
    isGroup,
    text: extractText(rawMessage?.message),
    quotedText: extractText(unwrapMessage(rawMessage?.message)?.extendedTextMessage?.contextInfo?.quotedMessage)
  };
}

module.exports = {
  extractText,
  getContextInfo,
  getImageMessage,
  getMessageContext,
  normalizeJid,
  resolveJid,
  unwrapMessage
};
