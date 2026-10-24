'use strict';
// Real installed Baileys preparation/protobuf generation and real callbacks;
// only its upload/relay transport and media provider are mocked. No handset or
// live YouTube success is implied by these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sharp = require('sharp');
const { proto } = require('@whiskeysockets/baileys');
const { extractText } = require('../system/lib/message');
const { createFlow, createBudget } = require('../system/lib/youtube-flow');
const { MediaError } = require('../system/lib/youtube-engine');
const { redactDiagnostic } = require('../system/lib/youtube-recovered');
const { makeHarness } = require('../test-support/command-harness');
const URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const jpeg = sharp({ create: { width: 32, height: 32, channels: 3, background: '#8b5cf6' } }).jpeg().toBuffer();
function controls(message) {
  const flow = message.interactiveMessage.nativeFlowMessage;
  return flow.buttons.flatMap(button => {
    const data = JSON.parse(button.buttonParamsJson);
    return button.name === 'single_select' ? data.sections.flatMap(s => s.rows.map(row => ({ id: row.id, label: row.title }))) : [{ id: data.id, label: data.display_text }];
  });
}
function fixture(options = {}) {
  const sends = [], cards = [], jobs = [], logs = []; let serial = 0, time = 1, cleaned = 0, imageUploads = 0;
  const socket = {
    user: { id: '123456789@s.whatsapp.net' },
    waUploadToServer: async file => { assert.ok((await fs.stat(file)).size > 0); imageUploads++; return { mediaUrl: 'https://mmg.whatsapp.net/mock', directPath: '/mock' }; },
    relayMessage: async (chat, message) => {
      if (options.noNative || (options.rejectQuick && message.interactiveMessage.nativeFlowMessage.buttons.some(b => b.name === 'quick_reply'))) throw new Error('unsupported');
      cards.push({ chat, message });
    },
    sendMessage: async (chat, payload) => {
      sends.push({ chat, ...payload });
      if (payload.audio && options.uploadError) throw new Error('upload lost');
      return { key: { id: `message-${++serial}`, remoteJid: chat, fromMe: true } };
    }
  };
  function ctx(id, user = 'owner@s.whatsapp.net', chat = 'chat@g.us') {
    const message = id ? { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id }) } } } : { conversation: '!play song with spaces' };
    return { chatId: chat, sender: user, text: extractText(message), raw: { key: { id: `in-${++serial}`, remoteJid: chat, participant: user }, message } };
  }
  const provider = {
    inspect: async url => ({ url, title: 'Song with spaces', uploader: 'Channel', duration: 61, thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', qualities: [{ height: 720 }, { height: 360 }], audio: true }),
    download: async (info, kind, height, progress) => {
      jobs.push({ kind, height, url: info.url });
      await options.hold?.();
      await progress('Downloading • local-pre61'); await progress('Downloading • cobalt');
      await progress('Processing audio'); await progress('Validating media');
      if (options.providerError) throw options.providerError;
      return { file: '/mock/media', mimetype: kind === 'video' ? 'video/mp4' : kind === 'voice' ? 'audio/ogg; codecs=opus' : 'audio/mpeg', fileName: 'Song.mp3', cleanup: async () => { cleaned++; } };
    }
  };
  const flow = createFlow(socket, { provider, search: async () => [{ url: URL }], thumbnail: async () => { if (options.noThumb) throw new Error('no thumbnail'); return jpeg; },
    now: () => time, ttlMs: 100, withSlot: createBudget(options.limit || 2), confirm: async () => options.confirmed ?? true, log: (...args) => logs.push(args) });
  return { flow, socket, sends, cards, jobs, logs, ctx, provider, advance: () => { time += 101; }, cleaned: () => cleaned, imageUploads: () => imageUploads,
    last: () => cards.at(-1).message,
    start: (user, chat) => flow.start(ctx(undefined, user, chat), { name: 'play', text: 'Song with spaces' }) };
}

test('rc14 emits an actual image-header native card with three quick replies plus a visible numbered fallback', async () => {
  const f = fixture(); await f.start();
  const message = f.last();
  assert.ok(message.interactiveMessage.header.hasMediaAttachment);
  assert.ok(message.interactiveMessage.header.imageMessage.mediaKey.length);
  assert.equal(f.imageUploads(), 1);
  assert.deepEqual(controls(message).map(c => c.label), ['HD VIDEO', 'AUDIO MP3', 'VOICE TYPE']);
  const text = message.interactiveMessage.body.text.normalize('NFKC');
  assert.match(text, /Song with spaces[\s\S]*Channel[\s\S]*1:01/);
  // The same options are readable text, so a handset that does not render the
  // buttons can still answer with a number (reported "only Choose a format").
  assert.match(text, /1\. HD VIDEO[\s\S]*2\. AUDIO MP3[\s\S]*3\. VOICE TYPE[\s\S]*Reply with a number/);
  const decoded = proto.Message.decode(proto.Message.encode(message).finish());
  assert.equal(controls(decoded).length, 3);
  for (const item of controls(decoded)) assert.match(item.id, /^yt:[a-f0-9]{12}:1:[123]$/);
});
for (const [label, kind] of [['AUDIO MP3', 'audio'], ['VOICE TYPE', 'voice']]) test(`emitted ${label} callback downloads, uploads and cleans exactly once`, async () => {
  const f = fixture(); await f.start(); const button = controls(f.last()).find(b => b.label === label);
  await f.flow.select(f.ctx(button.id)); await f.flow.select(f.ctx(button.id));
  assert.equal(f.jobs.length, 1); assert.equal(f.jobs[0].kind, kind); assert.equal(f.cleaned(), 1);
  assert.equal(f.sends.filter(p => p.audio).length, 1);
  assert.equal(f.sends.find(p => p.audio).ptt, kind === 'voice');
});
test('HD callback emits a native resolution list; old/repeated HD tap cannot choose a quality accidentally', async () => {
  const f = fixture(); await f.start(); const hd = controls(f.last())[0];
  await f.flow.select(f.ctx(hd.id));
  const message = f.last(); assert.equal(message.interactiveMessage.nativeFlowMessage.buttons[0].name, 'single_select');
  assert.deepEqual(controls(message).map(b => b.label), ['720p', '360p']);
  await f.flow.select(f.ctx(hd.id)); assert.equal(f.jobs.length, 0);
  await f.flow.select(f.ctx(controls(message)[1].id));
  assert.equal(f.jobs[0].kind, 'video'); assert.equal(f.jobs[0].height, 360);
});
test('native callback sender/chat, expiry and invalid options are checked before downloads', async () => {
  const f = fixture(); await f.start(); const audio = controls(f.last())[1];
  await f.flow.select(f.ctx(audio.id, 'intruder@s.whatsapp.net'));
  await f.flow.select(f.ctx(audio.id, undefined, 'other@g.us')); assert.equal(f.jobs.length, 0);
  await f.flow.select(f.ctx(audio.id.replace(/:2$/, ':99'))); assert.equal(f.jobs.length, 0);
  f.advance(); await f.flow.select(f.ctx(audio.id)); assert.equal(f.jobs.length, 0);
  assert.match(f.sends.at(-1).text, /expired/);
});
test('missing thumbnail retains genuine native controls and a clear text notice', async () => {
  const f = fixture({ noThumb: true }); await f.start();
  assert.equal(f.last().interactiveMessage.header.hasMediaAttachment, false);
  assert.match(f.last().interactiveMessage.body.text, /Thumbnail unavailable/);
  await f.flow.select(f.ctx(controls(f.last())[1].id)); assert.equal(f.jobs.length, 1);
});
test('unsupported quick replies use a native list before any numbered fallback', async () => {
  const f = fixture({ rejectQuick: true }); await f.start();
  assert.equal(f.last().interactiveMessage.nativeFlowMessage.buttons[0].name, 'single_select');
  assert.equal(controls(f.last()).length, 3);
  assert.ok(!f.sends.some(p => /Buttons are unavailable/.test(p.text || p.caption || '')));
  const id = controls(f.last())[1].id;
  const ctx = f.ctx(); ctx.raw.message = { listResponseMessage: { singleSelectReply: { selectedRowId: id } } }; ctx.text = extractText(ctx.raw.message);
  await f.flow.select(ctx); assert.equal(f.jobs[0].kind, 'audio');
});
test('only complete native rejection uses the numbered compatibility fallback', async () => {
  const f = fixture({ noNative: true }); const result = await f.start();
  assert.equal(f.cards.length, 0); const card = f.sends.find(p => p.image);
  assert.match(card.caption, /Buttons are unavailable/);
  assert.doesNotMatch(card.caption, new RegExp(result.id));
  const ctx = f.ctx(); ctx.text = '2'; await f.flow.select(ctx);
  assert.equal(f.jobs[0].kind, 'audio');
});
for (const code of ['BOT_CHECK', 'NETWORK', 'PROVIDERS', 'TIMEOUT']) test(`${code} stays in diagnostics, with one clean error/retry card and no repeated media menus`, async () => {
  const error = new MediaError(code, `All download providers failed local-pre61: ${code}, cobalt: NETWORK token=secret`);
  error.failures = [{ provider: 'local-pre61', code }];
  const f = fixture({ providerError: error }); await f.start(); const audio = controls(f.last())[1];
  await f.flow.select(f.ctx(audio.id));
  const fail = f.last(); assert.match(fail.interactiveMessage.body.text, /Download failed/);
  assert.equal(controls(fail)[0].label, 'Try again');
  const visible = [...f.cards.map(p => p.message.interactiveMessage.body.text), ...f.sends.map(p => p.text || p.caption || '')].join('\n');
  assert.doesNotMatch(visible, /local-pre61|cobalt|BOT_CHECK|NETWORK|PROVIDERS|TIMEOUT|secret|All download providers/);
  assert.equal(f.cards.length, 2, 'one initial card plus one error card');
  assert.ok(JSON.stringify(f.logs).includes(code));
});
test('real-stage reaction sequence is bounded/deduplicated; completion only follows a receipt', async () => {
  const f = fixture(); await f.start(); await f.flow.select(f.ctx(controls(f.last())[1].id));
  const reactions = f.sends.filter(p => p.react).map(p => p.react.text);
  assert.deepEqual(reactions, ['🔍', '🎵', '⬇️', '⚙️', '📤', '✅']);
  assert.equal(f.sends.filter(p => p.text === '⬇️ Downloading').length, 1);
  assert.equal(f.sends.filter(p => p.text === '⚙️ Preparing media').length, 1);
  assert.ok(f.sends.findIndex(p => p.audio) < f.sends.findIndex(p => p.react?.text === '✅'));
  const g = fixture({ confirmed: false }); await g.start(); await g.flow.select(g.ctx(controls(g.last())[1].id));
  assert.ok(!g.sends.some(p => p.react?.text === '✅'));
});
test('simultaneous native requests from different users do not cross ownership or duplicate jobs', async () => {
  let release; const hold = new Promise(r => { release = r; });
  const f = fixture({ hold: () => hold });
  await f.start('a@s.whatsapp.net'); const a = controls(f.last())[1];
  await f.start('b@s.whatsapp.net'); const b = controls(f.last())[2];
  await f.flow.select(f.ctx(a.id, 'b@s.whatsapp.net')); assert.equal(f.jobs.length, 0);
  const first = f.flow.select(f.ctx(a.id, 'a@s.whatsapp.net'));
  const second = f.flow.select(f.ctx(b.id, 'b@s.whatsapp.net'));
  await f.flow.select(f.ctx(a.id, 'a@s.whatsapp.net'));
  release(); await Promise.all([first, second]);
  assert.equal(f.jobs.length, 2); assert.equal(f.cleaned(), 2);
});
test('upload exception cleans once and offers no blind Retry button', async () => {
  const f = fixture({ uploadError: true }); await f.start(); const id = controls(f.last())[1].id;
  await f.flow.select(f.ctx(id)); await f.flow.select(f.ctx(id));
  assert.equal(f.jobs.length, 1); assert.equal(f.cleaned(), 1); assert.equal(f.cards.length, 1);
  assert.match(f.sends.at(-1).text, /no automatic resend/);
});
test('actual dispatcher consumes IDs from the emitted native card after a prefix-independent callback', async t => {
  const h = makeHarness(); t.after(() => h.close()); const socket = h.socket({ interactive: true });
  await h.handler(socket, socket.message('!play Song with spaces'));
  const message = socket.sends.find(p => p.payload.interactiveMessage).payload;
  const response = socket.message('');
  response.message = { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: controls(message)[1].id }) } } };
  await h.handler(socket, response);
  assert.equal(socket.sends.filter(p => p.payload.audio?.url === '/mock/media').length, 1);
});
test('diagnostic sanitizer removes signed URLs and credentials from server logs', () => {
  const text = redactDiagnostic(new Error('403 https://media.example/x?token=SECRET api_key=XYZ cookie=VALUE --cookies /private/cookies.txt'));
  assert.doesNotMatch(text, /SECRET|XYZ|VALUE|\/private\/cookies/);
});

test('host can choose native list or explicit text compatibility without replacing the media engine', async () => {
  const { selection } = require('../system/lib/youtube-ui');
  for (const mode of ['list', 'text']) {
    const f = fixture();
    const result = await selection(f.socket, f.ctx(), { mode, text: 'Choose a format', token: 'aaaaaaaaaaaa', revision: 1, actions: [{ label: 'AUDIO MP3', value: '2' }] });
    assert.equal(result.native, mode === 'list');
    if (mode === 'list') assert.equal(f.last().interactiveMessage.nativeFlowMessage.buttons[0].name, 'single_select');
    else { assert.equal(f.cards.length, 0); assert.match(f.sends.at(-1).text, /Reply/); }
  }
});

test('a native tap during direct-command progress cannot race the automatic download into a second job', async () => {
  const f = fixture(); const original = f.socket.sendMessage;
  f.socket.sendMessage = async (chat, payload) => {
    if (payload.edit && /Choose a format/.test(payload.text)) await f.flow.select(f.ctx(controls(f.last())[1].id));
    return original(chat, payload);
  };
  const result = await f.flow.start(f.ctx(), { name: 'ytmp3', text: URL });
  assert.equal(result.ok, true); assert.equal(f.jobs.length, 1); assert.equal(f.cleaned(), 1);
});


test('video resolution native list retains the prepared image header', async () => {
  const f = fixture();
  await f.flow.start(f.ctx(), { name: 'video', text: 'Song with spaces' });
  assert.equal(f.last().interactiveMessage.nativeFlowMessage.buttons[0].name, 'single_select');
  assert.equal(f.last().interactiveMessage.header.hasMediaAttachment, true);
  assert.ok(f.imageUploads() > 0);
});
test('chat errors never prescribe cookies for automation challenges or aggregate failures', () => {
  const { safeError } = require('../system/lib/youtube-flow');
  for (const code of ['BOT_CHECK', 'NETWORK', 'PROVIDERS']) assert.doesNotMatch(safeError({ code }), /cookies|local-pre61|stack|signed.in|session credentials/i);
});
