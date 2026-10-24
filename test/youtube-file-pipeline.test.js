'use strict';
// Deterministic transport/file tests. External services and upload sockets are
// mocked; this does not establish live YouTube/WhatsApp delivery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('../system/lib/net-tools');
const local = require('../system/lib/local-downloader');
const { createRecoveredProvider, mediaTypeFile } = require('../system/lib/youtube-recovered');
const URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(128)]);
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-pipeline-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
function mockFetch(t, fn) { const original = global.fetch; global.fetch = fn; t.after(() => { global.fetch = original; }); }

test('media response streams into a private file without returning a full Buffer', async t => {
  const file = path.join(await directory(t), 'media.bin');
  mockFetch(t, async () => new Response(mp3, { headers: { 'content-length': String(mp3.length) } }));
  const result = await net.downloadRemoteFile('https://media.example/audio', 1024, { file });
  assert.equal(result.file, file); assert.equal(result.bytes, mp3.length); assert.equal(result.buffer, undefined);
  assert.deepEqual(await fs.readFile(file), mp3);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});
for (const [name, body, headers, limit] of [
  ['empty body', '', {}, 1024], ['truncated body', mp3, { 'content-length': '999' }, 1024],
  ['announced overflow', mp3, { 'content-length': '9999' }, 1024], ['chunk overflow', Buffer.alloc(2048), {}, 1024]
]) test(`streamed ${name} rejects and removes partial output`, async t => {
  const file = path.join(await directory(t), 'partial.bin');
  mockFetch(t, async () => new Response(body, { headers }));
  await assert.rejects(net.downloadRemoteFile('https://media.example/audio', limit, { file }));
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
test('exclusive output creation cannot erase an existing file', async t => {
  const file = path.join(await directory(t), 'existing'); await fs.writeFile(file, 'keep');
  mockFetch(t, async () => new Response(mp3));
  await assert.rejects(net.downloadRemoteFile('https://media.example/audio', 1024, { file }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});
test('upstream cancellation stops a streaming body and cleans its partial file', async t => {
  const file = path.join(await directory(t), 'partial.bin'); const controller = new AbortController();
  let bodyCanceled = false;
  mockFetch(t, async (url, options) => new Response(new ReadableStream({ start(stream) {
    stream.enqueue(mp3);
    options.signal.addEventListener('abort', () => { bodyCanceled = true; stream.error(options.signal.reason); }, { once: true });
  } })));
  const promise = net.downloadRemoteFile('https://media.example/audio', 1024, { file, signal: controller.signal });
  const reason = new Error('test deadline'); const timer = setTimeout(() => controller.abort(reason), 20);
  try { await assert.rejects(promise, error => error === reason); } finally { clearTimeout(timer); }
  assert.equal(bodyCanceled, true); await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
test('shared fetch helper retains upstream cancellation after HTTP headers', async t => {
  const controller = new AbortController();
  mockFetch(t, async (url, options) => new Response(new ReadableStream({ start(stream) {
    options.signal.addEventListener('abort', () => stream.error(options.signal.reason), { once: true });
  } })));
  const response = await net.fetchWithTimeout('https://media.example', { signal: controller.signal }, 1000);
  const body = response.text(); const reason = new Error('body deadline'); controller.abort(reason);
  await assert.rejects(body, error => error === reason);
});
test('file validation detects MP4 markers across read boundaries without whole-file buffering', async t => {
  const file = path.join(await directory(t), 'media.bin');
  const bytes = Buffer.alloc(128 * 1024); bytes.write('ftyp', 4); bytes.write('moov mdat vide soun avc1 mp4a', 65534);
  await fs.writeFile(file, bytes);
  assert.equal((await mediaTypeFile(file, 'video', bytes.length)).ext, 'mp4');
  await assert.rejects(mediaTypeFile(file, 'video', 1024), { code: 'SIZE' });
});
test('Matroska is not mislabeled WebM, and HTML cannot pass the file gate', async t => {
  const file = path.join(await directory(t), 'media.bin');
  await fs.writeFile(file, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('matroska')]));
  assert.equal((await mediaTypeFile(file, 'video', 1024)).mimetype, 'video/x-matroska');
  await fs.writeFile(file, '<html>Error</html>'); await assert.rejects(mediaTypeFile(file, 'video', 1024), { code: 'CORRUPT' });
});
test('actual recovered API path streams, returns a file and releases its directory', async t => {
  mockFetch(t, async () => new Response(mp3));
  const provider = createRecoveredProvider({ autoInstall: false, maxBytes: 1024 }, {
    onlyProvider: 'davidcyril', log: () => {},
    dc: { downloadYtAudio: async () => ({ ok: true, url: 'https://media.example/audio' }) },
    local: { ...local, resolveFfmpeg: async () => null }
  });
  const media = await provider.download(await provider.inspect(URL, { title: 'Requested song' }), 'audio');
  assert.equal(media.buffer, undefined); assert.equal(media.mimetype, 'audio/mpeg');
  assert.deepEqual(await fs.readFile(media.file), mp3);
  await media.cleanup(); await assert.rejects(fs.stat(path.dirname(media.file)), { code: 'ENOENT' });
});
test('file-backed fallback cleanup runs even when validation rejects its bytes', async t => {
  const dir = await directory(t), file = path.join(dir, 'media.bin'); await fs.writeFile(file, 'not media'); let cleaned = 0;
  const provider = createRecoveredProvider({ autoInstall: false }, {
    onlyProvider: 'local', log: () => {}, local: { ...local,
      downloadAudio: async (url, options) => { assert.equal(options.fileBacked, true); return { file, cleanup: async () => { cleaned++; await fs.rm(file); } }; }
    }
  });
  await assert.rejects(provider.download(await provider.inspect(URL), 'audio'));
  assert.equal(cleaned, 1); await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
function page(details) { return `var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: details })};`; }
test('watch metadata preserves the exact source, escaped titles, channel and duration', async t => {
  mockFetch(t, async () => new Response(page({ videoId: 'dQw4w9WgXcQ', title: 'Title with } and "quotes"', author: 'Channel', lengthSeconds: '123' })));
  assert.deepEqual(await net.youtubeMetadata(URL), { title: 'Title with } and "quotes"', author: 'Channel', duration: 123 });
});
for (const [name, content] of [['wrong source', page({ videoId: 'BaW_jenozKc', title: 'Other song' })], ['malformed metadata', 'var ytInitialPlayerResponse = {bad};'], ['missing metadata', '<html>unavailable</html>']]) test(`watch metadata rejects ${name}`, async t => {
  mockFetch(t, async () => new Response(content)); await assert.rejects(net.youtubeMetadata(URL));
});
test('direct metadata is best effort and never gates the old download APIs', async () => {
  const provider = createRecoveredProvider({}, { log: () => {}, metadata: async url => { assert.equal(url, URL); throw new Error('TLS failure'); } });
  const info = await provider.inspect(URL); assert.equal(info.metadataSource, 'fallback'); assert.equal(info.autoVideo, true);
  const known = await provider.inspect(URL, { title: 'Searched title', author: 'Channel' }); assert.equal(known.metadataSource, 'search');
});
test('direct watch metadata fills the initial media card without a local extractor', async () => {
  const provider = createRecoveredProvider({}, { metadata: async () => ({ title: 'Actual title', author: 'Actual channel', duration: 61 }) });
  const info = await provider.inspect(URL); assert.equal(info.title, 'Actual title'); assert.equal(info.uploader, 'Actual channel'); assert.equal(info.duration, 61);
});

test('real streamed MP4/MP3/voice files pass FFmpeg; non-420 H.264 is a document, not inline video', async t => {
  const { execFileSync } = require('node:child_process');
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { t.skip('FFmpeg not installed'); return; }
  const dir = await directory(t), sound = path.join(dir, 'sound.mp3');
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.5', '-c:a', 'libmp3lame', sound]);
  let input = sound;
  mockFetch(t, async () => new Response(await fs.readFile(input)));
  const provider = createRecoveredProvider({ autoInstall: false, maxBytes: 2 * 1024 * 1024 }, {
    onlyProvider: 'davidcyril', log: () => {},
    dc: { downloadYtAudio: async () => ({ ok: true, url: 'https://media.example/audio' }), downloadYtVideo: async () => ({ ok: true, url: 'https://media.example/video' }) },
    local: { ...local, resolveFfmpeg: async () => ({ command: 'ffmpeg' }) }
  });
  const info = await provider.inspect(URL, { title: 'Requested title' });
  for (const kind of ['audio', 'voice']) {
    const media = await provider.download(info, kind);
    try {
      assert.equal(media.buffer, undefined);
      assert.equal(media.mimetype, kind === 'audio' ? 'audio/mpeg' : 'audio/ogg; codecs=opus');
      await require('../system/lib/youtube-engine').validateFile(media.file, kind, { command: 'ffmpeg' }, { maxBytes: 2 * 1024 * 1024, timeoutMs: 5000 });
    } finally { await media.cleanup(); }
    await assert.rejects(fs.stat(media.file), { code: 'ENOENT' });
  }
  for (const pixel of ['yuv420p', 'yuv444p']) {
    input = path.join(dir, `${pixel}.mp4`);
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=160x120:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', pixel, '-c:a', 'aac', input]);
    const media = await provider.download(info, 'video');
    try {
      assert.equal(Boolean(media.asDocument), pixel !== 'yuv420p');
      assert.equal(media.mimetype, 'video/mp4');
      assert.equal(media.fileName, 'Requested title.mp4');
      if (pixel === 'yuv444p') await assert.rejects(require('../system/lib/youtube-engine').validateFile(media.file, 'video', { command: 'ffmpeg' }, { maxBytes: 2 * 1024 * 1024, timeoutMs: 5000 }), { code: 'CORRUPT' });
    } finally { await media.cleanup(); }
  }
});

test('deadline also cancels a stalled disk sink after the response body has completed', async t => {
  const { Writable } = require('node:stream');
  const file = path.join(await directory(t), 'stalled.bin');
  const open = fs.open; t.after(() => { fs.open = open; });
  const sink = new Writable({ write(chunk, encoding, callback) { /* Deliberately stalled disk boundary. */ } });
  fs.open = async () => ({ createWriteStream: () => sink, close: async () => {} });
  mockFetch(t, async () => new Response(mp3));
  const controller = new AbortController(), reason = new Error('provider deadline');
  let forced = false;
  const fallback = setTimeout(() => { forced = true; sink.destroy(new Error('test safety deadline')); }, 1000);
  const timer = setTimeout(() => controller.abort(reason), 20);
  try { await assert.rejects(net.downloadRemoteFile('https://media.example/audio', 1024, { file, signal: controller.signal }), error => error === reason); }
  finally { clearTimeout(timer); clearTimeout(fallback); }
  assert.equal(forced, false, 'pipeline must not wait for its sink after the provider aborts');
});

test('oversized metadata is rejected before reading and releases its response body', async t => {
  let canceled = false;
  mockFetch(t, async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'content-length': String(3 * 1024 * 1024) } }));
  await assert.rejects(net.youtubeMetadata(URL), /too large/i);
  assert.equal(canceled, true);
});
