'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getQuotedMessage } = require('./message');

// Metadata lives in RuntimeSettingsStore; no second database or replacement schema.
async function storedMedia(socket, context, command, { settings, download }) {
  const reply = text => socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
  const root = path.join(path.dirname(settings.filePath), 'user_media');
  const key = 'sourceUserMedia';
  const records = await settings.get(key) || [];
  const name = command.args[0]?.toLowerCase();
  if (command.name === 'list') return reply(records.length ? records.map(m => `${m.type}: ${m.name}`).join('\n') : 'No saved media.');
  if (command.name === 'store') {
    const quoted = getQuotedMessage(context.raw);
    const type = quoted.videoMessage ? 'video' : quoted.audioMessage ? 'audio' : undefined;
    if (!type || !name) return reply('Reply to audio/video with: store <name>');
    if (records.some(m => m.name === name && m.type === type)) return reply('Media already exists.');
    const buffer = await download(quoted[`${type}Message`], type);
    if (!buffer.length) throw new Error('Downloaded media is empty');
    await fs.mkdir(root, { recursive: true });
    const file = `${randomUUID()}.${type === 'video' ? 'mp4' : 'mp3'}`;
    await fs.writeFile(path.join(root, file), buffer);
    try {
      await settings.update(data => {
        const media = data[key] || [];
        if (media.some(m => m.name === name && m.type === type)) throw new Error('Media already exists');
        data[key] = [...media, { name, type, file }];
      });
    } catch (error) { await fs.unlink(path.join(root, file)); throw error; }
    return reply('✅ Media stored.');
  }
  const type = command.name === 'del' ? name : command.name === 'vd' ? 'video' : 'audio';
  const target = command.name === 'del' ? command.args[1]?.toLowerCase() : command.args.filter(a => a !== '-c')[0]?.toLowerCase();
  if (!['audio', 'video'].includes(type) || !target) return reply('Usage: ad <name> | vd <name> [-c] | del audio|video <name>');
  const record = records.find(m => m.type === type && m.name === target);
  if (!record) return reply('Media not found.');
  if (path.basename(record.file) !== record.file) throw new Error('Invalid stored media path');
  const filePath = path.join(root, record.file);
  if (command.name === 'del') {
    await settings.update(data => { data[key] = (data[key] || []).filter(m => m.file !== record.file); });
    await fs.unlink(filePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return reply('✅ Media deleted.');
  }
  const buffer = await fs.readFile(filePath);
  await socket.sendMessage(context.chatId, type === 'video'
    ? { video: buffer, caption: target, ptv: command.args.includes('-c') }
    : { audio: buffer, mimetype: 'audio/mpeg', ptt: false }, { quoted: context.raw });
}
module.exports = { storedMedia };
