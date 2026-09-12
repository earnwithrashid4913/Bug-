'use strict';

// ---------------------------------------------------------------------------
// Full WhatsApp button audit.
//
// For EVERY button the bot can emit, this traces the complete chain:
//
//   BUTTON → callback id → handler → registered command → result
//
// It covers quick-reply buttons, single_select list rows, the on/off/status
// setting rows, prefix changes, and a real "click" delivered the way WhatsApp
// and WhatsApp Business both deliver it (interactiveResponseMessage with a
// nativeFlowResponseMessage.paramsJson payload).
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const test = require('node:test');
const handler = require('../system/handler');
const { COMMANDS, categoriesWithCommands, resolveCommand } = require('../system/lib/menu');
const { MAX_QUICK_BUTTONS, cleanText, listButton, quickButton } = require('../system/lib/ui');
const {
  contextButtons,
  settingButtons,
  menuButton,
  backButton,
  safeCommandId,
  toggleButtons
} = require('../system/lib/whatsapp-actions');

// A realistic reply context: a downloadable query, a media URL, a track name.
const CTX = {
  query: 'Alan Walker Faded',
  url: 'https://vm.tiktok.com/ZM8xYz/',
  track: 'Faded Alan Walker'
};

const REGISTERED = new Set();
for (const entry of COMMANDS) {
  REGISTERED.add(entry.name);
  for (const alias of entry.aliases) REGISTERED.add(alias);
}

// ---------------------------------------------------------------------------
// Structural audit of every emitted button id.
// ---------------------------------------------------------------------------

function auditButtonId(id, where) {
  assert.equal(typeof id, 'string', `${where}: id is a string`);
  assert.ok(id.length > 0, `${where}: id is not empty`);
  assert.ok(id.length <= 200, `${where}: id "${id}" exceeds the 200-character paramsJson limit`);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(id, /[\u0000-\u001F\u007F]/, `${where}: id "${id}" contains a control character`);
  assert.equal(id, id.replace(/\s+/g, ' ').trim(), `${where}: id "${id}" has stray whitespace`);

  // The id must parse exactly like a typed command.
  const parsed = handler.commandFromText(id);
  assert.ok(parsed, `${where}: id "${id}" does not parse as a command`);
  assert.ok(REGISTERED.has(parsed.name), `${where}: id "${id}" maps to unregistered command "${parsed.name}"`);
  return parsed;
}

function auditRow(prefix, commandName, buttons, label) {
  assert.ok(buttons.length <= MAX_QUICK_BUTTONS, `${label}: ${buttons.length} buttons exceeds the ${MAX_QUICK_BUTTONS}-button client limit`);
  const ids = new Set();
  for (const button of buttons) {
    assert.ok(button.label && button.label.trim(), `${label}: a button has no label`);
    assert.ok(button.label.length <= 60, `${label}: label "${button.label}" exceeds 60 characters`);
    assert.doesNotMatch(button.label, /[\u0000-\u001F\u007F]/, `${label}: label has a control character`);
    assert.ok(!ids.has(button.id), `${label}: duplicate callback id "${button.id}"`);
    ids.add(button.id);
    auditButtonId(button.id, `${label} [${button.label}]`);
  }
  return buttons;
}

test('every command has a button row and every button reaches a registered handler', () => {
  let audited = 0;
  for (const entry of COMMANDS) {
    const buttons = auditRow('!', entry.name, contextButtons('!', entry.name, CTX), entry.name);
    assert.ok(buttons.length >= 1, `${entry.name}: has no buttons at all`);
    audited += buttons.length;

    // Setting commands also expose an on/off/status row.
    auditRow('!', entry.name, settingButtons('!', entry.name, { showStatus: true }), `${entry.name} (toggle row)`);
    audited += settingButtons('!', entry.name, { showStatus: true }).length;
    audited += auditRow('!', entry.name, settingButtons('!', entry.name, { enabled: true, showStatus: false }), `${entry.name} (applied row)`).length;
  }
  assert.ok(audited > 300, `expected a full audit, only saw ${audited} buttons`);
});

test('menu list rows are real commands and survive the row limits', () => {
  for (const category of categoriesWithCommands()) {
    const rows = category.commands.map((entry) => ({
      header: category.icon,
      title: `!${entry.name}`,
      description: entry.description,
      id: safeCommandId('!', entry.name)
    }));
    for (const row of rows) {
      auditButtonId(row.id, `${category.id} list row "${row.title}"`);
      assert.ok(row.title.length <= 80, `${category.id}: row title too long`);
      assert.ok(row.description.length <= 120, `${category.id}: row description too long`);
    }
    // WhatsApp accepts at most 30 rows per section; no category exceeds it.
    assert.ok(rows.length <= 30, `${category.id} has ${rows.length} rows (> 30)`);
    // The category menu row itself must open a real category view.
    auditButtonId(safeCommandId('!', 'menu', category.id), `${category.id} category row`);
  }
});

test('buttons are rebuilt from the live prefix, so they survive !setprefix and reconnects', async () => {
  const original = handler.getCommandPrefix();
  try {
    await handler.setCommandPrefix('.');
    assert.equal(handler.getCommandPrefix(), '.');
    for (const button of contextButtons('.', 'play', CTX)) {
      assert.ok(button.id.startsWith('.'), `button id "${button.id}" did not follow the new prefix`);
      const parsed = handler.commandFromText(button.id);
      assert.ok(parsed && REGISTERED.has(parsed.name), `"${button.id}" is unparseable after the prefix change`);
    }
  } finally {
    await handler.setCommandPrefix(original);
  }
});

test('button ids are sanitized for the paramsJson payload', () => {
  assert.equal(safeCommandId('!', 'play', 'a\u0000b\nc'), '!play a b c');
  assert.equal(safeCommandId('!', 'play', '  spaced   out  '), '!play spaced out');
  assert.equal(safeCommandId('!', 'menu'), '!menu');
  assert.equal(safeCommandId('!', 'play', 'x'.repeat(500)).length, 200);
  // A newline inside an id would break the client's paramsJson round trip.
  assert.doesNotMatch(quickButton('Menu', '!menu\nhome').buttonParamsJson, /\n/);
  assert.equal(JSON.parse(quickButton('Menu', '!menu home').buttonParamsJson).id, '!menu home');
  // cleanText must never emit a control character.
  assert.equal(cleanText('a\u0007b'), 'ab');
  // A list button with no usable rows still serializes to valid JSON.
  const list = listButton('Title', [{ title: 'Rows', rows: [] }]);
  assert.doesNotThrow(() => JSON.parse(list.buttonParamsJson));
});

test('the toggle row always reflects the setting it controls', () => {
  const row = toggleButtons('!', 'antilink');
  assert.deepEqual(row.map((button) => button.id), ['!antilink on', '!antilink off', '!antilink status']);
  const applied = settingButtons('!', 'welcome', { enabled: true, showStatus: false });
  assert.equal(applied[0].id, '!welcome off', 'an enabled setting offers to turn it off');
  assert.ok(applied.some((button) => button.id === '!menu group'), 'the applied row navigates back to its category');
  assert.ok(applied.some((button) => button.id === '!menu home'), 'the applied row can reach the main menu');
});

test('navigation helpers always point at real menu views', () => {
  assert.equal(menuButton('!').id, '!menu home');
  assert.equal(menuButton('!', 'downloader').id, '!menu downloader');
  assert.equal(backButton('!', 'rpg').id, '!menu rpg');
  assert.equal(backButton('!', undefined), undefined);
});

// ---------------------------------------------------------------------------
// Real "click" simulation: the payload WhatsApp / WhatsApp Business send back.
// ---------------------------------------------------------------------------

function makeSocket(sent) {
  return {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => String(jid).replace(/:\d+@/, '@'),
    public: true,
    sendMessage: async (chatId, payload) => {
      sent.push({ chatId, payload });
      return { key: { id: 'click-result' } };
    }
  };
}

// Exactly what Baileys 7 hands to messages.upsert when a quick_reply button or
// a single_select row is tapped on either client.
function clickMessage(id, senderJid = '15551234568@s.whatsapp.net') {
  return {
    key: { remoteJid: senderJid, participant: senderJid, fromMe: false },
    message: {
      interactiveResponseMessage: {
        nativeFlowResponseMessage: {
          name: 'quick_reply',
          paramsJson: JSON.stringify({ id })
        }
      }
    }
  };
}

test('clicking a button executes the real handler and returns a result', async () => {
  const clicks = [
    { id: '!menu home', expect: /Choose a category|ANIME MD/ },
    { id: '!menu downloader', expect: /DOWNLOADER/ },
    { id: '!ping', expect: /PONG|𝐏𝐎𝐍𝐆/ },
    { id: '!balance', expect: /BALANCE/ },
    { id: '!daily', expect: /DAILY REWARD CLAIMED|ALREADY CLAIMED/ },
    { id: '!work', expect: /WORK COMPLETE|YOU NEED TO REST/ },
    { id: '!dice', expect: /YOU ROLLED/ },
    { id: '!coin', expect: /COIN FLIP/ },
    { id: '!status', expect: /STATUS/ },
    { id: '!owner', expect: /OWNER DETAILS/ },
    { id: '!calc 2+2', expect: /4/ },
    { id: '!jid', expect: /JID INFO/ },
    { id: '!sessions', expect: /SESSION/ },
    { id: '!convert', expect: /CONVERTER/ },
    { id: '!tools', expect: /TOOLS/ },
    { id: '!rpg', expect: /RPG/ }
  ];

  for (const click of clicks) {
    const sent = [];
    await handler(makeSocket(sent), clickMessage(click.id));
    const text = sent.map((entry) => entry.payload.text || entry.payload.caption || '').join('\n');
    assert.ok(sent.length > 0, `"${click.id}" produced no reply at all`);
    assert.match(text.normalize('NFKC'), click.expect, `"${click.id}" produced an unexpected reply: ${text.slice(0, 160)}`);
  }
});

test('a second click on the same button works (no one-shot buttons)', async () => {
  for (const id of ['!menu home', '!ping', '!balance', '!status']) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const sent = [];
      await handler(makeSocket(sent), clickMessage(id));
      assert.ok(sent.length > 0, `"${id}" stopped responding on click ${attempt}`);
    }
  }
});

test('a button that needs input replies with a short tutorial instead of failing silently', async () => {
  for (const id of ['!play', '!video', '!media', '!tts', '!qr', '!translate', '!ai', '!calc', '!ss', '!short']) {
    const sent = [];
    await handler(makeSocket(sent), clickMessage(id));
    const text = sent.map((entry) => entry.payload.text || entry.payload.caption || '').join('\n');
    assert.ok(sent.length > 0, `"${id}" produced no reply`);
    assert.match(text.normalize('NFKC'), /USAGE|Usage|Example/, `"${id}" did not guide the user: ${text.slice(0, 160)}`);
  }
});

test('legacy button payload shapes are still understood after a client update', async () => {
  const legacyShapes = [
    { buttonsResponseMessage: { selectedButtonId: '!ping' } },
    { listResponseMessage: { singleSelectReply: { selectedRowId: '!ping' } } },
    { templateButtonReplyMessage: { selectedId: '!ping' } },
    {
      interactiveResponseMessage: {
        nativeFlowResponseMessage: { name: 'single_select', paramsJson: JSON.stringify({ id: '!ping' }) }
      }
    }
  ];
  for (const message of legacyShapes) {
    const sent = [];
    await handler(makeSocket(sent), {
      key: { remoteJid: '15551234568@s.whatsapp.net', participant: '15551234568@s.whatsapp.net', fromMe: false },
      message
    });
    assert.match(sent.map((entry) => entry.payload.text || entry.payload.caption || '').join('\n').normalize('NFKC'), /PONG/);
  }
});
