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

async function getMessageContext(socket, rawMessage) {
  const chatId = rawMessage?.key?.remoteJid;
  const isGroup = Boolean(chatId?.endsWith('@g.us'));
  const sender = normalizeJid(
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
  getMessageContext,
  normalizeJid,
  unwrapMessage
};
