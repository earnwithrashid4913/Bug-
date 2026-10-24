'use strict';

// Regression tests for the ANIME MD premium UI redesign:
//   - the unified, brand-safe footer credit (one identity, no legacy names),
//   - the premium welcome caption identity (no legacy third-party brand),
//   - category-view pagination (real `!menu <id> <page>` navigation),
//   - the interactive action ids always resolve to real registered commands.

const test = require('node:test');
const assert = require('node:assert/strict');

const { FOOTER, font, styleHeaders } = require('../system/lib/presentation');
const handler = require('../system/handler');
const menu = require('../system/lib/menu');
const { welcomeCaption } = require('../system/lib/connection-welcome');

test('the shared footer credit is one canonical ANIME MD line', () => {
  // Mathematical-bold rendering of "Powered By ANIME MD".
  const expected = `𝐏𝐨𝐰𝐞𝐫𝐞𝐝 𝐁𝐲 ${font('ANIME MD')}`;
  assert.equal(FOOTER, expected);
  assert.doesNotMatch(FOOTER, /goatmods|gojo|limitless/i);
});

test('styleHeaders styles headings without ever changing an action id', () => {
  const rendered = styleHeaders('⚡ *COMMAND CENTER*\nType !menu for details.');
  const kunreited = rendered.normalize('NFKC');
  assert.match(kunreited, /COMMAND CENTER/);
  assert.match(rendered, /!menu/, 'the raw id survives untouched');
});

test('welcome caption: premium ANIME MD identity only, own data intact', () => {
  const caption = welcomeCaption({ user: { id: '923001234567:4@s.whatsapp.net', name: 'Own User' } }).normalize('NFKC');
  assert.match(caption, /ANIME MD/);
  assert.match(caption, /USER : Own User/);
  assert.match(caption, /NUMBER : \+923001234567/);
  assert.doesNotMatch(caption, /GOJO|GOAT|LIMITLESS/i, 'legacy third-party branding stays gone');
  assert.doesNotMatch(caption, /undefined|NaN|\[object/);
});

test('category pagination splits long listings into real pages under the WhatsApp limit', () => {
  const { paginateText } = handler;
  // 60 numbered lines ≈ 1,400 chars; a 400-char limit yields ≥3 whole-line pages.
  const lines = Array.from({ length: 60 }, (_, index) => `!cmd${index + 1} — Description for command ${index + 1}.`);
  const text = lines.join('\n');
  const pages = paginateText(text, 400);
  assert.ok(pages.length >= 3, 'long text is paginated');
  for (const page of pages) {
    assert.ok(page.length <= 400 + 200, 'a page stays close to its limit (whole-line break rule)');
    assert.ok(!/Description for command \d+\.很…Description/.test(page), 'no line is split mid-line');
  }
  const reassembled = pages.join('\n').split('\n').map((line) => line.trim()).filter(Boolean);
  const original = text.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(reassembled, original, 'pagination loses no content');
  // Short text is never touched: one page, byte-identical.
  assert.deepEqual(paginateText('short menu', 400), ['short menu']);
});

test('every category id and menu help header advertised by the registry resolves to a real category', () => {
  for (const category of menu.categoriesWithCommands()) {
    assert.ok(menu.getCategory(category.id), `${category.id} is resolvable`);
    const detail = menu.helpText('!', category.id);
    assert.ok(detail.includes(`${category.commands.length} Command`), `${category.id}: the header shows the real command count`);
    assert.match(detail, /Type !menu for all categories\.$/m);
  }
});
