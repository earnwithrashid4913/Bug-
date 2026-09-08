'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { assertWhatsappNumber, config, loadConfig } = require('../system/config');
const { CANONICAL_IDENTITY } = require('../system/security');
const handleMessage = require('../system/handler');
const { commandFromText, getCommandPrefix, setCommandPrefix } = handleMessage;
const {
  extractText,
  getImageMessage,
  getStickerMessage,
  getTargetJid,
  resolveJid
} = require('../system/lib/message');
const { groupSettings, handleGroupParticipantsUpdate, renderGroupMessage } = require('../system/group-events');
const { AI_REQUEST_COOLDOWN_MS, askGroq, buildGroqRequest, reserveAiRequest } = require('../system/lib/ai');
const { safeMath } = require('../system/lib/net-tools');
const { GroupSettingsStore } = require('../system/lib/group-settings');
const { COMMANDS, allAliases, resolveCommand } = require('../system/lib/menu');
const { convertStickerToImage, createImageSticker } = require('../system/lib/sticker');
const { sendList } = require('../system/lib/ui');
const { PremiumStore, parseDuration } = require('../system/lib/premium');
const sharp = require('sharp');

test('configuration exposes canonical identity without a deployment pairing number', () => {
  assert.equal(config.ownerName, 'Rashid Hussain');
  // Identity comes from the canonical source in system/security.js, so it
  // cannot drift from the protected project identity.
  assert.equal(config.projectName, CANONICAL_IDENTITY.projectName);
  assert.equal(config.developerBrand, CANONICAL_IDENTITY.organization);
  assert.equal(config.developerName, CANONICAL_IDENTITY.developer);
  assert.equal(config.authorName, CANONICAL_IDENTITY.author);
  assert.equal(config.commandPrefix, '!');
  assert.equal(config.botName, CANONICAL_IDENTITY.projectName);
  assert.equal(config.stickerPackname, CANONICAL_IDENTITY.projectName);
  assert.equal(config.stickerAuthor, CANONICAL_IDENTITY.developer);
  assert.equal(config.groqModel, 'openai/gpt-oss-20b');
  assert.equal(config.authMethod, 'pairing');
});

test('WhatsApp number validation rejects a leading plus sign', () => {
  assert.equal(assertWhatsappNumber('923001234567'), '923001234567');
  assert.throws(() => assertWhatsappNumber('+923001234567'), /without \+/);
  assert.throws(() => assertWhatsappNumber('12345'), /7-15 digits/);
  assert.throws(() => assertWhatsappNumber('+15551234567', 'Phone number'), /Phone number must not contain/);
});

test('Telegram configuration is read from config.js-shaped values', () => {
  const source = structuredClone(require('../config'));
  source.telegram.botToken = 'test-token';
  source.telegram.botLink = 'https://t.me/test_bot';
  source.telegram.ownerIds = ['12345', '67890'];
  const telegramConfig = loadConfig(source);
  assert.equal(telegramConfig.telegramBotToken, 'test-token');
  assert.equal(telegramConfig.telegramBotLink, 'https://t.me/test_bot');
  assert.deepEqual(telegramConfig.telegramOwnerIds, ['12345', '67890']);
});

test('Telegram pairing is optional and has no static WhatsApp phone number', () => {
  const source = structuredClone(require('../config'));
  source.telegram.enabled = false;
  source.telegram.botToken = '';
  source.telegram.ownerIds = [];
  const withoutTelegram = loadConfig(source);
  assert.equal(withoutTelegram.telegramBotToken, '');
  assert.equal(withoutTelegram.telegramBotLink, '');
  assert.deepEqual(withoutTelegram.telegramOwnerIds, []);
});

test('configuration rejects an insecure Telegram link with a clear config.js error', () => {
  const source = structuredClone(require('../config'));
  source.telegram.botLink = 'http://t.me/not_secure';
  assert.throws(() => loadConfig(source), /telegram\.botLink must be a valid HTTPS URL/);
});

test('command parser accepts only the configured prefix', () => {
  assert.deepEqual(commandFromText('!addprem 15551234567 30d'), {
    name: 'addprem',
    args: ['15551234567', '30d'],
    text: '15551234567 30d'
  });
  assert.equal(commandFromText('addprem 15551234567'), undefined);
});

test('command names and aliases are unique and resolve to their documented command', () => {
  const names = COMMANDS.flatMap((entry) => [entry.name, ...entry.aliases]);
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(allAliases()).size, names.length);
  assert.equal(resolveCommand('telegram').name, 'telegram');
  assert.equal(resolveCommand('tgpair').name, 'pairing');
});

test('runtime prefix changes update command parsing without mutating frozen config', async () => {
  await setCommandPrefix('$');
  try {
    assert.equal(getCommandPrefix(), '$');
    assert.deepEqual(commandFromText('$ping'), { name: 'ping', args: [], text: '' });
    assert.equal(commandFromText('!ping'), undefined);
    assert.equal(config.commandPrefix, '!');
  } finally {
    await setCommandPrefix('!');
  }
});

test('message text extraction handles standard and interactive messages', () => {
  assert.equal(extractText({ conversation: '!ping' }), '!ping');
  assert.equal(
    extractText({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"!menu"}' } } }),
    '!menu'
  );
});

test('image messages can be found directly or in a quoted message', () => {
  const direct = { message: { imageMessage: { mimetype: 'image/png', url: 'direct' } } };
  const quoted = {
    message: {
      extendedTextMessage: {
        contextInfo: {
          quotedMessage: { imageMessage: { mimetype: 'image/jpeg', url: 'quoted' } }
        }
      }
    }
  };

  assert.equal(getImageMessage(direct).url, 'direct');
  assert.equal(getImageMessage(quoted).url, 'quoted');
});

test('sticker and target helpers support direct or quoted command context', () => {
  const direct = { message: { stickerMessage: { mimetype: 'image/webp', url: 'sticker' } } };
  const quoted = {
    message: {
      extendedTextMessage: {
        contextInfo: {
          participant: '15551234567@s.whatsapp.net',
          mentionedJid: ['15551234568@s.whatsapp.net'],
          quotedMessage: { stickerMessage: { mimetype: 'image/webp', url: 'quoted-sticker' } }
        }
      }
    }
  };

  assert.equal(getStickerMessage(direct).url, 'sticker');
  assert.equal(getStickerMessage(quoted).url, 'quoted-sticker');
  assert.equal(getTargetJid(quoted), '15551234568@s.whatsapp.net');
});

test('image sticker converter emits a WebP sticker with pack metadata', async () => {
  const source = await sharp({
    create: { width: 32, height: 20, channels: 4, background: { r: 20, g: 120, b: 80, alpha: 1 } }
  }).png().toBuffer();
  const sticker = await createImageSticker(source, {
    packname: 'ANIME MD',
    author: 'Only Fixa Dev'
  });

  assert.equal(sticker.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(sticker.subarray(8, 12).toString('ascii'), 'WEBP');

  const image = await convertStickerToImage(sticker);
  assert.equal(image.subarray(1, 4).toString('ascii'), 'PNG');
});

test('AI request builder is bounded and requires an explicitly configured key', async () => {
  const request = buildGroqRequest('Hello', 'openai/gpt-oss-20b', 'ANIME MD');
  assert.equal(request.model, 'openai/gpt-oss-20b');
  assert.equal(request.messages[1].content, 'Hello');
  await assert.rejects(askGroq({ apiKey: '', model: request.model, prompt: 'Hello', botName: 'ANIME MD' }), /not configured/);

  const sender = 'ai-test@s.whatsapp.net';
  reserveAiRequest(sender);
  assert.throws(() => reserveAiRequest(sender), /Please wait/);
  assert.equal(AI_REQUEST_COOLDOWN_MS, 30_000);
});

test('calculator evaluates supported arithmetic without dynamic code execution', () => {
  assert.equal(safeMath('2 + 3 * (4 - 1)'), 11);
  assert.equal(safeMath('-5.5 % 2'), -1.5);
  assert.throws(() => safeMath('process.exit()'), /Only numbers/);
  assert.throws(() => safeMath('2 + )'), /Expected a number/);
});

test('LID senders resolve to mapped phone-number JIDs when available', async () => {
  const socket = {
    decodeJid: (jid) => jid.replace(/:\d+@/, '@'),
    signalRepository: {
      lidMapping: {
        getPNForLID: async (jid) => (jid === '12345@lid' ? '15551234567@s.whatsapp.net' : null)
      }
    }
  };

  assert.equal(await resolveJid(socket, '12345@lid'), '15551234567@s.whatsapp.net');
});

test('command handler dispatches a menu response', async () => {
  const sent = [];
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => jid.replace(/:\d+@/, '@'),
    sendMessage: async (chatId, payload, options) => {
      sent.push({ chatId, payload, options });
      return { key: { id: 'test-message' } };
    }
  };
  const message = {
    key: {
      remoteJid: '15551234568@s.whatsapp.net',
      participant: '15551234568@s.whatsapp.net',
      fromMe: false
    },
    message: { conversation: '!menu' }
  };

  await handleMessage(socket, message);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, message.key.remoteJid);
  assert.ok(sent[0].payload.text, 'menu response should contain text');
});

test('command send failures are awaited instead of becoming unhandled rejections', async () => {
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => jid,
    sendMessage: async () => { throw new Error('transport unavailable'); }
  };
  await assert.rejects(handleMessage(socket, {
    key: { remoteJid: '15551234568@s.whatsapp.net', participant: '15551234568@s.whatsapp.net', fromMe: false },
    message: { conversation: '!dice' }
  }), /transport unavailable/);
});

test('sticker command provides usage text when no image is supplied', async () => {
  const sent = [];
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => jid.replace(/:\d+@/, '@'),
    sendMessage: async (chatId, payload, options) => {
      sent.push({ chatId, payload, options });
      return { key: { id: 'test-message' } };
    }
  };

  await handleMessage(socket, {
    key: {
      remoteJid: '15551234568@s.whatsapp.net',
      participant: '15551234568@s.whatsapp.net',
      fromMe: false
    },
    message: { conversation: '!sticker' }
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.text, /Reply to an image/);
});

test('profile picture command uses the current Baileys profile picture API', async () => {
  const sent = [];
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => jid.replace(/:\d+@/, '@'),
    profilePictureUrl: async () => 'https://example.invalid/profile.jpg',
    sendMessage: async (chatId, payload, options) => {
      sent.push({ chatId, payload, options });
      return { key: { id: 'test-message' } };
    }
  };

  await handleMessage(socket, {
    key: {
      remoteJid: '15551234568@s.whatsapp.net',
      participant: '15551234568@s.whatsapp.net',
      fromMe: false
    },
    message: { conversation: '!getpp' }
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.image.url, 'https://example.invalid/profile.jpg');
});

test('group management help is available only to a group admin', async () => {
  const sent = [];
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => jid.replace(/:\d+@/, '@'),
    groupMetadata: async () => ({
      subject: 'Test Group',
      participants: [
        { id: '15551234567@s.whatsapp.net', admin: 'admin' },
        { id: '15551234568@s.whatsapp.net', admin: 'admin' }
      ]
    }),
    sendMessage: async (chatId, payload, options) => {
      sent.push({ chatId, payload, options });
      return { key: { id: 'test-message' } };
    }
  };

  await handleMessage(socket, {
    key: {
      remoteJid: '123456789@g.us',
      participant: '15551234568@s.whatsapp.net',
      fromMe: false
    },
    message: { conversation: '!group' }
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.text, /Safe group management/);
});

test('premium duration parser validates supported units', () => {
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.throws(() => parseDuration('forever'), /Duration must use/);
});

test('group settings persist greeting toggles and render templates', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'black-clover-groups-'));
  const store = new GroupSettingsStore(path.join(directory, 'groups.json'));

  try {
  assert.deepEqual(await store.get('123@g.us'), {
    welcomeEnabled: false,
    goodbyeEnabled: false,
    antilink: false,
    antispam: false,
    antimention: false,
    antitag: false,
    antidelete: false,
    autoreact: false,
    autowrite: false
  });
  assert.deepEqual(
    await store.update('123@g.us', { welcomeEnabled: true }),
    {
      welcomeEnabled: true,
      goodbyeEnabled: false,
      antilink: false,
      antispam: false,
      antimention: false,
      antitag: false,
      antidelete: false,
      autoreact: false,
      autowrite: false
    }
  );
    assert.equal(renderGroupMessage('Welcome @user to @group', '15551234567@s.whatsapp.net', 'Test Group'), 'Welcome @15551234567 to Test Group');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('group participant events send greetings only when enabled', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'black-clover-events-'));
  const originalPath = groupSettings.filePath;
  groupSettings.filePath = path.join(directory, 'groups.json');
  const sent = [];
  const socket = {
    decodeJid: (jid) => jid.replace(/:\d+@/, '@'),
    groupMetadata: async () => ({ subject: 'Test Group' }),
    sendMessage: async (chatId, payload) => sent.push({ chatId, payload })
  };

  try {
    await groupSettings.update('123@g.us', { welcomeEnabled: true });
    await handleGroupParticipantsUpdate(socket, {
      id: '123@g.us',
      action: 'add',
      participants: ['15551234567@s.whatsapp.net']
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].payload.text, /@15551234567/);
  } finally {
    groupSettings.filePath = originalPath;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('premium store writes, lists, and removes an active record', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'only-fixa-premium-'));
  const databasePath = path.join(directory, 'premium.json');
  const store = new PremiumStore(databasePath);

  try {
    const record = await store.add('15551234567', '1d');
    assert.equal(record.id, '15551234567');
    assert.equal((await store.list()).length, 1);
    assert.equal(await store.remove('15551234567'), true);
    assert.deepEqual(await store.list(), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Interactive menu surface: rows and buttons follow the live command prefix.
// ---------------------------------------------------------------------------

test('the interactive menu rows use the live command prefix', async () => {
  const relayed = [];
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => jid.replace(/:\\d+@/, '@'),
    sendMessage: async () => ({ key: { id: 'fallback' } }),
    relayMessage: async (chatId, message) => { relayed.push({ chatId, message }); }
  };
  await setCommandPrefix('$');
  try {
    await handleMessage(socket, {
      key: { remoteJid: '15551234568@s.whatsapp.net', participant: '15551234568@s.whatsapp.net', fromMe: false },
      message: { conversation: '$menu' }
    });
    assert.equal(relayed.length, 1, 'the menu is sent through the interactive relay');
    const serialized = JSON.stringify(relayed[0]);
    assert.match(serialized, /\$menu general/, 'category rows use the live prefix');
    assert.doesNotMatch(serialized, /"!menu/, 'no hardcoded !menu ids remain');
    assert.match(serialized, /\$status/, 'quick actions use the live prefix too');

    // A category page is also an interactive list with working actions.
    relayed.length = 0;
    await handleMessage(socket, {
      key: { remoteJid: '15551234568@s.whatsapp.net', participant: '15551234568@s.whatsapp.net', fromMe: false },
      message: { conversation: '$menu games' }
    });
    assert.equal(relayed.length, 1);
    const category = JSON.stringify(relayed[0]);
    assert.match(category, /\$dice/, 'command rows carry their command id');
    assert.match(category, /\$menu home/, 'the home action carries its id');
  } finally {
    await setCommandPrefix('!');
  }
});

test('sendList renders list rows plus quick actions in one interactive message', async () => {
  const relayed = [];
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    sendMessage: async () => ({ key: { id: 'fallback' } }),
    relayMessage: async (chatId, message) => { relayed.push(message); }
  };
  await sendList(socket, 'chat@g.us', {
    text: 'Choose:',
    title: 'Browse',
    sections: [{ title: 'S', rows: [{ header: '⚡', title: 'General', id: '!menu general' }] }],
    actions: [{ label: '🏠 Main Menu', id: '!menu home' }],
    footer: 'ANIME MD'
  });
  const serialized = JSON.stringify(relayed[0]);
  assert.match(serialized, /single_select/, 'the list button is present');
  assert.match(serialized, /quick_reply/, 'the quick action is present');
  assert.match(serialized, /!menu home/, 'the action id survives');
  // Without relay support the fallback keeps every option readable as text.
  const plain = [];
  await sendList({ sendMessage: async (_chatId, payload) => { plain.push(payload.text); } }, 'chat', {
    text: 'Choose:',
    title: 'Browse',
    sections: [{ title: 'S', rows: [{ title: 'General', id: '!menu general' }] }],
    actions: [{ label: '🏠 Main Menu', id: '!menu home' }]
  });
  assert.match(plain[0], /!menu general/);
  assert.match(plain[0], /!menu home/);
});
