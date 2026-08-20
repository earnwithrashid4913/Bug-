'use strict';

const { config } = require('./config');
const { GroupSettingsStore } = require('./lib/group-settings');
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
  if (!['add', 'remove'].includes(update.action)) return;

  const settings = await groupSettings.get(update.id);
  const enabled = update.action === 'add' ? settings.welcomeEnabled : settings.goodbyeEnabled;
  if (!enabled) return;

  const metadata = await socket.groupMetadata(update.id).catch(() => undefined);
  const subject = metadata?.subject || 'this group';
  const template = update.action === 'add' ? config.welcomeMessage : config.goodbyeMessage;

  for (const rawParticipant of update.participants) {
    const participant = normalizeJid(socket, rawParticipant);
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
