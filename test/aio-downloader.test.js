'use strict';

// ---------------------------------------------------------------------------
// !aio — the ALL IN ONE downloader.
//
// One command for any supported link. These tests drive the REAL dispatcher
// (system/handler.js) with the real commands/downloader-extended.js module;
// only the network/codec boundary is mocked by the shared harness.
//
// Covered:
//   * usage text when no link is supplied,
//   * routing a known platform to the specialised handler that already owns
//     that platform's fallback chain (no duplicated downloader logic),
//   * the generic chain for an unknown site, ending in either real media or a
//     clean, non-technical failure message,
//   * registry integrity: canonical name, aliases, category and the menu.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const test = require('node:test');
const { makeHarness } = require('../test-support/command-harness');
const { categoriesWithCommands, resolveCommand } = require('../system/lib/menu');

const textOf = (socket) => socket.sends.map((entry) => entry.payload?.text || entry.payload?.caption || '').join('\n');
const mediaOf = (socket) => socket.sends.filter((entry) => entry.payload && !entry.payload.react && Object.keys(entry.payload).some((key) => ['video', 'image', 'audio', 'document'].includes(key)));

test('!aio explains itself when no link is supplied', async (t) => {
  const h = makeHarness(); t.after(() => h.close());
  const socket = h.socket();
  await h.handler(socket, socket.message('!aio'));
  const text = textOf(socket);
  assert.match(text, /Usage:\*?\s*!aio <link>/);
  assert.match(text, /ALL IN ONE downloader/);
  assert.match(text, /YouTube/);
  assert.match(text, /TikTok/);
  assert.equal(h.network.length, 0, 'no provider is called without a link');
});

test('!aio routes a TikTok link to the existing TikTok fallback chain', async (t) => {
  const h = makeHarness(); t.after(() => h.close());
  const socket = h.socket();
  await h.handler(socket, socket.message('!aio https://vm.tiktok.com/ZMexample/'));
  const text = textOf(socket);
  assert.match(text, /AIO.*TikTok/);
  assert.ok(h.network.some((url) => /tikwm\.com|tiktok/i.test(url)), 'the TikTok providers were used');
  assert.doesNotMatch(text, /is not a function|TypeError|Cannot read/);
});

test('!aio routes a YouTube link to the existing YouTube download path', async (t) => {
  const h = makeHarness(); t.after(() => h.close());
  const socket = h.socket();
  await h.handler(socket, socket.message('!aio https://youtu.be/dQw4w9WgXcQ'));
  assert.match(textOf(socket), /AIO.*YouTube/);
  assert.ok(mediaOf(socket).length > 0, 'media was delivered');
});

test('!aio falls back through the generic chain for an unknown site', async (t) => {
  const h = makeHarness(); t.after(() => h.close());
  const socket = h.socket();
  await h.handler(socket, socket.message('!aio https://some-unknown-video-site.example/watch/42'));
  const text = textOf(socket);
  assert.match(text, /AIO/);
  assert.ok(
    h.network.some((url) => /\/download\/(aio|aiov2|aiov3)/.test(url)),
    'the generic DavidCyril AIO endpoints were tried'
  );
  const cleanFailure = /could not download that link/i.test(text);
  assert.ok(mediaOf(socket).length > 0 || cleanFailure, 'either real media or one clean failure message');
  assert.doesNotMatch(text, /No media URL|TypeError|is not a function/);
});

test('!aio is registered once, with working aliases, in the downloader category', async (t) => {
  const entry = resolveCommand('aio');
  assert.ok(entry, '!aio exists in the registry');
  assert.equal(entry.category, 'downloader');
  assert.deepEqual(entry.aliases, ['allinone', 'alldownload', 'alldl', 'anydl']);
  for (const alias of ['aio', 'AIO', 'Aio', 'allinone', 'alldownload', 'alldl', 'anydl', 'ANYDL']) {
    assert.equal(resolveCommand(alias), entry, `${alias} resolves to !aio`);
  }
  const downloader = categoriesWithCommands().find((category) => category.id === 'downloader');
  assert.ok(downloader.commands.includes(entry), '!aio is listed in the downloader category');
  const listed = categoriesWithCommands().flatMap((category) => category.commands).filter((command) => command.name === 'aio');
  assert.equal(listed.length, 1, '!aio appears exactly once in the directory');

  // And the dispatcher really executes it, in any case.
  const h = makeHarness(); t.after(() => h.close());
  for (const text of ['!aio', '!AIO', '!Aio', '!allinone', '!alldownload']) {
    const socket = h.socket();
    await h.handler(socket, socket.message(text));
    assert.match(textOf(socket), /Usage:\*?\s*!aio <link>/, `${text} reaches the !aio handler`);
  }
});

test('!aio shows up in the !menu index and in the downloader category view', async (t) => {
  const h = makeHarness(); t.after(() => h.close());
  const root = h.socket();
  await h.handler(root, root.message('!menu'));
  const index = root.sends.map((entry) => entry.payload?.text || '').join('\n');
  assert.match(index, /!aio • !allinone • !alldownload/, 'the whole alias set is advertised once');

  const category = h.socket({ interactive: true });
  await h.handler(category, category.message('!menu downloader'));
  const body = category.sends
    .map((entry) => entry.payload?.interactiveMessage?.body?.text || entry.payload?.text || '')
    .join('\n');
  assert.match(body, /!aio <link>/);
  assert.match(body, /ALL IN ONE downloader/);
  const rows = JSON.parse(
    category.sends
      .map((entry) => entry.payload?.interactiveMessage)
      .filter(Boolean)
      .map((message) => message.nativeFlowMessage.buttons.find((button) => button.name === 'single_select').buttonParamsJson)[0]
  ).sections.flatMap((section) => section.rows);
  assert.ok(rows.some((row) => row.id === '!aio'), 'the category row runs the real !aio command');
});
