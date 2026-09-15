'use strict';

// ---------------------------------------------------------------------------
// ExecuteAfter — provider pipeline: request construction → HTTP → validation →
// provider parser → universal normalization → clean errors.
//
// Everything runs against local HTTP servers, so the suite is deterministic and
// offline. No real provider name or endpoint is used anywhere.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const { createAdapter } = require('../system/execute-after/adapters/base-adapter');
const { resolveSingleResult } = require('../system/execute-after/parser');
const { normalizeResult, FIELDS } = require('../system/execute-after/normalize');
const { compilePolicy } = require('../system/execute-after/policy');
const { ERROR_CODES } = require('../system/execute-after/errors');
const { buildContext, supportedModes } = require('../system/execute-after/context');
const { createGate, isPrivateHostname, validateMediaUrl } = require('../system/execute-after/media-engine');

const servers = [];
const baseFramework = {
  cache: { enabled: false, maxEntries: 10, ttlMs: 1000 },
  discovery: { enabled: true, maxArrayScan: 40, maxDepth: 4 },
  http: {
    baseDelayMs: 30,
    maxAttempts: 2,
    maxDelayMs: 120,
    maxRedirects: 3,
    maxResponseBytes: 64 * 1024,
    minHostIntervalMs: 0,
    respectRetryAfter: true,
    retryPost: false,
    timeoutMs: 2500
  },
  maxInFlightGlobal: 3,
  maxInFlightPerProvider: 1,
  media: { allowPrivateHosts: true, allowedContentTypes: ['video/', 'audio/'], allowedHosts: [], bufferBelowBytes: 4096, deniedContentTypes: ['text/html', 'application/json'], enabled: true, maxBytes: 1024 * 1024, maxConcurrent: 2, maxRedirects: 3, probeTimeoutMs: 2000, queueLimit: 2, tempDir: '', timeoutMs: 4000 },
  menuLimit: 10,
  perChatCooldownMs: 0,
  policy: { blockedHostPatterns: [], blockedTerms: [], enforce: true },
  resultLimit: 5,
  verbose: false
};

function makeSlot(overrides = {}) {
  const config = {
    auth: {},
    bodyMode: '',
    contract: { fields: {}, listPath: '', totalPath: '', verified: false },
    endpoint: '',
    extraParams: {},
    headers: {},
    idParam: '',
    label: 'Demo Site',
    method: 'GET',
    mode: 'auto',
    modeOverrides: {},
    pageParam: '',
    pathTemplate: '',
    queryParam: 'q',
    timeoutMs: 0,
    ...overrides
  };
  return { command: 'exec1', config, enabled: true, hidden: false, id: 'provider_01', index: 0, label: config.label, modes: overrides.modes || ['search'], status: 'READY' };
}

async function serve(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test.after(() => {
  for (const server of servers) server.close();
});

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

test('search mode sends only declared parameters and normalizes every result', async () => {
  const seen = [];
  const endpoint = await serve((req, res) => {
    seen.push(req.url);
    json(res, 200, {
      data: {
        total: 2,
        results: [
          { id: 'v1', title: 'First result', duration: 95, thumb: 'https://cdn.example/1.jpg', pageUrl: 'https://site.example/watch/v1', streamUrl: 'https://cdn.example/1.mp4', quality: '720p', type: 'video/mp4' },
          { video_id: 'v2', name: 'Second result' }
        ]
      }
    });
  });
  const slot = makeSlot({ contract: { fields: {}, listPath: 'data.results', totalPath: 'data.total', verified: true }, endpoint, modes: ['search'] });
  const adapter = createAdapter({ id: 'provider_01', parseProviderResponse: require('../system/execute-after/parser').parseProviderResponse });
  const outcome = await adapter.execute({ framework: baseFramework, mode: 'search', query: 'naruto', slot });

  assert.match(seen[0], /^\/\?q=naruto$/, 'only the declared query parameter is sent');
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.meta.total, 2);
  assert.equal(outcome.meta.listPath, 'data.results');
  assert.equal(outcome.meta.attempts, 1);

  const [first, second] = outcome.results;
  assert.deepEqual(Object.keys(first).sort(), [...FIELDS].sort(), 'the universal result shape is always complete');
  assert.equal(first.source, 'provider_01');
  assert.equal(first.sourceName, 'Demo Site');
  assert.equal(first.title, 'First result');
  assert.equal(first.streamUrl, 'https://cdn.example/1.mp4');
  assert.equal(first.thumbnail, 'https://cdn.example/1.jpg');
  assert.equal(first.quality, '720p');
  assert.equal(first.metadata.mode, 'search');
  assert.equal(second.id, 'v2', 'documented alias video_id is used when no path is declared');
  assert.equal(second.title, 'Second result');
  // Missing fields stay null — never fabricated, never undefined.
  for (const field of FIELDS) assert.notEqual(second[field], undefined, `${field} must be present`);
  assert.equal(second.streamUrl, null);
  assert.equal(second.duration, null);
  assert.equal(second.raw.id, undefined);
  assert.equal(adapter.stats().calls, 1);
  assert.equal(adapter.stats().failures, 0);
});

test('a declared field path wins over the alias table', async () => {
  const endpoint = await serve((req, res) => json(res, 200, {
    items: [{ clip: { heading: 'Nested title', file: { url: 'https://cdn.example/n.mp4' } }, id: 'x1' }]
  }));
  const slot = makeSlot({
    contract: { fields: { streamUrl: 'clip.file.url', title: 'clip.heading' }, listPath: 'items', totalPath: '', verified: true },
    endpoint,
    queryParam: 'q'
  });
  const adapter = createAdapter({ id: 'provider_01' });
  const outcome = await adapter.execute({ framework: baseFramework, mode: 'search', query: 'x', slot });
  assert.equal(outcome.results[0].title, 'Nested title');
  assert.equal(outcome.results[0].streamUrl, 'https://cdn.example/n.mp4');
  assert.equal(outcome.results[0].id, 'x1');
});

test('POST providers send the declared parameters as a JSON body', async () => {
  let received = null;
  const endpoint = await serve(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { body: Buffer.concat(chunks).toString('utf8'), headers: req.headers, method: req.method };
    json(res, 200, { result: [{ title: 'Posted result', url: 'https://site.example/p1' }] });
  });
  const slot = makeSlot({ contract: { fields: {}, listPath: 'result', totalPath: '', verified: true }, endpoint, extraParams: { site: 'demo' }, method: 'POST' });
  const adapter = createAdapter({ id: 'provider_01' });
  const outcome = await adapter.execute({ framework: baseFramework, mode: 'search', query: 'hello', slot });
  assert.equal(received.method, 'POST');
  assert.equal(received.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(received.body), { site: 'demo', q: 'hello' });
  assert.equal(outcome.results[0].title, 'Posted result');
});

test('path templates and pagination are applied only when the config declares them', async () => {
  const seen = [];
  const endpoint = await serve((req, res) => {
    seen.push(req.url);
    json(res, 200, [{ title: 'Row' }]);
  });
  const slot = makeSlot({ contract: { fields: {}, listPath: '', totalPath: '', verified: true }, endpoint, modes: ['search', 'trending'], pathTemplate: '/find/{query}', modes: ['search', 'trending'], pageParam: 'page', queryParam: '' });
  const adapter = createAdapter({ id: 'provider_01' });
  await adapter.execute({ framework: baseFramework, mode: 'search', query: 'two words', slot });
  assert.equal(seen[0], '/find/two%20words');
  await adapter.execute({ framework: baseFramework, mode: 'trending', page: 3, query: '', slot });
  assert.equal(seen[1], '/find/?page=3', 'a list mode without a query keeps only declared pagination');

  // Without pageParam nothing is invented.
  const noPage = makeSlot({ contract: { fields: {}, listPath: '', totalPath: '', verified: true }, endpoint, modes: ['trending'], pathTemplate: '' });
  const seenBefore = seen.length;
  await adapter.execute({ framework: baseFramework, mode: 'trending', page: 3, query: '', slot: noPage });
  assert.equal(seen[seen.length - 1], '/', 'no page parameter is sent when the config declares none');
  assert.ok(seen.length > seenBefore);
});

test('malformed and empty responses are typed errors, never crashes', async () => {
  const broken = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data": [ this is not json');
  });
  const empty = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('');
  });
  const html = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>not an api</body></html>');
  });
  const adapter = createAdapter({ id: 'provider_01' });
  const cases = [
    [broken, ERROR_CODES.INVALID_JSON],
    [empty, ERROR_CODES.EMPTY_RESPONSE],
    [html, ERROR_CODES.INVALID_JSON]
  ];
  for (const [endpoint, code] of cases) {
    const slot = makeSlot({ endpoint });
    await assert.rejects(
      () => adapter.execute({ framework: baseFramework, mode: 'search', query: 'x', slot }),
      (error) => {
        assert.equal(error.code, code);
        assert.ok(error.userMessage && !/undefined|NaN/i.test(error.userMessage));
        return true;
      },
      `${endpoint} → ${code}`
    );
  }
  assert.equal(adapter.stats().failures, 3);
});

test('HTTP statuses map to clean user messages, with no retry for 4xx', async () => {
  const hits = { 400: 0, 401: 0, 404: 0, 418: 0, 500: 0 };
  const endpoint = await serve((req, res) => {
    const status = Number((req.url.match(/\d+/) || [500])[0]);
    hits[status] = (hits[status] || 0) + 1;
    json(res, status, { error: 'provider says no' });
  });
  const adapter = createAdapter({ id: 'provider_01' });
  const expectations = [
    [400, ERROR_CODES.BAD_REQUEST, 'rejected'],
    [401, ERROR_CODES.UNAUTHORIZED, 'refused'],
    [404, ERROR_CODES.NOT_FOUND, 'Nothing was found'],
    [500, ERROR_CODES.SERVER_ERROR, 'internal error']
  ];
  for (const [status, code, fragment] of expectations) {
    const slot = makeSlot({ endpoint: `${endpoint}/${status}` });
    await assert.rejects(
      () => adapter.execute({ framework: baseFramework, mode: 'search', query: 'x', slot }),
      (error) => {
        assert.equal(error.code, code, `${status} → ${code}`);
        assert.equal(error.status, status);
        assert.match(error.userMessage, new RegExp(fragment, 'i'));
        return true;
      }
    );
  }
  assert.equal(hits[400], 1, '400 is final: exactly one attempt');
  assert.equal(hits[401], 1, '401 is final: exactly one attempt');
  assert.equal(hits[404], 1, '404 is final: exactly one attempt');
  assert.equal(hits[500], 2, '5xx is retried up to maxAttempts, then reported');
});

test('429 honours Retry-After, retries once and then succeeds', async () => {
  let calls = 0;
  const endpoint = await serve((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end('{"error":"slow down"}');
      return;
    }
    json(res, 200, { data: { results: [{ title: 'After retry', url: 'https://site.example/a' }] } });
  });
  const slot = makeSlot({ contract: { fields: {}, listPath: 'data.results', totalPath: '', verified: true }, endpoint });
  const adapter = createAdapter({ id: 'provider_01' });
  const outcome = await adapter.execute({ framework: baseFramework, mode: 'search', query: 'x', slot });
  assert.equal(calls, 2, 'one retry after 429');
  assert.equal(outcome.meta.attempts, 2);
  assert.equal(outcome.results[0].title, 'After retry');
});

test('the retry ceiling is enforced even when the config asks for more', async () => {
  let calls = 0;
  const endpoint = await serve((req, res) => {
    calls += 1;
    json(res, 503, { error: 'down' });
  });
  const slot = makeSlot({ endpoint });
  const adapter = createAdapter({ id: 'provider_01' });
  const framework = { ...baseFramework, http: { ...baseFramework.http, maxAttempts: 9 } };
  await assert.rejects(() => adapter.execute({ framework, mode: 'search', query: 'x', slot }), (error) => error.code === ERROR_CODES.SERVER_ERROR);
  assert.equal(calls, 5, 'hard ceiling: never more than 5 attempts, never infinite retries');
});

test('timeouts and DNS failures are reported without hanging the caller', async () => {
  const slow = await serve((req, res) => {
    setTimeout(() => json(res, 200, { data: [] }), 3000);
  });
  const adapter = createAdapter({ id: 'provider_01' });
  const slot = makeSlot({ endpoint: slow, timeoutMs: 400 });
  const started = Date.now();
  await assert.rejects(
    () => adapter.execute({ framework: baseFramework, mode: 'search', query: 'x', slot }),
    (error) => [ERROR_CODES.TIMEOUT, ERROR_CODES.NETWORK].includes(error.code)
  );
  assert.ok(Date.now() - started < 2800, 'the abort controller cancels the request');

  const dnsSlot = makeSlot({ endpoint: 'http://execute-after-does-not-exist.invalid/search' });
  await assert.rejects(
    () => adapter.execute({ framework: baseFramework, mode: 'search', query: 'x', slot: dnsSlot }),
    (error) => error.code === ERROR_CODES.DNS
  );
});

test('oversized responses are refused instead of buffered', async () => {
  const big = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(200 * 1024) });
    res.end(JSON.stringify({ data: 'x'.repeat(200 * 1024) }));
  });
  const adapter = createAdapter({ id: 'provider_01' });
  await assert.rejects(
    () => adapter.execute({ framework: baseFramework, mode: 'search', query: 'x', slot: makeSlot({ endpoint: big }) }),
    (error) => error.code === ERROR_CODES.RESPONSE_TOO_LARGE
  );
});

test('policy-blocked results are refused and counted, the rest of the batch still works', async () => {
  const endpoint = await serve((req, res) => json(res, 200, {
    results: [{ title: 'Clean result', url: 'https://site.example/ok' }, { title: 'forbidden porn clip', url: 'https://site.example/x' }]
  }));
  const slot = makeSlot({ contract: { fields: {}, listPath: 'results', totalPath: '', verified: true }, endpoint });
  const adapter = createAdapter({ id: 'provider_01' });
  const policy = compilePolicy({ blockedTerms: ['porn'], enforce: true });
  const outcome = await adapter.execute({ framework: baseFramework, mode: 'search', policy, query: 'x', slot });
  assert.deepEqual(outcome.results.map((result) => result.title), ['Clean result']);
  assert.equal(outcome.meta.blocked, 1);
});

test('no results is a clean typed answer, never an empty message', async () => {
  const endpoint = await serve((req, res) => json(res, 200, { data: { results: [] } }));
  const slot = makeSlot({ contract: { fields: {}, listPath: 'data.results', totalPath: '', verified: true }, endpoint });
  const adapter = createAdapter({ id: 'provider_01' });
  await assert.rejects(
    () => adapter.execute({ framework: baseFramework, mode: 'search', query: 'nothing', slot }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.NO_RESULTS);
      assert.match(error.userMessage, /No results/i);
      return true;
    }
  );
});

test('a declared contract path that does not exist is reported instead of guessed', async () => {
  const endpoint = await serve((req, res) => json(res, 200, { something: { else: 1 } }));
  const slot = makeSlot({ contract: { fields: {}, listPath: 'data.results', totalPath: '', verified: true }, endpoint });
  const adapter = createAdapter({ id: 'provider_01' });
  await assert.rejects(
    () => adapter.execute({ framework: baseFramework, mode: 'search', query: 'x', slot }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.INVALID_JSON);
      assert.match(error.hint, /contract\.listPath/);
      return true;
    }
  );
});

test('info mode resolves one item by id and never invents a missing field', async () => {
  const endpoint = await serve((req, res) => json(res, 200, {
    data: [
      { id: 'a1', title: 'Wrong item' },
      { id: 'b2', title: 'Wanted item', streamUrl: 'https://cdn.example/b2.mp4' }
    ]
  }));
  const slot = makeSlot({ contract: { fields: {}, listPath: '', totalPath: '', verified: true }, endpoint, modes: ['info'] });
  const adapter = createAdapter({ id: 'provider_01' });
  const outcome = await adapter.execute({ framework: baseFramework, mode: 'info', id: 'b2', slot });
  assert.equal(outcome.single.title, 'Wanted item');
  assert.equal(outcome.single.description, null, 'missing fields stay null');
  assert.equal(outcome.single.streamUrl, 'https://cdn.example/b2.mp4');
});

test('mode resolution only offers what the slot declares', () => {
  const searchOnly = makeSlot({ modes: ['search'] });
  assert.deepEqual(supportedModes(searchOnly), ['search']);
  assert.throws(() => buildContext(searchOnly, { args: ['trending'], name: 'exec1', text: 'trending' }), (error) => error.code === ERROR_CODES.UNSUPPORTED_MODE);

  const multi = makeSlot({ modes: ['search', 'info', 'stream', 'download', 'trending'] });
  assert.deepEqual(buildContext(multi, { args: ['trending', '2'], name: 'exec1', text: 'trending 2' }).mode, 'trending');
  assert.equal(buildContext(multi, { args: [], name: 'exec1', text: '' }).mode, 'trending', 'no arguments → first list mode');
  assert.equal(buildContext(multi, { args: ['naruto'], name: 'exec1', text: 'naruto' }).mode, 'search', 'text → search when supported');
  assert.equal(buildContext(multi, { args: ['info', 'b2'], name: 'exec1', text: 'info b2' }).id, 'b2');
  assert.throws(() => buildContext(multi, { args: ['info'], name: 'exec1', text: 'info' }), (error) => error.code === ERROR_CODES.MISSING_QUERY);

  const noParam = makeSlot({ queryParam: '', modes: ['search'] });
  assert.throws(() => buildContext(noParam, { args: ['naruto'], name: 'exec1', text: 'naruto' }), (error) => error.code === ERROR_CODES.MISSING_PARAMETER);

  const infoOnly = makeSlot({ modes: ['info'], queryParam: '' });
  assert.equal(buildContext(infoOnly, { args: ['a1'], name: 'exec1', text: 'a1' }).mode, 'info');
});

test('adaptive mode: no arguments uses the configured mode, explicit modes win', () => {
  const forced = makeSlot({ mode: 'search', modes: ['search', 'trending'] });
  assert.equal(buildContext(forced, { args: ['trending'], name: 'exec1', text: 'trending' }).mode, 'trending', 'an explicit supported mode is honoured');
  const pinned = makeSlot({ mode: 'search', modes: ['search', 'trending'] });
  pinned.config.mode = 'search';
  assert.equal(buildContext(pinned, { args: ['naruto'], name: 'exec1', text: 'naruto' }).mode, 'search');
});

test('adapters are isolated: one provider failing never touches another', async () => {
  const good = await serve((req, res) => json(res, 200, { data: { results: [{ title: 'Good', url: 'https://site.example/g' }] } }));
  const bad = await serve((req, res) => json(res, 500, { error: 'boom' }));
  const goodAdapter = createAdapter({ id: 'provider_01' });
  const badAdapter = createAdapter({ id: 'provider_02' });
  const goodSlot = makeSlot({ contract: { fields: {}, listPath: 'data.results', totalPath: '', verified: true }, endpoint: good, id: 'provider_01' });
  const badSlot = makeSlot({ endpoint: bad, id: 'provider_02' });

  await assert.rejects(() => badAdapter.execute({ framework: baseFramework, mode: 'search', query: 'x', slot: badSlot }));
  const outcome = await goodAdapter.execute({ framework: baseFramework, mode: 'search', query: 'x', slot: goodSlot });
  assert.equal(outcome.results[0].title, 'Good');
  assert.equal(goodAdapter.stats().failures, 0);
  assert.equal(badAdapter.stats().failures, 1);
  assert.equal(badAdapter.stats().lastErrorCode, ERROR_CODES.SERVER_ERROR);
  assert.equal(goodAdapter.stats().calls, 1);
  assert.equal(badAdapter.stats().calls, 1);
});

test('provider-specific parsers can be plugged in per adapter', async () => {
  const endpoint = await serve((req, res) => json(res, 200, { custom: { hits: [{ label: 'Custom', file: 'https://cdn.example/c.mp4' }] } }));
  const adapter = createAdapter({
    id: 'provider_01',
    parseProviderResponse: (data, context) => ({
      discovered: false,
      listPath: 'custom.hits',
      results: data.custom.hits.map((hit, index) => normalizeResult({ id: `c${index}`, streamUrl: hit.file, title: hit.label }, { slot: context.slot, mode: context.mode, index })),
      skipped: 0,
      total: null
    })
  });
  const slot = makeSlot({ endpoint });
  const outcome = await adapter.execute({ framework: baseFramework, mode: 'search', query: 'x', slot });
  assert.equal(outcome.results[0].title, 'Custom');
  assert.equal(outcome.results[0].id, 'c0');
});

test('missing media URLs and webpage URLs are refused before anything is fetched', async () => {
  const { ERROR_CODES: codes } = require('../system/execute-after/errors');
  assert.throws(() => validateMediaUrl('', {}), (error) => error.code === codes.MISSING_MEDIA_URL);
  assert.throws(() => validateMediaUrl('ftp://cdn.example/a.mp4', {}), (error) => error.code === codes.INVALID_MEDIA_URL);
  assert.throws(() => validateMediaUrl('https://user:pass@cdn.example/a.mp4', {}), (error) => error.code === codes.INVALID_MEDIA_URL);
  assert.throws(() => validateMediaUrl('http://127.0.0.1/a.mp4', {}), (error) => error.code === codes.INVALID_MEDIA_URL);
  assert.equal(isPrivateHostname('127.0.0.1'), true);
  assert.equal(isPrivateHostname('10.0.0.5'), true);
  assert.equal(isPrivateHostname('::1'), true);
  assert.equal(isPrivateHostname('cdn.example'), false);
  assert.ok(validateMediaUrl('https://cdn.example/a.mp4?token=1', {}));
  assert.ok(validateMediaUrl('http://127.0.0.1/a.mp4', { allowPrivateHosts: true }), 'explicit opt-in for a local media server');
});

test('the bounded concurrency gate refuses extra waiters instead of queueing forever', async () => {
  const gate = createGate({ maxConcurrent: 1, queueLimit: 1 });
  assert.equal(await gate.acquire(), true);
  const second = gate.acquire();
  assert.equal(await gate.acquire(), false, 'beyond the queue limit the request is refused');
  gate.release();
  assert.equal(await second, true, 'the queued waiter is served after a slot frees up');
  gate.release();
  assert.equal(gate.active, 0);
  assert.equal(gate.waiting, 0);
});
