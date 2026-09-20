'use strict';

// ---------------------------------------------------------------------------
// Hidden Video Engine (!hvideo) production suite — provider-driven upgrade.
//
// Coverage map (spec §25):
//   Configuration — provider loading, keyword mapping, disabled providers,
//                   invalid config rejection, size-limit fallbacks.
//   Search        — exact/case/multi-word keyword routing, provider selection,
//                   multi-provider dedup, empty/malformed responses.
//   Parser        — containers, cyclic/deep/huge/malicious payloads,
//                   missing titles and media URLs.
//   Session       — creation, chat+sender isolation, 120s expiry, lazy
//                   expiry, sweeper, cap/eviction, selection paths.
//   Download      — valid/invalid URLs, HTML, missing/oversized Content-Length,
//                   streaming limit, timeout, failure cleanup, WhatsApp send.
//   Progress      — card rendering, throttling, 0/50/100%.
//   Failover      — timeout/invalid/no-results first provider, second wins.
//   Security      — secrets never exposed, filenames sanitized, RAM caps.
//   E2E           — real handler: search → reply 2 → progress → send → clear,
//                   and the 120-second expiry flow.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');
const axios = require('axios');
const hiddenVideo = require('../commands/hidden-video');
const { extractVideoUrl } = hiddenVideo;

const CHAT_A = '15550000001@s.whatsapp.net';
const USER_A = '15550000002@s.whatsapp.net';
const USER_B = '15550000003@s.whatsapp.net';

function makeContext(chatId = CHAT_A, sender = USER_A, text = '') {
  return { chatId, sender, text, raw: { key: { id: 'raw' } } };
}

function makeSocket(overrides = {}) {
  const sent = [];
  return {
    sent,
    sendMessage: async (chatId, payload, options) => {
      if (overrides.failOnMedia && payload?.video) throw new Error('transport down');
      sent.push({ chatId, payload, options });
      return { key: { id: `sent-${sent.length}` } };
    }
  };
}

function textOf(socket) {
  return socket.sent.map((entry) => entry.payload?.text || entry.payload?.caption || '').join('\n');
}

function patchAxios(t, stubs) {
  const originals = {};
  for (const [method, stub] of Object.entries(stubs)) {
    originals[method] = axios[method];
    axios[method] = stub;
  }
  t.after(() => {
    for (const [method, original] of Object.entries(originals)) axios[method] = original;
  });
}

const SMALL_HEAD = async () => ({ headers: { 'content-length': String(1024 * 1024), 'content-type': 'video/mp4' } });

function streamOf(buffer, contentType = 'video/mp4', extraHeaders = {}) {
  return {
    headers: { 'content-length': String(buffer.length), 'content-type': contentType, ...extraHeaders },
    data: Readable.from([buffer])
  };
}

test.beforeEach(() => {
  hiddenVideo._sessions.clear();
  hiddenVideo._activeDownloads.clear();
});

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

function loadWith(mutate) {
  const { loadConfig } = require('../system/config');
  const source = structuredClone(require('../config'));
  mutate(source);
  return loadConfig(source);
}

test('config: provider matrix loads with normalized fields and keyword mapping', () => {
  const loaded = loadWith((source) => {
    source.hiddenVideo.providers = [{
      id: 'MyProvider',
      name: 'My Provider',
      method: 'get',
      url: 'https://api.example.test/search',
      keywords: ['  NaRuTo ', 'naruto', 'one   piece'],
      response: { resultsPath: 'data.results', mediaUrlPath: 'links.mp4' }
    }];
  });
  const provider = loaded.hiddenVideo.providers[0];
  assert.equal(provider.id, 'myprovider');
  assert.equal(provider.name, 'My Provider');
  assert.equal(provider.method, 'GET');
  assert.equal(provider.searchParam, 'search');
  assert.deepEqual([...provider.keywords], ['naruto', 'one piece']);
  assert.equal(provider.response.resultsPath, 'data.results');
  assert.equal(provider.timeoutMs, loaded.hiddenVideo.requestTimeoutMs);
});

test('config: disabled providers stay configured but flagged off', () => {
  const loaded = loadWith((source) => {
    source.hiddenVideo.providers[0].enabled = false;
  });
  assert.equal(loaded.hiddenVideo.providers[0].enabled, false);
  assert.equal(loaded.hiddenVideo.providers.length, 3);
});

test('config: invalid provider settings are rejected safely at boot', () => {
  assert.throws(() => loadWith((s) => { s.hiddenVideo.providers[0].url = 'http://insecure.example.test'; }), /HTTPS/i);
  assert.throws(() => loadWith((s) => { s.hiddenVideo.providers[1].id = s.hiddenVideo.providers[0].id; }), /more than once/);
  assert.throws(() => loadWith((s) => { s.hiddenVideo.providers[0].method = 'DELETE'; }), /method/);
  assert.throws(() => loadWith((s) => { s.hiddenVideo.providers[0].response = { resultsPath: 'data["evil' }; }), /dot path/);
  assert.throws(() => loadWith((s) => { s.hiddenVideo.providers[0].id = ''; }), /id/);
});

test('config: download limit accepts bytes and the legacy megabyte setting', () => {
  const bytes = loadWith((s) => { s.hiddenVideo.maxDownloadBytes = 10 * 1024 * 1024; });
  assert.equal(bytes.hiddenVideo.maxDownloadBytes, 10 * 1024 * 1024);
  const legacy = loadWith((s) => { delete s.hiddenVideo.maxDownloadBytes; s.hiddenVideo.maxDownloadSizeMb = 20; });
  assert.equal(legacy.hiddenVideo.maxDownloadBytes, 20 * 1024 * 1024);
  assert.throws(() => loadWith((s) => { s.hiddenVideo.maxDownloadBytes = 12; }), /maxDownloadBytes/);
});

test('config: empty or placeholder auth headers are dropped, real ones kept', () => {
  const loaded = loadWith((s) => {
    s.hiddenVideo.providers[0].headers = {
      Authorization: 'Bearer real-token',
      'X-Empty': '',
      'X-Placeholder': 'YOUR_SECRET_TOKEN'
    };
  });
  assert.deepEqual({ ...loaded.hiddenVideo.providers[0].headers }, { Authorization: 'Bearer real-token' });
});

// ---------------------------------------------------------------------------
// Keyword routing.
// ---------------------------------------------------------------------------

test('routing: exact keyword match is case-insensitive, trimmed and space-folded', () => {
  const sys = require('../system/config');
  console.log('DBG providers:', sys.config.hiddenVideo.providers.length, JSON.stringify(sys.config.hiddenVideo.providers.map(p=>p.id)));
  console.log('DBG module-settings:', hiddenVideo._settings().providers.length, JSON.stringify(hiddenVideo._settings().providers.map(p=>p.id)));
  console.log('DBG keywords:', JSON.stringify(hiddenVideo._settings().providers.map(p=>[...p.keywords])));
  console.log('DBG route:', JSON.stringify(hiddenVideo._eligibleProviders('anime').mode));
  assert.deepEqual(hiddenVideo._eligibleProviders('anime').providers.map((p) => p.id), ['nexsus', 'new']);
  assert.deepEqual(hiddenVideo._eligibleProviders('  ANImE ').providers.map((p) => p.id), ['nexsus', 'new']);
});

test('routing: multi-word keywords resolve as one unit', () => {
  const route = hiddenVideo._eligibleProviders('one piece');
  assert.deepEqual(route.providers.map((p) => p.id), ['nexsus']);
  assert.equal(route.query, 'one piece');
});

test('routing: explicit provider id targets only that node and strips itself', () => {
  const route = hiddenVideo._eligibleProviders('david shippuden arc');
  assert.deepEqual(route.providers.map((p) => p.id), ['david']);
  assert.equal(route.query, 'shippuden arc');
  assert.equal(route.mode, 'id');
});

test('routing: unmatched keywords never blindly call every provider', () => {
  assert.deepEqual(hiddenVideo._eligibleProviders('does not exist anywhere'), { providers: [], query: 'does not exist anywhere', mode: 'none' });
});

test('routing: disabled providers are skipped', () => {
  const enabled = hiddenVideo._eligibleProviders('nexsus').providers;
  assert.ok(enabled.every((provider) => provider.enabled));
});

// ---------------------------------------------------------------------------
// Search flow.
// ---------------------------------------------------------------------------

test('search: keyword targets only matching providers and renders a capped list', async (t) => {
  const socket = makeSocket();
  const requested = [];
  const items = Array.from({ length: 8 }, (_, index) => ({ title: `Video ${index + 1}`, url: `https://cdn.test/v${index + 1}.mp4` }));
  patchAxios(t, { get: async (url, options) => { requested.push({ url: String(url), options }); return { data: { result: items } }; } });

  await hiddenVideo.handleHvideoCommand(socket, makeContext(), { text: 'amv' });

  const body = textOf(socket);
  assert.ok(requested.length, 'the matching provider was queried');
  assert.ok(requested.every((entry) => entry.url.includes('example.com')), 'non-matching providers were not called');
  assert.ok(requested.every((entry) => entry.url.includes('search=amv')));
  for (let index = 1; index <= 5; index += 1) assert.match(body, new RegExp(`${index}\\. Video ${index}`));
  assert.ok(!body.includes('Video 6'), 'anti-spam cap holds');
  assert.match(body, /Results: 5/);
  assert.match(body, /Session: 2 minutes/);
  assert.equal(hiddenVideo._sessions.get(`${CHAT_A}|${USER_A}`).results.length, 5);
});

test('search: multi-provider keyword merges and deduplicates identical media', async (t) => {
  const socket = makeSocket();
  const requested = [];
  patchAxios(t, {
    get: async (url) => {
      requested.push(String(url));
      return { data: { result: [{ title: 'Shared AMV', url: 'https://cdn.test/shared.mp4#frag' }, { title: 'Other', url: 'https://cdn.test/other.mp4' }] } };
    }
  });

  await hiddenVideo.handleHvideoCommand(socket, makeContext(), { text: 'anime' });

  assert.equal(requested.length, 2, 'both keyword-matched providers were queried');
  assert.match(textOf(socket), /Results: 2/, 'identical media (fragment only difference) was deduplicated');
  const stored = hiddenVideo._sessions.get(`${CHAT_A}|${USER_A}`).results;
  assert.equal(stored.filter((result) => result.mediaUrl.includes('shared')).length, 1);
});

test('search: response mapping adapter overrides auto-discovery', () => {
  const provider = {
    id: 'mapped', name: 'Mapped', response: {
      resultsPath: 'payload.list', titlePath: 'meta.title', mediaUrlPath: 'files.mp4', thumbnailPath: 'meta.thumb', durationPath: 'meta.length', sourceUrlPath: 'meta.page'
    }
  };
  const results = hiddenVideo._normalizeProviderResponse(provider, {
    payload: { list: [{ meta: { title: 'Mapped Title', thumb: 'https://cdn.test/t.jpg', length: 90, page: 'https://site.test/watch/1' }, files: { mp4: 'https://cdn.test/mapped.mp4' } }] }
  });
  assert.equal(results.length, 1);
  assert.deepEqual(
    { ...results[0] },
    { id: 'mapped#1', title: 'Mapped Title', mediaUrl: 'https://cdn.test/mapped.mp4', thumbnail: 'https://cdn.test/t.jpg', duration: '90', size: '', provider: 'Mapped', providerId: 'mapped', sourceUrl: 'https://site.test/watch/1' }
  );
});

test('search: missing mapping fields fall back to the generic drill', () => {
  const provider = { id: 'x', name: 'X', response: { resultsPath: 'nope.missing' } };
  const results = hiddenVideo._normalizeProviderResponse(provider, {
    result: [{ heading: 'Drill Title', deep: { download_url: 'https://cdn.test/drill.mp4' } }]
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Drill Title');
  assert.equal(results[0].mediaUrl, 'https://cdn.test/drill.mp4');
});

test('search: POST providers send the keyword as a JSON body', async (t) => {
  const posts = [];
  patchAxios(t, { post: async (url, body, options) => { posts.push({ url, body, options }); return { data: { result: [] } }; } });
  await hiddenVideo._fetchProvider({ id: 'p', name: 'P', method: 'POST', url: 'https://api.test/search', searchParam: 'q', timeoutMs: 5000, headers: {}, response: {} }, 'bleach');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { q: 'bleach' });
});

test('search: empty results and total outage give distinct clean messages', async (t) => {
  const empty = makeSocket();
  patchAxios(t, { get: async () => ({ data: { result: [] } }) });
  await hiddenVideo.handleHvideoCommand(empty, makeContext(), { text: 'amv' });
  assert.match(textOf(empty), /No videos found/);
  assert.doesNotMatch(textOf(empty), /undefined|\[object Object\]/);

  const down = makeSocket();
  patchAxios(t, { get: async () => { throw new Error('ECONNREFUSED'); } });
  await hiddenVideo.handleHvideoCommand(down, makeContext(), { text: 'david' });
  assert.match(textOf(down), /temporarily unavailable/i);
});

test('search: unmatched keyword explains itself without touching the network', async (t) => {
  const socket = makeSocket();
  patchAxios(t, { get: async () => { throw new Error('network must not be called'); } });
  await hiddenVideo.handleHvideoCommand(socket, makeContext(), { text: 'nonexistent show' });
  assert.match(textOf(socket), /No provider matches that keyword/);
  assert.match(textOf(socket), /Configured keywords:/);
});

// ---------------------------------------------------------------------------
// Parser protections.
// ---------------------------------------------------------------------------

test('parser: every documented list container is discovered', () => {
  for (const key of ['result', 'results', 'data', 'videos', 'items', 'list']) {
    const found = hiddenVideo._listItems({ [key]: [{ url: 'https://cdn.test/x.mp4' }] });
    assert.ok(Array.isArray(found), `container "${key}" must be detected`);
  }
});

test('parser: nested, cyclic, deep, huge and malicious payloads stay safe', () => {
  assert.equal(extractVideoUrl({ deep: { nested: { items: [{ stream: 'https://cdn.test/b' }] } } }), 'https://cdn.test/b');
  const cyclic = { child: {} };
  cyclic.child.parent = cyclic;
  assert.equal(extractVideoUrl(cyclic), null);
  let chain = { fileUrl: 'https://cdn.test/deep.mp4' };
  for (let level = 0; level < 40; level += 1) chain = { next: chain };
  assert.equal(extractVideoUrl(chain), null);
  let huge = { payload: 'x'.repeat(64) };
  for (let level = 0; level < 5000; level += 1) huge = { next: huge };
  assert.equal(extractVideoUrl(huge), null);
  assert.equal(extractVideoUrl({ url: 'javascript:alert(1)' }), null);
  assert.equal(extractVideoUrl({ url: 'ftp://cdn.test/video.mp4' }), null);
  const parent = { url: 'https://evil.test/video.mp4' };
  const child = Object.create(parent);
  assert.equal(extractVideoUrl(child), null);
});

test('parser: missing titles and missing media URLs degrade gracefully', () => {
  const provider = { id: 'x', name: 'X', response: {} };
  const results = hiddenVideo._normalizeProviderResponse(provider, {
    result: [{ url: 'https://cdn.test/ok.mp4' }, { title: 'No Link Here' }]
  });
  assert.equal(results.length, 1, 'items without a media URL are skipped');
  assert.equal(results[0].title, 'Selection 1', 'items without a title get a safe fallback');
});

// ---------------------------------------------------------------------------
// Sessions.
// ---------------------------------------------------------------------------

function seedSession(chatId, sender, results, ageMs = 0, query = 'anime') {
  hiddenVideo._sessions.set(`${chatId}|${sender}`, { results, query, timestamp: Date.now() - ageMs });
}

test('session: numeric selection is isolated by chat and by sender', async (t) => {
  seedSession(CHAT_A, USER_A, [{ title: 'Mine', mediaUrl: 'https://cdn.test/mine.mp4', provider: 'P', providerId: 'p' }]);
  patchAxios(t, { head: SMALL_HEAD, get: async () => streamOf(Buffer.from('MEDIA')) });
  assert.equal(await hiddenVideo.handleHvideoSelectionReply(makeSocket(), makeContext(CHAT_A, USER_B, '1')), false, 'another user cannot select it');
  assert.equal(await hiddenVideo.handleHvideoSelectionReply(makeSocket(), makeContext('other@s.whatsapp.net', USER_A, '1')), false, 'another chat cannot select it');
  assert.equal(hiddenVideo._sessions.size, 1);
});

test('session: 120-second expiry via lazy check and background sweeper', async () => {
  seedSession(CHAT_A, USER_A, [{ title: 'Old', mediaUrl: 'https://cdn.test/old.mp4' }], 121000);
  const expired = makeSocket();
  assert.equal(await hiddenVideo.handleHvideoSelectionReply(expired, makeContext(CHAT_A, USER_A, '1')), true);
  assert.match(textOf(expired), /session has expired/i);
  assert.match(textOf(expired), /!hvideo anime to search again/);
  assert.equal(hiddenVideo._sessions.size, 0);

  seedSession('live@s.whatsapp.net', USER_A, [{ title: 'x', mediaUrl: 'https://cdn.test/x.mp4' }]);
  seedSession('dead@s.whatsapp.net', USER_A, [{ title: 'y', mediaUrl: 'https://cdn.test/y.mp4' }], 121000);
  hiddenVideo._sweepExpiredSessions();
  assert.ok(hiddenVideo._sessions.has(`live@s.whatsapp.net|${USER_A}`));
  assert.ok(!hiddenVideo._sessions.has(`dead@s.whatsapp.net|${USER_A}`));
});

test('session: hard cap evicts the oldest entry', () => {
  for (let index = 0; index <= 5000; index += 1) {
    hiddenVideo._storeSession({ chatId: `chat${index}@g.us`, sender: 'user@s.whatsapp.net' }, [], 'q');
  }
  assert.ok(hiddenVideo._sessions.size <= 5000);
  assert.ok(!hiddenVideo._sessions.has('chat0@g.us|user@s.whatsapp.net'), 'oldest entry was evicted');
  assert.ok(hiddenVideo._sessions.has('chat5000@g.us|user@s.whatsapp.net'));
});

test('session: invalid selection keeps the session alive', async () => {
  seedSession(CHAT_A, USER_A, [{ title: 'One', mediaUrl: 'https://cdn.test/1.mp4' }]);
  const socket = makeSocket();
  await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_A, '9'));
  assert.match(textOf(socket), /between 1 and 1/);
  assert.equal(hiddenVideo._sessions.size, 1);
});

test('session: a new search replaces any previous session', async (t) => {
  seedSession(CHAT_A, USER_A, [{ title: 'Stale', mediaUrl: 'https://cdn.test/stale.mp4' }], 0, 'old');
  patchAxios(t, { get: async () => ({ data: { result: [{ title: 'Fresh', url: 'https://cdn.test/fresh.mp4' }] } }) });
  await hiddenVideo.handleHvideoCommand(makeSocket(), makeContext(), { text: 'amv' });
  const session = hiddenVideo._sessions.get(`${CHAT_A}|${USER_A}`);
  assert.equal(session.results[0].title, 'Fresh');
  assert.equal(session.query, 'amv');
});

// ---------------------------------------------------------------------------
// Downloads.
// ---------------------------------------------------------------------------

function seedChoice(url, title = 'Chosen') {
  seedSession(CHAT_A, USER_A, [{ title, mediaUrl: url, provider: 'TestNode', providerId: 'testnode' }]);
}

test('download: valid selection streams to WhatsApp as a buffer, session cleared', async (t) => {
  seedChoice('https://cdn.test/ok.mp4');
  patchAxios(t, { head: SMALL_HEAD, get: async () => streamOf(Buffer.from('MP4-BYTES'), 'video/mp4') });
  const socket = makeSocket();
  await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_A, '1'));
  const media = socket.sent.find((entry) => entry.payload.video);
  assert.ok(media, 'the video was delivered');
  assert.ok(Buffer.isBuffer(media.payload.video), 'delivered from memory, never a filesystem path');
  assert.equal(media.payload.video.toString(), 'MP4-BYTES');
  assert.match(media.payload.caption, /Chosen/);
  assert.match(media.payload.caption, /TestNode/);
  assert.doesNotMatch(textOf(socket), /https:\/\/cdn\.test\/ok\.mp4/, 'raw URL is never exposed when delivery works');
  assert.equal(hiddenVideo._sessions.size, 0);
  assert.equal(hiddenVideo._activeDownloads.size, 0);
});

test('download: progress card updates then the completion card is edited in place', async (t) => {
  seedChoice('https://cdn.test/ok.mp4');
  const big = Buffer.alloc(4 * 1024 * 1024, 1);
  patchAxios(t, {
    head: async () => ({ headers: { 'content-length': String(big.length), 'content-type': 'video/mp4' } }),
    get: async () => ({ headers: { 'content-length': String(big.length), 'content-type': 'video/mp4' }, data: Readable.from([big.slice(0, 2 * 1024 * 1024), big.slice(2 * 1024 * 1024)]) })
  });
  const socket = makeSocket();
  await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_A, '1'));
  const texts = socket.sent.map((entry) => entry.payload?.text || '');
  assert.ok(texts.some((text) => text.includes('Downloading')), 'initial progress card');
  assert.ok(socket.sent.some((entry) => entry.payload?.edit), 'updates edit the same message instead of spamming new ones');
  assert.ok(texts.some((text) => text.includes('Download complete')), 'completion card rendered');
  assert.ok(socket.sent.some((entry) => entry.payload.video), 'media sent after progress');
});

test('download: invalid cached link and HTML streams are refused cleanly', async (t) => {
  seedChoice('not-a-url');
  const bad = makeSocket();
  await hiddenVideo.handleHvideoSelectionReply(bad, makeContext(CHAT_A, USER_A, '1'));
  assert.match(textOf(bad), /no playable media link/);

  seedChoice('https://cdn.test/page.mp4');
  patchAxios(t, { head: async () => ({ headers: { 'content-type': 'text/html; charset=utf-8' } }) });
  const html = makeSocket();
  await hiddenVideo.handleHvideoSelectionReply(html, makeContext(CHAT_A, USER_A, '1'));
  assert.match(textOf(html), /does not provide a direct media file/);
  assert.ok(!html.sent.some((entry) => entry.payload.video));
});

test('download: oversized Content-Length is refused before any body is read', async (t) => {
  seedChoice('https://cdn.test/heavy.mp4');
  let downloaded = false;
  patchAxios(t, {
    head: async () => ({ headers: { 'content-length': String(200 * 1024 * 1024), 'content-type': 'video/mp4' } }),
    get: async () => { downloaded = true; return streamOf(Buffer.alloc(8)); }
  });
  const socket = makeSocket();
  await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_A, '1'));
  assert.match(textOf(socket), /File is too large/);
  assert.match(textOf(socket), /Maximum: 50 MB/);
  assert.match(textOf(socket), /Download cancelled/);
  assert.equal(downloaded, false, 'no byte of the oversized file was downloaded');
  assert.doesNotMatch(textOf(socket), /https:\/\/cdn\.test\/heavy\.mp4/);
});

test('download: lying Content-Length is caught by the mid-stream cap', async (t) => {
  patchAxios(t, {
    get: async () => ({ headers: { 'content-type': 'video/mp4' }, data: Readable.from([Buffer.alloc(60), Buffer.alloc(60)]) })
  });
  await assert.rejects(
    hiddenVideo._downloadMedia('https://cdn.test/lie.mp4', { timeoutMs: 5000, maxBytes: 100 }),
    (error) => error.code === 'too-large'
  );
});

test('download: stalled streams abort on the timeout', async (t) => {
  patchAxios(t, { get: async () => ({ headers: { 'content-type': 'video/mp4' }, data: new Readable({ read() {} }) }) });
  await assert.rejects(
    hiddenVideo._downloadMedia('https://cdn.test/stall.mp4', { timeoutMs: 150, maxBytes: 1024 }),
    (error) => error.code === 'timeout'
  );
});

test('download: stream failures report a clean error and free the slot', async (t) => {
  seedChoice('https://cdn.test/broken.mp4');
  patchAxios(t, {
    head: SMALL_HEAD,
    get: async () => ({ headers: { 'content-type': 'video/mp4' }, data: new Readable({ read() { this.destroy(new Error('connection reset')); } }) })
  });
  const socket = makeSocket();
  await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_A, '1'));
  assert.match(textOf(socket), /Video download failed/);
  assert.doesNotMatch(textOf(socket), /connection reset|at |Error:/, 'no stack trace or raw error leaks to the user');
  assert.equal(hiddenVideo._activeDownloads.size, 0, 'cleanup ran after the failure');
});

test('download: WhatsApp send failure still releases the slot', async (t) => {
  seedChoice('https://cdn.test/ok.mp4');
  patchAxios(t, { head: SMALL_HEAD, get: async () => streamOf(Buffer.from('DATA')) });
  const socket = makeSocket({ failOnMedia: true });
  await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_A, '1'));
  assert.equal(hiddenVideo._activeDownloads.size, 0);
});

test('download: concurrent downloads per user are limited', async (t) => {
  seedChoice('https://cdn.test/slow.mp4');
  hiddenVideo._activeDownloads.set(`${CHAT_A}|${USER_A}`, 1);
  const socket = makeSocket();
  await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_A, '1'));
  assert.match(textOf(socket), /still downloading/);
});

// ---------------------------------------------------------------------------
// Progress unit behaviour.
// ---------------------------------------------------------------------------

test('progress: cards render 0%, intermediate, 100% and unknown-total states', () => {
  const zero = hiddenVideo._buildProgressCard('T', 0, 1000);
  assert.match(zero, /0%/);
  assert.ok(zero.includes('░'));
  const mid = hiddenVideo._buildProgressCard('T', 500, 1000);
  assert.match(mid, /50%/);
  assert.ok(mid.includes('█'));
  const done = hiddenVideo._buildProgressCard('T', 1000, 1000);
  assert.match(done, /100%/);
  const unknown = hiddenVideo._buildProgressCard('T', 100, 0);
  assert.doesNotMatch(unknown, /%/);
  assert.match(unknown, /0\.0 MB/);
  const complete = hiddenVideo._buildProgressCard('T', 1, 1, { complete: true });
  assert.match(complete, /Download complete/);
  assert.match(complete, /Sending to WhatsApp/);
});

test('progress: updates are throttled by percentage delta and time, never at 100%', () => {
  const last = { pct: 10, at: 1000 };
  assert.equal(hiddenVideo._shouldUpdateProgress(last, 12, 5000), false, 'small delta waits');
  assert.equal(hiddenVideo._shouldUpdateProgress(last, 20, 1500), false, 'quiet window not elapsed');
  assert.equal(hiddenVideo._shouldUpdateProgress(last, 20, 2001), true, 'meaningful change after the window');
  assert.equal(hiddenVideo._shouldUpdateProgress(last, 100, 1001), true, '100% always renders');
});

// ---------------------------------------------------------------------------
// Provider failover.
// ---------------------------------------------------------------------------

test('failover: provider timeout, then the next provider answers', async (t) => {
  const socket = makeSocket();
  let calls = 0;
  patchAxios(t, {
    get: async (url) => {
      calls += 1;
      if (calls === 1) { const error = new Error('timeout of 6500ms exceeded'); error.code = 'ECONNABORTED'; throw error; }
      return { data: { result: [{ title: 'Second Node Hit', url: 'https://cdn.test/s2.mp4' }] } };
    }
  });
  await hiddenVideo.handleHvideoCommand(socket, makeContext(), { text: 'anime' });
  assert.equal(calls, 2);
  assert.match(textOf(socket), /Second Node Hit/);
});

test('failover: invalid JSON/HTML from one provider is skipped, the next succeeds', async (t) => {
  const socket = makeSocket();
  let calls = 0;
  patchAxios(t, {
    get: async () => {
      calls += 1;
      if (calls === 1) return { data: '<html><body>gateway error</body></html>' };
      return { data: { result: [{ title: 'Recovered', url: 'https://cdn.test/r.mp4' }] } };
    }
  });
  await hiddenVideo.handleHvideoCommand(socket, makeContext(), { text: 'anime' });
  assert.match(textOf(socket), /Recovered/);
});

test('failover: a provider with no usable results hands over to the next', async (t) => {
  const socket = makeSocket();
  let calls = 0;
  patchAxios(t, {
    get: async () => {
      calls += 1;
      if (calls === 1) return { data: { result: [] } };
      return { data: { result: [{ title: 'Found Later', url: 'https://cdn.test/l.mp4' }] } };
    }
  });
  await hiddenVideo.handleHvideoCommand(socket, makeContext(), { text: 'anime' });
  assert.match(textOf(socket), /Found Later/);
});

// ---------------------------------------------------------------------------
// Security.
// ---------------------------------------------------------------------------

test('security: provider secrets travel to the provider only, never to chat or logs', async (t) => {
  const SECRET = 'Bearer SUPER-SECRET-KEY-123';
  const captured = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  t.after(() => { console.warn = originalWarn; });

  // Phase 1: the header reaches the provider request...
  patchAxios(t, { get: async (url, options) => { captured.push({ url, options }); throw new Error('down'); } });
  const provider = { id: 'secret', name: 'Secret', method: 'GET', url: 'https://api.test/search', searchParam: 'q', timeoutMs: 5000, headers: { Authorization: SECRET }, response: {} };
  await hiddenVideo._fetchProvider(provider, 'anime').catch(() => {});
  assert.equal(captured[0]?.options?.headers?.Authorization, SECRET, 'the header reached the provider');

  // Phase 2: ...but a failing search never leaks it into logs or chat.
  const socket = makeSocket();
  patchAxios(t, { get: async () => { throw new Error('provider exploded'); } });
  await hiddenVideo.handleHvideoCommand(socket, makeContext(), { text: 'anime' });
  assert.ok(!warnings.some((line) => line.includes('SUPER-SECRET')), 'logs never carry the secret');
  assert.ok(!textOf(socket).includes('SUPER-SECRET'), 'chat output never carries the secret');
  assert.match(textOf(socket), /temporarily unavailable/i);
});

test('security: provider-controlled filenames are sanitized against traversal', () => {
  const name = hiddenVideo._safeFileName('../../etc/passwd');
  assert.ok(!name.includes('/') && !name.includes('..') && !name.includes('\\'));
  assert.match(name, /^animemd-hidden-video-[a-z0-9.-]+\.mp4$/);
  assert.equal(hiddenVideo._safeFileName(''), 'animemd-hidden-video-video.mp4');
});

test('security: titles are stripped of HTML and control characters', () => {
  assert.equal(hiddenVideo._sanitizeTitle('<script>alert(1)</script>Naruto\u0000 AMV'), 'alert(1) Naruto AMV');
  assert.equal(hiddenVideo._sanitizeTitle('x'.repeat(500)).length, 120);
});

test('security: provider JSON payloads are capped at maxResponseBytes', async (t) => {
  const requested = [];
  patchAxios(t, { get: async (url, options) => { requested.push(options); return { data: { result: [] } }; } });
  await hiddenVideo.handleHvideoCommand(makeSocket(), makeContext(), { text: 'amv' });
  const limits = require('../system/config').config.hiddenVideo;
  assert.ok(requested.length);
  for (const options of requested) {
    assert.equal(options.maxContentLength, limits.maxResponseBytes);
    assert.equal(options.maxBodyLength, limits.maxResponseBytes);
    assert.ok(Number.isFinite(options.timeout) && options.timeout > 0, 'every request carries a timeout');
  }
});

// ---------------------------------------------------------------------------
// End-to-end through the real handler (spec §27 live-style dry run).
// ---------------------------------------------------------------------------

test('e2e: search → reply 2 → mocked download → progress → WhatsApp send → session cleared', async (t) => {
  const handler = require('../system/handler');
  const media = Buffer.from('MOCK-MP4-PAYLOAD');
  patchAxios(t, {
    head: SMALL_HEAD,
    get: async (url, options) => {
      if (options?.responseType === 'stream') return streamOf(media, 'video/mp4');
      return {
        data: {
          result: [
            { title: 'Naruto AMV', url: 'https://cdn.test/n1.mp4' },
            { title: 'Naruto Fight Edit', url: 'https://cdn.test/n2.mp4' },
            { title: 'Naruto Ultra Edit', url: 'https://cdn.test/n3.mp4' },
            { title: 'Naruto vs Pain', url: 'https://cdn.test/n4.mp4' },
            { title: 'Naruto Tribute', url: 'https://cdn.test/n5.mp4' }
          ]
        }
      };
    }
  });

  const sent = [];
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => String(jid).replace(/:\d+@/, '@'),
    sendMessage: async (chatId, payload) => { sent.push({ chatId, payload }); return { key: { id: 'ok' } }; },
    profilePictureUrl: async () => 'https://example.invalid/pp.jpg'
  };
  const message = (text) => ({ key: { remoteJid: USER_A, participant: USER_A, fromMe: false }, message: { conversation: text } });

  await handler(socket, message('!hvideo anime'));
  const listText = sent.map((entry) => entry.payload?.text || '').join('\n');
  assert.match(listText, /1\. Naruto AMV/);
  assert.match(listText, /5\. Naruto Tribute/);
  assert.match(listText, /Reply with a number/);

  sent.length = 0;
  await handler(socket, message('2'));
  const texts = sent.map((entry) => entry.payload?.text || '');
  assert.ok(texts.some((text) => text.includes('Downloading')), 'live progress was shown');
  assert.ok(sent.some((entry) => entry.payload?.edit), 'progress updates edited one message');
  assert.ok(texts.some((text) => text.includes('Download complete')), 'completion card shown');
  const video = sent.find((entry) => entry.payload.video);
  assert.ok(video, 'the video reached WhatsApp');
  assert.equal(video.payload.video.toString(), 'MOCK-MP4-PAYLOAD');
  assert.match(video.payload.caption, /Naruto Fight Edit/);
  assert.equal(hiddenVideo._sessions.size, 0, 'session cleared after delivery');

  // Idle numeric replies keep their legacy menu behaviour.
  sent.length = 0;
  await handler(socket, message('1'));
  assert.match(sent.map((entry) => entry.payload?.text || '').join('\n'), /!fancy/);
});

test('e2e: after the 120-second TTL the same reply reports an expired session', async (t) => {
  const handler = require('../system/handler');
  patchAxios(t, { get: async () => ({ data: { result: [{ title: 'Expired Candidate', url: 'https://cdn.test/e.mp4' }] } }) });

  const sent = [];
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => String(jid).replace(/:\d+@/, '@'),
    sendMessage: async (chatId, payload) => { sent.push({ chatId, payload }); return { key: { id: 'ok' } }; },
    profilePictureUrl: async () => 'https://example.invalid/pp.jpg'
  };
  const message = (text) => ({ key: { remoteJid: USER_A, participant: USER_A, fromMe: false }, message: { conversation: text } });

  await handler(socket, message('!hvideo anime'));
  // Advance the session clock past the TTL without waiting 120 real seconds.
  const session = hiddenVideo._sessions.get(`${USER_A}|${USER_A}`);
  assert.ok(session, 'the search created a session');
  session.timestamp -= 121000;

  sent.length = 0;
  await handler(socket, message('2'));
  const body = sent.map((entry) => entry.payload?.text || '').join('\n');
  assert.match(body, /session has expired/i);
  assert.match(body, /!hvideo anime to search again/);
  assert.equal(hiddenVideo._sessions.size, 0);
  assert.ok(!sent.some((entry) => entry.payload.video), 'nothing was downloaded after expiry');
});
