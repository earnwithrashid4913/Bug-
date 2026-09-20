'use strict';

// ---------------------------------------------------------------------------
// Menu synchronization regression suite.
//
// Proves the three sets agree at runtime of the audit, so `!menu` can never
// drift from what the bot can actually execute:
//
//   REGISTERED  (system/lib/menu.js)  ==  MENU (what !menu renders)
//   EXECUTABLE  (system/handler.js)   ==  MENU execute names
//
// and that the Telegram surface never leaks a Telegram-only feature into the
// WhatsApp menu, nor hides a WhatsApp feature that Telegram also has.
// ---------------------------------------------------------------------------

const { displayAssert: assert } = require('../test-support/telegram-display');
const test = require('node:test');
const { COMMANDS, allAliases, resolveCommand } = require('../system/lib/menu');
const { audit, report, telegramTable, TELEGRAM_TO_WHATSAPP } = require('../scripts/menu-sync-audit');
const { inspect } = require('../scripts/command-registry-check');

test('every executable WhatsApp command is rendered by !menu exactly once', () => {
  const result = audit();
  assert.deepEqual(result.missingFromMenu, [], 'a registered command is absent from the rendered menu');
  assert.deepEqual(result.nonExecutable, [], 'the menu advertises something the dispatcher cannot run');
  assert.deepEqual(result.obsolete, [], 'the menu advertises a command that is not in the registry');
  assert.deepEqual(result.duplicateCanonical, [], 'a canonical command is rendered twice');
  assert.deepEqual(result.executableButUnlisted, [], 'a dispatcher route is not listed anywhere');
  assert.deepEqual(result.aliasAsCanonical, [], 'an alias is rendered as its own command');
  assert.deepEqual(result.deadRoutes, [], 'a route has no handler call');
  assert.deepEqual(result.unresolvedCategories, [], 'a category has no metadata');
  assert.deepEqual(result.telegramGap, [], 'a Telegram feature has a WhatsApp counterpart that is missing from !menu');
  assert.equal(report(result).failures, 0);
});

test('the three scanned sets agree on counts', () => {
  const result = audit();
  assert.equal(result.counts.canonical, COMMANDS.length);
  assert.equal(result.counts.menuCommands, COMMANDS.length, 'menu command count == canonical count');
  assert.equal(result.counts.executable, allAliases().length, 'dispatcher names == registry names');
  assert.equal(result.counts.menuExecuteNames, allAliases().length, 'menu execute names == registry names');
  assert.equal(result.counts.aliases, COMMANDS.reduce((total, entry) => total + entry.aliases.length, 0));
  // Aliases are preserved and executable, but never rendered as extra commands.
  assert.ok(result.counts.aliases > 0);
  assert.ok(result.counts.menuCommands < result.counts.menuExecuteNames);
});

test('intentionally hidden commands stay executable but unlisted', () => {
  const result = audit();
  assert.deepEqual(result.executable.hiddenTriggers, ['h', 'hidden']);
  assert.deepEqual(result.registered.hidden, [], 'no public command is silently hidden from the menu');
  for (const trigger of result.executable.hiddenTriggers) {
    assert.equal(resolveCommand(trigger), undefined, `${trigger} must not be a public command`);
    assert.ok(!result.menu.rendered.includes(trigger), `${trigger} must not appear in !menu`);
  }
  // They are still real routes, so the feature is not dead.
  const routes = inspect().routes.map((route) => route.name);
  assert.ok(!routes.includes('h') && !routes.includes('hidden'), 'hidden triggers use their own route, not the dispatcher');
});

test('permission-restricted commands are listed, never silently dropped', () => {
  const result = audit();
  const restricted = COMMANDS.filter((entry) => entry.permission !== 'public');
  assert.ok(restricted.length > 0, 'the project has owner/admin/sudo commands');
  assert.equal(result.counts.permissionRestricted, restricted.length);
  for (const entry of restricted) {
    assert.ok(result.menu.rendered.includes(entry.name), `restricted command !${entry.name} must still be listed`);
  }
  // Listing is not executing: the dispatcher keeps the existing permission gates.
  assert.ok(restricted.every((entry) => entry.permission === 'owner' || entry.permission === 'admin' || entry.permission === 'sudo'));
});

test('the Telegram surface is classified, and Telegram-only commands are not faked', () => {
  const result = audit();
  const table = telegramTable(result);
  assert.ok(result.counts.telegramCommands >= 30, 'the Telegram command surface is scanned');
  assert.equal(result.counts.telegramOnWhatsapp + result.counts.telegramOnly, result.counts.telegramCommands);
  for (const entry of result.telegram.classified) {
    if (entry.kind === 'TELEGRAM-ONLY') {
      // Not presented as a WhatsApp command anywhere.
      assert.equal(resolveCommand(entry.telegram), undefined, `${entry.telegram} is Telegram-only`);
      assert.ok(!result.menu.rendered.includes(entry.telegram), `${entry.telegram} must not appear in !menu`);
      assert.match(table, new RegExp(`${entry.telegram}\\s+—\\s+TELEGRAM-ONLY`));
    } else {
      assert.ok(resolveCommand(entry.whatsapp), `${entry.telegram} maps to a real WhatsApp command`);
      assert.ok(result.menu.rendered.includes(entry.whatsapp), `!${entry.whatsapp} (for Telegram /${entry.telegram}) is in !menu`);
    }
  }
  // Every declared feature-equivalence must resolve to a registered command.
  for (const [telegram, whatsapp] of Object.entries(TELEGRAM_TO_WHATSAPP)) {
    assert.ok(resolveCommand(whatsapp), `mapping ${telegram} -> ${whatsapp} must point at a real command`);
    assert.ok(result.telegram.names.includes(telegram), `mapping ${telegram} must still exist on Telegram`);
  }
});

test('the rendered menu is message-safe and loses nothing to truncation', () => {
  const result = audit();
  // One line per command, so the rendered row count is the command count.
  assert.equal(result.menu.rows, COMMANDS.length);
  assert.equal(result.menu.categories, result.counts.categories);
  for (const line of result.menu.text.split('\n')) {
    assert.ok(line.length <= 500, `a rendered line is longer than any WhatsApp limit: ${line.slice(0, 40)}`);
  }
  // Category headers carry the real per-category counts, so a reader can verify
  // completeness without counting by hand.
  const counts = [...result.menu.text.matchAll(/— (\d+) commands?/g)].map((match) => Number(match[1]));
  assert.equal(counts.reduce((total, value) => total + value, 0), COMMANDS.length);
});
