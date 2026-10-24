'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const axios = require('axios');
const dc = require('../commands/davidcyril-api');
const net = require('../system/lib/net-tools');
const local = require('../system/lib/local-downloader');
const { loadConfig } = require('../system/config');
const URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

for (const method of ['downloadYtAudio', 'downloadYtVideo', 'aioDownload']) test(`${method} stops the existing endpoint pool when its provider deadline aborts`, async t => {
  const original = axios.get; t.after(() => { axios.get = original; }); let calls = 0;
  axios.get = async (url, options) => {
    calls++; assert.ok(options.signal); assert.equal(options.timeout, 50);
    return new Promise((resolve, reject) => {
      const hold = setTimeout(() => reject(new Error('deadline did not abort')), 1000);
      options.signal.addEventListener('abort', () => { clearTimeout(hold); reject(options.signal.reason); }, { once: true });
    });
  };
  const signal = AbortSignal.timeout(20);
  if (method === 'aioDownload') await assert.rejects(dc[method](URL, { timeout: 50, signal, quietLogs: true }), error => error === signal.reason);
  else {
    const result = await dc[method](URL, { timeout: 50, signal, quietLogs: true });
    assert.equal(result.ok, false); assert.equal(result.error, signal.reason);
  }
  assert.equal(calls, 1, 'no remaining endpoints are launched after cancellation');
});
test('existing MP3 parser prefers a real audio field over a competing video field', async t => {
  const original = axios.get; t.after(() => { axios.get = original; });
  axios.get = async () => ({ data: { status: true, result: { audio: 'https://media.example/audio.mp3', video: 'https://media.example/video.mp4', title: 'Correct track' } } });
  const result = await dc.downloadYtAudio(URL, { quietLogs: true });
  assert.equal(result.ok, true); assert.equal(result.url, 'https://media.example/audio.mp3');
});
for (const [name, response] of [
  ['403 with a custom message', () => new Response(JSON.stringify({ error: 'blocked here' }), { status: 403, headers: { 'content-type': 'application/json' } })],
  ['200 bot-check refusal', () => new Response(JSON.stringify({ status: 'error', text: 'Sign in to confirm you are not a bot' }), { headers: { 'content-type': 'application/json' } })],
  ['200 malformed JSON', () => new Response('{bad', { headers: { 'content-type': 'application/json' } })]
]) test(`Cobalt does not retry permanent ${name}`, async t => {
  const original = global.fetch; t.after(() => { global.fetch = original; }); let calls = 0;
  global.fetch = async () => { calls++; return response(); };
  await assert.rejects(net.requestCobalt('https://configured.example', URL)); assert.equal(calls, 1);
});
test('download body deadline covers a stalled body and propagates the real abort reason', async t => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  const hold = setTimeout(() => {}, 1000); t.after(() => clearTimeout(hold));
  let cancelled = false;
  global.fetch = async (url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from('ID3'));
    options.signal.addEventListener('abort', () => { cancelled = true; controller.error(options.signal.reason); }, { once: true });
  } }), { headers: { 'content-type': 'audio/mpeg' } });
  const signal = AbortSignal.timeout(20);
  await assert.rejects(net.downloadRemoteFile('https://media.example/audio', 1024, { signal }), error => error === signal.reason);
  assert.equal(cancelled, true);
});
test('runtime capability probing enables Node only on supporting binaries, caches the result and honors opt-out', { skip: process.platform === 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-runtime-test-'));
  t.after(async () => { local.resetEngineCache(); await fs.rm(directory, { recursive: true, force: true }); });
  for (const supported of [true, false]) {
    const file = path.join(directory, supported ? 'modern' : 'legacy'); const count = `${file}.calls`;
    await fs.writeFile(file, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(count)},'x'); console.log(${JSON.stringify(supported ? '--js-runtimes RUNTIME' : 'legacy help')});`, { mode: 0o755 });
    const engine = { command: file, prefixArgs: [], version: 'test' };
    const options = local.settings({ timeoutMs: 1000 });
    assert.equal((await local.runtimeOptions(engine, options)).jsRuntime, supported ? process.execPath : undefined);
    await local.runtimeOptions(engine, options); assert.equal((await fs.readFile(count, 'utf8')).length, 1);
    assert.equal((await local.runtimeOptions(engine, { ...options, jsRuntime: false })).jsRuntime, false);
    assert.equal((await fs.readFile(count, 'utf8')).length, 1);
  }
});
test('download concurrency/provider deadlines are validated configuration, not fixed hidden constants', () => {
  const source = structuredClone(require('../config'));
  source.downloads.maxConcurrent = 3; source.downloads.providerTimeoutMs = 2000;
  const config = loadConfig(source); assert.equal(config.downloadsMaxConcurrent, 3); assert.equal(config.downloadsProviderTimeoutMs, 2000);
  source.downloads.maxConcurrent = 0; assert.throws(() => loadConfig(source));
  source.downloads.maxConcurrent = 2; source.downloads.interactiveMode = 'list';
  assert.equal(loadConfig(source).downloadsInteractiveMode, 'list');
  source.downloads.interactiveMode = 'invalid'; assert.throws(() => loadConfig(source));
});

for (const codec of ['libx264', 'mpeg4']) test(`actual recovered video codec check: ${codec} in MP4`, async t => {
  const { execFileSync } = require('node:child_process');
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { t.skip('FFmpeg not installed'); return; }
  const { createRecoveredProvider } = require('../system/lib/youtube-recovered');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-codec-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const clip = path.join(directory, 'source.mp4');
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=160x120:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.5', '-c:v', codec, '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  const provider = createRecoveredProvider({ autoInstall: false, maxBytes: 1024 * 1024 }, { onlyProvider: 'cobalt', log: () => {},
    net: { requestCobalt: async () => ({ url: 'https://media.example/source' }), downloadRemoteFile: async () => ({ buffer: await fs.readFile(clip) }) } });
  const media = await provider.download(await provider.inspect(URL), 'video');
  try {
    assert.equal(media.mimetype, 'video/mp4'); assert.equal(Boolean(media.asDocument), codec !== 'libx264');
    assert.equal((await fs.readFile(media.file)).toString('ascii', 4, 8), 'ftyp');
  } finally { await media.cleanup(); }
});
test('conversion failure is classified and its temporary directory is removed', async t => {
  const { createRecoveredProvider } = require('../system/lib/youtube-recovered');
  const original = fs.mkdtemp; const directories = [];
  fs.mkdtemp = async (...args) => { const result = await original(...args); directories.push(result); return result; };
  t.after(() => { fs.mkdtemp = original; });
  const provider = createRecoveredProvider({ maxBytes: 1024, timeoutMs: 1000 }, { onlyProvider: 'cobalt', log: () => {},
    local: { ...local, resolveFfmpeg: async () => ({ command: process.execPath }) },
    net: { requestCobalt: async () => ({ url: 'https://media.example/audio' }), downloadRemoteFile: async () => ({ buffer: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(128)]) }) } });
  await assert.rejects(provider.download(await provider.inspect(URL), 'voice'), error => {
    assert.equal(error.code, 'PROVIDERS'); assert.equal(error.failures[0].code, 'CONVERSION'); return true;
  });
  assert.equal(directories.length, 1);
  await assert.rejects(fs.stat(directories[0]), { code: 'ENOENT' });
});

test('Cobalt upstream deadline still aborts a stalled JSON body after response headers', async t => {
  const original = global.fetch; t.after(() => { global.fetch = original; }); let calls = 0;
  const hold = setTimeout(() => {}, 1000); t.after(() => clearTimeout(hold));
  global.fetch = async (url, options) => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('{'));
      options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
    } }), { headers: { 'content-type': 'application/json' } });
  };
  const signal = AbortSignal.timeout(20);
  await assert.rejects(net.requestCobalt('https://configured.example', URL, { signal, timeoutMs: 1000 }), error => error === signal.reason);
  assert.equal(calls, 1, 'no retry or live body survives the family deadline');
});
