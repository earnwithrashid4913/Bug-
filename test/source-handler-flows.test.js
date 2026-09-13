'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
// Resolve all runtime store paths into an isolated test directory before loading
// the real handler; never write test settings into the checkout's live data.
const cwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-handler-flows-'));
process.chdir(dir);
const handler = require('../system/handler');
const { config } = require('../system/config');
const { groupSettings, handleGroupParticipantsUpdate } = require('../system/group-events');
const { AutomationStore } = require('../system/lib/automation');
process.chdir(cwd);
const automation = new AutomationStore(config.automationDbPath);
const bot = '15551234567@s.whatsapp.net';
const user = '15551234568@s.whatsapp.net';
const target = '15551234569@s.whatsapp.net';
const group = '120363555555555@g.us';
let counter = 0;
function makeSocket({ admin = true } = {}) {
  const sent = [], actions = [], presence = [];
  return {
    sent, actions, presence,
    user: { id: bot }, decodeJid: jid => jid,
    sendMessage: async (jid, payload) => { sent.push({ jid, payload }); return { key: { id: 'sent' } }; },
    groupMetadata: async () => ({ subject: 'Flow Group', participants: [{ id: bot, admin: 'admin' }, { id: user, admin: admin ? 'admin' : null }, { id: target, admin: null }] }),
    groupParticipantsUpdate: async (jid, users, action) => { actions.push({ jid, users, action }); return []; },
    groupSettingUpdate: async (jid, value) => actions.push({ jid, value }),
    groupInviteCode: async () => 'real-test-code',
    profilePictureUrl: async () => 'https://example.invalid/group.jpg',
    sendPresenceUpdate: async type => presence.push(type),
    signalRepository: { lidMapping: { getPNForLID: async () => target } }
  };
}
function message(text, { owner = false, privateChat = false, quoted } = {}) {
  return { key: { id: `flow-${counter++}`, remoteJid: privateChat ? (owner ? bot : user) : group, participant: owner ? bot : user, fromMe: owner }, message: quoted ? { extendedTextMessage: { text, contextInfo: quoted } } : { conversation: text } };
}
function texts(sock) { return sock.sent.map(s => s.payload.text || s.payload.caption || '').join('\n').normalize('NFKC'); }
test.after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

test('source greet both toggles persisted flags; explicit button on/off remains idempotent', async () => {
  const sock = makeSocket();
  await handler(sock, message('!gReEt both'));
  let settings = await groupSettings.get(group);
  assert.equal(settings.welcomeEnabled, true); assert.equal(settings.goodbyeEnabled, true);
  await handler(sock, message('!WELCOME off'));
  await handler(sock, message('!welcome off'));
  settings = await groupSettings.get(group);
  assert.equal(settings.welcomeEnabled, false); assert.equal(settings.goodbyeEnabled, true);
});
test('anti-link source detection deletes, warns three times and removes only violating member', async () => {
  const admin = makeSocket();
  await handler(admin, message('!antilink on'));
  const member = makeSocket({ admin: false });
  for (let i = 0; i < 3; i++) await handler(member, message(`https://example.com/${i}`));
  assert.equal(member.sent.filter(s => s.payload.delete).length, 3);
  assert.equal(member.actions.length, 1);
  assert.deepEqual(member.actions[0].users, [user]);
  assert.equal(member.actions[0].action, 'remove');
  await handler(admin, message('!warnings reset'));
  await handler(admin, message('!warnings', { quoted: { mentionedJid: [user] } }));
  assert.match(texts(admin), /Anti-Link: 0\/3/);
  await handler(admin, message('!antilink off'));
});
test('source spam, mention and mass-tag enforcement respect owner/admin exemption', async () => {
  const admin = makeSocket();
  for (const cmd of ['antispam', 'antimention', 'antitag']) await handler(admin, message(`!${cmd} on`));
  const member = makeSocket({ admin: false });
  for (let i = 0; i < 6; i++) await handler(member, message('repeated text'));
  assert.match(texts(member), /antispam violation/);
  await handler(member, message('hi', { quoted: { mentionedJid: [bot, user, target, 'a@s.whatsapp.net', 'b@s.whatsapp.net'] } }));
  assert.match(texts(member), /antimention violation/); assert.match(texts(member), /antitag violation/);
  const before = admin.sent.filter(s => s.payload.delete).length;
  await handler(admin, message('@everyone', { owner: true }));
  assert.equal(admin.sent.filter(s => s.payload.delete).length, before);
  for (const cmd of ['antispam', 'antimention', 'antitag']) await handler(admin, message(`!${cmd} off`));
});
test('autoreact command custom emojis reaches the actual non-command hook', async () => {
  const admin = makeSocket();
  await handler(admin, message('!AutoReaction emojis 🦊'));
  await handler(admin, message('!AUTOREACT on'));
  const member = makeSocket({ admin: false });
  await handler(member, message('ordinary message'));
  assert.ok(member.sent.some(s => s.payload.react?.text === '🦊'));
  await handler(admin, message('!autoreact off'));
});
test('sudo mention and reply/LID aliases use the existing phone-number store', async () => {
  const sock = makeSocket();
  await handler(sock, message('!MakeSudo', { owner: true, privateChat: true, quoted: { participant: '123456789@lid', quotedMessage: { conversation: 'hello' } } }));
  assert.match(texts(sock), /SUDO GRANTED/);
  await handler(sock, message('!unsudo', { owner: true, privateChat: true, quoted: { mentionedJid: [target] } }));
  assert.match(texts(sock), /SUDO REMOVED/);
  const denied = makeSocket();
  await handler(denied, message('!makesudo 15551234569', { privateChat: true }));
  assert.match(texts(denied), /OWNER ONLY/);
});
test('anti-demote participant events reverse once without oscillating', async () => {
  const sock = makeSocket();
  await handler(sock, message('!antidemote on'));
  await handler(sock, message('!antipromote on'));
  await handleGroupParticipantsUpdate(sock, { id: group, action: 'demote', author: target, participants: [user] });
  assert.deepEqual(sock.actions.at(-1), { jid: group, users: [user], action: 'promote' });
  const count = sock.actions.length;
  await handleGroupParticipantsUpdate(sock, { id: group, action: 'promote', author: bot, participants: [user] });
  assert.equal(sock.actions.length, count);
  await automation.setChat(group, 'antidemote', false); await automation.setChat(group, 'antipromote', false);
});
test('purge uses one batch, and unauthorized user cannot invoke it', async () => {
  const sock = makeSocket();
  await handler(sock, message('!PuRgE'));
  assert.deepEqual(sock.actions, [{ jid: group, users: [target], action: 'remove' }]);
  const denied = makeSocket({ admin: false });
  await handler(denied, message('!purge'));
  assert.equal(denied.actions.length, 0);
  assert.match(texts(denied), /admin/i);
});
test('tag is source hidetag while everyone uses visible tagging', async () => {
  const sock = makeSocket();
  await handler(sock, message('!tag hello all'));
  assert.ok(sock.sent.some(s => s.payload.delete));
  assert.ok(sock.sent.some(s => s.payload.text?.includes('HIDETAG') && s.payload.mentions.length === 3));
  const visible = makeSocket();
  await handler(visible, message('!everyone hello'));
  assert.ok(visible.sent.some(s => s.payload.text?.includes('@15551234569')));
  assert.equal(visible.sent.filter(s => s.payload.delete).length, 0);
});
test('private alias uses existing self mode without changing owner authorization', async () => {
  const sock = makeSocket();
  await handler(sock, message('!PRIVATE', { owner: true, privateChat: true }));
  const denied = makeSocket();
  await handler(denied, message('!ping', { privateChat: true }));
  assert.equal(denied.sent.length, 0);
  await handler(sock, message('!public', { owner: true, privateChat: true }));
});

test('status-save persists downloaded bytes and confirms only after delivery to owner', async () => {
  const { saveStatus } = require('../system/lib/message-recovery');
  const sock = makeSocket();
  const raw = message('!save', { quoted: { quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } } } });
  await saveStatus(sock, { chatId: group, sender: user, isGroup: true, raw }, async () => Buffer.from('saved status fixture'), bot);
  assert.equal(sock.sent[0].jid, bot);
  assert.equal(sock.sent[0].payload.image.toString(), 'saved status fixture');
  assert.equal(sock.sent[1].jid, group);
  assert.match(sock.sent[1].payload.text, /sent to owner/);
  const saved = await fsp.readdir(path.join(path.dirname(config.settingsDbPath), 'saved_status'));
  assert.equal(saved.length, 1);
});
