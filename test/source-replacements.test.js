'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const webp = require('node-webpmux');
const { buildGroqRequest } = require('../system/lib/ai');
const { MessageStore, storeMessage, handleMessageRevocation, revealViewOnce } = require('../system/lib/message-recovery');
const { createSimpleVideo, createVideoSticker, convertToVideo, takeSticker, extractFirstFrameFromWebP } = require('../system/lib/sticker');
const { AutomationStore, handleAutoReact, handleAutowriteMessage, handleAutoStatus } = require('../system/lib/automation');
const { RuntimeSettingsStore } = require('../system/lib/runtime-settings');
const { BotTracker } = require('../system/lib/bot-tracker');
const { styleHeaders } = require('../system/lib/presentation');
const { COMMANDS, allAliases } = require('../system/lib/menu');

const owner = '15551234567@s.whatsapp.net';
const sender = '15551234568@s.whatsapp.net';
const group = '120363111111111@g.us';
function socket(sent) {
  return { user: { id: owner }, sendMessage: async (jid, payload) => { sent.push({ jid, payload }); return { key: { id: 'sent' } }; }, groupMetadata: async () => ({ subject: 'Test group' }) };
}
function raw(id, message, jid = group) { return { key: { id, remoteJid: jid, participant: sender, fromMe: false }, message }; }
async function temporary(operation) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-replacements-'));
  try { return await operation(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('all dispatcher cases have unique menu registration and every alias has a real case', async () => {
  const source = await fs.readFile(path.join(__dirname, '../system/handler.js'), 'utf8');
  const body = source.split('async function dispatchCommand')[1].split('module.exports =')[0];
  const cases = [...body.matchAll(/case '([^']+)':/g)].map(m => m[1]);
  assert.equal(new Set(cases).size, cases.length, 'no duplicate dispatch cases');
  assert.deepEqual([...cases].sort(), allAliases());
  assert.equal(new Set(COMMANDS.flatMap(c => [c.name, ...c.aliases])).size, allAliases().length);
});
test('Groq personas retain source temperature, token budget, identity and multilingual instructions', () => {
  const love = buildGroqRequest('Bonjour', 'llama-3.1-8b-instant', 'ANIME-MD', 'love');
  assert.equal(love.temperature, 0.8);
  assert.equal(love.max_tokens, 1024);
  assert.match(love.messages[0].content, /GoatMods/);
  assert.match(love.messages[0].content, /langue de l'utilisateur/);
  assert.match(love.messages[0].content, /3-4 phrases/);
  assert.equal(love.messages[1].content, 'Bonjour');
  const free = buildGroqRequest('hello', 'model', 'ANIME-MD', 'free');
  assert.equal(free.temperature, 0.7);
  assert.match(free.messages[0].content, /utile, amical et précis/);
  const normal = buildGroqRequest('hello', 'model', 'ANIME-MD');
  assert.equal(normal.max_tokens, 700, 'existing standard AI retained');
});
test('deleted image/media is recovered only to owner with original text and sender', async () => {
  const sent = [];
  const sock = socket(sent);
  await storeMessage(sock, raw('image', { imageMessage: { caption: 'Original caption', mimetype: 'image/jpeg' } }), { download: async () => Buffer.from('media bytes'), ownerJid: owner });
  await handleMessageRevocation(sock, raw('revoke', { protocolMessage: { type: 0, key: { id: 'image', remoteJid: group } } }), owner);
  assert.ok(sent.every(m => m.jid === owner));
  assert.match(sent[0].payload.text, /Original caption/);
  assert.ok(sent[0].payload.mentions.includes(sender));
  assert.equal(sent[1].payload.image.toString(), 'media bytes');
  const count = sent.length;
  await handleMessageRevocation(sock, raw('again', { protocolMessage: { key: { id: 'image', remoteJid: group } } }), owner);
  assert.equal(sent.length, count, 'recovered record removed');
});
test('recovery cache is isolated per socket and per chat even with identical message IDs', async () => {
  const sentA = [], sentB = [];
  const a = socket(sentA), b = socket(sentB);
  await storeMessage(a, raw('same', { conversation: 'private A' }), { ownerJid: owner });
  const deletion = raw('delete', { protocolMessage: { key: { id: 'same', remoteJid: group } } });
  await handleMessageRevocation(b, deletion, owner);
  await handleMessageRevocation(a, raw('delete', { protocolMessage: { key: { id: 'same', remoteJid: 'other@g.us' } } }), owner);
  assert.equal(sentA.length + sentB.length, 0);
  await handleMessageRevocation(a, deletion, owner);
  assert.match(sentA[0].payload.text, /private A/);
});
test('message store TTL and capacity cleanup remove expired and oldest entries', () => {
  const cache = new MessageStore();
  cache.storeMessage({ id: 'old', jid: group, timestamp: Date.now() - 3600001 });
  assert.equal(cache.getMessage(group, 'old'), undefined);
  for (let i = 0; i < 1001; i++) cache.storeMessage({ id: String(i), jid: group, timestamp: Date.now() });
  assert.equal(cache.messages.size, 1000);
  assert.equal(cache.getMessage(group, '0'), undefined);
});
test('view-once wrapped video sends privately and acknowledges only in the group', async () => {
  const sent = [];
  const message = raw('vv', { extendedTextMessage: { text: '!hey', contextInfo: { quotedMessage: { viewOnceMessageV2: { message: { videoMessage: { viewOnce: true, caption: 'One time', mimetype: 'video/mp4' } } } } } } });
  await revealViewOnce(socket(sent), { chatId: group, sender, isGroup: true, raw: message }, async () => Buffer.from('video'));
  assert.equal(sent[0].jid, sender);
  assert.equal(sent[0].payload.video.toString(), 'video');
  assert.equal(sent[1].jid, group);
  assert.equal(sent[1].payload.react.text, '✔️');
});
test('real FFmpeg conversion: PNG to MP4 to animated sticker to MP4, and EXIF take/steal', async () => {
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#f08080' } }).png().toBuffer();
  const video = await createSimpleVideo(png);
  assert.equal(video.toString('ascii', 4, 8), 'ftyp');
  const sticker = await createVideoSticker(video, { packname: 'ANIME-MD', author: 'GoatMods' });
  assert.equal(sticker.toString('ascii', 8, 12), 'WEBP');
  const frame = await extractFirstFrameFromWebP(sticker);
  assert.equal((await sharp(frame).metadata()).format, 'png');
  const changed = await takeSticker(sticker, { packname: 'New Pack', author: 'New Author' });
  const image = new webp.Image(); await image.load(changed);
  assert.match(image.exif.toString(), /New Pack/);
  const result = await convertToVideo(changed);
  assert.equal(result.toString('ascii', 4, 8), 'ftyp');
});
test('autoreact uses persisted emoji list; autowrite ends with paused presence', async () => temporary(async dir => {
  const store = new AutomationStore(path.join(dir, 'automation.json'));
  await store.setChat(group, 'autoreact', true);
  await store.setChat(group, 'autowrite', true);
  await store.update(data => { data.chats[group].emojis = ['🦊']; });
  const sent = [], presence = [];
  const sock = { ...socket(sent), sendPresenceUpdate: async type => presence.push(type) };
  const context = { chatId: group, isGroup: true, fromMe: false, raw: raw('hello', { conversation: 'hello' }) };
  await handleAutoReact(sock, context, store);
  await handleAutowriteMessage(sock, context, store);
  assert.equal(sent[0].payload.react.text, '🦊');
  assert.deepEqual(presence, ['composing', 'paused']);
}));
test('AutoStatus callable processes all status messages with view and configured reaction', async () => temporary(async dir => {
  // This proves the helper, not the protected index.js routing (currently blocked).
  const store = new AutomationStore(path.join(dir, 'automation.json'));
  await store.setGlobal('autostatus', true);
  await store.setGlobal('statusReact', true);
  await store.update(data => { data.global.statusEmoji = '✨'; });
  const reads = [], sent = [];
  const sock = { ...socket(sent), readMessages: async keys => reads.push(...keys) };
  await handleAutoStatus(sock, { messages: [raw('s1', { conversation: 'status' }, 'status@broadcast'), raw('s2', { conversation: 'status' }, 'status@broadcast')] }, store);
  assert.deepEqual(reads.map(key => key.id), ['s1', 's2']);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(entry => entry.payload.react.text === '✨'));
}));
test('BotTracker persists counts, bounds history, and stops its intervals', async () => temporary(async dir => {
  const settings = new RuntimeSettingsStore(path.join(dir, 'settings.json'));
  await settings.set('prefix', '!');
  const tracker = new BotTracker(settings, { apiUrl: '' });
  await tracker.start();
  for (let i = 0; i < 105; i++) tracker.incrementCommands('ping');
  assert.equal(tracker.getStats().commandHistory.length, 100);
  await tracker.stop();
  assert.equal(tracker.heartbeatInterval, null);
  assert.equal((await settings.get('botTracker')).commandsExecuted, 105);
  assert.equal(await settings.get('prefix'), '!');
  const restored = new BotTracker(settings, { apiUrl: '' });
  await restored.loadStats();
  assert.equal(restored.stats.commandsExecuted, 105);
}));
test('header styling leaves commands, URLs, code and action-like tokens unchanged', () => {
  const text = '*TITLE*\n!menu\n*https://example.com/Case*\n`*code*`\n*Header*';
  const styled = styleHeaders(text);
  assert.match(styled, /𝐓𝐈𝐓𝐋𝐄/);
  assert.match(styled, /!menu/);
  assert.match(styled, /https:\/\/example.com\/Case/);
  assert.match(styled, /`\*code\*`/);
  assert.equal(styled.normalize('NFKC'), text);
});
