'use strict';

// ---------------------------------------------------------------------------
// !aio — Google search/redirect wrapper handling.
//
// A Google wrapper URL is never media. !aio must resolve it to the REAL
// destination and route that destination through the normal chains — or, for
// a pure search page, refuse cleanly. Google's HTML must never be downloaded
// and never be sent to WhatsApp as a "video".
//
// Unit tests cover the resolver; integration tests drive the REAL dispatcher
// with the shared harness (network mocked at the boundary).
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveRedirectedUrl, isGoogleWrapper } = require('../commands/downloader-extended');
const { makeHarness } = require('../test-support/command-harness');

const textOf = (socket) => socket.sends.map((entry) => entry.payload?.text || entry.payload?.caption || '').join('\n');

test('Google /url wrappers resolve to their real destination', () => {
  assert.equal(
    resolveRedirectedUrl('https://www.google.com/url?sa=t&url=https%3A%2F%2Fvm.tiktok.com%2FZMexample%2F&usg=AOv'),
    'https://vm.tiktok.com/ZMexample/'
  );
  assert.equal(
    resolveRedirectedUrl('https://google.com/url?q=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ&sa=D'),
    'https://youtu.be/dQw4w9WgXcQ'
  );
  assert.equal(
    resolveRedirectedUrl('https://www.google.co.uk/imgres?imgurl=https%3A%2F%2Fcdn.example%2Fphoto.jpg'),
    'https://cdn.example/photo.jpg'
  );
});

test('pure Google search pages and non-Google URLs are not "resolved"', () => {
  assert.equal(resolveRedirectedUrl('https://www.google.com/search?q=funny+cat+video'), null);
  assert.equal(resolveRedirectedUrl('https://www.google.com/'), null);
  assert.equal(resolveRedirectedUrl('https://vm.tiktok.com/ZMexample/'), null, 'normal media URLs pass through untouched');
  assert.equal(resolveRedirectedUrl('not a url'), null);
  // Loop guard: a wrapper pointing back at Google itself is never followed.
  assert.equal(resolveRedirectedUrl('https://www.google.com/url?url=https%3A%2F%2Fwww.google.com%2Furl%3Furl%3Dhttps%253A%252F%252Fx.test'), null);
  // Only http(s) targets are ever produced.
  assert.equal(resolveRedirectedUrl('https://www.google.com/url?url=javascript%3Aalert(1)'), null);
});

test('isGoogleWrapper classifies Google hosts on every TLD', () => {
  assert.equal(isGoogleWrapper('https://www.google.com/url?url=x'), true);
  assert.equal(isGoogleWrapper('https://google.co.in/search?q=x'), true);
  assert.equal(isGoogleWrapper('https://www.google.com.pk/url?q=x'), true);
  assert.equal(isGoogleWrapper('https://notgoogle.com/url?url=x'), false);
  assert.equal(isGoogleWrapper('https://vm.tiktok.com/x'), false);
});

test('!aio resolves a Google redirect to the real TikTok source', async (t) => {
  const h = makeHarness(); t.after(() => h.close());
  const socket = h.socket();
  const wrapped = `https://www.google.com/url?sa=t&url=${encodeURIComponent('https://vm.tiktok.com/ZMexample/')}`;
  await h.handler(socket, socket.message(`!aio ${wrapped}`));
  const text = textOf(socket);
  assert.match(text, /Google redirect resolved/, 'the user is told the wrapper was resolved');
  assert.match(text, /AIO.*TikTok/, 'the resolved destination is routed to the TikTok chain');
  assert.ok(h.network.some((url) => /tikwm\.com|tiktok/i.test(url)), 'the TikTok providers were used for the REAL url');
  assert.ok(!h.network.some((url) => /google\.com/.test(url)), 'Google itself was never downloaded');
});

test('!aio refuses a pure Google search page cleanly and calls no provider', async (t) => {
  const h = makeHarness(); t.after(() => h.close());
  const socket = h.socket();
  await h.handler(socket, socket.message('!aio https://www.google.com/search?q=funny+cat+video'));
  const text = textOf(socket);
  assert.match(text, /Google search\/redirect link, not a media link/);
  assert.doesNotMatch(text, /DOWNLOAD COMPLETE/, 'no false success');
  assert.equal(h.network.length, 0, 'no provider is called for an unresolvable wrapper');
  const media = socket.sends.filter((entry) => entry.payload && Object.keys(entry.payload).some((key) => ['video', 'image', 'audio', 'document'].includes(key)));
  assert.equal(media.length, 0, 'no HTML is ever sent as media');
});

test('!aio never delivers an HTML error page as a video', async (t) => {
  const h = makeHarness(); t.after(() => h.close());
  const socket = h.socket();
  await h.handler(socket, socket.message('!aio https://some-unknown-video-site.example/watch/42'));
  const media = socket.sends.filter((entry) => entry.payload?.video);
  for (const entry of media) {
    const head = Buffer.from(entry.payload.video).subarray(0, 256).toString('latin1').trimStart().toLowerCase();
    assert.ok(!head.startsWith('<!doctype') && !head.startsWith('<html') && !head.startsWith('{'), 'a video payload is never an error page');
  }
});
