'use strict';

const { config } = require('./config');
const { GroupSettingsStore } = require('./lib/group-settings');
const { AutomationStore } = require('./lib/automation');
const automationStore = new AutomationStore(config.automationDbPath);
const corrections = new Map();
const { normalizeJid } = require('./lib/message');

const groupSettings = new GroupSettingsStore(config.groupSettingsDbPath);

function renderGroupMessage(template, participant, subject) {
  const number = participant?.split('@')[0] || 'member';
  return template
    .replaceAll('@user', `@${number}`)
    .replaceAll('@group', subject || 'this group');
}

async function handleGroupParticipantsUpdate(socket, update) {
  if (!update?.id?.endsWith('@g.us') || !Array.isArray(update.participants)) return;
  if (['promote', 'demote'].includes(update.action)) {
    const enabled = await automationStore.getChat(update.id, update.action === 'demote' ? 'antidemote' : 'antipromote');
    if (!enabled) return;
    const bot = normalizeJid(socket, socket.user?.id);
    // Do not reverse our own corrections (or intentional bot commands), which
    // would otherwise make source anti-promote/anti-demote fight forever.
    if (normalizeJid(socket, update.author) === bot) return;
    const now = Date.now();
    for (const [key, expires] of corrections) if (expires < now) corrections.delete(key);
    for (const raw of update.participants) {
      const jid = normalizeJid(socket, typeof raw === 'string' ? raw : raw.id);
      const key = `${bot}:${update.id}:${jid}`;
      if (!jid || jid === bot || corrections.has(key)) continue;
      corrections.set(key, now + 10000);
      try { await socket.groupParticipantsUpdate(update.id, [jid], update.action === 'demote' ? 'promote' : 'demote'); }
      catch (error) { corrections.delete(key); console.warn('[group protection]', error.message); }
    }
    return;
  }
  if (!['add', 'remove'].includes(update.action)) return;

  const settings = await groupSettings.get(update.id);
  const enabled = update.action === 'add' ? settings.welcomeEnabled : settings.goodbyeEnabled;
  if (!enabled) return;

  const metadata = await socket.groupMetadata(update.id).catch(() => undefined);
  const subject = metadata?.subject || 'this group';
  const template = update.action === 'add' ? config.welcomeMessage : config.goodbyeMessage;

  for (const rawParticipant of update.participants) {
    const participant = normalizeJid(socket, typeof rawParticipant === 'string' ? rawParticipant : rawParticipant.id);
    await socket.sendMessage(update.id, {
      text: renderGroupMessage(template, participant, subject),
      mentions: participant ? [participant] : []
    });
  }
}

module.exports = {
  groupSettings,
  handleGroupParticipantsUpdate,
  renderGroupMessage
};
