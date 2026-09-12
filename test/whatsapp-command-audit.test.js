'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHarness } = require('../test-support/command-harness');
const { COMMANDS, categoriesWithCommands, helpText, resolveCommand } = require('../system/lib/menu');
const { audit, inspect, markdown } = require('../scripts/command-registry-check');
const { styleHeaders } = require('../system/lib/presentation');

const input = {
  fancy: 'Fixture 1', encrypt: 'const x = 1', encrypt2: 'const x = 1', getmail: 'session-id', upload: 'https://example.test/file',
  request: 'Fixture report', mode: 'public', play: 'https://youtu.be/fixture', ytmp3: 'https://youtu.be/fixture', video: 'https://youtu.be/fixture', spotify: 'Fixture', media: 'https://example.test/video',
  ai: 'Fixture question', translate: 'en Bonjour', calc: '2+3', ss: 'https://example.test', short: 'https://example.test', tts: 'Hello', qr: 'Fixture',
  idch: 'https://whatsapp.com/channel/fixture', rps: 'rock', guess: 'start', gname: 'Fixture Group', gdesc: 'Fixture description', add: '15558888888',
  setname: 'Fixture Name', setprefix: '!', broadcast: 'Fixture announcement', sudo: '15558888888', delsudo: '15558888888', addprem: '15558888888 30d', delprem: '15558888888',
  stopsession: '15558888888', anime: 'search Fixture', manga: 'Fixture', character: 'Fixture', animevs: 'Naruto vs Bleach', ship: 'Alice Bob', meteo: 'Islamabad', lyrics: 'Fixture',
  tiktok: 'https://www.tiktok.com/fixture', facebook: 'https://facebook.com/fixture', twitter: 'https://x.com/fixture', opentime: 'cancel', closetime: 'cancel', give: '1'
};
function fixture(command) {
  if (['toimg', 'tovid', 'take'].includes(command)) return { stickerMessage: { mimetype: 'image/webp' } };
  if (['sticker', 'setpp', 'tourl', 'vv', 'save'].includes(command)) return { imageMessage: { mimetype: 'image/jpeg', viewOnce: command === 'vv' } };
}
function textOf(socket) {
  return socket.sends.map(s => s.payload.text || s.payload.caption || s.payload.interactiveMessage?.body?.text || '').join('\n').normalize('NFKC');
}

test('complete public registry, alias branches, menu bounds and hidden exclusion audit', () => {
  const result = audit();
  assert.equal(result.routes.length, 235);
  assert.equal(COMMANDS.length, 130);
  assert.equal(result.categories.length, 23);
  assert.equal(result.hidden.length, 2);
  assert.doesNotMatch(markdown(result), /\| h \||\| hidden \||davidcaril|davinci/i);
});

test('EVERY public execute name runs through the real handler and produces a result/action', async t => {
  const h = makeHarness();
  // Keep the test worker alive during intentional unref'ed provider pacing.
  const alive = setInterval(() => {}, 1000);
  t.after(async () => { clearInterval(alive); await h.close(); });
  for (const entry of COMMANDS) for (const name of [entry.name, ...entry.aliases]) {
    await t.test(`${name} → ${entry.name} → menu ${entry.category}`, async () => {
      const socket = h.socket();
      let args = input[entry.name] || '';
      let quoted = fixture(entry.name);
      if (['anti', 'automation'].includes(entry.category) || ['welcome', 'goodbye', 'greet'].includes(entry.name)) args = 'status';
      if (['store', 'ad', 'vd', 'del'].includes(entry.name)) {
        const type = entry.name === 'vd' ? 'video' : 'audio';
        quoted = { [`${type}Message`]: { mimetype: `${type}/mpeg` } };
        args = `fixture-${name}`;
        if (entry.name !== 'store') {
          await h.handler(socket, socket.message(`!store ${args}`, quoted));
          if (entry.name === 'del') args = `audio ${args}`;
          quoted = undefined;
        }
      }
      if (entry.name === 'give') await h.handler(socket, socket.message('!daily'));
      socket.sends.length = 0; socket.actions.length = 0; h.calls.length = 0; h.errors.length = 0;
      await h.handler(socket, socket.message(`!${name}${args ? ` ${args}` : ''}`, quoted, ['give', 'kick', 'promote', 'demote', 'warn', 'unwarn'].includes(entry.name)));
      assert.ok(h.calls.includes('dispatchCommand'), 'real dispatcher entered');
      const payloads = socket.sends.filter(s => !s.payload.react);
      assert.ok(payloads.length || socket.actions.length, `${name}: no result except reaction`);
      assert.doesNotMatch(textOf(socket).replace(/\*Failed:\* 0\b/g, 'No delivery failures'), /COMMAND FAILED|\bError:|\bFAILED\b|not a function|UNAVAILABLE|\bundefined\b|\bNaN\b/i, name);
      assert.deepEqual(h.errors, [], `${name}: internal error`);
      // Stop started quiz lobbies; do not leave delayed game jobs after tests.
      if (entry.name === 'quiz') await h.handler(socket, socket.message('!quiz stop'));
    });
  }
});

test('actual interactive and text category menus display every execute token without truncation', async t => {
  const h = makeHarness(); t.after(() => h.close());
  for (const interactive of [false, true]) for (const category of categoriesWithCommands()) {
    const socket = h.socket({ interactive });
    await h.handler(socket, socket.message(`!menu ${category.id}`));
    const message = socket.sends.find(s => interactive ? s.payload.interactiveMessage : s.payload.text);
    assert.ok(message, `${category.id}: ${interactive ? 'interactive' : 'fallback'} message`);
    const body = interactive ? message.payload.interactiveMessage.body.text : message.payload.text;
    assert.equal(body, styleHeaders(helpText('!', category.id)));
    const tokens = new Set([...body.matchAll(/(?:^|[\s(,])!([a-z][a-z0-9]*)\b/gm)].map(m => m[1]));
    for (const entry of category.commands) for (const name of [entry.name, ...entry.aliases]) assert.ok(tokens.has(name), name);
    for (const hidden of inspect().hidden) assert.ok(!tokens.has(hidden));
    if (interactive) {
      const select = message.payload.interactiveMessage.nativeFlowMessage.buttons.find(b => b.name === 'single_select');
      const rows = JSON.parse(select.buttonParamsJson).sections.flatMap(s => s.rows);
      assert.deepEqual(rows.map(row => row.id), category.commands.map(entry => `!${entry.name}`));
    }
  }
});

test('manual-only Davidcaril triggers work with mixed case and current prefix, never resolve publicly', async t => {
  const h = makeHarness(); t.after(() => h.close());
  for (const prefix of ['!', '?']) {
    await h.handler.setCommandPrefix(prefix);
    for (const trigger of ['h', 'H', 'hidden', 'HIDDEN', 'HiDdEn']) {
      const socket = h.socket(); h.calls.length = 0;
      await h.handler(socket, socket.message(`${prefix}${trigger}`));
      assert.ok(h.calls.includes('handleHiddenCommand'));
      assert.ok(!h.calls.includes('dispatchCommand'));
      assert.match(textOf(socket), /ANIME CORE/);
      assert.equal(resolveCommand(trigger), undefined);
    }
  }
});

test('quiz join commands explain absent lobby instead of silently returning', async t => {
  const h = makeHarness(); t.after(() => h.close());
  for (const text of ['!quizjoin', '!quiz join', '!startquiz join']) {
    const socket = h.socket();
    await h.handler(socket, socket.message(text));
    assert.match(textOf(socket), /No joinable quiz lobby/);
  }
});

test('owner and group gates are still enforced when commands are visible in the menu', async t => {
  const h = makeHarness(); t.after(() => h.close());
  for (const name of ['restart', 'rst', 'setname', 'setprefix', 'broadcast', 'bc', 'sudo', 'addprem', 'stopsession']) {
    const socket = h.socket({ owner: false });
    await h.handler(socket, socket.message(`!${name}`));
    assert.match(textOf(socket), /OWNER ONLY/);
    assert.equal(socket.actions.length, 0);
  }
});

test('explicit quiz join actually joins an existing lobby once; organizer can stop it', async t => {
  const h = makeHarness(); t.after(() => h.close());
  for (const command of ['!quizjoin', '!quiz join', '!startquiz join']) {
    const socket = h.socket();
    await h.handler(socket, socket.message('!quiz random easy'));
    socket.sends.length = 0;
    const join = socket.message(command);
    join.key.fromMe = false;
    join.key.participant = socket.target;
    await h.handler(socket, join);
    assert.match(textOf(socket), /joined the quiz/);
    assert.equal(socket.sends.filter(s => /joined the quiz/.test(s.payload.text || '')).length, 1);
    assert.doesNotMatch(textOf(socket), /No joinable quiz/);
    await h.handler(socket, socket.message('!quizstop'));
    assert.match(textOf(socket), /Quiz stopped/);
  }
});

test('advertised plain join and A-D/numeric answers reach the real quiz; idle numeric replies still open menu', async t => {
  const h = makeHarness(); const alive = setInterval(() => {}, 1000);
  t.after(async () => { clearInterval(alive); await h.close(); });
  for (const answer of ['a', '1']) {
    const socket = h.socket();
    await h.handler(socket, socket.message('!quiz random easy'));
    const join = socket.message('join'); join.key.fromMe = false; join.key.participant = socket.target;
    await h.handler(socket, join);
    assert.match(textOf(socket), /joined the quiz/);
    await h.runTimer(45000); // Existing lobby timer, no live wait or replacement quiz.
    assert.match(textOf(socket), /QUESTION 1/);
    socket.sends.length = 0;
    const reply = socket.message(answer); reply.key.fromMe = false; reply.key.participant = socket.target;
    await h.handler(socket, reply);
    assert.ok(socket.sends.some(s => ['✅', '❌'].includes(s.payload.react?.text)), 'quiz accepts answer (correct or incorrect)');
    assert.doesNotMatch(textOf(socket), /Type !menu/);
    await h.handler(socket, socket.message('!quizstop'));
  }
  const idle = h.socket();
  await h.handler(idle, idle.message('1'));
  assert.match(textOf(idle), /!fancy/);
  assert.match(textOf(idle), /!calculate/);
});
