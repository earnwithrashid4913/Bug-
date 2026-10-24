'use strict';

// ---------------------------------------------------------------------------
// Regressions for the five issues reported from a real WhatsApp handset:
//
//   1. "!play <query>" only sent "Choose a format" — no result, thumbnail or
//      delivery, and the options existed only as button payloads.
//   2. Tapping/replying Audio did not complete the download.
//   3. "!video <query>" showed the audio format selector (HD/AUDIO/VOICE).
//   4. "!audio <query>" failed with "send a valid YouTube video link".
//   5. Selection/reply handling lost the request or repeated the selector.
//
// These drive the REAL dispatcher (system/handler.js) and the REAL
// youtube-flow; only the provider/network/socket boundaries are mocked. They do
// not prove handset rendering or WhatsApp delivery.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHarness } = require('../test-support/command-harness');
const { createFlow, createBudget } = require('../system/lib/youtube-flow');
const { MediaError } = require('../system/lib/youtube-engine');

const URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const textOf = (socket) => socket.sends.map((entry) => entry.payload?.text || entry.payload?.caption || '').join('\n');
const mediaOf = (socket, kind) => socket.sends.filter((entry) => entry.payload?.[kind]?.url);
const nativeCard = (socket) => socket.sends.find((entry) => entry.payload?.interactiveMessage)?.payload.interactiveMessage;
const nativeIds = (message) => {
  const flow = message.interactiveMessage?.nativeFlowMessage || message.nativeFlowMessage;
  return flow.buttons.flatMap((button) => {
    const data = JSON.parse(button.buttonParamsJson);
    return button.name === 'single_select'
      ? data.sections.flatMap((section) => section.rows.map((row) => ({ id: row.id, label: row.title })))
      : [{ id: data.id, label: data.display_text }];
  });
};

test('issue 1+2: !play <query> shows the real result and options, then Audio delivers exactly one file', async (t) => {
  const h = makeHarness(); t.after(() => h.close());
  const socket = h.socket();
  await h.handler(socket, socket.message('!play funks 2026 latest all in one'));

  const card = textOf(socket);
  assert.match(card, /Fixture/, 'the searched title is visible');
  assert.match(card, /AUDIO MP3/);
  assert.match(card, /VOICE TYPE/);
  assert.equal(mediaOf(socket, 'audio').length, 0, 'nothing is downloaded before the user chooses');

  // A handset without working buttons replies with the number.
  await h.handler(socket, socket.message('2'));
  assert.equal(mediaOf(socket, 'audio').length, 1, 'Audio delivered once');
  assert.equal((textOf(socket).match(/MEDIA SELECT/g) || []).length, 1, 'the selector is not repeated');
});

test('issue 2: a genuine native AUDIO MP3 tap downloads once and a second tap cannot duplicate it', async (t) => {
  const h = makeHarness(); t.after(() => h.close());
  const socket = h.socket({ interactive: true });
  await h.handler(socket, socket.message('!play funks 2026'));
  const ids = nativeIds(nativeCard(socket));
  const audio = ids.find((entry) => entry.label === 'AUDIO MP3');
  assert.ok(audio, 'the native card offers AUDIO MP3');

  const tap = () => {
    const response = socket.message('');
    response.message = { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: audio.id }) } } };
    return response;
  };
  await h.handler(socket, tap());
  await h.handler(socket, tap());
  assert.equal(mediaOf(socket, 'audio').length, 1);
});

test('issue 3: !video <query> offers resolutions, never the audio selector, and delivers the video', async (t) => {
  const h = makeHarness(); t.after(() => h.close());
  const socket = h.socket();
  await h.handler(socket, socket.message('!video funks 2026'));

  const card = textOf(socket);
  assert.match(card, /VIDEO QUALITY/);
  assert.match(card, /720p/, 'a real resolution is offered');
  assert.doesNotMatch(card, /AUDIO MP3|VOICE TYPE/);
  assert.equal(mediaOf(socket, 'audio').length, 0);

  await h.handler(socket, socket.message('1'));
  assert.equal(mediaOf(socket, 'video').length, 1);
});

test('issue 4: !audio accepts a search query as well as a URL', async (t) => {
  const h = makeHarness(); t.after(() => h.close());
  const query = h.socket();
  await h.handler(query, query.message('!audio funks 2026'));
  assert.doesNotMatch(textOf(query), /valid YouTube video link/i);
  assert.equal(mediaOf(query, 'audio').length, 1);

  const link = h.socket();
  await h.handler(link, link.message(`!audio ${URL}`));
  assert.equal(mediaOf(link, 'audio').length, 1);
});

test('issue 5: an outdated or ambiguous selection cannot restart the selector or start a second job', async () => {
  const sends = [], jobs = [];
  let clock = 1;
  const socket = { sendMessage: async (chat, payload) => { sends.push({ chat, ...payload }); return { key: { id: `m-${sends.length}` } }; } };
  const provider = {
    inspect: async (url) => ({ url, title: 'A song', uploader: 'Channel', duration: 60, thumbnail: '', audio: true, qualities: [{ height: 720 }] }),
    download: async (info, kind, height) => {
      jobs.push({ kind, height });
      return { file: '/tmp/media', fileName: 'song.mp3', mimetype: 'audio/mpeg', cleanup: async () => {} };
    }
  };
  const flow = createFlow(socket, {
    provider,
    search: async () => [{ url: URL }],
    thumbnail: async () => { throw new Error('offline'); },
    confirm: async () => true,
    now: () => clock,
    ttlMs: 60_000,
    withSlot: createBudget(2),
    log: () => {}
  });
  const ctx = (text, id = `in-${Math.random()}`) => ({ chatId: 'chat@g.us', sender: 'owner@s.whatsapp.net', text, raw: { key: { id }, message: { conversation: text } } });

  const started = await flow.start(ctx('!play a song'), { name: 'play', text: 'a song' });
  // HD VIDEO opens the quality list (revision 2); the old revision must answer,
  // not silently disappear and not select a quality.
  await flow.select(ctx(`${started.id} 1`));
  const staleTap = `yt:${started.id}:1:2`;
  await flow.select(ctx(staleTap));
  assert.match(sends.at(-1).text, /out of date/i);
  assert.deepEqual(jobs, []);

  // The current quality card still works exactly once.
  await flow.select(ctx(`${started.id} 1`));
  await flow.select(ctx(`${started.id} 1`));
  assert.deepEqual(jobs, [{ kind: 'video', height: 720 }]);
});

test('the real underlying failure reaches the chat instead of a generic aggregate', async () => {
  const { createRecoveredProvider } = require('../system/lib/youtube-recovered');
  const localDownloader = require('../system/lib/local-downloader');
  const provider = createRecoveredProvider({}, {
    onlyProvider: 'local',
    log: () => {},
    local: { ...localDownloader, downloadAudio: async () => { throw new Error("ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot."); } }
  });
  const info = await provider.inspect(URL);
  await assert.rejects(provider.download(info, 'audio'), (error) => {
    assert.equal(error.code, 'BOT_CHECK', 'the actionable cause is preserved, not masked as PROVIDERS');
    assert.match(error.message, /local-pre61: BOT_CHECK/);
    return true;
  });
});

test('issue 5: a failing selection offers a retry card without repeating the media menu', async () => {
  const sends = [], jobs = [];
  const socket = { sendMessage: async (chat, payload) => { sends.push({ chat, ...payload }); return { key: { id: `m-${sends.length}` } }; } };
  const provider = {
    inspect: async (url) => ({ url, title: 'A song', uploader: 'Channel', duration: 60, thumbnail: '', audio: true, qualities: [{ height: 720 }] }),
    download: async () => { jobs.push(1); throw new MediaError('PROVIDERS', 'All download providers failed (local-pre61: NETWORK).'); }
  };
  const flow = createFlow(socket, {
    provider,
    search: async () => [{ url: URL }],
    thumbnail: async () => { throw new Error('offline'); },
    confirm: async () => true,
    withSlot: createBudget(2),
    log: () => {}
  });
  const ctx = (text) => ({ chatId: 'chat@g.us', sender: 'owner@s.whatsapp.net', text, raw: { key: { id: `in-${sends.length}` }, message: { conversation: text } } });
  const started = await flow.start(ctx('!play a song'), { name: 'play', text: 'a song' });
  await flow.select(ctx(`${started.id} 2`));
  const text = sends.map((p) => p.text || p.caption || '').join('\n');
  assert.equal((text.match(/MEDIA SELECT/g) || []).length, 1, 'the format menu is not resent after a failure');
  assert.match(text, /Download failed/);
  assert.match(text, /Try again/);
  assert.doesNotMatch(text, /local-pre61|NETWORK|All download providers/);
  assert.equal(jobs.length, 1);
});
