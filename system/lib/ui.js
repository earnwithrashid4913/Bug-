'use strict';

const { generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');

const MAX_QUICK_BUTTONS = 3;

function cleanText(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, 3_500);
}

function quickButton(label, id) {
  return {
    name: 'quick_reply',
    buttonParamsJson: JSON.stringify({ display_text: cleanText(label).slice(0, 60), id: cleanText(id).slice(0, 200) })
  };
}

function listButton(title, sections) {
  const safeSections = sections
    .map((section) => ({
      title: cleanText(section.title || 'Select').slice(0, 100),
      rows: (section.rows || [])
        .filter((row) => row?.id && row?.title)
        .slice(0, 30)
        .map((row) => ({
          header: cleanText(row.header || '').slice(0, 60),
          title: cleanText(row.title).slice(0, 80),
          description: cleanText(row.description || '').slice(0, 120),
          id: cleanText(row.id).slice(0, 200)
        }))
    }))
    .filter((section) => section.rows.length);

  return {
    name: 'single_select',
    buttonParamsJson: JSON.stringify({ title: cleanText(title).slice(0, 60) || 'Select', sections: safeSections })
  };
}

async function relayInteractive(socket, chatId, { text, footer = '', buttons = [], quoted } = {}) {
  if (!socket?.relayMessage || typeof socket.relayMessage !== 'function') {
    throw new Error('Interactive relay is not supported by this socket.');
  }

  const content = proto.Message.InteractiveMessage.create({
    body: proto.Message.InteractiveMessage.Body.create({ text: cleanText(text) }),
    footer: proto.Message.InteractiveMessage.Footer.create({ text: cleanText(footer) }),
    header: proto.Message.InteractiveMessage.Header.create({ title: '', subtitle: '', hasMediaAttachment: false }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
      buttons: buttons.slice(0, 10),
      messageParamsJson: JSON.stringify({ version: 1 }),
      messageVersion: 1
    })
  });

  const message = generateWAMessageFromContent(
    chatId,
    { interactiveMessage: content },
    { quoted, userJid: socket.user?.id }
  );
  await socket.relayMessage(chatId, message.message, { messageId: message.key.id });
  return message;
}

async function sendButtons(socket, chatId, { text, footer = '', buttons = [], fallbackText, quoted } = {}) {
  try {
    return await relayInteractive(socket, chatId, {
      text,
      footer,
      buttons: buttons.filter(Boolean).slice(0, MAX_QUICK_BUTTONS).map((button) => quickButton(button.label, button.id)),
      quoted
    });
  } catch (error) {
    const fallback = fallbackText || [text, '', ...buttons.map((button) => `${button.label} — ${button.id}`), footer].filter(Boolean).join('\n');
    return socket.sendMessage(chatId, { text: fallback }, { quoted });
  }
}

// A single-select list plus optional quick-action buttons (e.g. "Main Menu").
// Every button/list row id is a real command the bot already handles, so the
// interactive surface never contains dead entries.
async function sendList(socket, chatId, { text, footer = '', title, sections = [], actions = [], fallbackText, quoted } = {}) {
  try {
    return await relayInteractive(socket, chatId, {
      text,
      footer,
      buttons: [
        listButton(title, sections),
        ...actions.filter(Boolean).slice(0, 3).map((action) => quickButton(action.label, action.id))
      ],
      quoted
    });
  } catch (error) {
    const rows = sections.flatMap((section) => section.rows || []);
    const fallback = fallbackText || [text, '', ...rows.map((row) => `${row.title} — ${row.id}`), ...actions.map((action) => `${action.label} — ${action.id}`), footer].filter(Boolean).join('\n');
    return socket.sendMessage(chatId, { text: fallback }, { quoted });
  }
}

module.exports = { MAX_QUICK_BUTTONS, cleanText, listButton, quickButton, relayInteractive, sendButtons, sendList };
