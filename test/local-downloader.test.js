'use strict';

// The local engine is exercised with a fake yt-dlp executable: real process
// spawning, real argument passing, real file output. No network and no
// third-party API is involved in these tests.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DownloadEngineError,
  downloadAudio,
  downloadVideo,
  getInfo,
  safeTitle
} = require('../system/lib/local-downloader');

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX executable fixture' : false };

const FAKE_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2026.01.01'); process.exit(0); }
if (args.includes('-J')) {
  if (process.env.FAKE_PLAYLIST === '1') {
    console.log(JSON.stringify({ _type: 'playlist', title: 'List' }));
  } else {
    console.log(JSON.stringify({ _type: 'video', id: 'abc123', title: process.env.FAKE_TITLE || 'Test / Song: Deluxe?' }));
  }
  process.exit(0);
}
if (process.env.FAKE_FAIL === '1') { console.error('ERROR: Sign in to confirm you\\'re not a bot'); process.exit(1); }
const outIndex = args.indexOf('-o');
const template = args[outIndex + 1];
const audio = args.includes('--extract-audio');
const file = template.replace('%(ext)s', audio ? 'mp3' : 'mp4');
fs.writeFileSync(file, Buffer.alloc(Number(process.env.FAKE_SIZE || 16), 7));
console.log('done');
`;

function fakeBinary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-md-fake-'));
  const file = path.join(dir, 'yt-dlp');
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

test('audio download returns the produced MP3 buffer, title and safe file name', posixOnly, async () => {
  const bin = fakeBinary();
  const result = await downloadAudio('https://www.youtube.com/watch?v=abc123', { bin, maxBytes: 1024 * 1024, timeoutMs: 10_000 });
  assert.equal(result.mimetype, 'audio/mpeg');
  assert.equal(result.fileName, 'Test Song Deluxe.mp3');
  assert.equal(result.title, 'Test Song Deluxe');
  assert.equal(result.buffer.length, 16);
});

test('video download uses the MP4 merge path and returns a video payload', posixOnly, async () => {
  const bin = fakeBinary();
  const result = await downloadVideo('https://www.youtube.com/watch?v=abc123', { bin, maxBytes: 1024 * 1024, timeoutMs: 10_000 });
  assert.equal(result.mimetype, 'video/mp4');
  assert.equal(result.fileName, 'Test Song Deluxe.mp4');
  assert.equal(result.buffer.length, 16);
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

test('a missing engine produces an actionable install message, not an API fallback', async () => {
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

test('cookies and bot-check failures are surfaced as a clear user message', posixOnly, async () => {
  const bin = fakeBinary();
  await withEnv({ FAKE_FAIL: '1' }, async () => {
    await assert.rejects(
      downloadVideo('https://www.youtube.com/watch?v=abc123', { bin, maxBytes: 1024 * 1024, timeoutMs: 10_000 }),
      (error) => {
        assert.match(error.userMessage, /cookies/i);
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
      downloadAudio('https://www.youtube.com/watch?v=abc123', { bin, maxBytes: 1024, timeoutMs: 10_000 }),
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
