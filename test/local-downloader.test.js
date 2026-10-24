'use strict';

// The local engine is exercised with a fake yt-dlp executable: real process
// spawning, real argument passing, real file output. No network and no
// third-party API is involved in these tests. Automatic provisioning is tested
// with an injected fetch that serves the same fake executable.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DownloadEngineError,
  audioFormatArgs,
  audioMatchScore,
  detectFfmpeg,
  downloadAudio,
  downloadVideo,
  getInfo,
  mimetypeFor,
  platformEngineAsset,
  platformFfmpegAsset,
  probeFfmpeg,
  provisionEngine,
  provisionFfmpeg,
  resolveEngine,
  safeTitle,
  searchAudio,
  searchVideo,
  settings,
  videoFormatArgs
} = require('../system/lib/local-downloader');

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX executable fixture' : false };

const FAKE_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_ARGS_FILE) fs.appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args) + '\\n');
if (args.includes('--version')) { console.log('2026.01.01'); process.exit(0); }
if (args.includes('--help')) { console.log('Legacy fixture help'); process.exit(0); }
if (args.includes('-J')) {
  if (args.some((arg) => String(arg).startsWith('ytsearch'))) {
    console.log(JSON.stringify({ _type: 'playlist', entries: [{ id: 'abc123', title: 'Local Search Result', url: 'https://www.youtube.com/watch?v=abc123' }] }));
    process.exit(0);
  }
  if (args.some((arg) => String(arg).startsWith('scsearch'))) {
    console.log(JSON.stringify({ _type: 'playlist', entries: [
      { id: 'sc1', title: 'Funky Song Cloud Track', webpage_url: 'https://soundcloud.com/x/cloud-track', duration: 210 },
      { id: 'sc2', title: 'Hour Long Mix', webpage_url: 'https://soundcloud.com/x/long-mix', duration: 3600 },
      { id: 'sc3', title: 'Hosanna 2026 New Song', webpage_url: 'https://soundcloud.com/x/unrelated', duration: 200 }
    ] }));
    process.exit(0);
  }
  if (process.env.FAKE_PLAYLIST === '1') {
    console.log(JSON.stringify({ _type: 'playlist', title: 'List' }));
  } else {
    console.log(JSON.stringify({ _type: 'video', id: 'abc123', title: process.env.FAKE_TITLE || 'Test / Song: Deluxe?' }));
  }
  process.exit(0);
}
if (process.env.FAKE_FAIL === '1') { console.error(process.env.FAKE_ERROR || 'ERROR: Sign in to confirm you\\'re not a bot'); process.exit(1); }
const format = args[args.indexOf('-f') + 1] || '';
const relaxed = format === 'bestaudio/best' || format === '18/b' || format === 'bv*+ba/b';
if (process.env.FAKE_FORMAT_FAIL === '1' && !relaxed) { console.error(process.env.FAKE_FORMAT_ERROR || 'ERROR: Requested format is not available'); process.exit(1); }
const outIndex = args.indexOf('-o');
const template = args[outIndex + 1];
const extract = args.includes('--extract-audio');
const ext = extract ? 'mp3' : String(format).startsWith('bestaudio') ? 'm4a' : 'mp4';
const file = template.replace('%(ext)s', ext);
fs.writeFileSync(file, Buffer.alloc(Number(process.env.FAKE_SIZE || 16), 7));
console.log('done');
if (process.env.FAKE_STALL === '1') setTimeout(() => {}, 10000);
`;

function fakeBinary(name = 'yt-dlp') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-md-fake-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, FAKE_SCRIPT, { mode: 0o755 });
  return file;
}

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

// Provisioning tests model a fresh host even when the developer has yt-dlp in Python.
async function withoutPython(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-no-python-'));
  fs.symlinkSync(process.execPath, path.join(directory, 'node'));
  try { return await withEnv({ PATH: directory }, fn); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('audio download returns the produced MP3 buffer, title and safe file name', posixOnly, async () => {
  const bin = fakeBinary();
  const result = await downloadAudio('https://www.youtube.com/watch?v=abc123', { bin, ffmpeg: true, maxBytes: 1024 * 1024, timeoutMs: 10_000 });
  assert.equal(result.mimetype, 'audio/mpeg');
  assert.equal(result.fileName, 'Test Song Deluxe.mp3');
  assert.equal(result.title, 'Test Song Deluxe');
  assert.equal(result.buffer.length, 16);
});

test('without FFmpeg the audio path downloads a ready-to-play M4A instead of failing', posixOnly, async () => {
  const bin = fakeBinary();
  const result = await downloadAudio('https://www.youtube.com/watch?v=abc123', { bin, ffmpeg: false, maxBytes: 1024 * 1024, timeoutMs: 10_000 });
  assert.equal(result.mimetype, 'audio/mp4');
  assert.equal(result.fileName, 'Test Song Deluxe.m4a');
  assert.equal(result.buffer.length, 16);
});

test('video download uses the MP4 merge path and returns a video payload', posixOnly, async () => {
  const bin = fakeBinary();
  const result = await downloadVideo('https://www.youtube.com/watch?v=abc123', { bin, ffmpeg: true, maxBytes: 1024 * 1024, timeoutMs: 10_000 });
  assert.equal(result.mimetype, 'video/mp4');
  assert.equal(result.fileName, 'Test Song Deluxe.mp4');
  assert.equal(result.buffer.length, 16);
});

test('without FFmpeg the video path asks for progressive MP4 and never merges', posixOnly, async () => {
  const bin = fakeBinary();
  const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anime-md-args-')), 'args.log');
  await withEnv({ FAKE_ARGS_FILE: argsFile }, async () => {
    const result = await downloadVideo('https://www.youtube.com/watch?v=abc123', { bin, ffmpeg: false, maxBytes: 1024 * 1024, timeoutMs: 10_000 });
    assert.equal(result.mimetype, 'video/mp4');
  });
  const runs = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const downloadRun = runs.find((args) => args.includes('-o'));
  assert.ok(downloadRun, 'the download process ran');
  assert.ok(!downloadRun.includes('--merge-output-format'), 'no merge is requested without FFmpeg');
  const format = downloadRun[downloadRun.indexOf('-f') + 1];
  assert.match(format, /acodec!=none/, 'a progressive format with both streams is requested');
  assert.ok(!format.includes('+'), 'no separate audio/video streams are combined');
});

test('format selection depends on FFmpeg availability', () => {
  assert.ok(audioFormatArgs(true).includes('--extract-audio'));
  assert.ok(!audioFormatArgs(false).includes('--extract-audio'));
  assert.ok(videoFormatArgs(true).includes('--merge-output-format'));
  assert.ok(!videoFormatArgs(false).includes('--merge-output-format'));
});

test('a vanished format is retried once with a relaxed selector', posixOnly, async () => {
  const bin = fakeBinary();
  const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anime-md-args-')), 'args.log');
  const warning = console.warn; const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await withEnv({ FAKE_FORMAT_FAIL: '1', FAKE_FORMAT_ERROR: 'ERROR: Requested format is not available https://cdn.example/private?token=SECRET', FAKE_ARGS_FILE: argsFile }, async () => {
      const result = await downloadAudio('https://www.youtube.com/watch?v=abc123', { bin, ffmpeg: true, maxBytes: 1024 * 1024, timeoutMs: 10_000 });
      assert.equal(result.buffer.length, 16);
    });
  } finally { console.warn = warning; }
  assert.match(warnings.join(' '), /relaxed format/);
  assert.doesNotMatch(warnings.join(' '), /SECRET|cdn.example/);
  const runs = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const downloads = runs.filter((args) => args.includes('-o'));
  assert.equal(downloads.length, 2, 'one retry after the format failure');
  assert.equal(downloads[1][downloads[1].indexOf('-f') + 1], 'bestaudio/best');
});

test('metadata is parsed and a playlist link is rejected before downloading', posixOnly, async () => {
  const bin = fakeBinary();
  const info = await getInfo('https://www.youtube.com/watch?v=abc123', { bin, timeoutMs: 10_000 });
  assert.equal(info.title, 'Test / Song: Deluxe?');

  await withEnv({ FAKE_PLAYLIST: '1' }, async () => {
    await assert.rejects(
      getInfo('https://www.youtube.com/playlist?list=1', { bin, timeoutMs: 10_000 }),
      /Playlist links are not supported/
    );
  });
});

test('the engine can search YouTube itself when the page scraper is unavailable', posixOnly, async () => {
  const bin = fakeBinary();
  const [result] = await searchVideo('funky song', { bin, timeoutMs: 10_000 });
  assert.equal(result.title, 'Local Search Result');
  assert.equal(result.url, 'https://www.youtube.com/watch?v=abc123');
  await assert.rejects(searchVideo('', { bin, timeoutMs: 10_000 }), /Empty search query/);
});

test('the second local source keeps matching short audio and drops long mixes and unrelated titles', posixOnly, async () => {
  const bin = fakeBinary();
  const tracks = await searchAudio('funky song', { bin, timeoutMs: 10_000 }, 3);
  assert.deepEqual(tracks, [{ title: 'Funky Song Cloud Track', url: 'https://soundcloud.com/x/cloud-track' }]);
});

test('a fuzzy audio result is only accepted when it matches the query', () => {
  assert.equal(audioMatchScore('karan aujla szn', 'Aujla Szn - Karan Aujla'), 1);
  assert.equal(audioMatchScore('funks 2026 latest', 'Hosanna 2026 New Song'), 0.5);
  assert.ok(audioMatchScore('believer imagine dragons', 'Imagine Dragons - Believer (Official Video)') >= 0.6);
  assert.equal(audioMatchScore('funky song', 'Completely Different Track'), 0);
});

test('an explicitly configured engine path that does not exist is reported, never silently replaced', async () => {
  await assert.rejects(
    downloadAudio('https://www.youtube.com/watch?v=abc123', { bin: path.join(os.tmpdir(), 'definitely-no-yt-dlp-here'), timeoutMs: 10_000 }),
    (error) => {
      assert.ok(error instanceof DownloadEngineError);
      assert.match(error.message, /not found/);
      assert.match(error.userMessage, /yt-dlp/);
      assert.match(error.userMessage, /not installed/);
      return true;
    }
  );
});

test('a bundled engine in downloads.binDir is discovered without PATH access', posixOnly, async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-md-bundled-'));
  const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  fs.writeFileSync(path.join(binDir, name), FAKE_SCRIPT, { mode: 0o755 });
  const engine = await resolveEngine(settings({ bin: 'yt-dlp-not-on-this-path', binDir, autoInstall: false, timeoutMs: 10_000 }));
  assert.equal(engine.source, 'bundled');
  assert.equal(engine.version, '2026.01.01');
});

test('a fresh host provisions the official engine automatically and then downloads', posixOnly, async () => withoutPython(async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-md-provision-'));
  const fetchImpl = async () => new Response(FAKE_SCRIPT, { status: 200 });
  const options = settings({ bin: 'yt-dlp-absent-from-this-host', binDir, autoInstall: true, ffmpeg: true, timeoutMs: 10_000, maxBytes: 1024 * 1024, fetchImpl, minBytes: 8 });
  const engine = await resolveEngine(options);
  assert.equal(engine.source, 'provisioned');
  assert.ok(fs.existsSync(path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')));

  const result = await downloadAudio('https://www.youtube.com/watch?v=abc123', options);
  assert.equal(result.buffer.length, 16);
}));

test('FFmpeg is provisioned automatically so video can be merged', posixOnly, async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-md-ffmpeg-'));
  const script = '#!/usr/bin/env node\nconsole.log("ffmpeg version 6.0-static Copyright");\n';
  const fetchImpl = async () => new Response(script, { status: 200 });
  const result = await provisionFfmpeg({ binDir, fetchImpl, url: 'https://example.test/ffmpeg', minBytes: 8 });
  assert.equal(result.version, '6.0-static');
  assert.equal(result.source, 'provisioned');
  assert.ok(fs.existsSync(path.join(binDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')));
  assert.equal(await probeFfmpeg(result.command), '6.0-static');
});

test('provisioning refuses an incomplete download and leaves no broken executable', posixOnly, async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-md-provision-'));
  const fetchImpl = async () => new Response('#!/bin/sh\necho broken\n', { status: 200 });
  await assert.rejects(provisionEngine({ binDir, fetchImpl, url: 'https://example.test/yt-dlp', minBytes: 4096 }), /incomplete/);
  assert.ok(!fs.existsSync(path.join(binDir, 'yt-dlp')), 'no partial engine is left behind');
});

test('a failed automatic setup is retried on the next command instead of being cached', posixOnly, async () => withoutPython(async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-md-retry-'));
  const fetchImpl = async () => new Response('nope', { status: 503 });
  const options = settings({ bin: 'yt-dlp-offline-host', binDir, autoInstall: true, timeoutMs: 10_000, fetchImpl });
  await assert.rejects(resolveEngine(options), (error) => {
    assert.match(error.userMessage, /not installed/i);
    return true;
  });

  const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  fs.writeFileSync(path.join(binDir, name), FAKE_SCRIPT, { mode: 0o755 });
  const engine = await resolveEngine(options);
  assert.equal(engine.source, 'bundled');
}));

test('a missing FFmpeg is detected instead of assumed', async () => {
  assert.equal(await detectFfmpeg({ bin: 'definitely-no-ffmpeg-on-this-host' }), false);
});

test('response MIME types follow the real container', () => {
  assert.equal(mimetypeFor('mp3', true), 'audio/mpeg');
  assert.equal(mimetypeFor('m4a', true), 'audio/mp4');
  assert.equal(mimetypeFor('opus', true), 'audio/ogg');
  assert.equal(mimetypeFor('mp4', false), 'video/mp4');
  assert.equal(mimetypeFor('webm', false), 'video/webm');
});

test('a standalone build name is chosen for every supported platform', () => {
  assert.equal(platformEngineAsset('win32', 'x64'), 'yt-dlp.exe');
  assert.equal(platformEngineAsset('darwin', 'arm64'), 'yt-dlp_macos');
  assert.ok(platformEngineAsset('linux', 'x64'));
  assert.ok(platformEngineAsset('linux', 'arm64'));
  assert.equal(platformFfmpegAsset('linux', 'x64'), 'ffmpeg-linux-x64');
  assert.equal(platformFfmpegAsset('darwin', 'arm64'), 'ffmpeg-darwin-arm64');
  assert.equal(platformFfmpegAsset('win32', 'x64'), 'ffmpeg-win32-x64');
  assert.equal(platformFfmpegAsset('freebsd', 'x64'), null);
});

test('bot-check failures do not assert login or prescribe cookies', posixOnly, async () => {
  const bin = fakeBinary();
  await withEnv({ FAKE_FAIL: '1' }, async () => {
    await assert.rejects(
      downloadVideo('https://www.youtube.com/watch?v=abc123', { bin, ffmpeg: true, maxBytes: 1024 * 1024, timeoutMs: 10_000 }),
      (error) => {
        assert.match(error.userMessage, /automated traffic/i);
        assert.doesNotMatch(error.userMessage, /cookies|signed.in|login/i);
        assert.match(error.message, /Sign in to confirm/);
        return true;
      }
    );
  });
});

test('a file above the configured limit is rejected after download', posixOnly, async () => {
  const bin = fakeBinary();
  await withEnv({ FAKE_SIZE: '2048' }, async () => {
    await assert.rejects(
      downloadAudio('https://www.youtube.com/watch?v=abc123', { bin, ffmpeg: true, maxBytes: 1024, timeoutMs: 10_000 }),
      /above the configured limit/
    );
  });
});

test('non-http input is rejected before any process is spawned', async () => {
  await assert.rejects(downloadAudio('not a url', { bin: 'ignored', timeoutMs: 1000 }), /Invalid media URL/);
});

test('titles are stripped of path separators and control characters', () => {
  assert.equal(safeTitle('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(safeTitle('   '), 'media');
  assert.equal(safeTitle('x'.repeat(300)).length, 120);
});

test('a bot challenge mentioning extraction is not retried with another format', posixOnly, async () => {
  const bin = fakeBinary();
  const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anime-botcheck-')), 'args.log');
  await withEnv({ FAKE_FAIL: '1', FAKE_ERROR: "ERROR: Unable to extract: Sign in to confirm you're not a bot", FAKE_ARGS_FILE: argsFile }, async () => {
    await assert.rejects(downloadVideo('https://www.youtube.com/watch?v=abc123', { bin, ffmpeg: true, timeoutMs: 1000 }), error => {
      assert.match(error.userMessage, /automated traffic/); return true;
    });
  });
  const runs = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(runs.filter(args => args.includes('-o')).length, 1);
});
test('a cookie-file read error is not proof that the video needs login', posixOnly, async () => {
  const bin = fakeBinary();
  await withEnv({ FAKE_FAIL: '1', FAKE_ERROR: 'ERROR: Could not read cookies file: Permission denied' }, async () => {
    await assert.rejects(downloadVideo('https://www.youtube.com/watch?v=abc123', { bin, ffmpeg: true, timeoutMs: 1000 }), error => {
      assert.doesNotMatch(error.userMessage, /requires.*session|signed.in|configure.*cookies/i); return true;
    });
  });
});

test('file-backed local download keeps the private output until caller cleanup', posixOnly, async () => {
  const result = await downloadAudio('https://www.youtube.com/watch?v=abc123', { bin: fakeBinary(), ffmpeg: true, fileBacked: true, maxBytes: 1024, timeoutMs: 1000 });
  assert.equal(result.buffer, undefined); assert.equal(typeof result.cleanup, 'function');
  assert.equal(fs.statSync(result.file).size, 16);
  await result.cleanup(); assert.equal(fs.existsSync(result.file), false);
});
test('local storage watchdog kills oversized in-progress output and cleans its directory', posixOnly, async () => {
  const bin = fakeBinary(), argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anime-storage-')), 'args.log');
  await withEnv({ FAKE_STALL: '1', FAKE_SIZE: '20000', FAKE_ARGS_FILE: argsFile }, async () => {
    await assert.rejects(downloadVideo('https://www.youtube.com/watch?v=abc123', { bin, ffmpeg: false, fileBacked: true, maxBytes: 1024, timeoutMs: 5000 }), /storage size limit/);
  });
  const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(JSON.parse).find(args => args.includes('-o'));
  assert.equal(fs.existsSync(path.dirname(args[args.indexOf('-o') + 1])), false);
});
