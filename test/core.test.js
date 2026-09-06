'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

process.env.BOT_NUMBER = '15551234567';

const { config } = require('../system/config');
const {
  isAuthorizedAdmin,
  isGlobalOwner,
  isPremiumAuthorized,
  loadProtectedIdentity,
  PROTECTED_DEVELOPER,
  verifyIdentityManifest
} = require('../system/security');
const handleMessage = require('../system/handler');
const { commandFromText } = handleMessage;
const {
  extractText,
  getImageMessage,
  getStickerMessage,
  getTargetJid,
  resolveJid
} = require('../system/lib/message');
const { groupSettings, handleGroupParticipantsUpdate, renderGroupMessage } = require('../system/group-events');
const { AI_REQUEST_COOLDOWN_MS, askGroq, buildGroqRequest, reserveAiRequest } = require('../system/lib/ai');
const { GroupSettingsStore } = require('../system/lib/group-settings');
const { convertStickerToImage, createImageSticker } = require('../system/lib/sticker');
const { PremiumStore, parseDuration } = require('../system/lib/premium');
const { DEFAULT_THEME, GOJO_THEME, MAKIMA_THEME, formatThemeSummary, getActiveTheme, listThemes } = require('../system/theme');
const sharp = require('sharp');

test('deployment configuration requires an explicit BOT_NUMBER', () => {
  const missingConnectionNumber = spawnSync(process.execPath, ['-e', "require('./system/config')"], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, BOT_NUMBER: '' },
    encoding: 'utf8'
  });

  assert.notEqual(missingConnectionNumber.status, 0);
  assert.match(missingConnectionNumber.stderr, /BOT_NUMBER is required/);

  const invalidConnectionNumber = spawnSync(process.execPath, ['-e', "require('./system/config')"], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, BOT_NUMBER: '123' },
    encoding: 'utf8'
  });
  assert.notEqual(invalidConnectionNumber.status, 0);
  assert.match(invalidConnectionNumber.stderr, /BOT_NUMBER must contain a 7-15 digit international phone number/);
  assert.equal(config.botNumber, '15551234567');
  assert.equal(config.instanceOwnerName, process.env.INSTANCE_OWNER_NAME || 'Instance Owner');
  assert.equal(config.commandPrefix, '!');
  assert.equal(config.stickerPackname, '𝙂𝙊𝘼𝙏𝙑𝙀𝙍𝙎𝙀 𝙈𝘿');
  assert.equal(config.stickerAuthor, 'Only F!xa Dev');
  assert.equal(config.groqModel, 'openai/gpt-oss-20b');
});

test('legacy connection setting is not an accepted BOT_NUMBER alias', () => {
  const legacyOnly = spawnSync(process.execPath, ['-e', "require('./system/config')"], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, BOT_NUMBER: '', [['BOT', 'CONNECTION_NUMBER'].join('_')]: '15551234568' },
    encoding: 'utf8'
  });

  assert.notEqual(legacyOnly.status, 0);
  assert.match(legacyOnly.stderr, /BOT_NUMBER is required/);
});
test('ordinary environment variables cannot override protected Global Owner authorization', () => {
  const override = spawnSync(process.execPath, ['-e', "require('./system/config')"], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, OWNER_NUMBER: '15551234568' },
    encoding: 'utf8'
  });

  assert.notEqual(override.status, 0);
  assert.match(override.stderr, /Security configuration error: protected identity overrides are not allowed/);

  const developerOverride = spawnSync(process.execPath, ['-e', "require('./system/config')"], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DEVELOPER_IDENTITY: 'Impostor' },
    encoding: 'utf8'
  });
  assert.notEqual(developerOverride.status, 0);
  assert.match(developerOverride.stderr, /Security configuration error: protected identity overrides are not allowed/);
});

test('instance branding is configurable without changing protected authorization', () => {
  const deployment = spawnSync(
    process.execPath,
    ['-e', "const { config } = require('./system/config'); console.log(JSON.stringify({ master: config.masterBotName, number: config.botNumber, owner: config.instanceOwnerName, ownerNumber: config.instanceOwnerNumber, theme: config.theme }));"],
    {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        BOT_NUMBER: '15551234568',
        INSTANCE_OWNER_NAME: 'New Deployer',
        INSTANCE_OWNER_NUMBER: '15551234569',
        THEME: 'gojo'
      },
      encoding: 'utf8'
    }
  );

  assert.equal(deployment.status, 0);
  assert.deepEqual(JSON.parse(deployment.stdout), {
    master: '𝙂𝙊𝘼𝙏𝙑𝙀𝙍𝙎𝙀 𝙈𝘿',
    number: '15551234568',
    owner: 'New Deployer',
    ownerNumber: '15551234569',
    theme: 'gojo'
  });
  assert.equal(isGlobalOwner({ decodeJid: (jid) => jid }, '15551234568@s.whatsapp.net'), false);
  assert.equal(isAuthorizedAdmin({ decodeJid: (jid) => jid }, '15551234569@s.whatsapp.net', '15551234569'), true);
  assert.equal(isGlobalOwner({ decodeJid: (jid) => jid }, '15551234569@s.whatsapp.net'), false);
});

test('premium authorization remains tied to authorized identities', () => {
  const socket = { decodeJid: (jid) => jid };
  assert.equal(isPremiumAuthorized(socket, '15551234569@s.whatsapp.net', '15551234569'), true);
  assert.equal(isPremiumAuthorized(socket, '15551234568@s.whatsapp.net', '15551234569'), false);
});

test('unknown theme IDs safely fall back without changing the master identity', () => {
  assert.equal(getActiveTheme('default'), DEFAULT_THEME);
  assert.equal(getActiveTheme('GOJO'), GOJO_THEME);
  assert.equal(getActiveTheme('makima'), MAKIMA_THEME);
  assert.equal(getActiveTheme('future-theme'), DEFAULT_THEME);
  assert.deepEqual(listThemes().map((theme) => theme.id), ['default', 'gojo', 'sukuna', 'asta', 'nami', 'nezuko', 'shinobu', 'makima']);
  assert.match(formatThemeSummary(GOJO_THEME), /Satoru Gojo/);
  assert.equal(config.masterBotName, '𝙂𝙊𝘼𝙏𝙑𝙀𝙍𝙎𝙀 𝙈𝘿');
});

test('protected identity manifests are HMAC verified and fail closed when tampered', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goatverse-identity-'));
  const manifestPath = path.join(directory, 'identity.json');
  const secret = 'external-test-secret';
  const manifest = { developer: PROTECTED_DEVELOPER, globalOwnerNumbers: ['15551234560'], developerNumbers: ['15551234561'] };
  const crypto = require('node:crypto');
  manifest.signature = crypto.createHmac('sha256', secret)
    .update(JSON.stringify({ developer: PROTECTED_DEVELOPER, globalOwnerNumbers: ['15551234560'], developerNumbers: ['15551234561'] }))
    .digest('hex');
  assert.equal(verifyIdentityManifest(manifest, secret), true);
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal(loadProtectedIdentity({ GOATVERSE_TRUSTED_IDENTITY_FILE: manifestPath, GOATVERSE_TRUSTED_IDENTITY_HMAC_KEY: secret }).locked, false);
  manifest.globalOwnerNumbers = ['15551234569'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const tampered = loadProtectedIdentity({ GOATVERSE_TRUSTED_IDENTITY_FILE: manifestPath, GOATVERSE_TRUSTED_IDENTITY_HMAC_KEY: secret });
  assert.equal(tampered.locked, true);
  assert.equal(tampered.globalOwners.size, 0);

  const lockedRuntime = spawnSync(process.execPath, ['-e', "const s = require('./system/security'); console.log(s.isAuthorizedAdmin({ decodeJid: x => x }, '15551234560@s.whatsapp.net', '15551234569'))"], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, GOATVERSE_TRUSTED_IDENTITY_FILE: manifestPath, GOATVERSE_TRUSTED_IDENTITY_HMAC_KEY: secret },
    encoding: 'utf8'
  });
  assert.equal(lockedRuntime.status, 0);
  assert.equal(lockedRuntime.stdout.trim(), 'false');
});

test('authenticated WhatsApp account must match the configured bot number', () => {
  const matchingConnection = spawnSync(
    process.execPath,
    ['-e', "require('./index').assertConnectedBotIdentity({ user: { id: '15551234567@s.whatsapp.net' } })"],
    {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, BOT_DRY_RUN: 'true' },
      encoding: 'utf8'
    }
  );
  assert.equal(matchingConnection.status, 0);

  const mismatchedConnection = spawnSync(
    process.execPath,
    ['-e', "require('./index').assertConnectedBotIdentity({ user: { id: '15551234568@s.whatsapp.net' } })"],
    {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, BOT_DRY_RUN: 'true' },
      encoding: 'utf8'
    }
  );
  assert.notEqual(mismatchedConnection.status, 0);
  assert.match(mismatchedConnection.stderr, /Bot connection identity mismatch/);
});

test('command parser accepts only the configured prefix', () => {
  assert.deepEqual(commandFromText('!addprem 15551234567 30d'), {
    name: 'addprem',
    args: ['15551234567', '30d'],
    text: '15551234567 30d'
  });
  assert.equal(commandFromText('addprem 15551234567'), undefined);
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
    packname: '𝙂𝙊𝘼𝙏𝙑𝙀𝙍𝙎𝙀 𝙈𝘿',
    author: 'Only F!xa Dev'
  });

  assert.equal(sticker.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(sticker.subarray(8, 12).toString('ascii'), 'WEBP');

  const image = await convertStickerToImage(sticker);
  assert.equal(image.subarray(1, 4).toString('ascii'), 'PNG');
});

test('AI request builder is bounded and requires an explicitly configured key', async () => {
  const request = buildGroqRequest('Hello', 'openai/gpt-oss-20b', '𝙂𝙊𝘼𝙏𝙑𝙀𝙍𝙎𝙀 𝙈𝘿');
  assert.equal(request.model, 'openai/gpt-oss-20b');
  assert.equal(request.messages[1].content, 'Hello');
  await assert.rejects(askGroq({ apiKey: '', model: request.model, prompt: 'Hello', botName: '𝙂𝙊𝘼𝙏𝙑𝙀𝙍𝙎𝙀 𝙈𝘿' }), /not configured/);

  const sender = 'ai-test@s.whatsapp.net';
  reserveAiRequest(sender);
  assert.throws(() => reserveAiRequest(sender), /Please wait/);
  assert.equal(AI_REQUEST_COOLDOWN_MS, 30_000);
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
  assert.match(sent[0].payload.text, /General commands/);
});

test('command handler displays the configured character theme', async () => {
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
    key: { remoteJid: '15551234568@s.whatsapp.net', participant: '15551234568@s.whatsapp.net', fromMe: false },
    message: { conversation: '!theme' }
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.text, /Available themes/);
  assert.match(sent[0].payload.text, /gojo — Satoru Gojo/);
  assert.match(sent[0].payload.text, /makima — Makima/);
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

test('group management recognizes a bot admin represented by a Privacy LID', async () => {
  let updatedSubject;
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => jid.replace(/:\d+@/, '@'),
    signalRepository: {
      lidMapping: {
        getPNForLID: async (jid) => (jid === 'bot-lid@lid' ? '15551234567@s.whatsapp.net' : null)
      }
    },
    groupMetadata: async () => ({
      subject: 'Test Group',
      participants: [
        { id: 'bot-lid@lid', admin: 'admin' },
        { id: '15551234568@s.whatsapp.net', admin: 'admin' }
      ]
    }),
    groupUpdateSubject: async (_chatId, subject) => {
      updatedSubject = subject;
    },
    sendMessage: async () => ({ key: { id: 'test-message' } })
  };

  await handleMessage(socket, {
    key: {
      remoteJid: '123456789@g.us',
      participant: '15551234568@s.whatsapp.net',
      fromMe: false
    },
    message: { conversation: '!gname Updated Group' }
  });

  assert.equal(updatedSubject, 'Updated Group');
});

test('premium duration parser validates supported units', () => {
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.throws(() => parseDuration('forever'), /Duration must use/);
  for (const duration of ['0s', '0m', '0h', '0d']) {
    assert.throws(() => parseDuration(duration), /at least 1 second/);
  }
});

test('group settings persist greeting toggles and render templates', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goatverse-groups-'));
  const store = new GroupSettingsStore(path.join(directory, 'groups.json'));

  try {
    assert.deepEqual(await store.get('123@g.us'), { welcomeEnabled: false, goodbyeEnabled: false });
    assert.deepEqual(
      await store.update('123@g.us', { welcomeEnabled: true }),
      { welcomeEnabled: true, goodbyeEnabled: false }
    );
    assert.equal(renderGroupMessage('Welcome @user to @group', '15551234567@s.whatsapp.net', 'Test Group'), 'Welcome @15551234567 to Test Group');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('group participant events send greetings only when enabled', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goatverse-events-'));
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
    assert.equal(await store.has('15551234567'), true);
    assert.equal(await store.remove('15551234567'), true);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.has('15551234567'), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('canonical identity is immutable and verified on startup', () => {
  const { CANONICAL_IDENTITY, verifyCanonicalIdentity } = require('../system/security');
  assert.equal(CANONICAL_IDENTITY.projectName, '𝙂𝙊𝘼𝙏𝙑𝙀𝙍𝙎𝙀 𝙈𝘿');
  assert.equal(CANONICAL_IDENTITY.organization, 'GOATS MODS');
  assert.equal(CANONICAL_IDENTITY.developer, 'Only F!xa Dev');
  assert.equal(CANONICAL_IDENTITY.author, 'RaShiD Hussain');
  assert.equal(verifyCanonicalIdentity(), true);
  assert.throws(() => {
    CANONICAL_IDENTITY.developer = 'Imposter';
  });
});
