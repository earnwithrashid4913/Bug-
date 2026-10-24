'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createRecoveredProvider } = require('../system/lib/youtube-recovered');
const { createFlow, createBudget } = require('../system/lib/youtube-flow');
const { classifyError, MediaError } = require('../system/lib/youtube-engine');
const local = require('../system/lib/local-downloader');
const URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SECOND = 'https://www.youtube.com/watch?v=BaW_jenozKc';
// Signature-only fixture, used explicitly with FFmpeg unavailable. Not a real
// YouTube recording and not evidence of live extraction/playback.
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(128)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from('moov mdat vide soun avc1 mp4a'), Buffer.alloc(128)]);
function setup(options = {}) {
  const calls = [];
  const api = {
    downloadYtAudio: async url => { calls.push(['dc-audio', url]); return options.dcFail ? { ok: false, error: new Error('HTTP Error 503') } : { ok: true, url: 'https://media.example/audio', title: 'Restored song' }; },
    downloadYtVideo: async url => { calls.push(['dc-video', url]); return { ok: true, url: 'https://media.example/video' }; },
    aioDownload: async url => { calls.push(['aio', url]); return { result: { url: 'https://media.example/video' } }; },
    pickUrl: data => data.result?.url, pickTitle: () => 'Video'
  };
  const net = {
    requestCobalt: async (endpoint, url, mode) => { calls.push(['cobalt', url, mode.audio]); if (options.cobaltFail) throw new Error('HTTP Error 503'); return { url: mode.audio ? 'https://media.example/audio' : 'https://media.example/video' }; },
    downloadRemoteFile: async url => { calls.push(['bytes', url]); if (options.corruptFirst && url.includes('audio') && !calls.some(c => c[0] === 'cobalt')) return { buffer: Buffer.from('{"error":"expired"}') }; return { buffer: url.includes('video') ? mp4 : mp3 }; }
  };
  const engine = { ...local,
    getInfo: async () => { calls.push(['getInfo']); throw new Error('Sign in to confirm you are not a bot'); },
    resolveFfmpeg: async () => { calls.push(['ffmpeg']); return null; },
    downloadAudio: async url => { calls.push(['local-audio', url]); return { buffer: mp3, title: 'Legacy local', mimetype: 'audio/mpeg' }; },
    downloadVideo: async url => { calls.push(['local-video', url]); return { buffer: mp4, title: 'Legacy local', mimetype: 'video/mp4' }; }
  };
  const provider = createRecoveredProvider({ autoInstall: false, maxBytes: 100000 }, {
    dc: api, net, local: engine, cobaltProviders: () => ['https://configured.example'],
    advanced: () => ({ inspect: async () => { calls.push(['advanced']); throw classifyError('requested format is not available'); } }), log: () => {}
  });
  return { provider, calls, api, engine, net };
}
async function consume(provider, info, kind, height) {
  const media = await provider.download(info, kind, height);
  try { assert.ok((await fs.stat(media.file)).size); return { ...media, bytes: await fs.readFile(media.file) }; }
  finally { await media.cleanup(); await assert.rejects(fs.stat(media.file), { code: 'ENOENT' }); }
}

test('Git recovery: successful original API path does not call yt-dlp metadata or need FFmpeg', async () => {
  const f = setup(); const info = await f.provider.inspect(URL, { title: 'Original result', author: 'Uploader', length: '10:00' });
  assert.equal(info.title, 'Original result'); assert.equal(info.durationText, '10:00');
  assert.equal(f.calls.length, 0, 'menu metadata does not invoke any extractor');
  const media = await consume(f.provider, info, 'audio');
  assert.equal(media.provider, 'davidcyril-audio'); assert.equal(media.mimetype, 'audio/mpeg');
  assert.deepEqual(f.calls.filter(c => c[0].includes('local') || c[0] === 'getInfo' || c[0] === 'advanced'), []);
  assert.equal(media.bytes.equals(mp3), true);
});
test('restored audio fallback: DavidCyril genuinely fails, then Cobalt downloads the SAME source', async () => {
  const f = setup({ dcFail: true }); const info = await f.provider.inspect(URL);
  const media = await consume(f.provider, info, 'audio');
  assert.equal(media.provider, 'cobalt');
  assert.deepEqual(f.calls.filter(c => ['dc-audio', 'cobalt'].includes(c[0])), [['dc-audio', URL], ['cobalt', URL, true]]);
});
test('restored video order is Cobalt, DavidCyril MP4, AIO then pre61 local', async () => {
  const f = setup({ cobaltFail: true }); const info = await f.provider.inspect(URL);
  assert.equal((await consume(f.provider, info, 'video')).provider, 'davidcyril-video');
  assert.deepEqual(f.calls.filter(c => ['cobalt', 'dc-video'].includes(c[0])), [['cobalt', URL, false], ['dc-video', URL]]);
  f.api.downloadYtVideo = async () => ({ ok: false });
  assert.equal((await consume(f.provider, info, 'video')).provider, 'davidcyril-aio');
  f.api.aioDownload = async () => { throw new Error('HTTP Error 503'); };
  assert.equal((await consume(f.provider, info, 'video')).provider, 'local-pre61');
});
test('previous flexible local audio downloader is reached after API failures, without changing the video', async () => {
  const f = setup({ dcFail: true, cobaltFail: true }); const info = await f.provider.inspect(URL);
  assert.equal((await consume(f.provider, info, 'audio')).provider, 'local-pre61');
  assert.ok(f.calls.some(c => c[0] === 'local-audio' && c[1] === URL));
  assert.ok(!f.calls.some(c => /soundcloud|getInfo|advanced/.test(c[0])));
});
test('invalid provider bytes fall through before upload instead of being reported as restricted', async () => {
  const f = setup({ corruptFirst: true }); const info = await f.provider.inspect(URL);
  assert.equal((await consume(f.provider, info, 'audio')).provider, 'cobalt');
});
test('all-provider failure reports distinct reasons, not an unsupported authentication claim', async () => {
  const f = setup({ dcFail: true, cobaltFail: true });
  f.engine.downloadAudio = async () => { throw new Error('TLS/SSL connection has been closed (EOF)'); };
  await assert.rejects(f.provider.download(await f.provider.inspect(URL), 'audio'), error => {
    assert.equal(error.code, 'PROVIDERS'); assert.match(error.message, /TRANSIENT[\s\S]*NETWORK/);
    assert.doesNotMatch(error.message, /requires? (?:a )?(?:login|authorized)/); return true;
  });
});
test('voice is explicitly unavailable without FFmpeg but does not disable normal audio', async () => {
  const f = setup(); const info = await f.provider.inspect(URL);
  await assert.rejects(f.provider.download(info, 'voice'), { code: 'ENGINE' });
  assert.equal((await consume(f.provider, info, 'audio')).provider, 'davidcyril-audio');
});
for (const [message, code] of [
  ['ERROR: Requested format is not available', 'QUALITY'],
  ['No video formats found', 'QUALITY'],
  ['HTTP Error 403: Forbidden', 'FORBIDDEN'],
  ['HTTP Error 404', 'UNAVAILABLE'],
  ['This video is unavailable', 'UNAVAILABLE'],
  ['Private video', 'UNAVAILABLE'],
  ['Sign in to confirm you are not a bot', 'BOT_CHECK'],
  ['Login required for members-only video', 'AUTH'],
  ['This video is age-restricted', 'RESTRICTED'],
  ['TLS/SSL connection has been closed (EOF)', 'NETWORK'],
  ['getaddrinfo ENOTFOUND youtube.com', 'NETWORK'],
  ['certificate verify failed', 'NETWORK'],
  ['ERROR: unable to extract signature', 'EXTRACTOR'],
  ['Download engine could not be started (ENOENT)', 'ENGINE'],
  ['HTTP Error 429', 'TRANSIENT'],
  ['HTTP Error 503', 'TRANSIENT'],
  ['timed out after 30s', 'TIMEOUT']
]) test(`accurate failure classification: ${message}`, () => assert.equal(classifyError(message).code, code));

function socketFixture() {
  const sent = [];
  const socket = { sendMessage: async (chat, payload) => { sent.push(payload); return { key: { id: `sent-${sent.length}` } }; } };
  let id = 0;
  const ctx = text => ({ chatId: 'chat@g.us', sender: 'user@s.whatsapp.net', text: text || '', raw: { key: { id: `in-${++id}` }, message: {} } });
  return { socket, sent, ctx };
}
for (const query of ['New FunkS Latest 10 minutes', 'memories hasan']) test(`reported regression command: !play ${query} reaches restored provider and actual send payload (mocked service)`, async () => {
  const f = setup(), { socket, sent, ctx } = socketFixture(); const searches = [];
  const flow = createFlow(socket, { provider: f.provider, search: async text => { searches.push(text); return [{ url: URL, title: query, author: 'Uploader' }]; },
    thumbnail: async () => Buffer.from('mock-thumbnail'), confirm: async () => true, log: () => {}, withSlot: createBudget() });
  const result = await flow.start(ctx(), { name: 'play', text: query });
  assert.deepEqual(searches, [query]); assert.equal(result.pending, true);
  assert.ok(sent.some(p => p.image && p.caption.includes(query)));
  await flow.select(ctx(`${result.id} 2`));
  assert.ok(sent.some(p => p.audio?.url && p.mimetype === 'audio/mpeg'));
  assert.ok(!f.calls.some(c => c[0] === 'getInfo'));
});
test('HD optional lookup failure offers previous auto-video path; direct ytmp4 never enters strict inspection', async () => {
  const f = setup(), { socket, sent, ctx } = socketFixture();
  const flow = createFlow(socket, { provider: f.provider, thumbnail: async () => Buffer.from('mock'), confirm: async () => true, log: () => {}, withSlot: createBudget() });
  const result = await flow.start(ctx(), { name: 'video', text: URL });
  await flow.select(ctx(`${result.id} 1`));
  assert.match(sent.at(-1).text, /Automatic video/);
  await flow.select(ctx(`${result.id} 1`));
  assert.ok(sent.some(p => p.video?.url));
  const before = f.calls.filter(c => c[0] === 'advanced').length;
  await flow.start(ctx(), { name: 'ytmp4', text: URL });
  assert.equal(f.calls.filter(c => c[0] === 'advanced').length, before);
  assert.equal(sent.filter(p => p.video).length, 2);
});
test('other search results require explicit consent after failure; SoundCloud is never substituted', async () => {
  const f = setup(), { socket, sent, ctx } = socketFixture(); let source = URL;
  f.provider.download = async (info) => { source = info.url; throw new MediaError('PROVIDERS', 'All failed'); };
  const flow = createFlow(socket, { provider: f.provider, search: async () => [{ url: URL, title: 'First' }, { url: SECOND, title: 'Second' }],
    thumbnail: async () => Buffer.from('mock'), confirm: async () => true, log: () => {}, withSlot: createBudget() });
  const result = await flow.start(ctx(), { name: 'play', text: 'a song' });
  await flow.select(ctx(`${result.id} 2`)); assert.equal(source, URL);
  assert.match(sent.at(-1).text, /sources/);
  await flow.select(ctx(`${result.id} sources`));
  assert.match(sent.at(-1).text, /Second/); assert.equal(source, URL);
  await flow.select(ctx(`${result.id} 2`));
  assert.equal(source, SECOND, 'explicit source consent resumes the already selected format without another menu');
});
test('actual fallback order ignores misleading filename and MIME claims', async () => {
  const f = setup();
  f.net.downloadRemoteFile = async () => ({ buffer: Buffer.from('<html>blocked</html>'), type: 'audio/mpeg' });
  const info = await f.provider.inspect(URL);
  assert.equal((await consume(f.provider, info, 'audio')).provider, 'local-pre61');
});

test('original ytmp3/ytmp4 aliases deliver file bytes through recovered adapter before cleanup', async () => {
  for (const [name, field, bytes] of [['ytmp3', 'audio', mp3], ['ytmp4', 'video', mp4]]) {
    const f = setup(), { socket, ctx } = socketFixture(); let uploaded;
    const original = socket.sendMessage;
    socket.sendMessage = async (chat, payload) => {
      if (payload[field]) { uploaded = payload[field].url; assert.deepEqual(await fs.readFile(uploaded), bytes); }
      return original(chat, payload);
    };
    const flow = createFlow(socket, { provider: f.provider, thumbnail: async () => Buffer.from('mock'), confirm: async () => true, log: () => {}, withSlot: createBudget() });
    const result = await flow.start(ctx(), { name, text: URL });
    assert.equal(result.ok, true, name); assert.ok(uploaded);
    await assert.rejects(fs.stat(uploaded), { code: 'ENOENT' });
  }
});
test('WhatsApp exception after recovered preparation does not enter a second provider or resend', async () => {
  const f = setup(), { socket, ctx } = socketFixture(); const original = socket.sendMessage; let uploads = 0;
  socket.sendMessage = async (chat, payload) => {
    if (payload.audio) { uploads++; throw new Error('connection lost after upload'); }
    return original(chat, payload);
  };
  const flow = createFlow(socket, { provider: f.provider, thumbnail: async () => Buffer.from('mock'), confirm: async () => true, log: () => {}, withSlot: createBudget() });
  const result = await flow.start(ctx(), { name: 'play', text: URL });
  await flow.select(ctx(`${result.id} 2`)); await flow.select(ctx(`${result.id} retry`));
  assert.equal(uploads, 1); assert.equal(f.calls.filter(c => c[0] === 'dc-audio').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'cobalt').length, 0);
});
for (const [message, code] of [['Request failed with status code 503', 'TRANSIENT'], ['Download failed (403).', 'FORBIDDEN'], ['Unable to download API page: HTTP Error 403', 'FORBIDDEN']]) {
  test(`classifies existing helper error: ${message}`, () => assert.equal(classifyError(message).code, code));
}
test('recovered adapter performs real MP3/Opus conversion and full decode when FFmpeg is installed', async t => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os'), path = require('node:path');
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { t.skip('FFmpeg not installed'); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recovered-real-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'source.mp3');
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.5', '-c:a', 'libmp3lame', input]);
  const f = setup(); f.net.downloadRemoteFile = async () => ({ buffer: await fs.readFile(input) });
  f.engine.resolveFfmpeg = async () => ({ command: 'ffmpeg' });
  const info = await f.provider.inspect(URL);
  const audio = await consume(f.provider, info, 'audio'); assert.equal(audio.mimetype, 'audio/mpeg');
  const voice = await consume(f.provider, info, 'voice'); assert.equal(voice.mimetype, 'audio/ogg; codecs=opus');
  assert.ok(voice.bytes.includes(Buffer.from('OpusHead')));
});
