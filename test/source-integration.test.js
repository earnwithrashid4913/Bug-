'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const source = require('../commands/source-commands');
const { storedMedia } = require('../commands/stored-media');
const { RuntimeSettingsStore } = require('../system/lib/runtime-settings');
const { COMMANDS, resolveCommand } = require('../system/lib/menu');
const handler = require('../system/handler');
const context = { chatId: '123@s.whatsapp.net', raw: { key: { id: 'source-test', remoteJid: '123@s.whatsapp.net' }, message: {} } };

test('mixed-case command lookup preserves URL and argument capitalization', () => {
  for (const name of ['menu', 'Menu', 'MENU', 'mEnU', 'ping', 'Ping', 'PING']) {
    const parsed = handler.commandFromText(`!${name} Some URL https://example.com/Case`);
    assert.equal(parsed.name, name.toLowerCase());
    assert.equal(parsed.text, 'Some URL https://example.com/Case');
    assert.ok(resolveCommand(parsed.name));
  }
});
test('menu aliases are unique and approved conflicting aliases resolve canonically', () => {
  const aliases = COMMANDS.flatMap(c => [c.name, ...c.aliases]);
  assert.equal(new Set(aliases).size, aliases.length);
  for (const name of ['ad', 'list', 'upload', 'menu', 'antidelete']) assert.equal(resolveCommand(name).name, name);
  assert.equal(resolveCommand('tourl').name, 'tourl');
});
test('ping measures awaited send and falls back to text without losing the measurement', async () => {
  const sent = [];
  const socket = { sendMessage: async (jid, payload) => {
    if (payload.react) await new Promise(r => setTimeout(r, 20));
    if (payload.image) throw new Error('image unavailable');
    sent.push(payload);
  } };
  await source.ping(socket, context);
  const text = sent.at(-1).text.normalize('NFKC');
  assert.match(text, /PONG/);
  assert.ok(Number(text.match(/Latence: (\d+)ms/)[1]) >= 15);
  assert.doesNotMatch(text, /Measuring/);
});
test('alive image failure produces completed uptime text', async () => {
  let text;
  await source.alive({ sendMessage: async (jid, payload) => {
    if (payload.image) throw new Error('offline image');
    text = payload.text.normalize('NFKC');
  } }, context);
  assert.match(text, /ANIME-MD/);
  assert.match(text, /\d+h \d+m \d+s/);
});
test('uploader without URL uses the existing quoted-media implementation', async () => {
  let called = false;
  await source.upload({}, context, { text: '', args: [] }, async (socket, actual) => { called = actual === context; });
  assert.equal(called, true);
});
test('stored media round-trip and exact deletion preserve unrelated runtime settings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-source-'));
  try {
    const settings = new RuntimeSettingsStore(path.join(dir, 'settings.json'));
    await settings.set('prefix', '?');
    const sent = [];
    const socket = { sendMessage: async (jid, payload) => sent.push(payload) };
    const ctx = { ...context, raw: { ...context.raw, message: { extendedTextMessage: { contextInfo: { quotedMessage: { audioMessage: { mimetype: 'audio/mpeg' } } } } } } };
    const run = (name, args) => storedMedia(socket, ctx, { name, args }, { settings, download: async () => Buffer.from('audio fixture') });
    await run('store', ['../Song']);
    await run('ad', ['../song']);
    assert.equal(sent.at(-1).audio.toString(), 'audio fixture');
    await run('list', []);
    assert.match(sent.at(-1).text, /audio: ..\/song/);
    await run('del', ['audio', '../song']);
    assert.deepEqual(await settings.get('sourceUserMedia'), []);
    assert.equal(await settings.get('prefix'), '?');
    assert.deepEqual(await fs.readdir(path.join(dir, 'user_media')), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('source downloader selects highest available video quality', async () => {
  const axios = require('axios');
  const originalFetch = global.fetch;
  const originalGet = axios.get;
  const sent = [];
  // Mock the transports the video chain actually uses, in its real order:
  // Cobalt over fetch refuses the link, so the DavidCyril provider pool (axios)
  // has to serve it and must pick the highest rendition it is offered.
  global.fetch = async () => new Response(JSON.stringify({ status: 'error', text: 'Download service refused this link.' }), { status: 400, headers: { 'content-type': 'application/json' } });
  axios.get = async () => ({ data: { status: true, title: 'Fixture', videos: { '360': 'https://example.com/360.mp4', '720': 'https://example.com/720.mp4' } } });
  try {
    await source.download({ sendMessage: async (jid, payload) => sent.push(payload) }, context, { name: 'ytmp4', text: 'https://youtu.be/example', args: ['https://youtu.be/example'] });
    assert.equal(sent.find(p => p.video).video.url, 'https://example.com/720.mp4');
  } finally { global.fetch = originalFetch; axios.get = originalGet; }
});
test('provider rendition maps resolve to the best media of the requested kind', () => {
  const dc = require('../commands/davidcyril-api');
  // A quality map is a real provider response shape, not a single URL field.
  assert.equal(dc.pickUrl({ status: true, videos: { '360': 'https://e.test/360.mp4', '1080': 'https://e.test/1080.mp4', '720': 'https://e.test/720.mp4' } }), 'https://e.test/1080.mp4');
  assert.equal(dc.pickUrl({ formats: [{ quality: '360p', type: 'video', url: 'https://e.test/360.mp4' }, { quality: '720p', type: 'video', url: 'https://e.test/720.mp4' }] }), 'https://e.test/720.mp4');
  assert.equal(dc.pickAudioUrl({ status: true, audios: { '128': 'https://e.test/128.mp3', '320': 'https://e.test/320.mp3' } }), 'https://e.test/320.mp3');
  // An explicit single URL still wins over rendition selection, and an audio
  // request is never satisfied with a video-only rendition map.
  assert.equal(dc.pickUrl({ url: 'https://e.test/direct.mp4', videos: { '720': 'https://e.test/720.mp4' } }), 'https://e.test/direct.mp4');
  assert.equal(dc.pickAudioUrl({ status: true, videos: { '720': 'https://e.test/720.mp4' } }), null);
  assert.equal(dc.pickUrl({ status: true, title: 'nothing to download' }), null);
});
