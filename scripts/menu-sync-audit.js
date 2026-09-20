'use strict';

// ---------------------------------------------------------------------------
// ANIME-MD MENU SYNC AUDIT — read-only.
//
// Compares three independently scanned sets and proves they agree:
//
//   REGISTERED   system/lib/menu.js                      (canonical registry)
//   EXECUTABLE   system/handler.js dispatchCommand()      (real WhatsApp routes)
//   MENU         the text `!menu` actually renders        (commandIndex output)
//
// plus the Telegram command surface, so a Telegram feature that already has a
// WhatsApp implementation can never silently go missing from `!menu`, and a
// Telegram-only feature can never be advertised as a WhatsApp command.
//
// Nothing here is a second command framework and nothing here is a runtime
// registry: it reuses the project's own dispatcher scanner
// (scripts/command-registry-check.js) and the project's own menu builder.
//
//   node scripts/menu-sync-audit.js            # summary + non-zero exit on drift
//   node scripts/menu-sync-audit.js --verbose  # every classified name
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { COMMANDS, allAliases, categoriesWithCommands, commandIndex, resolveCommand, CATEGORY_META } = require('../system/lib/menu');
const { inspect } = require('./command-registry-check');

// ---------------------------------------------------------------------------
// 1. REGISTERED — the canonical registry.
// ---------------------------------------------------------------------------

function registeredSet() {
  const canonical = COMMANDS.map((entry) => entry.name);
  const aliases = COMMANDS.flatMap((entry) => entry.aliases);
  const hidden = COMMANDS.filter((entry) => entry.hidden === true);
  const restricted = COMMANDS.filter((entry) => entry.permission !== 'public');
  return {
    canonical,
    aliases,
    hidden: hidden.map((entry) => entry.name),
    restricted: restricted.map((entry) => `${entry.name} (${entry.permission})`),
    categories: [...new Set(COMMANDS.map((entry) => entry.category))]
  };
}

// ---------------------------------------------------------------------------
// 2. EXECUTABLE — what system/handler.js can actually run.
//    Reuses the same scanner the registry check uses, so both audits can never
//    disagree about what "executable" means.
// ---------------------------------------------------------------------------

function executableSet() {
  const { routes, hidden } = inspect();
  return {
    names: routes.map((route) => route.name),
    // A route with no awaited handler call is registered but cannot do anything.
    dead: routes.filter((route) => !route.targets.length).map((route) => route.name),
    hiddenTriggers: hidden
  };
}

// ---------------------------------------------------------------------------
// 3. MENU — the exact text `!menu` renders, parsed back into names.
//    This is the rendered artifact, not a re-derivation of the registry, so a
//    bug in the menu builder shows up here as MISSING/STALE.
// ---------------------------------------------------------------------------

function menuSet(categories = categoriesWithCommands(), prefix = '!') {
  const lines = commandIndex(categories, prefix);
  const text = lines.join('\n');
  const rendered = [...text.matchAll(new RegExp(`(?:^|[\\s(])${prefix}([a-z][a-z0-9]*)`, 'gm'))].map((match) => match[1]);
  // One entry per line; a line is "name • alias • alias".
  const rows = lines.filter((line) => line.startsWith(prefix));
  const canonicalRows = rows.map((line) => line.split(' • ')[0].slice(prefix.length));
  return {
    text,
    rendered,
    canonicalRows,
    rows: rows.length,
    categories: lines.filter((line) => line.startsWith('*')).length
  };
}

// ---------------------------------------------------------------------------
// 4. TELEGRAM — every Telegram command name, classified against WhatsApp.
//    `maps` records the WhatsApp command that already implements the same
//    feature under a different name; anything unmapped is genuinely
//    Telegram-only and must NOT appear in the WhatsApp menu.
// ---------------------------------------------------------------------------

const TELEGRAM_TO_WHATSAPP = Object.freeze({
  help: 'menu',
  allmenu: 'menu',
  commands: 'menu',
  developer: 'owner',
  dev: 'owner',
  listsessions: 'sessions',
  delpair: 'stopsession',
  // "show my identifier" exists on both sides under different names.
  myid: 'uid'
});

function telegramSet() {
  const source = fs.readFileSync(path.join(__dirname, '../system/lib/telegram-controller.js'), 'utf8');
  const names = [...new Set([...source.matchAll(/^        case '([a-z0-9]+)':/gm)].map((match) => match[1]))];
  // Two commands are answered before the switch; they are part of the surface.
  for (const extra of ['verify', 'myid']) {
    if (new RegExp(`command\\.name === '${extra}'`).test(source) && !names.includes(extra)) names.push(extra);
  }
  const classified = names.map((name) => {
    const direct = resolveCommand(name);
    if (direct) return { telegram: name, whatsapp: direct.name, via: 'same-name', kind: 'WHATSAPP-AVAILABLE' };
    const mapped = TELEGRAM_TO_WHATSAPP[name];
    if (mapped && resolveCommand(mapped)) return { telegram: name, whatsapp: mapped, via: 'feature-equivalent', kind: 'WHATSAPP-AVAILABLE' };
    return { telegram: name, whatsapp: null, via: '—', kind: 'TELEGRAM-ONLY' };
  });
  return { names, classified };
}

// ---------------------------------------------------------------------------
// Comparison.
// ---------------------------------------------------------------------------

function audit() {
  const registered = registeredSet();
  const executable = executableSet();
  const menu = menuSet();
  const telegram = telegramSet();

  const canonical = new Set(registered.canonical);
  const aliasNames = new Set(registered.aliases);
  const executableNames = new Set(executable.names);
  const menuCanonical = new Set(menu.canonicalRows);
  const menuNames = new Set(menu.rendered);

  const sorted = (values) => [...new Set(values)].sort();

  // A canonical command the menu never renders (hidden ones are exempt by
  // design — they stay executable but unlisted).
  const missingFromMenu = sorted(registered.canonical.filter((name) => !registered.hidden.includes(name) && !menuCanonical.has(name)));
  // Something the menu advertises that the dispatcher cannot run.
  const nonExecutable = sorted([...menuNames].filter((name) => !executableNames.has(name)));
  // Something the menu advertises that the registry does not know.
  const obsolete = sorted([...menuNames].filter((name) => !canonical.has(name) && !aliasNames.has(name)));
  // The same canonical command rendered on more than one line/category.
  const duplicateCanonical = sorted(menu.canonicalRows.filter((name, index) => menu.canonicalRows.indexOf(name) !== index));
  // Registry categories with no metadata (they would render as an empty header).
  const unresolvedCategories = sorted(registered.categories.filter((id) => !CATEGORY_META[id]));
  // Categories present in metadata but holding no command: listed nowhere, which
  // is correct, and reported so an emptied category is never mistaken for a bug.
  const emptyCategories = sorted(Object.keys(CATEGORY_META).filter((id) => !registered.categories.includes(id)));
  // An alias rendered as if it were its own canonical command.
  const aliasAsCanonical = sorted(menu.canonicalRows.filter((name) => aliasNames.has(name) && !canonical.has(name)));
  // Registered as executable but not listed anywhere (and not hidden): the
  // "130 registered vs 97 in menu" case, spelled out.
  const executableButUnlisted = sorted(executable.names.filter((name) => !menuNames.has(name) && !executable.hiddenTriggers.includes(name)));
  // Telegram features that already have a WhatsApp counterpart but whose
  // WhatsApp counterpart is missing from the menu.
  const telegramGap = telegram.classified
    .filter((entry) => entry.kind === 'WHATSAPP-AVAILABLE')
    .filter((entry) => !menuNames.has(entry.whatsapp));

  return {
    counts: {
      canonical: canonical.size,
      executable: executableNames.size,
      menuCommands: menuCanonical.size,
      menuExecuteNames: menuNames.size,
      aliases: aliasNames.size,
      categories: registered.categories.length,
      renderedCategories: menu.categories,
      hidden: executable.hiddenTriggers.length,
      permissionRestricted: registered.restricted.length,
      telegramCommands: telegram.names.length,
      telegramOnWhatsapp: telegram.classified.filter((entry) => entry.kind === 'WHATSAPP-AVAILABLE').length,
      telegramOnly: telegram.classified.filter((entry) => entry.kind === 'TELEGRAM-ONLY').length
    },
    missingFromMenu,
    nonExecutable,
    obsolete,
    duplicateCanonical,
    unresolvedCategories,
    emptyCategories,
    aliasAsCanonical,
    executableButUnlisted,
    deadRoutes: executable.dead,
    telegramGap,
    telegram,
    registered,
    executable,
    menu
  };
}

function report(result = audit()) {
  const pad = (label) => `${label}:`.padEnd(26);
  const lines = [
    '',
    'ANIME-MD MENU SYNC AUDIT',
    '',
    pad('Canonical commands') + result.counts.canonical,
    pad('Executable WhatsApp') + result.counts.executable,
    pad('Menu commands') + result.counts.menuCommands,
    pad('Menu execute names') + result.counts.menuExecuteNames,
    pad('Aliases') + result.counts.aliases,
    pad('Categories') + `${result.counts.categories} (${result.counts.renderedCategories} rendered)`,
    '',
    pad('Missing from menu') + result.missingFromMenu.length,
    pad('Non-executable in menu') + result.nonExecutable.length,
    pad('Duplicate canonical') + result.duplicateCanonical.length,
    pad('Obsolete entries') + result.obsolete.length,
    pad('Unresolved categories') + result.unresolvedCategories.length,
    pad('Dead routes') + result.deadRoutes.length,
    pad('Telegram gaps') + result.telegramGap.length,
    '',
    pad('Hidden/intentional') + `${result.counts.hidden} (${result.executable.hiddenTriggers.join(', ')})`,
    pad('Permission restricted') + result.counts.permissionRestricted,
    pad('Telegram commands') + `${result.counts.telegramCommands} (${result.counts.telegramOnWhatsapp} also on WhatsApp, ${result.counts.telegramOnly} Telegram-only)`
  ];

  const detail = [
    ['MISSING FROM MENU', result.missingFromMenu],
    ['MENU BUT NOT EXECUTABLE', result.nonExecutable],
    ['OBSOLETE (menu, not registry)', result.obsolete],
    ['DUPLICATE CANONICAL', result.duplicateCanonical],
    ['ALIAS RENDERED AS COMMAND', result.aliasAsCanonical],
    ['EXECUTABLE BUT UNLISTED', result.executableButUnlisted],
    ['UNRESOLVED CATEGORIES', result.unresolvedCategories],
    ['DEAD ROUTES', result.deadRoutes],
    ['TELEGRAM FEATURE MISSING ON WHATSAPP MENU', result.telegramGap.map((entry) => `${entry.telegram} -> ${entry.whatsapp}`)]
  ].filter(([, values]) => values.length);

  if (detail.length) {
    lines.push('');
    for (const [label, values] of detail) lines.push(`${label}: ${values.join(', ')}`);
  }

  if (result.emptyCategories.length) {
    lines.push('', `EMPTY CATEGORIES (no command registered, not rendered): ${result.emptyCategories.join(', ')}`);
  }

  const failures = [
    result.missingFromMenu, result.nonExecutable, result.obsolete, result.duplicateCanonical,
    result.unresolvedCategories, result.deadRoutes, result.telegramGap, result.aliasAsCanonical, result.executableButUnlisted
  ].filter((values) => values.length).length;

  lines.push('', failures ? `FAIL: ${failures} drift group(s) listed above.` : 'PASS: every executable WhatsApp command is rendered exactly once by !menu; no stale, duplicate or dead entries.', '');
  return { text: lines.join('\n'), failures };
}

function telegramTable(result = audit()) {
  const lines = ['', 'TELEGRAM MENU → WHATSAPP COMPARISON', '', 'Telegram'.padEnd(14) + 'WhatsApp counterpart'.padEnd(24) + 'Status'];
  for (const entry of result.telegram.classified) {
    lines.push(entry.telegram.padEnd(14) + (entry.whatsapp ? `!${entry.whatsapp}`.padEnd(24) : '—'.padEnd(24)) + entry.kind + (entry.via === 'feature-equivalent' ? ' (feature-equivalent)' : ''));
  }
  return lines.join('\n');
}

if (require.main === module) {
  const verbose = process.argv.includes('--verbose') || process.argv.includes('--telegram');
  const result = audit();
  const { text, failures } = report(result);
  process.stdout.write(text);
  if (verbose) process.stdout.write(telegramTable(result) + '\n');
  if (failures) process.exitCode = 1;
}

module.exports = { audit, report, telegramTable, TELEGRAM_TO_WHATSAPP };
