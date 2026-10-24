'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createFlow, createBudget, receiptTracker, directAudio, directVideo } = require('../system/lib/youtube-flow');
const { MediaError, youtubeUrl, availableFormats, retry } = require('../system/lib/youtube-engine');
const URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const info = () => ({ url: URL, title: 'A song', uploader: 'A channel', duration: 123, thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', audio: true, qualities: [{ height: 720, selector: '22' }, { height: 360, selector: '18' }] });
let counter = 0;
function context(text = '', overrides = {}) {
  return { chatId: 'group@g.us', sender: 'owner@s.whatsapp.net', text,
    raw: { key: { id: `source-${++counter}` }, message: { conversation: text } }, ...overrides };
}
function fixture(options = {}) {
  const sent = [], calls = [], logs = [];
  let cleanup = 0, clock = 1;
  const socket = { sendMessage: async (chat, payload) => {
    sent.push({ chat, ...payload });
    if (options.uploadFail && (payload.audio || payload.video)) throw new Error('upload secret=https://private/token');
    if (options.editFail && payload.edit) throw new Error('unsupported edit');
    if (options.imageFail && payload.image) throw new Error('no image');
    return { key: { id: `sent-${sent.length}`, remoteJid: chat, fromMe: true } };
  } };
  const provider = {
    inspect: async url => { calls.push(['inspect', url]); if (options.inspectError) throw options.inspectError; return info(); },
    download: async (value, kind, height, progress) => {
      calls.push(['download', kind, height]);
      if (options.beforeDownload) await options.beforeDownload();
      if (options.downloadError) throw options.downloadError;
      await progress('Downloading');
      return { file: '/test/file', fileName: 'A song.mp3', mimetype: kind === 'video' ? 'video/mp4' : kind === 'voice' ? 'audio/ogg; codecs=opus' : 'audio/mpeg', cleanup: async () => { cleanup++; } };
    }
  };
  const flow = createFlow(socket, { provider, search: async query => { calls.push(['search', query]); return options.results ?? [{ url: URL }]; },
    thumbnail: async () => { if (options.thumbnailFail) throw new Error('offline'); return Buffer.from('jpeg'); },
    confirm: async () => options.confirmed ?? true, now: () => clock, ttlMs: 1000,
    log: (...args) => logs.push(args), withSlot: options.withSlot || createBudget(2) });
  return { flow, sent, calls, socket, provider, logs, cleanup: () => cleanup,
    expire: () => { clock += 1001; }, start: (name = 'play', text = URL, ctx = context()) => flow.start(ctx, { name, text }) };
}

test('valid watch, music, Shorts and short URLs canonicalize without sensitive query params', () => {
  for (const input of [URL + '&list=abc&t=9&token=secret', 'https://youtu.be/dQw4w9WgXcQ?si=secret', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ']) assert.equal(youtubeUrl(input), URL);
});
test('SSRF, credentials, ports, malformed IDs, playlists and lookalike domains are rejected', () => {
  for (const input of ['file:///etc/passwd', 'https://127.0.0.1/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil/watch?v=dQw4w9WgXcQ', 'https://user:secret@youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com:444/watch?v=dQw4w9WgXcQ', 'https://youtube.com/playlist?list=abc', 'https://youtu.be/bad']) assert.throws(() => youtubeUrl(input), MediaError);
});
test('search with spaces and quoted text selects the original result and sends thumbnail first', async () => {
  const f = fixture(); const result = await f.start('play', '"some song with spaces"');
  assert.equal(result.pending, true);
  assert.deepEqual(f.calls[0], ['search', 'some song with spaces']);
  assert.equal(f.sent.filter(p => p.image).length, 1);
  assert.match(f.sent.find(p => p.image).caption, /A song[\s\S]*A channel[\s\S]*2:03[\s\S]*HD VIDEO[\s\S]*AUDIO MP3[\s\S]*VOICE TYPE/);
  assert.equal(f.calls.filter(c => c[0] === 'download').length, 0);
});
test('missing arguments and invalid URLs produce clear errors without a provider request', async () => {
  for (const input of ['', 'https://evil.test/watch', 'ftp://youtube.com/abc']) {
    const f = fixture(); await f.start('play', input);
    assert.equal(f.calls.length, 0); assert.ok(f.sent.some(p => /Usage|YouTube/.test(p.text || '')));
  }
});
test('no search results is terminal and does not substitute a different source', async () => {
  const f = fixture({ results: [] }); const result = await f.start('play', 'a song');
  assert.equal(result.ok, false); assert.match(f.sent.at(-1).text, /No YouTube results/);
});
for (const [name, error] of [
  ['provider timeout', new MediaError('TIMEOUT', 'The provider timed out.')],
  ['malformed JSON metadata', new MediaError('METADATA', 'The provider returned incomplete metadata.')],
  ['unavailable or restricted source', new MediaError('RESTRICTED', 'This video is restricted.')]
]) test(name + ' reaches a terminal error without exposing raw diagnostics', async () => {
  const f = fixture({ inspectError: error }); const result = await f.start();
  assert.equal(result.ok, false); assert.equal(result.state, 'failed');
  assert.equal(f.sent.filter(p => p.audio || p.video).length, 0);
});
for (const [choice, kind] of [['2', 'audio'], ['3', 'voice']]) test(`selecting ${kind} sends actual file payload after thumbnail and cleans up once`, async () => {
  const f = fixture(); const result = await f.start();
  await f.flow.select(context(`${result.id} ${choice}`));
  assert.equal(f.calls.filter(c => c[0] === 'download')[0][1], kind);
  const index = f.sent.findIndex(p => p.audio); assert.ok(index > f.sent.findIndex(p => p.image));
  assert.deepEqual(f.sent[index].audio, { url: '/test/file' });
  assert.equal(f.sent[index].ptt, kind === 'voice');
  assert.equal(f.sent[index].mimetype, kind === 'voice' ? 'audio/ogg; codecs=opus' : 'audio/mpeg');
  assert.equal(f.cleanup(), 1); assert.match(f.sent.at(-1).text, /delivery confirmed/);
});
test('!video opens the real resolution list (never the audio menu) and downloads the chosen quality', async () => {
  const f = fixture(); const result = await f.start('video');
  // `!video` is a video request: its card is the quality list, not AUDIO MP3.
  const card = f.sent.find(p => p.image);
  assert.match(card.caption, /VIDEO QUALITY[\s\S]*720p[\s\S]*360p/);
  assert.doesNotMatch(card.caption, /AUDIO MP3|VOICE TYPE/);
  assert.equal(f.sent.filter(p => p.image).length, 1);
  await f.flow.select(context(`${result.id} 2`));
  assert.deepEqual(f.calls.filter(c => c[0] === 'download'), [['download', 'video', 360]]);
  assert.match(f.sent.find(p => p.video).caption, /360p/);
});
test('HD VIDEO inside the play menu reveals real resolutions, not 1080p', async () => {
  const f = fixture(); const result = await f.start();
  await f.flow.select(context(`${result.id} 1`));
  const quality = f.sent.filter(p => p.image).at(-1).caption;
  assert.match(quality, /720p[\s\S]*360p/); assert.doesNotMatch(quality, /1080p/);
  await f.flow.select(context(`${result.id} 2`));
  assert.deepEqual(f.calls.filter(c => c[0] === 'download'), [['download', 'video', 360]]);
  assert.equal(f.sent.filter(p => p.image).length, 2);
});
test('unavailable resolution and invalid choice retain the current selector', async () => {
  const f = fixture(); const result = await f.start();
  await f.flow.select(context(`${result.id} 1`));
  await f.flow.select(context(`${result.id} 9`));
  assert.match(f.sent.at(-1).text, /latest card/);
  await f.flow.select(context(`${result.id} 1`));
  assert.deepEqual(f.calls.filter(c => c[0] === 'download'), [['download', 'video', 720]]);
});
test('thumbnail retrieval or image send failure has an explicit text fallback and media still sends', async () => {
  for (const options of [{ thumbnailFail: true }, { imageFail: true }]) {
    const f = fixture(options); const result = await f.start();
    assert.match(f.sent.find(p => /MEDIA SELECT/.test(p.text || '')).text, /Thumbnail unavailable/);
    await f.flow.select(context(`${result.id} 2`)); assert.ok(f.sent.some(p => p.audio));
    assert.ok(f.logs.length);
  }
});
test('unrelated users and other chats cannot consume a pending selection', async () => {
  const f = fixture(); const result = await f.start();
  for (const extra of [{ sender: 'intruder@s.whatsapp.net' }, { chatId: 'elsewhere@g.us' }]) {
    await f.flow.select(context(`${result.id} 2`, extra)); assert.match(f.sent.at(-1).text, /another user or chat/);
  }
  assert.equal(f.calls.filter(c => c[0] === 'download').length, 0);
  await f.flow.select(context(`${result.id} 2`)); assert.ok(f.sent.some(p => p.audio));
});
test('a numbered reply selects the only pending card, quoted or not, and never steals idle numbers', async () => {
  // No pending media request: numbers stay available to the menu/quiz paths.
  const idle = fixture();
  assert.equal(await idle.flow.select(context('2')), false);

  // Quoted reply to the card.
  const f = fixture(); await f.start();
  const quoted = f.sent.findIndex(p => p.image) + 1;
  const ctx = context('2'); ctx.raw.message = { extendedTextMessage: { text: '2', contextInfo: { stanzaId: `sent-${quoted}` } } };
  assert.equal(await f.flow.select(ctx), true); assert.ok(f.sent.some(p => p.audio));

  // Bare "2" after one card (a handset whose buttons did not render).
  const bare = fixture(); await bare.start();
  assert.equal(await bare.flow.select(context('2')), true);
  assert.equal(bare.calls.filter(c => c[0] === 'download').length, 1);

  // Two pending requests make a bare number ambiguous: it is not guessed.
  const two = fixture(); await two.start(); await two.start('play', URL, context());
  assert.equal(await two.flow.select(context('2')), false);
  assert.equal(two.calls.filter(c => c[0] === 'download').length, 0);
});
test('expired and unknown selections give a clear response and do not download', async () => {
  const f = fixture(); const result = await f.start(); f.expire();
  await f.flow.select(context(`${result.id} 2`)); assert.match(f.sent.at(-1).text, /expired/);
  await f.flow.select(context('aaaaaaaaaaaa 2')); assert.match(f.sent.at(-1).text, /expired/);
  assert.equal(f.calls.filter(c => c[0] === 'download').length, 0);
});
test('duplicate source messages and repeated clicks cannot start duplicate media jobs', async () => {
  let release; const pending = new Promise(r => { release = r; });
  const f = fixture({ beforeDownload: () => pending }); const ctx = context();
  const result = await f.start('play', URL, ctx);
  assert.equal((await f.start('play', URL, ctx)).duplicate, true);
  const first = f.flow.select(context(`${result.id} 2`));
  await f.flow.select(context(`${result.id} 2`)); release(); await first;
  const count = f.sent.length; await f.flow.select(context(`${result.id} 2`));
  assert.equal(f.sent.length, count); assert.equal(f.calls.filter(c => c[0] === 'download').length, 1);
});
test('two requests run concurrently; the bounded third gets busy rather than an unbounded queue', async () => {
  const withSlot = createBudget(2); let release;
  const hold = new Promise(r => { release = r; });
  const f = fixture({ withSlot, beforeDownload: () => hold });
  const a = await f.start(), b = await f.start(), c = await f.start();
  const first = f.flow.select(context(`${a.id} 2`));
  const second = f.flow.select(context(`${b.id} 3`));
  await f.flow.select(context(`${c.id} 2`));
  assert.match(f.sent.at(-1).text, /slots are busy/);
  release(); await Promise.all([first, second]);
  assert.equal(f.sent.filter(p => p.audio).length, 2);
});
for (const [name, code] of [['expired HTTP 403 URL', 'RESTRICTED'], ['empty/corrupt file', 'CORRUPT'], ['size overflow', 'SIZE'], ['missing audio stream', 'AUDIO']]) test(name + ' never uploads a thumbnail as media', async () => {
  const f = fixture({ downloadError: new MediaError(code, name) }); const r = await f.start();
  await f.flow.select(context(`${r.id} 2`));
  assert.equal(f.sent.filter(p => p.audio || p.video).length, 0);
  assert.match(f.sent.at(-1).text, /retry/);
});
test('a failed pre-upload request can be retried explicitly and safely once', async () => {
  const f = fixture(); const original = f.provider.download; let first = true;
  f.provider.download = async (...args) => { if (first) { first = false; throw new MediaError('TRANSIENT', 'Temporary error'); } return original(...args); };
  const result = await f.start(); await f.flow.select(context(`${result.id} 2`));
  await f.flow.select(context(`${result.id} retry`));
  assert.equal(f.sent.filter(p => p.audio).length, 1); assert.equal(f.cleanup(), 1);
});
test('WhatsApp upload failure is uncertain, cleaned up, and never retried blindly', async () => {
  const f = fixture({ uploadFail: true }); const result = await f.start();
  await f.flow.select(context(`${result.id} 2`));
  await f.flow.select(context(`${result.id} retry`));
  assert.equal(f.sent.filter(p => p.audio).length, 1); assert.equal(f.cleanup(), 1);
  assert.match(f.sent.at(-1).text, /may already have been sent/);
  assert.ok(!JSON.stringify(f.logs).includes('secret'));
});
test('missing receipt is not reported as successful delivery; edits may fail without duplicate statuses', async () => {
  const f = fixture({ confirmed: false }); const result = await f.start('ytmp3');
  assert.equal(result.uploaded, true); assert.equal(result.ok, false); assert.equal(result.state, 'unconfirmed');
  assert.doesNotMatch(f.sent.at(-1).text, /Completed/);
  const g = fixture({ editFail: true }); await g.start('ytmp3');
  assert.equal(g.sent.filter(p => p.audio).length, 1);
});
test('every original audio alias downloads directly; play/video aliases keep selection semantics', async () => {
  for (const name of [...directAudio, ...directVideo, 'play', 'song', 'music', 'video', 'yt', 'ytv', 'youtube', 'ytvideo']) {
    const f = fixture(); const result = await f.start(name);
    if (directAudio.has(name)) assert.ok(f.sent.some(p => p.audio), name);
    else if (directVideo.has(name)) assert.ok(f.sent.some(p => p.video), name);
    else assert.equal(result.pending, true, name);
  }
});
test('format capabilities omit missing formats, video-only without AAC, oversized and incompatible codecs', () => {
  assert.deepEqual(availableFormats({}, 1000), []);
  const formats = [
    { format_id: '137', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'none', filesize: 500 },
    { format_id: '22', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'mp4a', filesize: 900 },
    { format_id: 'av1', ext: 'mp4', height: 480, vcodec: 'av01', acodec: 'mp4a' },
    { format_id: 'big', ext: 'mp4', height: 1440, vcodec: 'avc1', acodec: 'mp4a', filesize: 2000 }
  ];
  assert.deepEqual(availableFormats({ formats }, 1000).map(f => f.height), [720]);
  formats.push({ format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', filesize: 100 });
  assert.deepEqual(availableFormats({ formats }, 1000).map(f => f.height), [1080, 720]);
  assert.equal(availableFormats({ formats }, 1000)[0].selector, '137+140');
});
test('only transient source failures receive bounded exponential-backoff retries', async () => {
  let calls = 0; const delays = [];
  assert.equal(await retry(async () => { if (!calls++) throw new MediaError('TRANSIENT', '503'); return 'ok'; }, async ms => delays.push(ms)), 'ok');
  assert.deepEqual(delays, [750]);
  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new MediaError('RESTRICTED', '403'); })); assert.equal(calls, 1);
});
test('only a matching outgoing delivery receipt confirms completion, including the early-receipt race', async () => {
  const socket = { ev: new EventEmitter() }; const confirm = receiptTracker(socket, 20);
  const promise = confirm({ id: 'a' }, 'chat');
  socket.ev.emit('messages.update', [{ key: { id: 'a', remoteJid: 'other', fromMe: true }, update: { status: 4 } }]);
  socket.ev.emit('messages.update', [{ key: { id: 'a', remoteJid: 'chat', fromMe: true }, update: { status: 2 } }]);
  socket.ev.emit('message-receipt.update', [{ key: { id: 'a', remoteJid: 'chat', fromMe: true }, receipt: { receiptTimestamp: 100 } }]);
  assert.equal(await promise, true);
  assert.equal(await confirm({ id: 'b' }, 'chat'), false);
  socket.ev.emit('messages.update', [{ key: { id: 'c', remoteJid: 'chat', fromMe: true }, update: { status: 3 } }]);
  assert.equal(await confirm({ id: 'c' }, 'chat'), true);
});

test('provider chain falls back without losing the video or selected quality, and rejects wrong-source fallback', async () => {
  const { createProviderChain } = require('../system/lib/youtube-engine');
  const calls = [];
  const first = { inspect: async () => info(), download: async () => { throw new MediaError('TRANSIENT', 'Provider down'); } };
  const second = { inspect: async url => { calls.push(url); return info(); }, download: async (source, kind, height) => { calls.push([source.url, kind, height]); return { file: '/second/file' }; } };
  const chain = createProviderChain([first, second]);
  const source = await chain.inspect(URL);
  assert.equal((await chain.download(source, 'video', 720)).file, '/second/file');
  assert.deepEqual(calls, [URL, [URL, 'video', 720]]);
  second.inspect = async () => ({ ...info(), url: 'https://youtu.be/BaW_jenozKc' });
  await assert.rejects(chain.download(source, 'video', 720), { code: 'METADATA' });
  second.inspect = async () => ({ ...info(), qualities: [{ height: 360 }] });
  await assert.rejects(chain.download(source, 'video', 720), { code: 'QUALITY' });
});
