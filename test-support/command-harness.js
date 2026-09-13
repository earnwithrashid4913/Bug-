'use strict';
// Test-only CJS sandbox. Actual local modules/dispatcher run unchanged except
// entry tracing. Network, media codec and process-restart boundaries are mocked;
// all stores (including the legacy dirname-based otaku store) use a temp tree.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const nativeRequire = createRequire(path.join(root, 'system/handler.js'));
const bytes = Buffer.alloc(1200, 1);
function makeHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-command-audit-'));
  const cache = new Map(), timers = new Set(), scheduled = new Map(), calls = [], errors = [], network = [];
  const config = structuredClone(require('../config'));
  config.database.dataDir = path.join(directory, 'data');
  for (const key of Object.keys(config.database)) if (key.endsWith('DbPath')) config.database[key] = '';
  config.whatsapp.authDir = path.join(directory, 'session');
  config.api.groqApiKey = 'test-only-key';
  config.bot.publicMode = true;
  const timeout = (fn, ms, ...args) => { const timer = setTimeout(fn, ms, ...args); timers.add(timer); scheduled.set(timer, { fn, ms, args }); timer.unref?.(); return timer; };
  const interval = (fn, ms, ...args) => { const timer = setInterval(fn, ms, ...args); timers.add(timer); timer.unref?.(); return timer; };
  const fetch = async url => {
    network.push(String(url));
    let result;
    if (String(url).includes('api.groq.com')) result = { choices: [{ message: { content: 'Fixture AI response' } }] };
    else if (String(url).includes('/tempmail')) result = { result: ['fixture@example.test', 'session-id'] };
    else if (String(url).includes('yt-dl.')) result = { status: true, title: 'Fixture', audio: 'https://media.example/a.mp3', videos: { '720': 'https://media.example/v.mp4' } };
    else if (String(url).includes('uploader-')) result = { url: 'https://media.example/upload' };
    else result = { status: true, result: 'Fixture tool result', emails: [] };
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  };
  const axios = {
    get: async (url, options) => {
      network.push(String(url));
      if (options?.responseType === 'arraybuffer') return { data: bytes };
      if (String(url).includes('jikan.moe')) return { data: { data: [{ mal_id: 1, title: 'Fixture Anime', name: 'Fixture Character', score: 9, genres: [], images: {} }] } };
      if (String(url).includes('wttr.in')) return { data: { current_condition: [{ temp_C: '25', FeelsLikeC: '25', humidity: '50', windspeedKmph: '10', weatherDesc: [{ value: 'Clear' }] }], weather: [{ mintempC: '20', maxtempC: '30' }] } };
      if (String(url).includes('lyrics')) return { data: { result: { lyrics: 'Fixture lyrics' } } };
      if (String(url).includes('waifu.pics')) return { data: { url: 'https://media.example/image.jpg' } };
      if (/facebook|twitter|\/download\//.test(String(url))) return { data: { result: { url: 'https://media.example/video.mp4' } } };
      return { data: { result: 'Fixture question/fact', question: 'Fixture question' } };
    },
    post: async url => { network.push(String(url)); return { data: { code: 0, data: { play: 'https://media.example/video.mp4', title: 'Fixture', author: {} } } }; }
  };
  function load(filename) {
    if (filename === path.join(root, 'config.js')) return config;
    if (cache.has(filename)) return cache.get(filename).exports;
    if (filename === path.join(root, 'system/lib/runtime.js')) return { requestRestart: () => { calls.push('requestRestart'); return 'supervisor'; } };
    if (filename === path.join(root, 'system/lib/sticker.js')) {
      const real = nativeRequire(filename);
      return { ...real, ...Object.fromEntries(['createImageSticker', 'createVideoSticker', 'convertStickerToImage', 'takeSticker', 'convertToVideo'].map(name => [name, async () => { calls.push(name); return bytes; }])) };
    }
    const module = { exports: {} }; cache.set(filename, module);
    let source = fs.readFileSync(filename, 'utf8');
    source = source.replace(/async function (\w+)\(([^)]*)\) \{/g, (match, name) => `${match}\n__calls.push('${name}');`);
    const globals = { structuredClone, Buffer, URL, URLSearchParams, Response, AbortSignal, AbortController, process, fetch, setTimeout: timeout, clearTimeout, setInterval: interval, clearInterval, __calls: calls,
      console: { info() {}, log() {}, warn() {}, error: (...args) => errors.push(args.map(String).join(' ')) }
    };
    const localRequire = id => {
      if (id === 'axios') return axios;
      if (id === '@whiskeysockets/baileys') return { ...nativeRequire(id), downloadContentFromMessage: async function* () { yield bytes; } };
      if (!id.startsWith('.')) return nativeRequire(id);
      const resolved = require.resolve(path.resolve(path.dirname(filename), id));
      return load(resolved);
    };
    const virtualDir = filename === path.join(root, 'system/lib/otaku.js') ? path.join(directory, 'system/lib') : path.dirname(filename);
    vm.runInNewContext(`(function(require,module,exports,__dirname,__filename){${source}\n})`, globals, { filename })(localRequire, module, module.exports, virtualDir, filename);
    if (filename === path.join(root, 'system/lib/net-tools.js')) Object.assign(module.exports, {
      youtubeSearch: async () => [{ url: 'https://youtu.be/fixture', title: 'Fixture' }],
      spotifySearch: async () => [{ title: 'Fixture', artist: 'Artist', url: 'https://open.spotify.com/track/fixture' }],
      requestCobalt: async () => ({ url: 'https://media.example/file' }),
      downloadRemoteFile: async () => ({ buffer: bytes, type: 'video/mp4' }),
      translateText: async () => ({ translated: 'Fixture translation', source: 'fr' }), textToSpeech: async () => ({ buffer: bytes, mimetype: 'audio/mpeg' }),
      shortenUrl: async () => 'https://example.test/short', uploadToCatbox: async () => 'https://media.example/upload'
    });
    return module.exports;
  }
  const handler = load(path.join(root, 'system/handler.js'));
  let serial = 0;
  function socket({ interactive = false, owner = true } = {}) {
    const n = ++serial;
    const bot = `1555000${String(n).padStart(4, '0')}@s.whatsapp.net`, user = '15559999999@s.whatsapp.net', target = '15558888888@s.whatsapp.net';
    const group = `120363${String(n).padStart(8, '0')}@g.us`;
    const sends = [], actions = [];
    const sock = { user: { id: bot, name: 'Fixture Owner' }, sends, actions, group, target, owner, decodeJid: id => id,
      sendMessage: async (jid, payload) => { sends.push({ jid, payload }); return { key: { id: 'sent' } }; },
      groupMetadata: async () => ({ id: group, subject: 'Fixture Group', participants: [{ id: bot, admin: 'admin' }, { id: user, admin: owner ? 'admin' : null }, { id: target }] }),
      profilePictureUrl: async () => 'https://media.example/profile.jpg', newsletterMetadata: async () => ({ id: '1@newsletter', name: 'Fixture Channel', subscribers: 10 }),
      groupInviteCode: async () => 'FixtureInvite', groupParticipantsUpdate: async (...args) => { actions.push(args); },
      groupUpdateSubject: async (...args) => actions.push(args), groupUpdateDescription: async (...args) => actions.push(args), groupSettingUpdate: async (...args) => actions.push(args),
      updateProfilePicture: async (...args) => actions.push(args), updateProfileName: async (...args) => actions.push(args), sendPresenceUpdate: async () => {}
    };
    if (interactive) sock.relayMessage = async (jid, message) => { sends.push({ jid, payload: message }); };
    sock.message = (text, quoted, mention = false) => ({ key: { id: `audit-${++serial}`, remoteJid: group, participant: owner ? bot : user, fromMe: owner }, pushName: 'Fixture User', message: quoted || mention ? { extendedTextMessage: { text, contextInfo: { ...(quoted ? { quotedMessage: quoted, participant: target, stanzaId: 'quoted' } : {}), ...(mention ? { mentionedJid: [target] } : {}) } } } : { conversation: text } });
    return sock;
  }
  return { handler, socket, calls, errors, network, load, directory,
    async runTimer(ms) {
      const found = [...scheduled].find(([timer, task]) => task.ms === ms && !timer._destroyed);
      if (!found) throw new Error(`No active fixture timer for ${ms}ms`);
      const [timer, task] = found;
      clearTimeout(timer); scheduled.delete(timer);
      return task.fn(...task.args);
    }, async close() {
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    // Let existing fire-and-forget chat tracking complete before deleting stores.
    await new Promise(resolve => setTimeout(resolve, 30));
    await fsp.rm(directory, { recursive: true, force: true });
  } };
}
module.exports = { makeHarness };
