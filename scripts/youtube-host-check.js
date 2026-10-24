'use strict';
// Transport/tool diagnostics only. Never starts the bot, pairs a device, sends
// WhatsApp messages, downloads binaries or declares provider availability.
const https = require('node:https');
const { Resolver } = require('node:dns').promises;
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

function code(error) { return /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'PROBE_FAILED'; }
async function probeDns(host, { timeoutMs = 5000, resolver = new Resolver({ timeout: timeoutMs, tries: 1 }) } = {}) {
  try {
    const records = await Promise.all(['resolve4', 'resolve6'].map(async method => {
      try { return { ok: true, records: (await resolver[method](host)).length }; }
      catch (error) { return { ok: false, code: code(error) }; }
    }));
    return { A: records[0], AAAA: records[1] };
  } finally { resolver.cancel(); }
}
function probeHttps(host, { timeoutMs = 5000, request = https.request } = {}) {
  return new Promise(resolve => {
    const result = { osLookup: null, tcpConnected: false, tlsEstablished: false, authorized: false };
    let done = false, req;
    const finish = extra => {
      if (done) return;
      done = true; clearTimeout(timer); req?.destroy(); resolve({ ...result, ...extra });
    };
    const timer = setTimeout(() => finish({ code: 'TIMEOUT' }), timeoutMs);
    try {
      req = request({ hostname: host, port: 443, path: '/', method: 'HEAD', agent: false, rejectUnauthorized: true }, response => {
        // A root HTTP response only verifies transport, NOT the download API.
        response.resume(); finish({ httpStatus: response.statusCode });
      });
      req.on('socket', socket => {
        socket.on('lookup', (error, address, family) => { result.osLookup = error ? { ok: false, code: code(error) } : { ok: true, family }; });
        socket.on('connect', () => { result.tcpConnected = true; });
        socket.on('secureConnect', () => { result.tlsEstablished = true; result.authorized = socket.authorized === true; result.protocol = socket.getProtocol(); });
      });
      req.on('error', error => finish({ code: code(error) }));
      req.end();
    } catch (error) { finish({ code: code(error) }); }
  });
}
async function mediaSelfTest(ffmpeg, validateFile) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-host-check-'));
  const options = { timeoutMs: 15000, maxBytes: 2 * 1024 * 1024 };
  let step = 'generate-video';
  const execute = args => execFile(ffmpeg.command, ['-nostdin', '-v', 'error', '-xerror', ...args], { timeout: options.timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true });
  try {
    const video = path.join(directory, 'video.mp4');
    await execute(['-f', 'lavfi', '-i', 'color=c=purple:s=160x120:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
    step = 'decode-video'; await validateFile(video, 'video', ffmpeg, options);
    const outputs = { video: { bytes: (await fs.stat(video)).size, codecs: 'h264/aac' } };
    for (const [kind, ext, args, codecs] of [
      ['audio', 'mp3', ['-c:a', 'libmp3lame', '-b:a', '128k'], 'mp3'],
      ['voice', 'ogg', ['-c:a', 'libopus', '-ac', '1', '-ar', '48000', '-b:a', '48k'], 'opus']
    ]) {
      const file = path.join(directory, `${kind}.${ext}`);
      step = `convert-${kind}`; await execute(['-protocol_whitelist', 'file,pipe', '-i', video, '-vn', ...args, file]);
      step = `decode-${kind}`; await validateFile(file, kind, ffmpeg, options);
      outputs[kind] = { bytes: (await fs.stat(file)).size, codecs };
    }
    return { ok: true, syntheticLocalMedia: true, outputs };
  } catch (error) { return { ok: false, syntheticLocalMedia: true, failedStep: step, code: code(error) }; }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
async function main(argv) {
  if (argv.includes('--help')) {
    console.log('From the bot checkout: node scripts/youtube-host-check.js [--media-self-test]'); return;
  }
  if (argv.some(arg => arg !== '--media-self-test')) throw new Error('Unsupported argument. Use --help.');
  const local = require('../system/lib/local-downloader');
  const { DC_BASE } = require('../commands/davidcyril-api');
  const { cobaltProviders } = require('../system/lib/youtube-recovered');
  const { validateFile } = require('../system/lib/youtube-engine');
  const { config } = require('../system/config');
  const hosts = [...new Set(['github.com', 'www.youtube.com', new URL(DC_BASE).hostname, ...cobaltProviders().map(url => new URL(url).hostname)])];
  const report = {
    schemaVersion: 1, at: new Date().toISOString(), node: process.version, openssl: process.versions.openssl,
    platform: `${process.platform}/${process.arch}`, transportOnly: true, providerAvailabilityTested: false,
    youtubeDownloaded: false, whatsappDeliveryTested: false,
    environment: Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY'].map(key => [key, Boolean(process.env[key])])),
    botTlsVerificationDisabled: process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0',
    // No cookie paths, config dumps, auth directory reads, proxy values,
    // resolved IP addresses, signed URLs, stderr, or certificate bodies.
    cookiesConfigured: Boolean(config.downloadsCookiesFile)
  };
  try {
    const gitOptions = { cwd: path.resolve(__dirname, '..'), timeout: 3000, maxBuffer: 1024 * 1024 };
    const revision = await execFile('git', ['rev-parse', 'HEAD'], gitOptions);
    const status = await execFile('git', ['status', '--porcelain', '--untracked-files=no'], gitOptions);
    report.checkout = { commit: revision.stdout.trim(), trackedChanges: Boolean(status.stdout.trim()) };
  } catch { report.checkout = { available: false }; }
  report.transports = await Promise.all(hosts.map(async host => ({ host, dns: await probeDns(host), https: await probeHttps(host) })));
  const options = local.settings({ autoInstall: false, timeoutMs: 5000 });
  try {
    const engine = await local.resolveEngine(options);
    const runtime = typeof local.runtimeOptions === 'function' ? await local.runtimeOptions(engine, options) : options;
    report.extractor = { ok: true, version: engine.version, source: engine.source,
      nodeRuntimeEnabled: runtime.jsRuntime === process.execPath, solverAvailability: 'not verified' };
  } catch (error) { report.extractor = { ok: false, code: code(error) }; }
  const ffmpeg = await local.resolveFfmpeg(options);
  report.ffmpeg = ffmpeg ? { ok: true, version: await local.probeFfmpeg(ffmpeg.command, { timeoutMs: 5000 }) } : { ok: false };
  if (argv.includes('--media-self-test')) report.mediaSelfTest = ffmpeg ? await mediaSelfTest(ffmpeg, validateFile) : { ok: false, code: 'ENGINE' };
  console.log(JSON.stringify(report, null, 2));
  if (report.transports.some(row => !row.https.authorized || row.https.code) || !report.extractor.ok || !report.ffmpeg.ok || report.mediaSelfTest?.ok === false) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch(() => { console.error('Host check failed. Run from the installed bot checkout; use --help. No credentials should be shared.'); process.exitCode = 1; });
module.exports = { probeDns, probeHttps, mediaSelfTest };
