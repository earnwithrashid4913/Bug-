'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AnimeLibraryClient, normalizeAnimeConfig, detectCountry, candidate, candidatesFrom, chooseVideo, videoLabel, publicHttpsUrl } = require('../system/lib/anime-library');
const { normalizeWelcomeConfig, authenticatedSelfJid, welcomeCaption, sendWelcomeVideo } = require('../system/lib/connection-welcome');
const { loadConfig } = require('../system/config');
const userConfig = require('../config');
const endpoint = 'https://library.example/api/anime/random';
const asset = (id = 'gojo', extra = {}) => ({ enabled: true, id, country: 'PK', gender: 'male', videoUrl: `https://media.example/${id}.mp4`, anime: 'Jujutsu Kaisen', character: 'Gojo', quality: 9, views: 100000, ...extra });
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const enabled = extra => ({ enabled: true, libraryApi: endpoint, ...extra });
const quiet = { warn() {} };

for (const options of [{}, { enabled: false, libraryApi: endpoint }, { enabled: true, libraryApi: '' }, { enabled: false, libraryApi: 'invalid' }]) {
  test(`anime OFF has zero fetch/media/error calls: ${JSON.stringify(options)}`, async () => {
    let calls = 0;
    const client = new AnimeLibraryClient(options, { fetchImpl: () => { calls++; }, log: { warn: () => { calls++; } } });
    assert.equal((await client.deliver('923001234567', () => { calls++; })).status, 'off');
    assert.equal(calls, 0);
    assert.deepEqual(client.recentVideoIds, []);
  });
}

test('optional invalid config does not abort loadConfig; settings are independent and frozen', () => {
  const c = loadConfig({ ...userConfig, telegramAnimeEdit: { enabled: true, libraryApi: 'not a url' }, connectionWelcomeVideo: { enabled: false } });
  assert.equal(c.telegramAnimeEdit.enabled, true);
  assert.equal(c.connectionWelcomeVideo.enabled, false);
  assert.ok(Object.isFrozen(c.telegramAnimeEdit));
  assert.equal(normalizeAnimeConfig({ enabled: 'true', timeoutMs: Infinity }).enabled, false);
  assert.equal(normalizeAnimeConfig({ avoidRecent: 100, timeoutMs: 999999 }).avoidRecent, 50);
  assert.equal(normalizeAnimeConfig({ timeoutMs: 999999 }).timeoutMs, 60000);
  assert.equal(normalizeWelcomeConfig(null).enabled, false);
});

for (const [number, country] of Object.entries({
  '923001234567': 'PK', '919876543210': 'IN', '442079460018': 'GB', '971501234567': 'AE',
  '966501234567': 'SA', '819012345678': 'JP', '821012345678': 'KR', '12025550123': 'US',
  '447911123456': 'GG', '999999999': 'WORLDWIDE', unknown: 'WORLDWIDE', '': 'WORLDWIDE'
})) test(`phone metadata: ${number || '(empty)'} → ${country}`, () => assert.equal(detectCountry(number), country));

test('URL guard rejects credentials, non-HTTPS and private/loopback literals', () => {
  for (const url of ['http://example.com/x', 'file:///tmp/a', 'https://user:secret@example.com/a', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://192.168.2.1/x', 'https://172.16.0.1/x', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://a.internal/x']) assert.throws(() => publicHttpsUrl(url));
  assert.equal(publicHttpsUrl(endpoint).href, endpoint);
});

test('country-first GET uses query controls, optional bearer header, and no phone/Telegram secret', async () => {
  const requests = [], sent = [];
  const client = new AnimeLibraryClient(enabled({ apiKey: 'PRIVATE_API_KEY', gender: 'male', quality: 'top', avoidRecent: 5 }), {
    fetchImpl: async (url, init) => { requests.push({ url, init }); return response(asset()); }, log: quiet
  });
  assert.equal((await client.deliver('923001234567', async (...args) => sent.push(args))).status, 'sent');
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('country'), 'PK');
  assert.equal(url.searchParams.get('gender'), 'male');
  assert.equal(url.searchParams.get('quality'), 'top');
  assert.equal(url.searchParams.get('avoid_recent'), '5');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer PRIVATE_API_KEY');
  assert.equal(requests[0].init.redirect, 'error');
  assert.doesNotMatch(url.href, /PRIVATE_API_KEY|923001234567/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], asset().videoUrl);
});

test('no local match falls back to WORLDWIDE, including disabled and gender-mismatched candidates', async () => {
  const countries = [];
  const client = new AnimeLibraryClient(enabled({ gender: 'female' }), {
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.Authorization, undefined);
      const country = new URL(url).searchParams.get('country'); countries.push(country);
      return response(country === 'PK' ? [asset('disabled', { enabled: false }), asset('male')] : [asset('world', { country: 'WORLDWIDE', gender: 'female' })]);
    }, log: quiet
  });
  const sent = [];
  assert.equal((await client.deliver('923001234567', async url => sent.push(url))).status, 'sent');
  assert.deepEqual(countries, ['PK', 'WORLDWIDE']);
  assert.match(sent[0], /world.mp4$/);
});

test('unknown number requests WORLDWIDE only; empty catalog is a safe skip', async () => {
  const requests = [], logs = [];
  const client = new AnimeLibraryClient(enabled(), { fetchImpl: async url => { requests.push(new URL(url).searchParams.get('country')); return response([]); }, log: { warn: line => logs.push(line) } });
  assert.equal((await client.deliver('unknown', () => assert.fail('must not send'))).status, 'failed');
  assert.deepEqual(requests, ['WORLDWIDE']);
  assert.match(logs[0], /NO_SUITABLE_VIDEO/);
});

test('single and candidate-array metadata validation tolerates missing optional text/metrics', () => {
  const basic = { id: 'safe', enabled: true, videoUrl: 'https://media.example/safe.mp4' };
  const parsed = candidate(basic);
  assert.equal(parsed.country, 'WORLDWIDE');
  assert.equal(parsed.quality, 1);
  assert.equal(parsed.views, 0);
  assert.ok(videoLabel(parsed).includes('✨'));
  assert.equal(videoLabel(candidate(asset('l', { label: '✦ API Label ✦' }))), '✦ API Label ✦');
  for (const data of [basic, [basic], { data: basic }, { data: [basic] }, { videos: [basic] }, { items: [basic] }]) assert.equal(candidatesFrom(data).length, 1);
  assert.equal(candidatesFrom([basic, basic]).length, 1);
  for (const extra of [{ enabled: false }, { enabled: 'true' }, { id: '' }, { id: '../creds' }, { videoUrl: 'javascript:x' }, { country: '<script>' }, { gender: 'invalid' }]) assert.equal(candidate({ ...basic, ...extra }), undefined);
  assert.equal(candidate(asset('x', { views: Infinity, quality: NaN, label: '\u202eGojo\n' })).label, 'Gojo');
});

test('weighted top selection favors stronger metrics without making the weaker candidate impossible', () => {
  const videos = candidatesFrom([asset('low', { quality: 0, views: 0 }), asset('high', { quality: 10, views: 1e6 })]);
  let high = 0;
  for (let i = 0; i < 1000; i++) if (chooseVideo(videos, { gender: 'male', random: () => i / 1000 }).id === 'high') high++;
  assert.ok(high > 900 && high < 1000, `high selected ${high}/1000`);
  assert.equal(chooseVideo(videos, { gender: 'male', quality: 'normal', random: () => 0.49 }).id, 'low');
  assert.equal(chooseVideo(videos, { gender: 'male', quality: 'normal', random: () => 0.51 }).id, 'high');
});

test('male, female and mixed preferences stay varied and respect recent IDs when alternatives exist', () => {
  const videos = candidatesFrom([asset('m'), asset('f', { gender: 'female' }), asset('f2', { gender: 'female' })]);
  assert.equal(chooseVideo(videos, { gender: 'male' }).id, 'm');
  assert.equal(chooseVideo(videos, { gender: 'female', random: () => 0 }).id, 'f');
  assert.equal(chooseVideo(videos, { gender: 'mixed', random: () => 0 }).id, 'm');
  assert.equal(chooseVideo(videos, { gender: 'mixed', random: () => 0.6 }).gender, 'female');
  assert.equal(chooseVideo(videos, { gender: 'female', recent: ['f'], random: () => 0 }).id, 'f2');
});

test('serialized concurrent deliveries avoid repeats, bound IDs, expire lazily and reset with a new client', async () => {
  let clock = 100000;
  const deps = { now: () => clock, random: () => 0, fetchImpl: async () => response([asset('a'), asset('b'), asset('c')]), log: quiet };
  const client = new AnimeLibraryClient(enabled({ avoidRecent: 2 }), deps);
  const sent = [];
  await Promise.all([1, 2, 3].map(() => client.deliver('923001234567', async url => sent.push(url))));
  assert.equal(new Set(sent).size, 3);
  assert.deepEqual(client.recentVideoIds, ['b', 'c']);
  assert.equal(client.pending, 0);
  assert.deepEqual(new AnimeLibraryClient(enabled(), deps).recentVideoIds, []);
  clock += 31 * 60000;
  await client.deliver('923001234567', async () => {});
  assert.deepEqual(client.recentVideoIds, ['a']);
  const disabledHistory = new AnimeLibraryClient(enabled({ avoidRecent: 0 }), deps);
  await disabledHistory.deliver('923001234567', async () => {});
  assert.deepEqual(disabledHistory.recentVideoIds, []);
});

for (const status of [401, 403, 429, 500, 503]) test(`HTTP ${status} is contained and logs no provider secrets`, async () => {
  const logs = [];
  const client = new AnimeLibraryClient(enabled({ apiKey: 'SECRET' }), { fetchImpl: async () => new Response('SECRET TOKENS AUTH CREDS', { status }), log: { warn: line => logs.push(line) } });
  assert.equal((await client.deliver('923001234567', () => assert.fail())).status, 'failed');
  assert.match(logs.join(''), new RegExp(`HTTP_${status}`));
  assert.doesNotMatch(logs.join(''), /SECRET|TOKENS|CREDS|923001234567/);
});

for (const [name, fetchImpl] of [
  ['DNS/fetch rejection', async () => { throw new Error('ENOTFOUND https://SECRET:TOKEN@provider.example'); }],
  ['invalid JSON', async () => new Response('<html>SECRET</html>')],
  ['oversized body', async () => new Response('x'.repeat(512 * 1024 + 1))],
  ['oversized content length', async () => new Response('{}', { headers: { 'content-length': '999999999' } })]
]) test(`${name} is safe and never invokes Telegram`, async () => {
  const logs = [];
  const client = new AnimeLibraryClient(enabled(), { fetchImpl, log: { warn: line => logs.push(line) } });
  assert.equal((await client.deliver('923001234567', () => assert.fail())).status, 'failed');
  assert.doesNotMatch(logs.join(''), /SECRET|TOKEN|provider.example/);
});

test('timeout aborts a slow library request, and invalid enabled endpoint makes no fetch', async () => {
  const logs = [];
  const client = new AnimeLibraryClient(enabled({ timeoutMs: 100 }), {
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(response(asset())), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }), log: { warn: line => logs.push(line) }
  });
  assert.equal((await client.deliver('923001234567', () => assert.fail())).status, 'failed');
  assert.match(logs.join(''), /TIMEOUT/);
  const invalid = new AnimeLibraryClient(enabled({ libraryApi: 'NOT A URL' }), { fetchImpl: () => assert.fail(), log: quiet });
  assert.equal((await invalid.deliver('923001234567', () => assert.fail())).status, 'failed');
});

test('404 country miss retries worldwide; Telegram video rejection never changes success or history', async () => {
  let requests = 0;
  const logs = [];
  const client = new AnimeLibraryClient(enabled(), {
    fetchImpl: async () => ++requests === 1 ? new Response(null, { status: 404 }) : response(asset('world', { country: 'WORLDWIDE' })),
    log: { warn: line => logs.push(line) }
  });
  assert.equal((await client.deliver('923001234567', async () => { throw new Error('https://api.telegram.org/botSECRET/sendVideo'); })).status, 'failed');
  assert.equal(requests, 2);
  assert.match(logs.join(''), /TELEGRAM_SEND_FAILED/);
  assert.doesNotMatch(logs.join(''), /SECRET|api.telegram/);
  assert.deepEqual(client.recentVideoIds, []);
});

test('self-JID validation rejects groups, status, broadcasts, guesses and malformed socket identity', () => {
  for (const id of [undefined, '', '123@g.us', 'status@broadcast', '123@broadcast', 'owner', '123:device@s.whatsapp.net', 123]) assert.equal(authenticatedSelfJid({ user: { id } }), undefined);
  assert.equal(authenticatedSelfJid({ user: { id: '923001234567:42@s.whatsapp.net' } }), '923001234567@s.whatsapp.net');
  assert.equal(authenticatedSelfJid({ user: { id: '123456789@lid' } }), '123456789@lid');
});

test('welcome caption uses only authenticated own display data; LID is not falsely displayed as a phone', () => {
  const caption = welcomeCaption({ user: { id: '923001234567:4@s.whatsapp.net', name: 'Own User' } }).normalize('NFKC');
  assert.match(caption, /USER : Own User/);
  assert.match(caption, /NUMBER : \+923001234567/);
  assert.match(caption, /GOJO'S SYSTEM/);
  assert.match(caption, /TODAY'S THOUGHT/);
  assert.doesNotMatch(caption, /Rashid|F!xa|undefined|TOKEN|creds/);
  assert.match(welcomeCaption({ user: { id: '123456789@lid' } }).normalize('NFKC'), /NUMBER : Unavailable/);
});

test('own-chat local welcome reads user video without writing any artifacts; disabled/missing source is safe', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-welcome-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const videoPath = path.join(dir, 'welcome.mp4');
  // Fixture bytes only: mocked socket IO, not a claim of playable/live media.
  await fs.writeFile(videoPath, 'mock MP4 bytes');
  const sends = [];
  const socket = { user: { id: '923001234567:42@s.whatsapp.net', name: 'Own User' }, sendMessage: async (...args) => sends.push(args) };
  assert.equal((await sendWelcomeVideo(socket, { enabled: false, path: videoPath })).status, 'off');
  assert.equal(sends.length, 0);
  assert.equal((await sendWelcomeVideo(socket, { enabled: true, source: 'local', path: videoPath })).status, 'sent');
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], '923001234567@s.whatsapp.net');
  assert.equal(sends[0][1].video.url, videoPath);
  assert.equal(sends[0][1].mimetype, 'video/mp4');
  assert.deepEqual(await fs.readdir(dir), ['welcome.mp4']);
  assert.equal((await sendWelcomeVideo(socket, { enabled: true, path: path.join(dir, 'missing.mp4') }, { log: quiet })).status, 'failed');
  assert.equal(sends.length, 1);
});

test('independent remote own welcome enforces HTTPS, contains send failures, and bounds waiting', async () => {
  const fetchImpl = async (_url, options) => { assert.equal(options.redirect, 'error'); assert.ok(options.signal); return new Response('mock video'); };
  const sends = [], logs = [];
  const socket = { user: { id: '923001234567@s.whatsapp.net' }, sendMessage: async (...args) => { sends.push(args); } };
  assert.equal((await sendWelcomeVideo(socket, { enabled: true, source: 'url', url: 'https://media.example/welcome.mp4' }, { fetchImpl })).status, 'sent');
  const options = { enabled: true, source: 'url', url: 'http://media.example/welcome.mp4' };
  assert.equal((await sendWelcomeVideo(socket, options, { log: quiet })).status, 'failed');
  assert.equal(sends.length, 1);
  socket.sendMessage = async () => { throw new Error('SECRET credentials'); };
  assert.equal((await sendWelcomeVideo(socket, { ...options, url: 'https://media.example/welcome.mp4' }, { fetchImpl, log: { warn: line => logs.push(line) } })).status, 'failed');
  assert.doesNotMatch(logs.join(''), /SECRET|credentials/);
  socket.sendMessage = async () => new Promise(() => {});
  assert.equal((await sendWelcomeVideo(socket, { ...options, url: 'https://media.example/welcome.mp4', timeoutMs: 100 }, { fetchImpl, log: quiet })).status, 'failed');
});

test('optional delivery queue is bounded rather than growing under connection bursts', async () => {
  let release;
  const first = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const client = new AnimeLibraryClient(enabled(), {
    fetchImpl: async () => { requests++; await first; return response(asset()); }, log: quiet
  });
  const jobs = Array.from({ length: 20 }, () => client.deliver('923001234567', async () => {}));
  assert.equal((await client.deliver('923001234567', async () => assert.fail())).status, 'skipped');
  assert.equal(client.pending, 20);
  release();
  await Promise.all(jobs);
  assert.equal(client.pending, 0);
  assert.equal(requests, 20);
});

test('remote welcome failures and oversize declarations never invoke the socket', async () => {
  const socket = { user: { id: '923001234567@s.whatsapp.net' }, sendMessage: async () => assert.fail('invalid remote video must not send') };
  const options = { enabled: true, source: 'url', url: 'https://media.example/welcome.mp4', timeoutMs: 100 };
  for (const fetchImpl of [
    async () => new Response('denied', { status: 403 }),
    async () => new Response('x', { headers: { 'content-length': '999999999' } }),
    async () => new Response(''),
    async () => { throw new Error('SECRET DNS error'); }
  ]) assert.equal((await sendWelcomeVideo(socket, options, { fetchImpl, log: quiet })).status, 'failed');
});
