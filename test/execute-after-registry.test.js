'use strict';

// ---------------------------------------------------------------------------
// ExecuteAfter — provider registry, slot generation and command registration.
//
// The framework is config-driven, so the configurable behaviours (rename, hide,
// disable, duplicate, menu limit, generated adapters) are verified in a child
// node process with its own config file. The default central config is verified
// in-process.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SPIN_UP = path.join(ROOT, 'system', 'execute-after', 'index.js');

const { entries, framework, slots, stats } = require('../system/execute-after/registry');
const { COMMANDS, STATIC_COMMANDS, categoriesWithCommands, resolveCommand } = require('../system/lib/menu');

function runWithConfig(configSource) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-config-'));
  const configPath = path.join(directory, 'execute-after.config.js');
  const reportPath = path.join(directory, 'report.json');
  fs.writeFileSync(configPath, configSource);
  const script = `
    const fs = require('node:fs');
    const REPORT = process.env.EXECUTE_AFTER_REPORT;
    const framework = require(${JSON.stringify(SPIN_UP)});
    const menu = require(${JSON.stringify(path.join(ROOT, 'system', 'lib', 'menu'))});
    const registry = framework.registry;
    const report = {
      audit: framework.audit(),
      categories: menu.categoriesWithCommands().map(category => ({ id: category.id, commands: category.commands.map(entry => entry.name) })),
      entries: registry.entries(),
      resolution: (() => {
        const probes = String(process.env.EXECUTE_AFTER_PROBE || '').split(',').map(entry => entry.trim()).filter(Boolean);
        const names = [...probes, ...menu.COMMANDS.map(entry => entry.name), ...menu.COMMANDS.flatMap(entry => entry.aliases)];
        const map = {};
        for (const name of new Set(names)) map[name.toLowerCase()] = Boolean(menu.resolveCommand(name));
        return map;
      })(),
      stats: registry.stats(),
      summary: registry.stats().registration,
      total: menu.COMMANDS.length
    };
    fs.writeFileSync(REPORT, JSON.stringify(report));
  `;
  execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, EXECUTE_AFTER_CONFIG: configPath, EXECUTE_AFTER_PROBE: process.env.EXECUTE_AFTER_PROBE || '', EXECUTE_AFTER_REPORT: reportPath },
    timeout: 30000
  });
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  fs.rmSync(directory, { recursive: true, force: true });
  return report;
}

function providerBlock(overrides = {}) {
  const base = {
    auth: { type: '', header: 'Authorization', queryParam: 'apikey', token: '' },
    command: 'Exec1',
    contract: { fields: {}, listPath: '', totalPath: '', verified: false },
    enabled: true,
    endpoint: '',
    extraParams: {},
    headers: {},
    hidden: false,
    idParam: '',
    label: '',
    method: 'GET',
    mode: 'auto',
    modeOverrides: {},
    modes: ['search'],
    pageParam: '',
    queryParam: 'q',
    timeoutMs: 0
  };
  return { ...base, ...overrides };
}

function configWith(providers) {
  return `module.exports = {
    EXECUTE_AFTER_FRAMEWORK: { enabled: true, menuLimit: 10 },
    EXECUTE_AFTER_PROVIDERS: ${JSON.stringify(providers, null, 2)}
  };`;
}

test('the shipped central config registers exactly one slot, command and adapter per provider', () => {
  const configured = Object.keys(require('../execute-after.config').EXECUTE_AFTER_PROVIDERS);
  assert.equal(configured.length, 4, 'central config ships four provider slots');
  assert.equal(slots.length, configured.length, 'slot count matches the configured provider count');
  assert.deepEqual(slots.map((slot) => slot.id), ['provider_01', 'provider_02', 'provider_03', 'provider_04']);
  assert.deepEqual(slots.map((slot) => slot.command), ['exec1', 'exec2', 'exec3', 'exec4']);
  assert.equal(stats().adapters, slots.length, 'every slot has its own adapter instance');
  assert.equal(entries().length, slots.length, 'every slot registered one command');
  assert.equal(stats().providers, stats().adapters);

  // Independent adapters: separate objects, separate counters.
  const adapters = slots.map((slot) => slot.adapter);
  assert.equal(new Set(adapters).size, adapters.length, 'adapters are not shared between slots');
  slots[0].adapter.execute({ slot: slots[0], framework, mode: 'stream' }).catch(() => {});
  assert.equal(typeof slots[0].adapter.stats().calls, 'number');
});

test('the dedicated ExecuteAfter category exists, is the only place these commands live, and matches the registry', () => {
  const category = categoriesWithCommands().find((entry) => entry.id === framework.category.id);
  assert.ok(category, 'ExecuteAfter category is registered');
  assert.equal(category.label, 'EXECUTE AFTER');
  assert.deepEqual(category.commands.map((entry) => entry.name), entries().filter((entry) => !entry.hidden).map((entry) => entry.command));
  for (const entry of entries()) assert.equal(resolveCommand(entry.command)?.category, framework.category.id);
  for (const entry of category.commands) {
    const other = categoriesWithCommands().filter((group) => group.id !== category.id && group.commands.some((command) => command.name === entry.name));
    assert.deepEqual(other, [], `${entry.name} must not appear in another category`);
  }
  assert.equal(COMMANDS.length, STATIC_COMMANDS.length + entries().length, 'extension commands are appended, static commands untouched');
});

test('command resolution is case-insensitive and adapters never need to know the command name', () => {
  for (const name of ['exec1', 'Exec1', 'EXEC1', 'eXeC1']) {
    const entry = resolveCommand(name);
    assert.ok(entry, `${name} resolves`);
    assert.equal(entry.name, 'exec1');
    assert.equal(entry.category, framework.category.id);
  }
  assert.equal(resolveCommand('exec1'), resolveCommand('EXEC1'), 'same registry entry regardless of case');
  assert.equal(resolveCommand('not-a-provider'), undefined);
  assert.equal(resolveCommand('constructor'), undefined);
});

test('renaming a command in the config is enough — no adapter, router or dispatcher change', () => {
  process.env.EXECUTE_AFTER_PROBE = 'exec1,Exec1,EXEC1,myVideoCommand,MYVIDEOCOMMAND';
  const report = runWithConfig(configWith({
    provider_01: providerBlock({ command: 'myVideoCommand' }),
    provider_02: providerBlock({ command: 'secondSite' })
  }));
  assert.deepEqual(report.audit.slots.map((slot) => slot.command), ['myvideocommand', 'secondsite']);
  assert.equal(report.resolution.myvideocommand, true, 'renamed command resolves (typed in any case)');
  assert.equal(report.resolution.exec1, false, 'the old placeholder name is gone');
  assert.deepEqual(report.entries.map((entry) => entry.id), ['provider_01', 'provider_02']);
  assert.deepEqual(report.audit.slots.map((slot) => slot.adapter), ['FILE', 'FILE']);
});

test('hidden commands stay usable but are not listed; disabled providers are not registered at all', () => {
  process.env.EXECUTE_AFTER_PROBE = 'HiddenOne,HIDDENONE,DisabledOne,VisibleOne';
  const report = runWithConfig(configWith({
    provider_01: providerBlock({ command: 'VisibleOne', hidden: false }),
    provider_02: providerBlock({ command: 'HiddenOne', hidden: true }),
    provider_03: providerBlock({ command: 'DisabledOne', enabled: false })
  }));
  assert.equal(report.resolution.hiddenone, true, 'a hidden command is still resolvable and usable');
  assert.equal(report.resolution.disabledone, false, 'a disabled provider registers nothing');
  const category = report.categories.find((entry) => entry.id === 'executeafter');
  assert.deepEqual(category.commands, ['visibleone'], 'only the visible command is listed in the menu');
  assert.deepEqual(report.entries.map((entry) => `${entry.command}${entry.hidden ? ':hidden' : ''}`), ['visibleone', 'hiddenone:hidden']);
  assert.equal(report.stats.DISABLED, 1);
});

test('additional providers get sequential ids and a generated adapter without new files or commands', () => {
  const providers = {};
  for (let index = 1; index <= 6; index += 1) providers[`provider_0${index}`] = providerBlock({ command: `Exec${index}` });
  const report = runWithConfig(configWith(providers));
  assert.deepEqual(report.audit.slots.map((slot) => slot.id), ['provider_01', 'provider_02', 'provider_03', 'provider_04', 'provider_05', 'provider_06']);
  assert.equal(report.audit.providers, 6);
  assert.equal(report.audit.commands, 6, 'six slots → six commands');
  assert.equal(report.audit.adapters, 6, 'six slots → six adapters');
  assert.deepEqual(report.audit.slots.map((slot) => slot.adapter), ['FILE', 'FILE', 'FILE', 'FILE', 'GENERATED', 'GENERATED']);
  assert.equal(report.audit.adapters, report.audit.providers);
});

test('prevent duplicate registration: a second slot with a taken command is refused, never merged', () => {
  process.env.EXECUTE_AFTER_PROBE = 'Exec1,play';
  const report = runWithConfig(configWith({
    provider_01: providerBlock({ command: 'Exec1' }),
    provider_02: providerBlock({ command: 'Exec1' }),
    provider_03: providerBlock({ command: 'play' })
  }));
  assert.equal(report.entries.length, 1, 'only the first slot registers the name');
  assert.deepEqual(report.entries.map((entry) => entry.id), ['provider_01']);
  assert.equal(report.summary.duplicate.length, 1, 'a repeated ExecuteAfter name is a duplicate');
  assert.equal(report.summary.duplicate[0].id, 'provider_02');
  assert.equal(report.summary.rejected.length, 1, 'an existing AnimeMD name is rejected, not stolen');
  assert.equal(report.summary.rejected[0].id, 'provider_03');
  assert.match(report.summary.rejected[0].reason, /already used by AnimeMD/);
  assert.equal(report.stats.DISABLED, 2, 'colliding and reserved names disable only their own slot');
  assert.equal(report.resolution.play, true, 'the AnimeMD command is untouched');
});

test('the menu limit hides extra providers from the list while keeping them usable', () => {
  const providers = {};
  for (let index = 1; index <= 4; index += 1) providers[`provider_0${index}`] = providerBlock({ command: `Site${index}` });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-limit-'));
  const configPath = path.join(directory, 'execute-after.config.js');
  fs.writeFileSync(configPath, `module.exports = {
    EXECUTE_AFTER_FRAMEWORK: { enabled: true, menuLimit: 2 },
    EXECUTE_AFTER_PROVIDERS: ${JSON.stringify(providers)}
  };`);
  const reportPath = path.join(directory, 'report.json');
  const script = `
    const fs = require('node:fs');
    const f = require(${JSON.stringify(SPIN_UP)});
    const menu = require(${JSON.stringify(path.join(ROOT, 'system', 'lib', 'menu'))});
    fs.writeFileSync(process.env.EXECUTE_AFTER_REPORT, JSON.stringify({
      category: (menu.categoriesWithCommands().find(c => c.id === 'executeafter') || { commands: [] }).commands.map(c => c.name),
      entries: f.registry.entries()
    }));
  `;
  execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, EXECUTE_AFTER_CONFIG: configPath, EXECUTE_AFTER_REPORT: reportPath } });
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  fs.rmSync(directory, { recursive: true, force: true });
  assert.deepEqual(report.category, ['site1', 'site2'], 'only menuLimit providers are listed');
  assert.equal(report.entries.length, 4, 'the extra providers stay registered and usable');
  assert.deepEqual(report.entries.filter((entry) => entry.hidden).map((entry) => entry.command), ['site3', 'site4']);
});

test('a broken config disables the framework without touching AnimeMD', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-broken-'));
  const configPath = path.join(directory, 'execute-after.config.js');
  fs.writeFileSync(configPath, 'module.exports = { EXECUTE_AFTER_FRAMEWORK: { enabled: false }, EXECUTE_AFTER_PROVIDERS: { provider_01: { command: "Exec1", endpoint: "https://example.invalid/search" } } };');
  const reportPath = path.join(directory, 'report.json');
  const script = `
    const fs = require('node:fs');
    const f = require(${JSON.stringify(SPIN_UP)});
    const menu = require(${JSON.stringify(path.join(ROOT, 'system', 'lib', 'menu'))});
    fs.writeFileSync(process.env.EXECUTE_AFTER_REPORT, JSON.stringify({
      commands: f.registry.entries().length,
      isExecuteAfterDisabled: menu.resolveCommand('exec1') === undefined,
      staticCommands: menu.STATIC_COMMANDS.length,
      total: menu.COMMANDS.length
    }));
  `;
  execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, EXECUTE_AFTER_CONFIG: configPath, EXECUTE_AFTER_REPORT: reportPath } });
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(report.commands, 0);
  assert.equal(report.isExecuteAfterDisabled, true);
  assert.equal(report.total, report.staticCommands, 'AnimeMD registry is unchanged when the framework is off');
});

test('provider slots without an endpoint are reported UNRESOLVED instead of pretending to work', () => {
  const report = runWithConfig(configWith({ provider_01: providerBlock({ command: 'Exec1' }) }));
  assert.equal(report.audit.slots[0].status, 'UNRESOLVED');
  assert.equal(report.audit.slots[0].endpointConfigured, false);
  assert.match(report.audit.slots[0].reason, /endpoint not configured/i);
  assert.equal(report.audit.statuses.UNRESOLVED, 1);
});
