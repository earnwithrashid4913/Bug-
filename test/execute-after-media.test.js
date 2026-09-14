'use strict';

// ---------------------------------------------------------------------------
// ExecuteAfter — media engine: URL validation, content-type verification,
// streamed downloads, temporary-file handling, cleanup and bounded concurrency.
//
// All servers are local. No real media provider or endpoint is referenced.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  TEMP_PREFIX,
  cleanupAllTempFiles,
  deliverMedia,
  downloadToTemp,
  probeMedia,
  stats,
  sweepStaleTempFiles,
  validateMediaUrl
} = require('../system/execute-after/media-engine');
const { ERROR_CODES } = require('../system/execute-after/errors');

const servers = [];
const directories = [];

function settings(overrides = {}) {
  return {
    allowPrivateHosts: true,
    allowedContentTypes: ['video/', 'audio/', 'image/', 'application/octet-stream'],
    allowedHosts: [],
    bufferBelowBytes: 4096,
    deniedContentTypes: ['text/html', 'application/json'],
    enabled: true,
    maxBytes: 64 * 1024,
    maxConcurrent: 2,
    maxRedirects: 3,
    probeTimeoutMs: 2000,
    queueLimit: 4,
    streamSettleMs: 50,
    tempDir: tempDirectory(),
    timeoutMs: 5000,
    ...overrides
  };
}

function tempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-media-'));
  directories.push(directory);
  return directory;
}

async function serve(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function callable(value) {
  return typeof value?.on === 'function' || typeof value?.pipe === 'function' || Buffer.isBuffer(value);
}

test.after(async () => {
  await cleanupAllTempFiles();
  for (const server of servers) server.close();
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});

test('URL validation: protocol, credentials, private hosts and host allowlists', () => {
  assert.throws(() => validateMediaUrl('not-a-url', {}), (error) => error.code === ERROR_CODES.INVALID_MEDIA_URL);
  assert.throws(() => validateMediaUrl('file:///etc/passwd', {}), (error) => error.code === ERROR_CODES.INVALID_MEDIA_URL);
  assert.throws(() => validateMediaUrl('https://user:secret@cdn.example/a.mp4', {}), (error) => error.code === ERROR_CODES.INVALID_MEDIA_URL);
  assert.throws(() => validateMediaUrl('http://169.254.169.254/latest/meta-data', {}), (error) => error.code === ERROR_CODES.INVALID_MEDIA_URL);
  assert.throws(() => validateMediaUrl('http://localhost/a.mp4', {}), (error) => error.code === ERROR_CODES.INVALID_MEDIA_URL);
  assert.throws(() => validateMediaUrl(`https://${'a'.repeat(3000)}.example/x.mp4`, {}), (error) => error.code === ERROR_CODES.INVALID_MEDIA_URL);
  assert.ok(validateMediaUrl('https://cdn.example/a.mp4', {}));
  assert.throws(
    () => validateMediaUrl('https://cdn.other.example/a.mp4', { allowedHosts: ['cdn.example'] }),
    (error) => error.code === ERROR_CODES.INVALID_MEDIA_URL
  );
  assert.ok(validateMediaUrl('https://sub.cdn.example/a.mp4', { allowedHosts: ['cdn.example'] }));
});

test('probeMedia verifies the real content type before anything is used as media', async () => {
  const video = Buffer.alloc(4096, 3);
  const base = await serve((req, res) => {
    if (req.url === '/video.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(video.length) });
      res.end(video);
      return;
    }
    if (req.url === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>watch here</html>');
      return;
    }
    if (req.url === '/api.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"error":"link expired"}');
      return;
    }
    if (req.url === '/gone.mp4') {
      res.writeHead(410, { 'content-type': 'video/mp4' });
      res.end('');
      return;
    }
    if (req.url === '/missing.mp4') {
      res.writeHead(404, { 'content-type': 'video/mp4' });
      res.end('');
      return;
    }
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('nope');
  });

  const probed = await probeMedia(`${base}/video.mp4`, { settings: settings() });
  assert.equal(probed.kind, 'video');
  assert.equal(probed.contentType, 'video/mp4');
  assert.equal(probed.contentLength, video.length);

  await assert.rejects(() => probeMedia(`${base}/page.html`, { settings: settings() }), (error) => error.code === ERROR_CODES.INVALID_MEDIA_URL);
  await assert.rejects(() => probeMedia(`${base}/api.json`, { settings: settings() }), (error) => error.code === ERROR_CODES.INVALID_MEDIA_URL);
  await assert.rejects(() => probeMedia(`${base}/gone.mp4`, { settings: settings() }), (error) => error.code === ERROR_CODES.EXPIRED_MEDIA);
  await assert.rejects(() => probeMedia(`${base}/missing.mp4`, { settings: settings() }), (error) => error.code === ERROR_CODES.INVALID_MEDIA_URL);
});

test('redirects are followed with every hop validated', async () => {
  const video = Buffer.alloc(2048, 5);
  const base = await serve((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/media.mp4' });
      res.end();
      return;
    }
    if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    if (req.url === '/to-private') {
      res.writeHead(302, { location: 'http://127.0.0.1/private.mp4' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(video.length) });
    res.end(video);
  });

  const probed = await probeMedia(`${base}/start`, { settings: settings() });
  assert.equal(probed.kind, 'video');
  await assert.rejects(() => probeMedia(`${base}/loop`, { settings: settings() }), (error) => error.code === ERROR_CODES.BAD_REQUEST);
  await assert.rejects(
    () => probeMedia(`${base}/to-private`, { settings: settings({ allowPrivateHosts: false }) }),
    (error) => error.code === ERROR_CODES.INVALID_MEDIA_URL
  );
});

test('small downloads stay in memory, large downloads stream to a temporary file that is always removed', async () => {
  const small = Buffer.alloc(2048, 1);
  const large = Buffer.alloc(9000, 2);
  const base = await serve((req, res) => {
    const body = req.url === '/large.mp4' ? large : small;
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) });
    res.end(body);
  });
  const configured = settings({ bufferBelowBytes: 4096, maxBytes: 1024 * 1024 });

  const memory = await downloadToTemp(`${base}/small.mp4`, { settings: configured });
  assert.ok(Buffer.isBuffer(memory.buffer), 'a small file uses the memory path');
  assert.equal(memory.bytes, small.length);
  assert.equal(memory.path, null);
  await memory.cleanup();

  const onDisk = await downloadToTemp(`${base}/large.mp4`, { settings: configured });
  assert.equal(onDisk.buffer, null);
  assert.ok(onDisk.path.startsWith(path.join(configured.tempDir, TEMP_PREFIX)), 'temp file is inside the configured temp dir');
  assert.equal((await fsp.stat(onDisk.path)).size, large.length);
  assert.equal(onDisk.kind, 'video');
  const filePath = onDisk.path;
  await onDisk.cleanup();
  await assert.rejects(() => fsp.stat(filePath), 'the temporary file is removed after delivery');
  assert.equal(stats().activeTempFiles, 0);
  assert.deepEqual(await fsp.readdir(configured.tempDir), []);
});

test('size limits stop the transfer and never leave a partial file behind', async () => {
  const base = await serve((req, res) => {
    if (req.url === '/declared.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(500000) });
      res.end(Buffer.alloc(500000, 4));
      return;
    }
    // No content-length: the limiter has to abort mid-stream.
    res.writeHead(200, { 'content-type': 'video/mp4' });
    const chunk = Buffer.alloc(600, 6);
    let sent = 0;
    const push = () => {
      if (sent > 20000) {
        res.end();
        return;
      }
      sent += chunk.length;
      res.write(chunk, () => setImmediate(push));
    };
    push();
  });
  const configured = settings({ bufferBelowBytes: 0, maxBytes: 2000 });
  await assert.rejects(() => downloadToTemp(`${base}/declared.mp4`, { settings: configured }), (error) => error.code === ERROR_CODES.MEDIA_TOO_LARGE);
  await assert.rejects(() => downloadToTemp(`${base}/stream.mp4`, { settings: configured }), (error) => error.code === ERROR_CODES.MEDIA_TOO_LARGE);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await fsp.readdir(configured.tempDir), [], 'failed downloads leave no partial files');
  assert.equal(stats().activeTempFiles, 0);
});

test('bounded concurrency refuses extra downloads instead of queueing without end', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const base = await serve(async (req, res) => {
    await gate;
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '1024' });
    res.end(Buffer.alloc(1024, 9));
  });
  const configured = settings({ bufferBelowBytes: 0, maxBytes: 4096, maxConcurrent: 1, queueLimit: 0 });
  const first = downloadToTemp(`${base}/a.mp4`, { settings: configured });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(() => downloadToTemp(`${base}/b.mp4`, { settings: configured }), (error) => {
    assert.equal(error.code, ERROR_CODES.BUSY);
    assert.match(error.userMessage, /Too many downloads/i);
    return true;
  });
  release();
  const done = await first;
  await done.cleanup();
});

test('an orphaned temporary file from a crash is swept, an active one is not', async () => {
  const directory = tempDirectory();
  const configured = settings({ tempDir: directory });
  const orphan = path.join(directory, `${TEMP_PREFIX}orphan-1`);
  const fresh = path.join(directory, `${TEMP_PREFIX}fresh-1`);
  const foreign = path.join(directory, 'not-ours.txt');
  fs.writeFileSync(orphan, 'old');
  fs.writeFileSync(fresh, 'new');
  fs.writeFileSync(foreign, 'keep');
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(orphan, old, old);

  const removed = await sweepStaleTempFiles(configured, { force: true });
  assert.equal(removed, 1, 'exactly the stale file is removed');
  assert.deepEqual((await fsp.readdir(directory)).sort(), ['fresh-1', 'not-ours.txt'].map((name) => (name.startsWith('fresh') ? `${TEMP_PREFIX}fresh-1` : name)).sort());
  assert.ok(fs.existsSync(fresh), 'a recent temporary file is left alone');
  assert.ok(fs.existsSync(foreign), 'files that are not ours are never touched');
});

test('deliverMedia verifies, streams and cleans up, and picks the right payload per content type', async () => {
  const bodies = { '/audio.mp3': { body: Buffer.alloc(1500, 1), type: 'audio/mpeg' }, '/video.mp4': { body: Buffer.alloc(1500, 2), type: 'video/mp4' }, '/blob.bin': { body: Buffer.alloc(1500, 3), type: 'application/octet-stream' } };
  const base = await serve((req, res) => {
    const entry = bodies[req.url];
    res.writeHead(200, { 'content-type': entry.type, 'content-length': String(entry.body.length) });
    res.end(entry.body);
  });
  const configured = settings({ bufferBelowBytes: 0, tempDir: tempDirectory() });
  const sent = [];
  const socket = { sendMessage: async (chatId, payload, options) => { sent.push({ chatId, options, payload }); return { key: { id: 'sent' } }; } };

  const video = await deliverMedia({ chatId: 'chat@s.whatsapp.net', kind: 'auto', provider: 'provider_01', rawUrl: `${base}/video.mp4`, settings: configured, socket });
  assert.equal(video.kind, 'video');
  assert.ok(callable(sent[0].payload.video), 'the video payload carries the downloaded media');
  assert.equal(sent[0].payload.mimetype, 'video/mp4');

  await deliverMedia({ chatId: 'chat@s.whatsapp.net', kind: 'auto', provider: 'provider_01', rawUrl: `${base}/audio.mp3`, settings: configured, socket });
  assert.ok(callable(sent[1].payload.audio));
  assert.equal(sent[1].payload.mimetype, 'audio/mpeg');
  assert.equal(sent[1].payload.ptt, false);

  await deliverMedia({ chatId: 'chat@s.whatsapp.net', kind: 'auto', provider: 'provider_01', rawUrl: `${base}/blob.bin`, settings: configured, socket });
  assert.ok(callable(sent[2].payload.document), 'unknown binary media is delivered as a document, never faked as video');
  assert.equal(sent[2].payload.video, undefined);

  await deliverMedia({ chatId: 'chat@s.whatsapp.net', kind: 'document', provider: 'provider_01', rawUrl: `${base}/video.mp4`, settings: configured, socket });
  assert.ok(callable(sent[3].payload.document), 'download mode delivers a real file');

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await fsp.readdir(configured.tempDir), [], 'no temporary file survives delivery');
  assert.equal(stats().activeTempFiles, 0);
});

test('deliverMedia refuses a webpage URL before downloading anything', async () => {
  let hits = 0;
  const base = await serve((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>page</html>');
  });
  const configured = settings({ tempDir: tempDirectory() });
  const socket = { sendMessage: async () => ({ key: { id: 'x' } }) };
  await assert.rejects(
    () => deliverMedia({ chatId: 'chat@s.whatsapp.net', kind: 'auto', provider: 'provider_01', rawUrl: `${base}/watch`, settings: configured, socket }),
    (error) => error.code === ERROR_CODES.INVALID_MEDIA_URL
  );
  assert.ok(hits <= 1, 'the page is fetched once to verify, then refused');
  assert.deepEqual(await fsp.readdir(configured.tempDir), []);
});

test('deliverMedia fails cleanly when the media server expires the link', async () => {
  const base = await serve((req, res) => {
    res.writeHead(410, { 'content-type': 'application/json' });
    res.end('{"error":"expired"}');
  });
  await assert.rejects(
    () => deliverMedia({ chatId: 'chat@s.whatsapp.net', kind: 'auto', provider: 'provider_01', rawUrl: `${base}/expired.mp4`, settings: settings({ tempDir: tempDirectory() }), socket: { sendMessage: async () => ({}) } }),
    (error) => error.code === ERROR_CODES.EXPIRED_MEDIA
  );
});
