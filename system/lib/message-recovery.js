'use strict';
const { unwrapMessage, getQuotedMessage, getContextInfo } = require('./message');
const { FOOTER } = require('./source-commands');

// Replaces the dispatcher's text-only cache. Socket isolation prevents media
// from one connected account being recovered through another account.
class MessageStore {
  constructor() { this.messages = new Map(); this.bytes = 0; }
  key(jid, id) { return `${jid}:${id}`; }
  deleteMessage(jid, id) {
    const key = this.key(jid, id);
    this.bytes -= this.messages.get(key)?.buffer?.length || 0;
    this.messages.delete(key);
  }
  cleanup() {
    for (const record of this.messages.values()) if (Date.now() - record.timestamp > 3600000) this.deleteMessage(record.jid, record.id);
  }
  storeMessage(record) {
    this.cleanup();
    this.deleteMessage(record.jid, record.id);
    this.messages.set(this.key(record.jid, record.id), record);
    this.bytes += record.buffer?.length || 0;
    while (this.messages.size > 1000 || this.bytes > 32 * 1024 * 1024) {
      const first = this.messages.values().next().value;
      this.deleteMessage(first.jid, first.id);
    }
  }
  getMessage(jid, id) { this.cleanup(); return this.messages.get(this.key(jid, id)); }
}
const stores = new WeakMap();
function storeFor(socket) {
  if (!stores.has(socket)) stores.set(socket, new MessageStore());
  return stores.get(socket);
}
function mediaOf(message) {
  const content = unwrapMessage(message);
  for (const type of ['image', 'video', 'audio', 'sticker']) if (content[`${type}Message`]) return { type, media: content[`${type}Message`] };
  return {};
}
async function sendRecoveredMedia(socket, jid, original, caption) {
  if (!original.buffer?.length) return;
  const payload = { [original.type]: original.buffer };
  if (original.type === 'audio') Object.assign(payload, { mimetype: original.mimetype || 'audio/mpeg', ptt: false });
  else if (original.type !== 'sticker') payload.caption = caption;
  await socket.sendMessage(jid, payload);
  if (original.type === 'sticker') await socket.sendMessage(jid, { text: caption });
}
async function forwardViewOnceToOwner(socket, original, ownerJid) {
  await sendRecoveredMedia(socket, ownerJid, original, `View-Once ${original.type.toUpperCase()} Detected\nFrom: ${original.sender}\nTime: ${new Date().toLocaleString()}\n\n> ${FOOTER}`);
}
async function storeMessage(socket, raw, { download, ownerJid }) {
  if (!raw.key?.id || raw.key.fromMe) return;
  const content = unwrapMessage(raw.message);
  const { type, media } = mediaOf(raw.message);
  const original = { id: raw.key.id, jid: raw.key.remoteJid, sender: raw.key.participant || raw.key.remoteJid, timestamp: Date.now(), content: content.conversation || content.extendedTextMessage?.text || media?.caption || '', type, mimetype: media?.mimetype };
  if (type) {
    try { original.buffer = await download(media, type); }
    catch (error) { original.content += `\n[Media could not be saved: ${error.message}]`; }
  }
  storeFor(socket).storeMessage(original);
  const viewOnce = media?.viewOnce || raw.message?.viewOnceMessage || raw.message?.viewOnceMessageV2 || raw.message?.viewOnceMessageV2Extension;
  if (viewOnce && original.buffer && ownerJid) await forwardViewOnceToOwner(socket, original, ownerJid);
}
async function handleMessageRevocation(socket, raw, ownerJid) {
  const key = unwrapMessage(raw.message).protocolMessage?.key;
  if (!key?.id || raw.key.fromMe || !ownerJid) return;
  const store = storeFor(socket);
  const original = store.getMessage(key.remoteJid || raw.key.remoteJid, key.id);
  if (!original) return;
  const deletedBy = raw.key.participant || raw.key.remoteJid;
  let group = 'Private Chat';
  if (original.jid.endsWith('@g.us')) group = (await socket.groupMetadata(original.jid).catch(() => ({}))).subject || 'Unknown Group';
  const text = `*DELETED MESSAGE DETECTED*\nFrom: @${original.sender.split('@')[0]}\nDeleted by: @${deletedBy.split('@')[0]}\nGroup/Chat: ${group}\nMessage: ${original.content || '[Media]'}\n\n> ${FOOTER}`;
  await socket.sendMessage(ownerJid, { text, mentions: [original.sender, deletedBy] });
  await sendRecoveredMedia(socket, ownerJid, original, text);
  store.deleteMessage(original.jid, original.id);
}
async function revealViewOnce(socket, context, download) {
  const quoted = getQuotedMessage(context.raw);
  const { type, media } = mediaOf(quoted);
  const originalQuote = getContextInfo(context.raw.message)?.quotedMessage || {};
  const valid = media?.viewOnce || originalQuote.viewOnceMessage || originalQuote.viewOnceMessageV2 || originalQuote.viewOnceMessageV2Extension;
  try {
    if (!type || !valid) throw new Error('Reply to a view-once image, video or audio.');
    const buffer = await download(media, type);
    if (!buffer.length) throw new Error('Empty media buffer');
    await sendRecoveredMedia(socket, context.sender, { type, buffer, mimetype: media.mimetype }, `*VIEW ONCE REVEALED*\nType: ${type}\nRequested by: ${context.sender}\nDate: ${new Date().toLocaleString()}\n${media.caption || ''}\n\n> ${FOOTER}`);
    if (context.isGroup) await socket.sendMessage(context.chatId, { react: { text: '✔️', key: context.raw.key } });
  } catch (error) {
    await socket.sendMessage(context.sender, { text: `Could not reveal: ${error.message}` });
    if (context.isGroup) await socket.sendMessage(context.chatId, { react: { text: '❎', key: context.raw.key } });
  }
}
async function saveStatus(socket, context, download, ownerJid) {
  const { type, media } = mediaOf(getQuotedMessage(context.raw));
  if (!['image', 'video'].includes(type)) return socket.sendMessage(context.chatId, { text: 'Please reply to an image/video status.' }, { quoted: context.raw });
  if (!ownerJid) throw new Error('Connected owner is unavailable');
  const buffer = await download(media, type);
  if (!buffer.length) throw new Error('Download failed');
  // The source keeps saved statuses on disk, outside the database.
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { randomUUID } = require('node:crypto');
  const { config } = require('../config');
  const dir = path.join(path.dirname(config.settingsDbPath), 'saved_status');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${randomUUID()}.${type === 'image' ? 'jpg' : 'mp4'}`), buffer);
  await sendRecoveredMedia(socket, ownerJid, { type, buffer }, `*Status Downloaded*\nFrom: ${context.sender}\nChat: ${context.isGroup ? 'Group' : 'Private'}\nType: ${type}\nTime: ${new Date().toLocaleString()}\n\n> ${FOOTER}`);
  await socket.sendMessage(context.chatId, { text: '✅ Status downloaded and sent to owner.' }, { quoted: context.raw });
}
module.exports = { MessageStore, storeMessage, handleMessageRevocation, revealViewOnce, saveStatus, sendRecoveredMedia, forwardViewOnceToOwner };
