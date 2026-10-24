'use strict';
// Actual subprocesses and FFmpeg media. Only the YouTube boundary is replaced
// by a tiny executable copying a local, generated one-second source clip.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createLocalProvider, validateFile, run, MediaError } = require('../system/lib/youtube-engine');
const local = require('../system/lib/local-downloader');
const URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
let ffmpegAvailable = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpegAvailable = true; } catch { /* Report a genuine skip on hosts without FFmpeg. */ }
async function setup(t, mode = 'normal', overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-youtube-test-'));
  t.after(async () => { local.resetEngineCache(); await fs.rm(directory, { recursive: true, force: true }); });
  const clip = path.join(directory, 'fixture.mp4');
  if (ffmpegAvailable) execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  const metadata = { id: 'dQw4w9WgXcQ', title: '../../Example: song?', uploader: 'Fixture uploader', duration: 1, formats: [
    { format_id: '18', ext: 'mp4', height: 240, vcodec: 'avc1.42001e', acodec: 'mp4a.40.2', filesize: 15000 }
  ] };
  const bin = path.join(directory, 'yt-dlp');
  await fs.writeFile(bin, `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture-1'); process.exit(0); }
if (!args.includes('--js-runtimes') || !args.includes('node:' + process.execPath)) { console.error('JavaScript runtime was not enabled'); process.exit(1); }
if (args.includes('-J')) {
  if (${JSON.stringify(mode)} === 'malformed') console.log('{bad-json');
  else if (${JSON.stringify(mode)} === 'missing-formats') console.log(JSON.stringify({ id: 'dQw4w9WgXcQ' }));
  else console.log(${JSON.stringify(JSON.stringify(metadata))});
  process.exit(0);
}
if (${JSON.stringify(mode)} === '403') { console.error('HTTP Error 403: Forbidden'); process.exit(1); }
const target = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4');
if (${JSON.stringify(mode)} === 'empty') fs.writeFileSync(target, '');
else if (${JSON.stringify(mode)} === 'json') fs.writeFileSync(target, '{"status":200,"error":"expired URL"}');
else fs.copyFileSync(${JSON.stringify(clip)}, target);
`, { mode: 0o755 });
  return { directory, clip, provider: createLocalProvider({ bin, ffmpegPath: 'ffmpeg', autoInstall: false, timeoutMs: 10000, maxBytes: 1024 * 1024, ...overrides }) };
}
test('file-backed audio, voice Opus and MP4 travel through actual engine, transcoding, full decode, and cleanup', { skip: !ffmpegAvailable || process.platform === 'win32' }, async t => {
  const { provider } = await setup(t);
  const info = await provider.inspect(URL);
  assert.equal(info.title.includes('/'), false);
  assert.deepEqual(info.qualities.map(q => q.height), [240]);
  for (const kind of ['audio', 'voice', 'video']) {
    const stages = []; const media = await provider.download(info, kind, 240, async stage => stages.push(stage));
    try {
      const bytes = await fs.readFile(media.file);
      assert.ok(bytes.length > 1000); assert.ok(!('buffer' in media));
      assert.deepEqual(stages, ['Downloading', 'Processing and validating']);
      if (kind === 'video') {
        assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
        await assert.rejects(validateFile(media.file, kind, { command: 'ffmpeg' }, { maxBytes: 1024 * 1024, timeoutMs: 1000, expectedHeight: 1080 }), { code: 'QUALITY' });
        await assert.rejects(validateFile(media.file, kind, { command: 'ffmpeg' }, { maxBytes: 1024 * 1024, timeoutMs: 1000, expectedDuration: 90 }), { code: 'CORRUPT' });
      }
      if (kind === 'voice') { assert.equal(bytes.toString('ascii', 0, 4), 'OggS'); assert.ok(bytes.includes(Buffer.from('OpusHead'))); }
      if (kind === 'audio') assert.equal(media.mimetype, 'audio/mpeg');
    } finally { await media.cleanup(); }
    await assert.rejects(fs.stat(media.file), { code: 'ENOENT' });
  }
});
for (const mode of ['malformed', 'missing-formats']) test(`actual metadata subprocess rejects ${mode}`, { skip: process.platform === 'win32' }, async t => {
  const { provider } = await setup(t, mode);
  await assert.rejects(provider.inspect(URL), MediaError);
});
for (const mode of ['403', 'empty', 'json']) test(`actual download subprocess rejects ${mode} and cleans temporary outputs`, { skip: !ffmpegAvailable || process.platform === 'win32' }, async t => {
  const { provider } = await setup(t, mode); const info = await provider.inspect(URL);
  const before = new Set((await fs.readdir(os.tmpdir())).filter(n => n.startsWith('anime-youtube-') && !n.startsWith('anime-youtube-test-')));
  await assert.rejects(provider.download(info, 'audio'), MediaError);
  const after = (await fs.readdir(os.tmpdir())).filter(n => n.startsWith('anime-youtube-') && !n.startsWith('anime-youtube-test-'));
  assert.ok(after.every(n => before.has(n)), 'no new download directory survives a failure');
});
test('actual engine rejects missing audio, missing video qualities and unavailable resolution', { skip: !ffmpegAvailable || process.platform === 'win32' }, async t => {
  const { provider } = await setup(t); const info = await provider.inspect(URL);
  await assert.rejects(provider.download({ ...info, audio: false }, 'audio'), { code: 'AUDIO' });
  await assert.rejects(provider.download({ ...info, qualities: [] }, 'video', 240), { code: 'QUALITY' });
  await assert.rejects(provider.download(info, 'video', 1080), { code: 'QUALITY' });
});
test('known size limits filter formats and final byte validation rejects oversized files', { skip: !ffmpegAvailable || process.platform === 'win32' }, async t => {
  const { provider, clip } = await setup(t, 'normal', { maxBytes: 50 });
  const info = await provider.inspect(URL); assert.deepEqual(info.qualities, []);
  await assert.rejects(provider.download(info, 'audio'), { code: 'SIZE' });
  await assert.rejects(validateFile(clip, 'video', { command: 'ffmpeg' }, { maxBytes: 10, timeoutMs: 1000 }), { code: 'SIZE' });
});
test('magic-looking but truncated MP4 is rejected by the real full-media decoder', { skip: !ffmpegAvailable }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-corrupt-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'corrupt.mp4');
  await fs.writeFile(file, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64)]));
  await assert.rejects(validateFile(file, 'video', { command: 'ffmpeg' }, { maxBytes: 1024, timeoutMs: 1000 }), MediaError);
});
test('subprocess timeouts and aggregate storage watchdog kill the process instead of hanging the bot', async t => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30, maxBytes: 100 }), { code: 'TIMEOUT' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-disk-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(run(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(directory, 'large'))},Buffer.alloc(2048));setInterval(()=>{},1000)`], { timeoutMs: 3000, directory, maxBytes: 100 }), { code: 'SIZE' });
});
