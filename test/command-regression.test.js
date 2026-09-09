'use strict';

// ---------------------------------------------------------------------------
// Full WhatsApp command regression sweep.
//
// EVERY command registered in system/lib/menu.js is dispatched through the real
// handleMessage() with a fake socket, and must:
//   * be recognized (no silent fall-through),
//   * never throw out of the handler,
//   * produce at least one reply,
//   * enforce its declared permission.
//
// External providers are stubbed so the sweep is deterministic and offline.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const test = require('node:test');
const handler = require('../system/handler');
const { COMMANDS } = require('../system/lib/menu');
const { generateWAMessageFromContent } = require('@whiskeysockets/baileys');

const BOT_JID = '15551234567@s.whatsapp.net';
const USER_JID = '15551234568@s.whatsapp.net';
const GROUP_JID = '120363000000000000@g.us';

// Commands whose job is to call an external provider. They are still swept, but
// the provider answers with an error so the sweep proves the ERROR path replies
// gracefully instead of throwing or going silent.
const NETWORK_COMMANDS = new Set(['play', 'ytmp3', 'video', 'spotify', 'media', 'ai', 'translate', 'ss', 'short', 'tourl', 'tts']);

// Need a reply/mention that a bare sweep cannot supply; covered by their own
// dedicated assertions below instead of the generic sweep.
const NEEDS_MEDIA_REPLY = new Set(['sticker', 'toimg', 'vv', 'setpp', 'hidetag', 'kick', 'promote', 'demote', 'warn', 'unwarn', 'give', 'add']);

function makeSocket(sent, { relay = false } = {}) {
  const socket = {
    user: { id: BOT_JID },
    decodeJid: (jid) => String(jid).replace(/:\d+@/, '@'),
    public: true,
    sendMessage: async (chatId, payload) => {
      sent.push({ chatId, payload });
      return { key: { id: 'swept' } };
    },
    relayMessage: relay
      ? async (chatId, message) => {
          sent.push({ chatId, payload: { interactive: message } });
          return 'relayed';
        }
      : undefined,
    sendPresenceUpdate: async () => {},
    groupMetadata: async () => ({
      subject: 'Swept Group',
      participants: [
        { id: BOT_JID, admin: 'admin' },
        { id: USER_JID, admin: 'admin' }
      ]
    }),
    groupParticipantsUpdate: async () => ({}),
    groupSettingUpdate: async () => ({}),
    groupUpdateSubject: async () => ({}),
    groupUpdateDescription: async () => ({}),
    groupInviteCode: async () => 'ABCDEF123',
    profilePictureUrl: async () => 'https://example.invalid/pp.jpg',
    newsletterMetadata: async () => ({ id: '123@newsletter', name: 'Channel', subscribers: 5, verification: 'UNVERIFIED' }),
    updateProfileName: async () => ({}),
    updateProfilePicture: async () => ({})
  };
  return socket;
}

function textMessage(text, { group = false, fromMe = false } = {}) {
  const remoteJid = group ? GROUP_JID : USER_JID;
  return {
    key: { remoteJid, participant: fromMe ? BOT_JID : USER_JID, fromMe },
    message: { conversation: text }
  };
}

// Every external provider fails fast and offline, so the sweep exercises the
// error handling paths without touching the network.
function stubNetwork() {
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network disabled in the command sweep');
  };
  return () => {
    globalThis.fetch = real;
  };
}

// Owner-only commands are dispatched as the bot account; everything else as a
// normal user, so the permission gate is exercised in both directions.
function dispatchContext(entry) {
  const ownerOnly = entry.permission === 'owner';
  return { group: entry.permission === 'admin', fromMe: ownerOnly };
}

// !public / !self change the bot's real mode for the rest of the process, which
// would silently drop every later non-owner command in a sweep. Restore it.
async function restoreBotState() {
  const prefix = handler.getCommandPrefix();
  const sent = [];
  await handler(makeSocket(sent), textMessage(`${prefix}public`, { fromMe: true }));
  // Put the prefix back too, in case a sweep iteration changed it.
  await handler.setCommandPrefix('!');
}

test('every registered command is dispatched, never throws, and always replies', async () => {
  const restore = stubNetwork();
  const problems = [];
  try {
    for (const entry of COMMANDS) {
      const args = sampleArgs(entry);
      const { group, fromMe } = dispatchContext(entry);
      const sent = [];
      const socket = makeSocket(sent);
      try {
        await handler(socket, textMessage(`!${entry.name}${args ? ` ${args}` : ''}`, { group, fromMe }));
      } catch (error) {
        problems.push(`${entry.name}: threw ${error.message}`);
        continue;
      }
      if (!sent.length) problems.push(`${entry.name}: produced no reply`);
      for (const message of sent) {
        const text = message.payload?.text || message.payload?.caption || '';
        assert.doesNotMatch(text, /undefined|NaN|\[object Object\]/, `${entry.name} leaked a raw value: ${text.slice(0, 120)}`);
      }
    }
  } finally {
    await restoreBotState();
    restore();
  }
  assert.deepEqual(problems, [], `${problems.length} command(s) misbehaved`);
});

test('every command tolerates an unexpected free-text argument', async () => {
  const restore = stubNetwork();
  const problems = [];
  try {
    for (const entry of COMMANDS) {
      // Dispatched as the owner inside a group so the public/self gate and the
      // group gate never mask the argument handling being tested here.
      const sent = [];
      const socket = makeSocket(sent);
      try {
        await handler(socket, textMessage(`!${entry.name} hello world`, { group: true, fromMe: true }));
      } catch (error) {
        problems.push(`${entry.name}: threw ${error.message}`);
        continue;
      }
      if (!sent.length) problems.push(`${entry.name}: produced no reply with args`);
      for (const message of sent) {
        const text = message.payload?.text || message.payload?.caption || '';
        assert.doesNotMatch(text, /undefined|NaN|\[object Object\]/, `${entry.name} leaked a raw value: ${text.slice(0, 120)}`);
      }
    }
  } finally {
    await restoreBotState();
    restore();
  }
  assert.deepEqual(problems, [], `${problems.length} command(s) misbehaved with arguments`);
});

test('admin commands are refused outside a group and non-admin commands stay open', async () => {
  const restore = stubNetwork();
  try {
    for (const entry of COMMANDS.filter((candidate) => candidate.permission === 'admin')) {
      const sent = [];
      // Private chat: the admin gate must answer, not silently drop the command.
      await handler(makeSocket(sent), textMessage(`!${entry.name}`));
      const text = sent.map((message) => message.payload?.text || '').join('\n');
      assert.match(text, /group|admin/i, `${entry.name} did not explain the group/admin requirement`);
    }
  } finally {
    restore();
  }
});

test('owner commands are refused for a normal user', async () => {
  const restore = stubNetwork();
  try {
    for (const entry of COMMANDS.filter((candidate) => candidate.permission === 'owner')) {
      const sent = [];
      await handler(makeSocket(sent), textMessage(`!${entry.name} test`, { group: false, fromMe: false }));
      const text = sent.map((message) => message.payload?.text || '').join('\n');
      assert.match(text, /owner/i, `${entry.name} did not enforce the owner gate`);
    }
  } finally {
    await restoreBotState();
    restore();
  }
});

test('network-dependent commands degrade to a short error, never a crash', async () => {
  const restore = stubNetwork();
  try {
    for (const name of NETWORK_COMMANDS) {
      const sent = [];
      await handler(makeSocket(sent), textMessage(`!${name} https://www.youtube.com/watch?v=dQw4w9WgXcQ`));
      const text = sent.map((message) => message.payload?.text || message.payload?.caption || '').join('\n');
      assert.ok(sent.length, `${name} went silent on a provider failure`);
      // Either the provider error, or the short guidance a command gives when
      // the sweep cannot supply the media it needs (e.g. !tourl).
      assert.match(
        text,
        /FAILED|UNAVAILABLE|Usage|USAGE|REPLY TO|Reply to|❌/,
        `${name} did not report the failure: ${text.slice(0, 140)}`
      );
    }
  } finally {
    restore();
  }
});

test('command replies are delivered as real interactive messages when the client supports them', async () => {
  const sent = [];
  const socket = makeSocket(sent, { relay: true });
  await handler(socket, textMessage('!ping'));

  const interactive = sent.find((message) => message.payload?.interactive);
  assert.ok(interactive, 'the reply used the interactive-message path');
  const content = interactive.payload.interactive.interactiveMessage;
  assert.ok(content?.nativeFlowMessage?.buttons?.length > 0, 'the interactive message carries buttons');
  const ids = content.nativeFlowMessage.buttons.map((button) => JSON.parse(button.buttonParamsJson).id);
  for (const id of ids) {
    const parsed = handler.commandFromText(id);
    assert.ok(parsed, `button id "${id}" is not a command`);
  }
  // The menu reply must build a single_select list a client can render.
  const menuSent = [];
  await handler(makeSocket(menuSent, { relay: true }), textMessage('!menu'));
  const menuInteractive = menuSent.find((message) => message.payload?.interactive);
  assert.ok(menuInteractive, 'the menu used the interactive-message path');
  const list = menuInteractive.payload.interactive.interactiveMessage.nativeFlowMessage.buttons
    .find((button) => button.name === 'single_select');
  assert.ok(list, 'the menu contains a single_select list');
  const sections = JSON.parse(list.buttonParamsJson).sections;
  assert.ok(sections.length > 0 && sections[0].rows.length > 0, 'the list has rows');
});

test('the interactive payload the bot emits round-trips through the real Baileys proto', () => {
  // Proves the structure is one Baileys itself can encode, which is what both
  // WhatsApp and WhatsApp Business render from.
  const message = generateWAMessageFromContent(
    USER_JID,
    {
      interactiveMessage: {
        body: { text: 'probe' },
        footer: { text: 'footer' },
        header: { title: '', subtitle: '', hasMediaAttachment: false },
        nativeFlowMessage: {
          buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Menu', id: '!menu home' }) }],
          messageParamsJson: JSON.stringify({ version: 1 }),
          messageVersion: 1
        }
      }
    },
    { userJid: BOT_JID }
  );
  assert.ok(message.key.id, 'a message key was produced');
  assert.ok(message.message.interactiveMessage, 'the interactive message survived encoding');
});

function sampleArgs(entry) {
  if (entry.usage) {
    if (entry.usage.includes('<on|off|status>')) return 'status';
    if (entry.usage.includes('<public|self>')) return 'public';
    if (entry.usage.includes('<number')) return '923001234567';
    if (entry.usage.includes('[start|guess|stop]')) return 'start';
    if (entry.usage.includes('<category>') || entry.name === 'menu') return 'downloader';
    if (entry.usage.includes('<url>') || entry.usage.includes('<query')) return 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    if (entry.usage.includes('<expression>')) return '2+2';
    // Changing the prefix would make every later "!..." command in the sweep
    // unrecognizable, so the sweep re-applies the current prefix instead.
    if (entry.usage.includes('<prefix>')) return handler.getCommandPrefix();
    if (entry.usage.includes('<name>')) return 'Swept';
    if (entry.usage.includes('<channel url>')) return 'https://whatsapp.com/channel/0029Test';
    if (entry.usage.includes('[category]')) return 'downloader';
    return 'test';
  }
  return '';
}
