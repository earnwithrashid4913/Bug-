'use strict';

// ---------------------------------------------------------------------------
// Hidden Video Engine (!hvideo) production suite.
//
// Proves the three live-hosting guarantees:
//   1. Memory leak protection — selection sessions expire, sweep and clear.
//   2. Robust error handling — oversized streams alert the user instead of
//      crashing the bot; every failure path replies, nothing throws.
//   3. Platform-agnostic extraction — the deep parser survives irregular,
//      cyclic, deep and hostile vendor payloads.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');
const hiddenVideo = require('../commands/hidden-video');
const { extractVideoUrl } = hiddenVideo;

const CHAT_A = '15550000001@s.whatsapp.net';
const USER_A = '15550000002@s.whatsapp.net';
const USER_B = '15550000003@s.whatsapp.net';

function makeContext(chatId = CHAT_A, sender = USER_A, text = '') {
  return { chatId, sender, text, raw: { key: { id: 'raw' } } };
}

function makeSocket() {
  const sent = [];
  return {
    sent,
    sendMessage: async (chatId, payload, options) => {
      sent.push({ chatId, payload, options });
      return { key: { id: 'sent' } };
    }
  };
}

function textOf(socket) {
  return socket.sent.map((entry) => entry.payload?.text || entry.payload?.caption || '').join('\n');
}

// Patch the shared axios instance; every patch is restored afterwards.
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

test.beforeEach(() => hiddenVideo._sessions.clear());

// ---------------------------------------------------------------------------
// 3. Universal structural parser.
// ---------------------------------------------------------------------------

test('extractVideoUrl drills through irregular and deeply nested vendor JSON', () => {
  assert.equal(extractVideoUrl({ downloadUrl: 'https://cdn.test/a.mp4' }), 'https://cdn.test/a.mp4');
  assert.equal(
    extractVideoUrl({ deep: { nested: { items: [{ stream: 'https://cdn.test/b' }] } } }),
    'https://cdn.test/b'
  );
  assert.equal(
    extractVideoUrl({ result: [{ meta: { links: { mp4: 'https://cdn.test/c.mp4' } } }] }),
    'https://cdn.test/c.mp4'
  );
  // A bare string payload with a video marker is accepted as-is.
  assert.equal(extractVideoUrl('https://cdn.test/stream/video.mp4'), 'https://cdn.test/stream/video.mp4');
});

test('extractVideoUrl rejects non-media links and non-http schemes', () => {
  assert.equal(extractVideoUrl('https://cdn.test/about'), null);
  assert.equal(extractVideoUrl({ url: 'javascript:alert(1)' }), null);
  assert.equal(extractVideoUrl({ url: 'ftp://cdn.test/video.mp4' }), null);
  assert.equal(extractVideoUrl(null), null);
  assert.equal(extractVideoUrl(42), null);
});

test('extractVideoUrl survives cyclic and extremely deep hostile payloads', () => {
  const cyclic = { child: {} };
  cyclic.child.parent = cyclic;
  assert.equal(extractVideoUrl(cyclic), null); // never loops forever

  let chain = { fileUrl: 'https://cdn.test/deep.mp4' };
  for (let level = 0; level < 40; level += 1) chain = { next: chain };
  assert.equal(extractVideoUrl(chain), null); // bounded depth, no stack overflow

  let huge = { payload: 'x'.repeat(64) };
  for (let level = 0; level < 5000; level += 1) huge = { next: huge };
  assert.equal(extractVideoUrl(huge), null); // returns fast, never throws
});

test('extractVideoUrl only reads own properties, never the prototype chain', () => {
  const parent = { url: 'https://evil.test/video.mp4' };
  const child = Object.create(parent);
  child.title = 'bait';
  assert.equal(extractVideoUrl(child), null);
});

// ---------------------------------------------------------------------------
// 1. Memory leak protection.
// ---------------------------------------------------------------------------

test('expired sessions are reported and deleted, live sessions survive the sweep', () => {
  hiddenVideo._sessions.set('live', { results: [{ title: 'x', url: 'https://cdn.test/x.mp4' }], timestamp: Date.now() });
  hiddenVideo._sessions.set('dead', { results: [{ title: 'y', url: 'https://cdn.test/y.mp4' }], timestamp: Date.now() - 121000 });
  hiddenVideo._sweepExpiredSessions();
  assert.ok(hiddenVideo._sessions.has('live'));
  assert.ok(!hiddenVideo._sessions.has('dead'));
});

test('an expired numeric reply alerts the user and frees the memory', async () => {
  const socket = makeSocket();
  hiddenVideo._sessions.set(`${CHAT_A}|${USER_A}`, {
    results: [{ title: 'Old', url: 'https://cdn.test/old.mp4' }],
    timestamp: Date.now() - 121000
  });
  const consumed = await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_A, '1'));
  assert.equal(consumed, true);
  assert.match(textOf(socket), /expired/i);
  assert.equal(hiddenVideo._sessions.size, 0);
});

test('sessions are isolated per chat and per sender', async (t) => {
  const socket = makeSocket();
  hiddenVideo._sessions.set(`${CHAT_A}|${USER_A}`, {
    results: [{ title: 'Mine', url: 'https://cdn.test/mine.mp4' }],
    timestamp: Date.now()
  });
  patchAxios(t, { head: SMALL_HEAD });
  // A different user in the same chat has no session: the reply is untouched.
  const consumed = await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_B, '1'));
  assert.equal(consumed, false);
  assert.equal(hiddenVideo._sessions.size, 1);
});

test('the selection session is cleared the moment a choice is delivered', async (t) => {
  const socket = makeSocket();
  hiddenVideo._sessions.set(`${CHAT_A}|${USER_A}`, {
    results: [{ title: 'One', url: 'https://cdn.test/one.mp4' }],
    timestamp: Date.now()
  });
  patchAxios(t, { head: SMALL_HEAD });
  await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_A, '1'));
  assert.equal(hiddenVideo._sessions.size, 0);
});

// ---------------------------------------------------------------------------
// 2. Robust error handling (size guard & graceful failures).
// ---------------------------------------------------------------------------

test('an oversized stream alerts the user instead of buffering and crashing', async (t) => {
  const socket = makeSocket();
  hiddenVideo._sessions.set(`${CHAT_A}|${USER_A}`, {
    results: [{ title: 'Heavy', url: 'https://cdn.test/heavy.mp4' }],
    timestamp: Date.now()
  });
  patchAxios(t, {
    head: async () => ({ headers: { 'content-length': String(200 * 1024 * 1024), 'content-type': 'video/mp4' } })
  });
  await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_A, '1'));
  assert.match(textOf(socket), /exceeds/);
  assert.match(textOf(socket), /https:\/\/cdn\.test\/heavy\.mp4/);
  assert.ok(!socket.sent.some((entry) => entry.payload.video), 'no video may be buffered');
});

test('a HEAD refusal or HTML stream degrades to an alert, never a crash', async (t) => {
  // HEAD unsupported: delivery still proceeds.
  const okSocket = makeSocket();
  hiddenVideo._sessions.set(`${CHAT_A}|${USER_A}`, {
    results: [{ title: 'NoHead', url: 'https://cdn.test/nohead.mp4' }],
    timestamp: Date.now()
  });
  patchAxios(t, { head: async () => { throw new Error('405 Method Not Allowed'); } });
  await hiddenVideo.handleHvideoSelectionReply(okSocket, makeContext(CHAT_A, USER_A, '1'));
  assert.ok(okSocket.sent.some((entry) => entry.payload.video?.url === 'https://cdn.test/nohead.mp4'));

  // HTML content-type: warned, never sent as a video.
  const htmlSocket = makeSocket();
  hiddenVideo._sessions.set(`${CHAT_A}|${USER_A}`, {
    results: [{ title: 'Page', url: 'https://cdn.test/page.mp4' }],
    timestamp: Date.now()
  });
  patchAxios(t, {
    head: async () => ({ headers: { 'content-length': '1024', 'content-type': 'text/html; charset=utf-8' } })
  });
  await hiddenVideo.handleHvideoSelectionReply(htmlSocket, makeContext(CHAT_A, USER_A, '1'));
  assert.match(textOf(htmlSocket), /web page/i);
  assert.ok(!htmlSocket.sent.some((entry) => entry.payload.video));
});

test('a broken cached stream link is rejected safely', async (t) => {
  const socket = makeSocket();
  hiddenVideo._sessions.set(`${CHAT_A}|${USER_A}`, {
    results: [{ title: 'Broken', url: 'not-a-url' }],
    timestamp: Date.now()
  });
  patchAxios(t, { head: SMALL_HEAD });
  await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_A, '1'));
  assert.match(textOf(socket), /could not be safely resolved/i);
  assert.ok(!socket.sent.some((entry) => entry.payload.video));
});

test('an out-of-range choice explains the valid range and keeps the session', async () => {
  const socket = makeSocket();
  hiddenVideo._sessions.set(`${CHAT_A}|${USER_A}`, {
    results: [
      { title: 'One', url: 'https://cdn.test/1.mp4' },
      { title: 'Two', url: 'https://cdn.test/2.mp4' }
    ],
    timestamp: Date.now()
  });
  await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_A, '9'));
  assert.match(textOf(socket), /between 1 and 2/);
  assert.equal(hiddenVideo._sessions.size, 1);
});

test('all nodes failing degrades to the exhausted notice, never a throw', async (t) => {
  const socket = makeSocket();
  patchAxios(t, { get: async () => { throw new Error('ECONNREFUSED'); } });
  await hiddenVideo.handleHvideoCommand(socket, makeContext(), { text: 'naruto' });
  assert.match(textOf(socket), /All secure layers exhausted/);
});

// ---------------------------------------------------------------------------
// Search routing, selection flow, keyword mode.
// ---------------------------------------------------------------------------

test('search renders a capped list, stores a session and skips flat-only vendors', async (t) => {
  const socket = makeSocket();
  const requested = [];
  const items = Array.from({ length: 8 }, (_, index) => ({ title: `Video ${index + 1}`, url: `https://cdn.test/v${index + 1}.mp4` }));
  patchAxios(t, { get: async (url) => { requested.push(String(url)); return { data: { result: items } }; } });

  await hiddenVideo.handleHvideoCommand(socket, makeContext(), { text: 'naruto' });

  const body = textOf(socket);
  for (let index = 1; index <= 5; index += 1) assert.match(body, new RegExp(`\\*${index}\\.\\* Video ${index}`));
  assert.ok(!body.includes('Video 6'), 'anti-spam cap: never more than 5 rows');
  assert.ok(requested.every((url) => url.includes('search=naruto')), 'generic search uses the search parameter');
  assert.ok(!requested.some((url) => url.includes('davidcyril')), 'supportSearch:false vendors are skipped by searches');
  assert.equal(hiddenVideo._sessions.get(`${CHAT_A}|${USER_A}`)?.results.length, 5);
});

test('the stored selection downloads the chosen stream and clears the session', async (t) => {
  const socket = makeSocket();
  patchAxios(t, {
    get: async () => ({
      data: {
        result: [
          { title: 'First', url: 'https://cdn.test/first.mp4' },
          { name: 'Second', nested: { link: 'https://cdn.test/second-stream' } }
        ]
      }
    }),
    head: SMALL_HEAD
  });

  await hiddenVideo.handleHvideoCommand(socket, makeContext(), { text: 'bleach' });
  await hiddenVideo.handleHvideoSelectionReply(socket, makeContext(CHAT_A, USER_A, '2'));

  const video = socket.sent.find((entry) => entry.payload.video);
  assert.equal(video.payload.video.url, 'https://cdn.test/second-stream');
  assert.match(video.payload.caption, /Second/);
  assert.equal(hiddenVideo._sessions.size, 0, 'session cleaned instantly post-delivery');
});

test('an explicit keyword targets only that node and strips itself from the query', async (t) => {
  const socket = makeSocket();
  const requested = [];
  patchAxios(t, {
    get: async (url) => { requested.push(String(url)); return { data: {} }; },
    head: SMALL_HEAD
  });

  await hiddenVideo.handleHvideoCommand(socket, makeContext(), { text: 'nexsus shippuden' });
  assert.equal(requested.length, 1, 'keyword mode never scans the generic matrix');
  assert.equal(requested[0], 'https://example.com?query=shippuden');
});

test('a flat payload answer bypasses the list and streams directly', async (t) => {
  const socket = makeSocket();
  patchAxios(t, {
    get: async () => ({ data: { status: 200, media: { download: 'https://cdn.test/direct.mp4' } } })
  });
  await hiddenVideo.handleHvideoCommand(socket, makeContext(), { text: 'david' });
  const video = socket.sent.find((entry) => entry.payload.video);
  assert.equal(video.payload.video.url, 'https://cdn.test/direct.mp4');
  assert.match(video.payload.caption, /Direct Layer Bypass/);
});

test('the usage matrix answers a bare command, no network involved', async (t) => {
  const socket = makeSocket();
  patchAxios(t, { get: async () => { throw new Error('network must not be called'); } });
  await hiddenVideo.handleHvideoCommand(socket, makeContext(), { text: '' });
  assert.match(textOf(socket), /Usage Matrix/);
});

// ---------------------------------------------------------------------------
// End-to-end through the real handler: dispatch route + numeric interception.
// ---------------------------------------------------------------------------

test('real handler: !hvideo list then a bare number downloads; idle numbers still open the menu', async (t) => {
  const handler = require('../system/handler');
  const requested = [];
  patchAxios(t, {
    get: async (url) => {
      requested.push(String(url));
      return { data: { result: [{ title: 'Fixture Stream', url: 'https://cdn.test/fixture.mp4' }] } };
    },
    head: SMALL_HEAD
  });

  const sent = [];
  const socket = {
    user: { id: '15551234567@s.whatsapp.net' },
    decodeJid: (jid) => String(jid).replace(/:\d+@/, '@'),
    sendMessage: async (chatId, payload) => { sent.push({ chatId, payload }); return { key: { id: 'ok' } }; },
    profilePictureUrl: async () => 'https://example.invalid/pp.jpg'
  };
  const message = (text) => ({
    key: { remoteJid: USER_A, participant: USER_A, fromMe: false },
    message: { conversation: text }
  });

  await handler(socket, message('!hvideo fixture'));
  assert.match(sent.map((entry) => entry.payload?.text || '').join('\n'), /Fixture Stream/);

  sent.length = 0;
  await handler(socket, message('1'));
  const video = sent.find((entry) => entry.payload.video);
  assert.ok(video, 'the numeric reply delivered the chosen video');
  assert.equal(video.payload.video.url, 'https://cdn.test/fixture.mp4');
  assert.equal(hiddenVideo._sessions.size, 0);

  // With no active session the same bare number must keep its old behaviour.
  sent.length = 0;
  await handler(socket, message('1'));
  const idleText = sent.map((entry) => entry.payload?.text || '').join('\n');
  assert.match(idleText, /!fancy/);
  assert.ok(!sent.some((entry) => entry.payload.video));
});
