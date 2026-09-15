'use strict';

// ---------------------------------------------------------------------------
// ExecuteAfter — end-to-end integration through the REAL AnimeMD handler.
//
// Each scenario runs in its own child process with its own ExecuteAfter config
// (EXECUTE_AFTER_CONFIG) and its own local provider server, so it proves the
// complete pipeline:
//
//   !Exec1 … → existing dispatcher → ExecuteAfter router → provider config →
//   adapter → HTTP → validation → parser → normalization → formatter →
//   existing AnimeMD sender → (media engine when a stream/download is asked)
//
// No real provider name or endpoint appears anywhere: everything is local and
// generated.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCENARIO_RUNNER = path.join(ROOT, 'test-support', 'execute-after-scenario.js');
const servers = [];
const directories = [];

const videoBytes = Buffer.alloc(4096, 8);

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function startProviderServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/search') {
      const query = url.searchParams.get('q') || '';
      const id = url.searchParams.get('id') || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          total: 3,
          results: [
            { video_id: 'v1', title: `First ${query}${id}`, duration: 100, streamUrl: `${base}/media.mp4`, quality: '720p', page: `${base}/watch/v1` },
            { video_id: 'v2', title: `Second ${query}${id}`, download_url: `${base}/media.mp4` },
            { video_id: 'v3', title: `Page only ${query}${id}`, pageUrl: `${base}/watch/v3` }
          ]
        }
      }));
      return;
    }
    if (url.pathname === '/api/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { results: [{ title: 'Slow result', url: `${base}/watch/slow` }] } }));
      }, 600);
      return;
    }
    if (url.pathname === '/api/broken') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"provider exploded"}');
      return;
    }
    if (url.pathname === '/media.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(videoBytes.length) });
      res.end(videoBytes);
      return;
    }
    if (url.pathname.startsWith('/watch/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>watch page, not a media file</body></html>');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

let base = '';

function providerBlock(overrides = {}) {
  return {
    auth: {},
    command: 'Exec1',
    contract: { fields: {}, listPath: 'data.results', totalPath: 'data.total', verified: true },
    enabled: true,
    endpoint: '',
    extraParams: {},
    headers: {},
    hidden: false,
    idParam: 'id',
    label: '',
    method: 'GET',
    mode: 'auto',
    modeOverrides: {},
    modes: ['search', 'info', 'stream', 'download'],
    pageParam: '',
    queryParam: 'q',
    timeoutMs: 4000,
    ...overrides
  };
}

function writeConfig({ framework = {}, providers }) {
  const directory = temporaryDirectory('ea-integration-');
  const configPath = path.join(directory, 'execute-after.config.js');
  const defaultFramework = {
    discovery: { enabled: true, maxArrayScan: 20, maxDepth: 4 },
    http: { baseDelayMs: 20, maxAttempts: 2, maxDelayMs: 80, minHostIntervalMs: 0, timeoutMs: 4000 },
    media: { allowPrivateHosts: true, bufferBelowBytes: 0, maxBytes: 1024 * 1024, streamSettleMs: 50, tempDir: temporaryDirectory('ea-integration-media-') },
    perChatCooldownMs: 0,
    resultLimit: 5
  };
  fs.writeFileSync(configPath, `module.exports = {
    EXECUTE_AFTER_FRAMEWORK: ${JSON.stringify({ ...defaultFramework, ...framework })},
    EXECUTE_AFTER_PROVIDERS: ${JSON.stringify(providers, null, 2)}
  };`);
  return configPath;
}

// Runs one scenario in a real child process. Async on purpose: the parent owns
// the local provider server, so its event loop must stay free to answer the
// child's HTTP requests.
function runScenario({ framework, providers, steps }) {
  const configPath = writeConfig({ framework, providers });
  const reportPath = path.join(configPath, '..', 'report.json');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCENARIO_RUNNER], {
      cwd: ROOT,
      env: {
        ...process.env,
        EXECUTE_AFTER_CONFIG: configPath,
        EXECUTE_AFTER_REPORT: reportPath,
        EXECUTE_AFTER_SCENARIO: JSON.stringify({ steps }),
        EXECUTE_AFTER_SCENARIO_TIMEOUT_MS: '30000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const guard = setTimeout(() => child.kill('SIGKILL'), 40000);
    child.on('error', (error) => {
      clearTimeout(guard);
      resolve({ error: `scenario child failed to start: ${error.message}`, report: null, stderr, stdout });
    });
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      const diagnostics = `exit ${code}${signal ? ` signal ${signal}` : ''}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
      if (code !== 0) {
        resolve({ error: `scenario child failed: ${diagnostics}`, report: null, stderr, stdout });
        return;
      }
      if (!fs.existsSync(reportPath)) {
        resolve({ error: `scenario child wrote no report: ${diagnostics}`, report: null, stderr, stdout });
        return;
      }
      let report = null;
      try {
        report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      } catch (error) {
        resolve({ error: `scenario report is not valid JSON (${error.message}): ${diagnostics}`, report: null, stderr, stdout });
        return;
      }
      if (report.fatal) {
        resolve({ error: `scenario crashed: ${report.fatal}\n${diagnostics}`, report: null, stderr, stdout });
        return;
      }
      resolve({ error: '', report, stderr, stdout });
    });
  });
}

async function scenarioOf(options) {
  const outcome = await runScenario(options);
  assert.equal(outcome.error, '', outcome.error || undefined);
  return outcome.report;
}

function step(report, text, occurrence = 0) {
  const entries = report.steps.filter((item) => item.step === text);
  assert.ok(entries[occurrence], `scenario ran "${text}" (occurrence ${occurrence + 1})`);
  return entries[occurrence];
}

test.before(async () => { base = await startProviderServer(); });

test.after(() => {
  for (const server of servers) server.close();
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});

test('search, case-insensitivity, modes, info and stream all work through the real handler', async () => {
  const mediaDirectory = temporaryDirectory('ea-integration-media-assert-');
  const report = await scenarioOf({
    framework: { media: { allowPrivateHosts: true, bufferBelowBytes: 0, tempDir: mediaDirectory } },
    providers: {
      provider_01: providerBlock({ command: 'Exec1', endpoint: `${base}/api/search` })
    },
    steps: ['!exec1 naruto', '!EXEC1 naruto', '!ExEc1 modes', '!exec1 info v1', '!exec1 stream v1', '!exec1 download v1', '!exec1 stream v3']
  });

  const search = step(report, '!exec1 naruto');
  assert.equal(search.error, '', 'the handler never throws');
  assert.match(search.text, /EXECUTE AFTER/i);
  assert.match(search.text, /\*MODE:\*\s*search/i);
  assert.match(search.text, /naruto/, 'the query is echoed back');
  assert.match(search.text, /First naruto/, 'provider results are rendered');
  assert.match(search.text, /Second naruto/);
  assert.match(search.text, /Page only naruto/);

  const upper = step(report, '!EXEC1 naruto');
  assert.match(upper.text, /First naruto/, '!EXEC1 is the same command as !exec1');
  const mixed = step(report, '!ExEc1 modes');
  assert.match(mixed.text, /Modes: search, info, stream, download/);
  assert.match(mixed.text, /Endpoint: configured/);

  const info = step(report, '!exec1 info v1');
  assert.match(info.text, /\*MODE:\*\s*info/i);
  assert.match(info.text, /First/);
  assert.match(info.text, new RegExp(`${base}/media.mp4`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the direct media link is shown');

  const streamed = step(report, '!exec1 stream v1');
  assert.equal(streamed.error, '');
  assert.equal(streamed.media.length, 1, 'exactly one media message');
  assert.equal(streamed.media[0].kind, 'video');
  assert.equal(streamed.media[0].mimetype, 'video/mp4');

  const downloaded = step(report, '!exec1 download v1');
  assert.equal(downloaded.media.length, 1);
  assert.equal(downloaded.media[0].kind, 'document', 'download mode delivers a real file');

  const pageOnly = step(report, '!exec1 stream v3');
  assert.equal(pageOnly.media.length, 0, 'a page URL is never treated as a media URL');
  assert.match(pageOnly.text, /did not return a playable media URL/i);

  assert.deepEqual(fs.readdirSync(mediaDirectory), [], 'no temporary file survives the requests');
});

test('a failing provider is isolated: it answers cleanly and other providers keep working', async () => {
  const report = await scenarioOf({
    providers: {
      provider_01: providerBlock({ command: 'Exec1', endpoint: `${base}/api/search` }),
      provider_02: providerBlock({ command: 'BrokenSite', endpoint: `${base}/api/broken`, modes: ['search'] })
    },
    steps: ['!brokensite naruto', '!exec1 naruto']
  });
  const broken = step(report, '!brokensite naruto');
  assert.equal(broken.error, '', 'no exception escapes the handler');
  assert.match(broken.text, /internal error|unavailable/i, 'a clean user-facing message');
  assert.doesNotMatch(broken.text, /stack|at Object|provider exploded/i, 'technical detail stays out of the chat');

  const healthy = step(report, '!exec1 naruto');
  assert.match(healthy.text, /First naruto/, 'provider_01 is unaffected by provider_02 failing');
});

test('hidden providers work without being listed; disabled providers are gone; duplicates are refused', async () => {
  const report = await scenarioOf({
    providers: {
      provider_01: providerBlock({ command: 'Exec1', endpoint: `${base}/api/search` }),
      provider_02: providerBlock({ command: 'HiddenSite', endpoint: `${base}/api/search`, hidden: true, modes: ['search'] }),
      provider_03: providerBlock({ command: 'OffSite', endpoint: `${base}/api/search`, enabled: false, modes: ['search'] }),
      provider_04: providerBlock({ command: 'Exec1', endpoint: `${base}/api/search`, modes: ['search'] })
    },
    steps: ['!hiddensite naruto', '!offsite naruto', '!exec1 naruto', '!menu executeafter']
  });
  assert.match(step(report, '!hiddensite naruto').text, /First naruto/, 'a hidden provider command is usable');
  assert.equal(step(report, '!offsite naruto').text, '', 'a disabled provider does not exist');
  assert.match(step(report, '!exec1 naruto').text, /First naruto/);

  const menu = step(report, '!menu executeafter');
  assert.match(menu.text, /EXECUTE AFTER/i);
  assert.match(menu.text, /!exec1/, 'the visible provider is listed');
  assert.doesNotMatch(menu.text, /hiddensite|offsite/i, 'hidden and disabled providers stay out of the menu');
});

test('the per-chat cooldown stops command spam without blocking other providers', async () => {
  const report = await scenarioOf({
    framework: { perChatCooldownMs: 6000 },
    providers: {
      provider_01: providerBlock({ command: 'Exec1', endpoint: `${base}/api/search` }),
      provider_02: providerBlock({ command: 'OtherSite', endpoint: `${base}/api/search`, modes: ['search'] })
    },
    steps: ['!exec1 naruto', '!exec1 naruto', '!othersite naruto']
  });
  assert.match(step(report, '!exec1 naruto').text, /First naruto/);
  assert.match(step(report, '!exec1 naruto', 1).text, /Please wait \d+s before using this provider again/);
  assert.match(step(report, '!othersite naruto').text, /First naruto/, 'the cooldown is per provider, not global');
});

test('a slow provider is capped by the in-flight guard instead of piling up requests', async () => {
  const report = await scenarioOf({
    framework: { maxInFlightGlobal: 3, maxInFlightPerProvider: 1, perChatCooldownMs: 0 },
    providers: {
      provider_01: providerBlock({ command: 'SlowSite', endpoint: `${base}/api/slow`, modes: ['search'] }),
      provider_02: providerBlock({ command: 'FastSite', endpoint: `${base}/api/search`, modes: ['search'] })
    },
    steps: [{ parallel: [{ chat: '15550000001@s.whatsapp.net', text: '!slowsite one' }, { chat: '15550000002@s.whatsapp.net', text: '!slowsite two' }] }, '!fastsite naruto']
  });
  const slowSteps = report.steps.filter((item) => item.step.startsWith('!slowsite'));
  assert.equal(slowSteps.length, 2);
  const answered = slowSteps.filter((item) => /Slow result/.test(item.text));
  const refused = slowSteps.filter((item) => /still busy with an earlier request/i.test(item.text));
  assert.equal(answered.length, 1, 'exactly one request per provider slot');
  assert.equal(refused.length, 1, 'the parallel request is refused with a clean message');
  assert.match(step(report, '!fastsite naruto').text, /First naruto/, 'another provider is unaffected');
});

test('the framework never answers with leaked internals, undefined or NaN', async () => {
  const report = await scenarioOf({
    providers: {
      provider_01: providerBlock({ command: 'Exec1', endpoint: `${base}/api/search` })
    },
    steps: ['!exec1', '!exec1 trending naruto', '!exec1 info', '!exec1 nonsense', '!exec1 search naruto']
  });
  for (const entry of report.steps) {
    assert.equal(entry.error, '', `${entry.step}: no exception`);
    assert.doesNotMatch(entry.text, /\bundefined\b|\bNaN\b|COMMAND FAILED|\bError:/i, entry.step);
  }
  assert.match(step(report, '!exec1').text, /search <query>|USAGE/, 'usage guidance for a bare command');
  assert.match(step(report, '!exec1 trending naruto').text, /does not support that mode/i, 'an undeclared mode is refused, never guessed');
  assert.match(step(report, '!exec1 info').text, /id or its page URL/i);
  assert.match(step(report, '!exec1 nonsense').text, /First nonsense/, 'free text is treated as a search query');
});
