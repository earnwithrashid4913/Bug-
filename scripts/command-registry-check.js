'use strict';
// Read-only audit of the existing registry/dispatcher, NOT a runtime registry.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { COMMANDS, allAliases, categoriesWithCommands, helpText, resolveCommand } = require('../system/lib/menu');
const { styleHeaders } = require('../system/lib/presentation');
const source = fs.readFileSync(path.join(__dirname, '../system/handler.js'), 'utf8');
function inspect() {
  const start = source.indexOf('async function dispatchCommand(');
  const end = source.indexOf('// Handle protocol message', start);
  assert.ok(start >= 0 && end > start, 'Existing dispatcher must be present');
  const dispatch = source.slice(start, end);
  const labels = [...dispatch.matchAll(/^    case '([^']+)':/gm)];
  const routes = labels.map((label, index) => {
    let at = index, body;
    do { body = dispatch.slice(labels[at].index + labels[at][0].length, labels[at + 1]?.index ?? dispatch.lastIndexOf('    default:')).trim(); at++; } while (!body && at < labels.length);
    const line = source.slice(0, start + label.index).split('\n').length;
    const target = [...body.matchAll(/await\s+([\w.]+)\(/g)].map(m => m[1]);
    return { name: label[1], line, body, targets: [...new Set(target)] };
  });
  const hidden = [...(source.match(/const HIDDEN_TRIGGERS = new Set\(\[([^\]]+)\]\)/)?.[1] || '').matchAll(/'([^']+)'/g)].map(m => m[1]);
  return { routes, hidden };
}
function audit() {
  const { routes, hidden } = inspect();
  const names = routes.map(route => route.name);
  const declared = COMMANDS.flatMap(command => [command.name, ...command.aliases]);
  assert.equal(new Set(names).size, names.length, 'Duplicate switch cases');
  assert.equal(new Set(declared).size, declared.length, 'Duplicate declared names or aliases');
  assert.deepEqual([...names].sort(), allAliases(), 'Registry and dispatcher must agree in both directions');
  assert.ok(hidden.length && /await handleHiddenCommand\(socket, context\)/.test(source), 'Existing manual-only route must remain connected');
  for (const name of hidden) assert.ok(!declared.includes(name) && !resolveCommand(name), 'Manual-only trigger leaked into public registry');
  const categories = categoriesWithCommands();
  assert.equal(categories.length, new Set(categories.map(c => c.id)).size);
  for (const category of categories) {
    assert.ok(category.id && category.label, 'Unmapped category');
    assert.ok(category.commands.length <= 30, 'List row truncation');
    for (const prefix of ['!', 'abcd']) {
      const text = helpText(prefix, category.id);
      assert.ok(styleHeaders(text).length <= 3500, 'Interactive body truncation');
      const tokens = new Set([...text.matchAll(new RegExp(`(?:^|[\\s(,])${prefix}([a-z][a-z0-9]*)\\b`, 'gm'))].map(m => m[1]));
      for (const command of category.commands) {
        const canonical = routes.find(r => r.name === command.name);
        assert.ok(canonical?.body && canonical.targets.length, `Dead route: ${command.name}`);
        for (const name of [command.name, ...command.aliases]) {
          assert.ok(tokens.has(name), `Missing rendered menu execute name: ${name}`);
          assert.equal(resolveCommand(name), command, `Wrong alias lookup: ${name}`);
          assert.equal(routes.find(r => r.name === name).body, canonical.body, `Alias reaches a different handler branch: ${name}`);
        }
      }
      for (const name of hidden) assert.ok(!tokens.has(name), 'Hidden entry in rendered menu');
    }
  }
  for (const name of ['constructor', '__proto__', 'toString', 'notacommand']) assert.equal(resolveCommand(name), undefined);
  return { routes, hidden, categories };
}
function markdown(result = audit()) {
  return [
    '# WhatsApp public command mapping', '',
    'Generated from the existing registry and dispatcher. Manual-only commands are intentionally omitted.',
    'Route checks prove registration/mapping, not external API availability or live WhatsApp delivery.', '',
    '| Command | Valid aliases | Category/menu | Permission | Handler route (awaited calls) | Dispatcher line |',
    '| --- | --- | --- | --- | --- | --- |',
    ...COMMANDS.map(command => {
      const route = result.routes.find(r => r.name === command.name);
      return `| ${command.name} | ${command.aliases.join(', ') || '—'} | !menu ${command.category} | ${command.permission} | ${route.targets.map(t => `\`${t}\``).join(', ')} | system/handler.js:${route.line} |`;
    })
  ].join('\n');
}
if (require.main === module) {
  const result = audit();
  if (process.argv.includes('--markdown')) console.log(markdown(result));
  else console.log(`PASS: ${COMMANDS.length} public commands, ${result.routes.length} public execute names/aliases, ${result.categories.length} complete menu categories; manual-only route isolated; no duplicate/missing/alias-branch/truncation errors.`);
}
module.exports = { inspect, audit, markdown };
