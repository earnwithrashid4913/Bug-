'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFileSync, spawnSync } = require('node:child_process');
const { probeDns, probeHttps, mediaSelfTest } = require('../scripts/youtube-host-check');

function transport({ error, status = 503 } = {}) {
  const state = { destroyed: 0 };
  state.request = (options, callback) => {
    state.options = options;
    const req = new EventEmitter(); req.destroy = () => { state.destroyed++; };
    req.end = () => queueMicrotask(() => {
      const socket = new EventEmitter(); socket.authorized = true; socket.getProtocol = () => 'TLSv1.3';
      req.emit('socket', socket); socket.emit('lookup', null, '192.0.2.1', 4); socket.emit('connect');
      if (error) req.emit('error', error);
      else { socket.emit('secureConnect'); callback({ statusCode: status, resume() {} }); }
    });
    return req;
  };
  return state;
}
test('host probe verifies TLS explicitly and does not call a download endpoint or report API availability', async () => {
  const f = transport(); const result = await probeHttps('provider.example', { request: f.request });
  assert.equal(f.options.rejectUnauthorized, true); assert.equal(f.options.method, 'HEAD'); assert.equal(f.options.path, '/');
  assert.equal(f.options.agent, false); assert.equal(result.authorized, true); assert.equal(result.httpStatus, 503);
  assert.equal(result.providerAvailable, undefined); assert.equal(f.destroyed, 1);
  assert.doesNotMatch(JSON.stringify(result), /192\.0\.2\.1/);
});
for (const code of ['ECONNRESET', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) test(`transport preserves ${code} and separates TCP from TLS`, async () => {
  const f = transport({ error: Object.assign(new Error('SECRET details'), { code }) });
  const result = await probeHttps('provider.example', { request: f.request });
  assert.equal(result.osLookup.ok, true); assert.equal(result.tcpConnected, true);
  assert.equal(result.tlsEstablished, false); assert.equal(result.code, code);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/); assert.equal(f.destroyed, 1);
});
test('a stalled transport has a single bounded deadline and closes its socket', async () => {
  let destroyed = 0; let calls = 0;
  const request = () => { calls++; const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { destroyed++; }; return req; };
  const result = await probeHttps('provider.example', { request, timeoutMs: 5 });
  assert.equal(result.code, 'TIMEOUT'); assert.equal(destroyed, 1); assert.equal(calls, 1);
});
test('DNS A and AAAA errors are kept separate from OS lookup and all queries are canceled', async () => {
  let canceled = false;
  const resolver = { resolve4: async () => { throw Object.assign(new Error('private details'), { code: 'ENODATA' }); }, resolve6: async () => ['2001:db8::1'], cancel: () => { canceled = true; } };
  const result = await probeDns('provider.example', { resolver });
  assert.deepEqual(result, { A: { ok: false, code: 'ENODATA' }, AAAA: { ok: true, records: 1 } });
  assert.equal(canceled, true); assert.doesNotMatch(JSON.stringify(result), /2001|private/);
});
test('host-check CLI help does not start the bot and rejects unsupported flags', () => {
  const help = spawnSync(process.execPath, ['scripts/youtube-host-check.js', '--help'], { encoding: 'utf8', timeout: 1000 });
  assert.equal(help.status, 0); assert.match(help.stdout, /media-self-test/);
  const invalid = spawnSync(process.execPath, ['scripts/youtube-host-check.js', '--download'], { encoding: 'utf8', timeout: 1000 });
  assert.equal(invalid.status, 1); assert.doesNotMatch(invalid.stdout + invalid.stderr, /pairing code|qr code/i);
});
test('host FFmpeg self-test generates and fully decodes video, MP3 and Opus without claiming YouTube delivery', async t => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { t.skip('FFmpeg not installed'); return; }
  const result = await mediaSelfTest({ command: 'ffmpeg' }, require('../system/lib/youtube-engine').validateFile);
  assert.equal(result.ok, true); assert.equal(result.syntheticLocalMedia, true);
  assert.equal(result.outputs.video.codecs, 'h264/aac'); assert.equal(result.outputs.audio.codecs, 'mp3'); assert.equal(result.outputs.voice.codecs, 'opus');
  for (const output of Object.values(result.outputs)) assert.ok(output.bytes > 0);
  assert.equal(result.youtubeDownloaded, undefined); assert.equal(result.whatsappDeliveryTested, undefined);
});
