'use strict';

// ════════════════════════════════════════════════════════════════════════════
//  DavidCyril Tech — Universal Downloader API Client
//
//  Centralised fallback engine for all ANIME-MD downloader commands.
//  Every service exposes a function that tries Primary → Secondary → Tertiary
//  → … endpoints in order and returns the first usable result.
//
//  All external requests are bounded by a timeout. API failures are caught
//  and propagated cleanly — they never crash the bot process.
// ════════════════════════════════════════════════════════════════════════════

const axios = require('axios');

const DC_BASE = 'https://apis.davidcyril.name.ng';
const TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

// ── helpers ────────────────────────────────────────────────────────────────

function extractUrl(text) {
  if (!text) return '';
  const m = text.match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : '';
}

// ── rendition (quality map) selection ──────────────────────────────────────
//
// Several providers answer with a MAP or LIST of renditions instead of one
// URL, e.g. `{ status: true, title, videos: { '360': url, '720': url } }`.
// Those responses used to be read as "no media" and the command reported a
// download failure even though a usable URL was offered. Every provider parser
// below now understands them and always takes the HIGHEST available quality.

const VIDEO_QUALITY_GROUPS = ['videos', 'video', 'mp4', 'renditions', 'formats', 'qualities', 'links', 'urls'];
const AUDIO_QUALITY_GROUPS = ['audios', 'audio', 'mp3', 'music', 'renditions', 'formats', 'qualities'];

function entryUrl(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return null;
  return entry.url || entry.link || entry.download_url || entry.downloadUrl || entry.direct_url || entry.src || entry.videoUrl || entry.audioUrl || null;
}

function entryKind(entry) {
  if (!entry || typeof entry === 'string') return '';
  return String(entry.type || entry.kind || entry.mimetype || entry.category || '').toLowerCase();
}

// 360 / 720p / 1080 / 4K-style labels rank by their vertical resolution.
function videoQualityRank(label) {
  const text = String(label ?? '').toLowerCase();
  if (/\d+\s*(kbps|kb\b)/.test(text)) return -1; // a bitrate label is not a video rendition
  const match = /(\d{3,5})/.exec(text);
  return match ? Number(match[1]) : -1;
}

// 128 / 320kbps / 64k-style labels rank by their bitrate.
function audioQualityRank(label) {
  const text = String(label ?? '').toLowerCase();
  const bitrate = /(\d{2,4})\s*(kbps|kb\b|k\b)/.exec(text);
  if (bitrate) return Number(bitrate[1]);
  const plain = /^(\d{2,3})p?$/.exec(text.trim());
  return plain ? Number(plain[1]) : -1;
}

function pickHighestQuality(source, { groups, kind, rank }) {
  if (!source || typeof source !== 'object') return null;
  let best = null;
  const consider = (value, label) => {
    const url = entryUrl(value);
    if (!isUrlLike(url)) return;
    if (kind) {
      const entryKindValue = entryKind(value);
      // Respect an explicit rendition type when the provider supplies one.
      if (entryKindValue && !entryKindValue.includes(kind)) return;
    }
    const score = rank(label ?? (value && typeof value === 'object' ? (value.quality ?? value.resolution ?? value.label ?? value.size ?? value.format ?? value.name) : ''));
    if (!best || score > best.score) best = { score, url };
  };
  for (const group of groups) {
    const entries = source[group];
    if (!entries || typeof entries !== 'object') continue;
    if (Array.isArray(entries)) {
      for (const entry of entries) consider(entry, entry && typeof entry === 'object' ? (entry.quality ?? entry.resolution ?? entry.label ?? entry.size ?? entry.format ?? entry.name) : '');
      continue;
    }
    for (const [label, entry] of Object.entries(entries)) consider(entry, label);
  }
  return best ? best.url : null;
}

function isUrlLike(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

// `skipVideoRenditions` keeps the audio parser away from video-only rendition
// maps: an audio command must never be handed a video file.
function pickUrl(data, { skipVideoRenditions = false } = {}) {
  if (!data) return null;
  const obj = data.result || data.data || data;
  if (typeof obj === 'string' && obj.startsWith('http')) return obj;
  const fields = [
    'download_url', 'downloadUrl', 'videoUrl', 'video_url', 'url',
    'hdUrl', 'mp4', 'media', 'link', 'playUrl', 'audio', 'audioUrl',
    'mp3', 'download', 'dl_url', 'direct_url', 'src', 'video'
  ];
  for (const f of fields) {
    if (obj[f] && typeof obj[f] === 'string' && /^https?:\/\//i.test(obj[f])) return obj[f];
    if (Array.isArray(obj[f]) && obj[f][0]?.url) return obj[f][0].url;
  }
  if (Array.isArray(obj.medias)) {
    const v = obj.medias.find(x => x.type === 'video');
    if (v?.url) return v.url;
    if (obj.medias[0]?.url) return obj.medias[0].url;
  }
  // Rendition maps/lists: take the highest video quality on offer.
  if (!skipVideoRenditions) {
    const rendition = pickHighestQuality(obj, { groups: VIDEO_QUALITY_GROUPS, kind: 'video', rank: videoQualityRank });
    if (rendition) return rendition;
  }
  // Deep scan for nested download URLs
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const f of fields) {
        if (val[f] && typeof val[f] === 'string' && /^https?:\/\//i.test(val[f])) return val[f];
      }
      if (!skipVideoRenditions) {
        const nested = pickHighestQuality(val, { groups: VIDEO_QUALITY_GROUPS, kind: 'video', rank: videoQualityRank });
        if (nested) return nested;
      }
    }
  }
  return null;
}

function pickAudioUrl(data) {
  if (!data) return null;
  const obj = data.result || data.data || data;
  const audioFields = ['audio', 'audioUrl', 'music', 'mp3', 'download_url', 'downloadUrl', 'url', 'link', 'dl_url'];
  for (const f of audioFields) {
    if (obj[f] && typeof obj[f] === 'string' && /^https?:\/\//i.test(obj[f])) return obj[f];
  }
  if (Array.isArray(obj.medias)) {
    const a = obj.medias.find(x => x.type === 'audio');
    if (a?.url) return a.url;
  }
  // Audio rendition maps/lists: take the highest bitrate on offer. A video-only
  // rendition map must NOT be handed to an audio command, so this stays scoped
  // to the audio groups and never reaches pickUrl()'s video selection.
  const rendition = pickHighestQuality(obj, { groups: AUDIO_QUALITY_GROUPS, kind: 'audio', rank: audioQualityRank });
  if (rendition) return rendition;
  return pickUrl(data, { skipVideoRenditions: true });
}

function pickTitle(data) {
  const obj = data?.result || data?.data || data || {};
  return obj.title || obj.caption || obj.description || obj.desc || obj.name || obj.filename || '';
}

function pickThumb(data) {
  const obj = data?.result || data?.data || data || {};
  return obj.thumbnail || obj.thumb || obj.cover || obj.image || obj.poster || null;
}

function isUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s);
}

function isValidResult(data) {
  if (!data) return false;
  if (data.success === false) {
    // Allow through if there's a usable media URL despite success=false
    if (pickUrl(data) || pickAudioUrl(data)) return true;
    // Allow through if there are search results
    if (Array.isArray(data.results) && data.results.length > 0) return true;
    return false;
  }
  return true;
}

// ── core fetch ─────────────────────────────────────────────────────────────

async function dcFetch(endpoint, { timeout = TIMEOUT_MS, params, method } = {}) {
  const url = endpoint.startsWith('http') ? endpoint : DC_BASE + endpoint;
  const config = { timeout, headers: { 'User-Agent': 'Mozilla/5.0 ANIME-MD' } };
  if (method === 'POST') {
    const res = await axios.post(url, params || {}, config);
    return res.data;
  }
  const res = await axios.get(url, { ...config, params });
  return res.data;
}

// ── universal fallback engine ──────────────────────────────────────────────

async function dcFallback(endpoints, { timeout, extractResult } = {}) {
  let lastError;
  for (const ep of endpoints) {
    try {
      const data = await dcFetch(ep.path || ep, { timeout: timeout || ep.timeout });
      if (!isValidResult(data)) continue;
      const result = extractResult ? extractResult(data) : { url: pickUrl(data), audioUrl: pickAudioUrl(data), title: pickTitle(data), thumb: pickThumb(data), data };
      const hasMedia = result?.url || result?.audioUrl;
      if (hasMedia) return result;
    } catch (err) {
      lastError = err;
      console.warn(`[DC-API] ${ep.path || ep} failed: ${err?.message || err}`);
    }
  }
  throw lastError || new Error('All download sources failed.');
}

// ── download media buffer ──────────────────────────────────────────────────

async function dlBuffer(url, timeout = DOWNLOAD_TIMEOUT_MS) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer', timeout,
    maxContentLength: 200 * 1024 * 1024, maxBodyLength: 200 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0' },
  });
  return Buffer.from(res.data);
}

// ════════════════════════════════════════════════════════════════════════════
//  SERVICE-SPECIFIC FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

// ── YouTube MP3 ────────────────────────────────────────────────────────────

async function ytMp3(url) {
  const enc = encodeURIComponent(url);
  return dcFallback([
    `/download/ytmp3?url=${enc}`,
    `/download/ytmp3v2?url=${enc}`,
    `/youtube/mp33?url=${enc}`,
    `/youtube/mp3?url=${enc}`,
    `/download/ytmp33?url=${enc}`,
    `/download/ytmp333?url=${enc}`,
    `/download/ytmp3-v2?url=${enc}`,
  ], { extractResult: (data) => ({ url: pickUrl(data) || pickAudioUrl(data), audioUrl: pickAudioUrl(data), title: pickTitle(data), thumb: pickThumb(data), data }) });
}

// ── YouTube MP4 ────────────────────────────────────────────────────────────

async function ytMp4(url) {
  const enc = encodeURIComponent(url);
  return dcFallback([
    `/download/ytmp4?url=${enc}`,
    `/youtube/mp444?url=${enc}`,
    `/youtube/mp4?url=${enc}`,
    `/download/ytmp444?url=${enc}`,
  ], { extractResult: (data) => ({ url: pickUrl(data), title: pickTitle(data), thumb: pickThumb(data), data }) });
}

// ── YouTube Generic ────────────────────────────────────────────────────────

async function ytGeneric(url) {
  const enc = encodeURIComponent(url);
  return dcFallback([
    `/download/yt?url=${enc}`,
    `/download/ytv3?url=${enc}`,
  ]);
}

// ── YTDL Rapid ─────────────────────────────────────────────────────────────

async function ytdlRapid(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/ytdl-rapid?url=${enc}`);
}

// ── Y2Mate ─────────────────────────────────────────────────────────────────

async function y2mateGeneric(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/y2mate?url=${enc}`);
}

async function y2mateMp3(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/y2mate/mp3?url=${enc}`);
}

async function y2mateMp4(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/y2mate/mp4?url=${enc}`);
}

// ── Play Music ─────────────────────────────────────────────────────────────

async function playMusic(query) {
  const enc = encodeURIComponent(query);
  return dcFallback([
    `/play?q=${enc}`,
    `/play-v2?q=${enc}`,
  ], { extractResult: (data) => ({ url: pickUrl(data) || pickAudioUrl(data), audioUrl: pickAudioUrl(data), title: pickTitle(data), thumb: pickThumb(data), data }) });
}

// ── Song Download ──────────────────────────────────────────────────────────

async function songDownload(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/song?q=${enc}`);
}

// ── Spotify ────────────────────────────────────────────────────────────────

async function spotifyDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFallback([
    `/download/spodownloader?url=${enc}`,
    `/download/spotdown?url=${enc}`,
    `/download/spotidown?url=${enc}`,
    `/download/spotidownloader?url=${enc}`,
    `/spotifydl?url=${enc}`,
    `/spotifydl2?url=${enc}`,
    `/download/spotmate?url=${enc}`,
    `/download/spotify?url=${enc}`,
  ], { extractResult: (data) => ({ url: pickUrl(data) || pickAudioUrl(data), audioUrl: pickAudioUrl(data), title: pickTitle(data), thumb: pickThumb(data), data }) });
}

// ── TikTok ─────────────────────────────────────────────────────────────────

async function tiktokDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFallback([
    `/download/tiktok?url=${enc}`,
    `/download/tiktokv2?url=${enc}`,
    `/download/tiktokv3?url=${enc}`,
    `/download/tiktokv4?url=${enc}`,
    `/download/tiktokdl-rapid?url=${enc}`,
  ]);
}

// ── Facebook ───────────────────────────────────────────────────────────────

async function facebookDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFallback([
    `/facebook?url=${enc}`,
    `/facebook2?url=${enc}`,
    `/facebook3?url=${enc}`,
  ]);
}

// ── Twitter / X ────────────────────────────────────────────────────────────

async function twitterDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFallback([
    `/download/tweeload?url=${enc}`,
    `/download/tweeterdownloader?url=${enc}`,
    `/twitter?url=${enc}`,
    `/twitterV2?url=${enc}`,
    `/download/xdownloader?url=${enc}`,
  ]);
}

// ── Instagram ──────────────────────────────────────────────────────────────

async function instagramDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/instagram?url=${enc}`);
}

// ── Pinterest ──────────────────────────────────────────────────────────────

async function pinterestDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/pinterest?url=${enc}`);
}

// ── Mediafire ──────────────────────────────────────────────────────────────

async function mediafireDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/mediafire?url=${enc}`);
}

// ── Google Drive ───────────────────────────────────────────────────────────

async function gdriveDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/gdrive?url=${enc}`);
}

// ── HD Video ───────────────────────────────────────────────────────────────

async function hdVideoDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/hdvideo?url=${enc}`);
}

// ── SoundCloud ─────────────────────────────────────────────────────────────

async function soundcloudDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFallback([
    `/download/soundcloud?url=${enc}`,
    `/soundcloud?url=${enc}`,
  ]);
}

async function soundcloudSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/search/soundcloud?q=${enc}`);
}

// ── Terabox ────────────────────────────────────────────────────────────────

async function teraboxDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/terabox?url=${enc}`);
}

// ── AIO Downloader ─────────────────────────────────────────────────────────

async function aioDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFallback([
    `/download/aio?url=${enc}`,
    `/download/aiov2?url=${enc}`,
    `/download/aiov3?url=${enc}`,
  ]);
}

// ── Vibetik ────────────────────────────────────────────────────────────────

async function vibetikDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/vibetik?url=${enc}`);
}

// ── Savetik ────────────────────────────────────────────────────────────────

async function savetikDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/savetik?url=${enc}`);
}

// ── Savetube ───────────────────────────────────────────────────────────────

async function savetubeDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/savetube?url=${enc}`);
}

// ── SnapTwitt ──────────────────────────────────────────────────────────────

async function snaptwittDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/snaptwitt?url=${enc}`);
}

// ── InThisTweet ────────────────────────────────────────────────────────────

async function inthistweetDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/inthistweet?url=${enc}`);
}

// ── Seekin ─────────────────────────────────────────────────────────────────

async function seekinDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/seekin?url=${enc}`);
}

// ── YTScribeTo ─────────────────────────────────────────────────────────────

async function ytscribetoDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/ytscribeto?url=${enc}`);
}

// ── SnapSaver ──────────────────────────────────────────────────────────────

async function snapsaverDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/download/snapsaver?url=${enc}`);
}

// ── Website Downloader ─────────────────────────────────────────────────────

async function websiteDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/tools/downloadweb?url=${enc}`);
}

// ── Dafont ─────────────────────────────────────────────────────────────────

async function dafontDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/dafont?url=${enc}`);
}

// ════════════════════════════════════════════════════════════════════════════
//  MOVIE / SERIES / STREAMING APIs
// ════════════════════════════════════════════════════════════════════════════

// ── Generic movie helpers ──────────────────────────────────────────────────

function pickLinks(data) {
  const obj = data?.result || data?.data || data || {};
  const links = obj.links || obj.downloadLinks || obj.download_links || obj.sources || obj.streams || obj.episodes || [];
  if (Array.isArray(links)) return links;
  return [];
}

function pickItems(data) {
  const obj = data?.result || data?.data || data || {};
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.results)) return obj.results;
  if (Array.isArray(obj.movies)) return obj.movies;
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

// ── Watch Movie (stream + download) ────────────────────────────────────────

async function movieWatch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/watch?q=${enc}`);
}

// ── NaijaPrey ──────────────────────────────────────────────────────────────

async function naijapreySearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/naijaprey/search?q=${enc}`);
}
async function naijapreyLatest() {
  return dcFetch('/naijaprey/latest');
}
async function naijapreyInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/naijaprey/info?url=${enc}`);
}

// ── Net9ja ─────────────────────────────────────────────────────────────────

async function net9jaSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/net9ja/search?q=${enc}`);
}
async function net9jaLatest() {
  return dcFetch('/movies/net9ja/latest');
}
async function net9jaInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/net9ja/info?url=${enc}`);
}

// ── Nkiri ──────────────────────────────────────────────────────────────────

async function nkiriSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/search?q=${enc}`);
}
async function nkiriLatest() {
  return dcFetch('/movies/latest');
}
async function nkiriInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/info?url=${enc}`);
}
async function nkiriDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/nkiri/download?url=${enc}`);
}

// ── Stream-X ───────────────────────────────────────────────────────────────

async function streamxSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/stream-x/search?q=${enc}`);
}
async function streamxLatest() {
  return dcFetch('/movies/stream-x/latest');
}
async function streamxInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/stream-x/info?url=${enc}`);
}

// ── CineSubz ───────────────────────────────────────────────────────────────

async function cinesubzSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/cinesubz/search?q=${enc}`);
}
async function cinesubzLatest() {
  return dcFetch('/cinesubz/latest');
}
async function cinesubzInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/cinesubz/info?url=${enc}`);
}
async function cinesubzDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/cinesubz/download?url=${enc}`);
}

// ── GokuHD ─────────────────────────────────────────────────────────────────

async function gokuSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/gokuhd/search?q=${enc}`);
}
async function gokuLatest() {
  return dcFetch('/gokuhd/latest');
}
async function gokuInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/gokuhd/info?url=${enc}`);
}
async function gokuDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/gokuhd/download?url=${enc}`);
}

// ── RogMovies ──────────────────────────────────────────────────────────────

async function rogSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/rogmovies/search?q=${enc}`);
}
async function rogLatest() {
  return dcFetch('/rogmovies/latest');
}
async function rogInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/rogmovies/info?url=${enc}`);
}
async function rogDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/rogmovies/download?url=${enc}`);
}

// ── XPrimeHub ──────────────────────────────────────────────────────────────

async function xprimeSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/xprimehub/search?q=${enc}`);
}
async function xprimeLatest() {
  return dcFetch('/xprimehub/latest');
}
async function xprimeInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/xprimehub/info?url=${enc}`);
}
async function xprimeDownload(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/xprimehub/download?url=${enc}`);
}

// ── O2TVSeries ─────────────────────────────────────────────────────────────

async function o2tvSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/o2tvseries/search?q=${enc}`);
}
async function o2tvLatest() {
  return dcFetch('/movies/o2tvseries/latest');
}
async function o2tvInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/o2tvseries/info?url=${enc}`);
}
async function o2tvSeason(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/o2tvseries/season?url=${enc}`);
}
async function o2tvEpisode(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/o2tvseries/episode?url=${enc}`);
}

// ── MovieBaaz ──────────────────────────────────────────────────────────────

async function moviebaazSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/moviebaaz/search?q=${enc}`);
}
async function moviebaazLatest() {
  return dcFetch('/movies/moviebaaz/latest');
}
async function moviebaazInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/moviebaaz/info?url=${enc}`);
}

// ── SeriezLoaded ───────────────────────────────────────────────────────────

async function seriezSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/seriezloaded/search?q=${enc}`);
}
async function seriezLatest() {
  return dcFetch('/movies/seriezloaded/latest');
}
async function seriezInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/seriezloaded/info?url=${enc}`);
}

// ── TvShows4Mobile ─────────────────────────────────────────────────────────

async function tvshows4mSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/tvshows4mobile/search?q=${enc}`);
}
async function tvshows4mLatest() {
  return dcFetch('/movies/tvshows4mobile/latest');
}
async function tvshows4mInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/tvshows4mobile/info?url=${enc}`);
}
async function tvshows4mSeason(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/tvshows4mobile/season?url=${enc}`);
}
async function tvshows4mEpisode(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/tvshows4mobile/episode?url=${enc}`);
}

// ── MoviesFoundOnline ──────────────────────────────────────────────────────

async function mfoSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/moviesfoundonline/search?q=${enc}`);
}
async function mfoLatest() {
  return dcFetch('/movies/moviesfoundonline/latest');
}
async function mfoInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/moviesfoundonline/info?url=${enc}`);
}

// ── TamilMV ────────────────────────────────────────────────────────────────

async function tamilmvSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/tamilmv/search?q=${enc}`);
}
async function tamilmvLatest() {
  return dcFetch('/movies/tamilmv/latest');
}
async function tamilmvInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/tamilmv/info?url=${enc}`);
}
async function tamilmvForums() {
  return dcFetch('/movies/tamilmv/forums');
}

// ── YTS ────────────────────────────────────────────────────────────────────

async function ytsSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/yts/search?q=${enc}`);
}
async function ytsLatest() {
  return dcFetch('/movies/yts/latest');
}
async function ytsDetails(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/yts/details?url=${enc}`);
}

// ── EZTV ───────────────────────────────────────────────────────────────────

async function eztvSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/eztv/search?q=${enc}`);
}

// ── ApiBay / TPB ───────────────────────────────────────────────────────────

async function apibaySearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/apibay/search?q=${enc}`);
}

// ── Soap2Day ───────────────────────────────────────────────────────────────

async function soap2daySearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/soap2day/search?q=${enc}`);
}
async function soap2dayLatest() {
  return dcFetch('/movies/soap2day/latest');
}
async function soap2dayInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/soap2day/info?url=${enc}`);
}
async function soap2dayWatch(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/movies/soap2day/watch?url=${enc}`);
}

// ── VegaMovies ─────────────────────────────────────────────────────────────

async function vegaSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/vegamovies/search?q=${enc}`);
}
async function vegaLatest() {
  return dcFetch('/movies/vegamovies/latest');
}

// ── HDHub4u ────────────────────────────────────────────────────────────────

async function hdhub4uSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/hdhub4u/search?q=${enc}`);
}
async function hdhub4uLatest() {
  return dcFetch('/movies/hdhub4u/latest');
}

// ── TvMaze ─────────────────────────────────────────────────────────────────

async function tvmazeSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/movies/tvmaze/search?q=${enc}`);
}
async function tvmazeShow(id) {
  return dcFetch(`/movies/tvmaze/show?id=${id}`);
}
async function tvmazeEpisodes(id) {
  return dcFetch(`/movies/tvmaze/episodes?id=${id}`);
}

// ── VidSrc ─────────────────────────────────────────────────────────────────

async function vidsrcUrl(imdbId) {
  return dcFetch(`/movies/vidsrc?imdb=${encodeURIComponent(imdbId)}`);
}

// ── Subttsearch ────────────────────────────────────────────────────────────

async function subSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/subttsearch/search?q=${enc}`);
}
async function subInfo(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/subttsearch/info?url=${enc}`);
}

// ── Zoom ───────────────────────────────────────────────────────────────────

async function zoomSearch(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/zoom/search?q=${enc}`);
}
async function zoomMovie(url) {
  const enc = encodeURIComponent(url);
  return dcFetch(`/zoom/movie?url=${enc}`);
}

// ── Spotify V2 Search ──────────────────────────────────────────────────────

async function spotifyV2Search(query) {
  const enc = encodeURIComponent(query);
  return dcFetch(`/spotify-v2?query=${enc}`);
}

// ════════════════════════════════════════════════════════════════════════════
//  IMAGE GENERATION / IMAGE EFFECT APIs
//
//  Same universal client as the downloaders and the movie/series providers:
//  one function per endpoint, bounded timeout, clean failures. The endpoint
//  paths below are the canonical inventory entries and are never renamed.
//
//  Request/response contracts verified against the live API:
//    GET /animagine?prompt=…           → { success, prompt, ratio, cdn_url, expires }
//    GET /epicrealism?prompt=…         → { success, result: "<image url>" }
//    GET /fluxv2?prompt=…              → { success, result: "<image url>" }
//    GET /flixier?prompt=…             → { success, result: { status, prompt, style,
//                                                          url, thumb, resolution } }
//    GET /ai/writecream/image?prompt=… → { success, prompt, ratio, image_url }
//    GET /nanobanana2?url=…&prompt=…   → image-to-image edit of a public image URL
//    GET /pixwith?url=…&prompt=…       → image-to-image edit of a public image URL
//    GET /api/ephoto/:effect?text=…    → dynamic effect segment; the API itself
//                                        answers "Invalid effect name." for an
//                                        effect it does not know.
// ════════════════════════════════════════════════════════════════════════════

// Image models are slower than a download, so they get a longer bounded timeout.
const IMAGE_TIMEOUT_MS = 90_000;

// Canonical inventory entries, kept verbatim (grep-able) — `:effect` is a
// dynamic path segment that is substituted per request, never hardcoded.
const IMAGE_ENDPOINTS = Object.freeze({
  animagine: '/animagine',
  ephoto: '/api/ephoto/:effect',
  epicrealism: '/epicrealism',
  flixier: '/flixier',
  nanobanana2: '/nanobanana2',
  pixwith: '/pixwith',
  writecream: '/ai/writecream/image',
  fluxv2: '/fluxv2'
});

// Field priority while hunting an image reference inside an unknown shape.
const IMAGE_URL_FIELDS = ['cdn_url', 'image_url', 'imageUrl', 'image', 'result', 'url', 'output', 'link', 'src', 'file', 'photo', 'thumb', 'thumbnail', 'preview'];
const IMAGE_DATA_URI = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i;
// Ephoto effect slugs are a path segment: letters/digits and a few separators
// only, so no slash, dot or query character can ever reach the request path.
const EFFECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_+-]{0,39}$/i;

function isImagePayload(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return /^https?:\/\/\S+$/i.test(text) || IMAGE_DATA_URI.test(text);
}

/**
 * Finds an image reference (https URL or base64 data URI) in any provider
 * response shape: a plain string, a nested object or an array. Depth and width
 * are bounded so a hostile/deep payload can never spin.
 *
 * `exclude` drops references the caller already knows are inputs, so an
 * image-to-image provider can never echo the source image back as its result.
 */
function pickImageUrl(data, { exclude = [] } = {}) {
  const blocked = new Set([...exclude].filter(Boolean).map(String));
  function scan(node, depth) {
    if (!node || depth > 3) return null;
    if (typeof node === 'string') {
      const text = node.trim();
      return isImagePayload(text) && !blocked.has(text) ? text : null;
    }
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 10)) {
        const found = scan(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof node !== 'object') return null;
    for (const field of IMAGE_URL_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(node, field)) continue;
      const found = scan(node[field], depth + 1);
      if (found) return found;
    }
    return null;
  }
  return scan(data, 0);
}

// Only the metadata a provider actually returned — nothing is invented.
function pickImageMeta(data) {
  const inner = data?.result && typeof data.result === 'object' ? data.result : data || {};
  const meta = {};
  if (typeof inner.prompt === 'string' && inner.prompt.trim()) meta.prompt = inner.prompt.trim();
  if (typeof inner.ratio === 'string' && inner.ratio.trim()) meta.ratio = inner.ratio.trim();
  if (typeof inner.style === 'string' && inner.style.trim()) meta.style = inner.style.trim();
  if (typeof inner.status === 'string' && inner.status.trim()) meta.status = inner.status.trim();
  if (inner.resolution && typeof inner.resolution === 'object') {
    const width = Number(inner.resolution.width);
    const height = Number(inner.resolution.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      meta.resolution = { width, height };
    }
  }
  if (typeof inner.thumb === 'string' && /^https?:\/\//i.test(inner.thumb)) meta.thumb = inner.thumb;
  if (inner.expires !== undefined && inner.expires !== null) meta.expires = inner.expires;
  if (typeof data?.creator === 'string' && data.creator.trim()) meta.creator = data.creator.trim();
  return meta;
}

// The API's own explanation, when it gave one (used for logs and for the
// effect-name classification, never dumped raw into a chat message).
function pickApiMessage(data) {
  const value = data?.message || data?.error || data?.result?.message || data?.detail;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : '';
}

// ── Text → Image ───────────────────────────────────────────────────────────

async function animagineImage(prompt) {
  return dcFetch(IMAGE_ENDPOINTS.animagine, { params: { prompt }, timeout: IMAGE_TIMEOUT_MS });
}

async function epicrealismImage(prompt) {
  return dcFetch(IMAGE_ENDPOINTS.epicrealism, { params: { prompt }, timeout: IMAGE_TIMEOUT_MS });
}

async function fluxV2Image(prompt) {
  return dcFetch(IMAGE_ENDPOINTS.fluxv2, { params: { prompt }, timeout: IMAGE_TIMEOUT_MS });
}

async function flixierImage(prompt) {
  return dcFetch(IMAGE_ENDPOINTS.flixier, { params: { prompt }, timeout: IMAGE_TIMEOUT_MS });
}

async function writecreamImage(prompt) {
  return dcFetch(IMAGE_ENDPOINTS.writecream, { params: { prompt }, timeout: IMAGE_TIMEOUT_MS });
}

// ── Image → Image (edit / restyle) ─────────────────────────────────────────

async function nanobanana2Edit(imageUrl, prompt) {
  return dcFetch(IMAGE_ENDPOINTS.nanobanana2, { params: { url: imageUrl, prompt }, timeout: IMAGE_TIMEOUT_MS });
}

async function pixwithEdit(imageUrl, prompt) {
  return dcFetch(IMAGE_ENDPOINTS.pixwith, { params: { url: imageUrl, prompt }, timeout: IMAGE_TIMEOUT_MS });
}

// ── Ephoto dynamic text effect (/api/ephoto/:effect) ───────────────────────

async function ephotoEffect(effect, text) {
  const safe = String(effect || '').trim();
  if (!EFFECT_NAME_PATTERN.test(safe)) throw new Error('Unsupported effect name.');
  const path = IMAGE_ENDPOINTS.ephoto.replace(':effect', encodeURIComponent(safe.toLowerCase()));
  return dcFetch(path, { params: { text }, timeout: IMAGE_TIMEOUT_MS });
}

// ════════════════════════════════════════════════════════════════════════════
//  COMBINED FALLBACK CHAINS (Cross-service)
// ════════════════════════════════════════════════════════════════════════════

// Download audio from a YouTube URL using the complete MP3 fallback pool.
// Returns { ok, url, title, error }.
async function downloadYtAudio(youtubeUrl) {
  try {
    const result = await ytMp3(youtubeUrl);
    const mediaUrl = result.url || result.audioUrl;
    if (!mediaUrl) throw new Error('No audio URL in response');
    return { ok: true, url: mediaUrl, title: result.title || '', thumb: result.thumb };
  } catch (err1) {
    console.warn('[DC-API] ytMp3 pool failed, trying playMusic:', err1?.message || err1);
  }
  try {
    const result = await playMusic(youtubeUrl);
    const mediaUrl = result.url || result.audioUrl;
    if (!mediaUrl) throw new Error('No audio URL');
    return { ok: true, url: mediaUrl, title: result.title || '', thumb: result.thumb };
  } catch (err2) {
    console.warn('[DC-API] playMusic failed, trying y2mateMp3:', err2?.message || err2);
  }
  try {
    const data = await y2mateMp3(youtubeUrl);
    const mediaUrl = pickUrl(data) || pickAudioUrl(data);
    if (!mediaUrl) throw new Error('No audio URL');
    return { ok: true, url: mediaUrl, title: pickTitle(data), thumb: pickThumb(data) };
  } catch (err3) {
    console.warn('[DC-API] y2mateMp3 failed, trying ytdlRapid:', err3?.message || err3);
  }
  try {
    const data = await ytdlRapid(youtubeUrl);
    const mediaUrl = pickAudioUrl(data) || pickUrl(data);
    if (!mediaUrl) throw new Error('No audio URL');
    return { ok: true, url: mediaUrl, title: pickTitle(data), thumb: pickThumb(data) };
  } catch (err4) {
    console.warn('[DC-API] ytdlRapid failed, trying ytGeneric:', err4?.message || err4);
  }
  try {
    const result = await ytGeneric(youtubeUrl);
    const mediaUrl = result.url || result.audioUrl;
    if (!mediaUrl) throw new Error('No audio URL');
    return { ok: true, url: mediaUrl, title: result.title || '', thumb: result.thumb };
  } catch (err5) {
    return { ok: false, error: err5 };
  }
}

// Download video from a YouTube URL using the complete MP4 fallback pool.
// Returns { ok, url, title, error }.
async function downloadYtVideo(youtubeUrl) {
  try {
    const result = await ytMp4(youtubeUrl);
    const mediaUrl = result.url;
    if (!mediaUrl) throw new Error('No video URL in response');
    return { ok: true, url: mediaUrl, title: result.title || '', thumb: result.thumb };
  } catch (err1) {
    console.warn('[DC-API] ytMp4 pool failed, trying y2mateMp4:', err1?.message || err1);
  }
  try {
    const data = await y2mateMp4(youtubeUrl);
    const mediaUrl = pickUrl(data);
    if (!mediaUrl) throw new Error('No video URL');
    return { ok: true, url: mediaUrl, title: pickTitle(data), thumb: pickThumb(data) };
  } catch (err2) {
    console.warn('[DC-API] y2mateMp4 failed, trying ytdlRapid:', err2?.message || err2);
  }
  try {
    const data = await ytdlRapid(youtubeUrl);
    const mediaUrl = pickUrl(data);
    if (!mediaUrl) throw new Error('No video URL');
    return { ok: true, url: mediaUrl, title: pickTitle(data), thumb: pickThumb(data) };
  } catch (err3) {
    console.warn('[DC-API] ytdlRapid failed, trying hdVideoDownload:', err3?.message || err3);
  }
  try {
    const data = await hdVideoDownload(youtubeUrl);
    const mediaUrl = pickUrl(data);
    if (!mediaUrl) throw new Error('No video URL');
    return { ok: true, url: mediaUrl, title: pickTitle(data), thumb: pickThumb(data) };
  } catch (err4) {
    console.warn('[DC-API] hdVideo failed, trying ytGeneric:', err4?.message || err4);
  }
  try {
    const result = await ytGeneric(youtubeUrl);
    const mediaUrl = result.url;
    if (!mediaUrl) throw new Error('No video URL');
    return { ok: true, url: mediaUrl, title: result.title || '', thumb: result.thumb };
  } catch (err5) {
    return { ok: false, error: err5 };
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
//  TEMP MAIL PROVIDERS — universal client section
//
//  Five separate temporary-mailbox providers, each with ONLY the operations
//  its own supplied endpoints actually offer:
//
//    emailnator      create, inbox
//    guerrilla       create, inbox, message, setuser
//    mailtm          create, inbox, message, delete
//    tempmailio      create, inbox, delete
//    temporary-mail  create, inbox, message, change, types
//
//  Contracts confirmed live against the API itself:
//    guerrilla/create      → { success, email, sid_token, alias,
//                              note: "Use sid_token to check inbox. …" }
//    mailtm/create         → { success, email, token,
//                              note: "Use the token to check inbox. …" }
//    temporary-mail/create → { success, status, result: { email, code, types,
//                              note: "Pass email + code to inbox endpoint" } }
//
//  Nothing below invents a parameter: the credential key names come from the
//  provider's own response/note, and `missingTempmailParam()` reads the
//  provider's own complaint when an endpoint wants something we did not send.
// ════════════════════════════════════════════════════════════════════════════

// Mailboxes are cheap but not free; a bounded timeout keeps a dead provider
// from freezing a command.
const TEMPMAIL_TIMEOUT_MS = 45_000;

// Canonical supplied paths, kept verbatim (grep-able).
const TEMPMAIL_ENDPOINTS = Object.freeze({
  emailnator: Object.freeze({
    create: '/tempmail/emailnator/create',
    inbox: '/tempmail/emailnator/inbox'
  }),
  guerrilla: Object.freeze({
    create: '/tempmail/guerrilla/create',
    inbox: '/tempmail/guerrilla/inbox',
    message: '/tempmail/guerrilla/message',
    setuser: '/tempmail/guerrilla/setuser'
  }),
  mailtm: Object.freeze({
    create: '/tempmail/mailtm/create',
    inbox: '/tempmail/mailtm/inbox',
    message: '/tempmail/mailtm/message',
    delete: '/tempmail/mailtm/delete'
  }),
  tempmailio: Object.freeze({
    create: '/tempmail/tempmailio/create',
    inbox: '/tempmail/tempmailio/inbox',
    delete: '/tempmail/tempmailio/delete'
  }),
  'temporary-mail': Object.freeze({
    create: '/tempmail/temporary-mail/create',
    inbox: '/tempmail/temporary-mail/inbox',
    message: '/tempmail/temporary-mail/message',
    change: '/tempmail/temporary-mail/change',
    types: '/tempmail/temporary-mail/types'
  })
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Provider message-id key names, in priority order. The exact key a provider
// used is remembered per message so an id is never sent under a foreign name.
const MESSAGE_ID_KEYS = ['_id', 'id', 'message_id', 'messageId', 'email_id', 'mail_id', 'uid', 'mid', 'msg_id'];
const MESSAGE_FROM_KEYS = ['from', 'sender', 'fromAddress', 'from_address', 'mail_from', 'author', 'fromName', 'from_name'];
const MESSAGE_SUBJECT_KEYS = ['subject', 'mail_subject', 'title', 'name', 'headline'];
const MESSAGE_DATE_KEYS = ['date', 'mail_date', 'created_at', 'createdAt', 'timestamp', 'mail_timestamp', 'time', 'received_at', 'received', 'sent_at', 'datetime', 'seen'];
const MESSAGE_BODY_KEYS = ['body', 'mail_body', 'text', 'content', 'plain', 'textBody', 'body_text', 'content_text', 'snippet', 'intro', 'summary', 'excerpt', 'preview'];
const MESSAGE_HTML_KEYS = ['html', 'body_html', 'htmlBody', 'content_html', 'html_body'];
// Everything a create response may carry that is NOT a session credential.
const TEMPMAIL_PUBLIC_KEYS = new Set([
  'creator', 'success', 'status', 'code_status', 'note', 'message', 'error', 'timestamp',
  'expires', 'expiresAt', 'expires_at', 'expiry', 'ttl', 'types', 'type', 'email', 'address',
  'mailbox', 'mail', 'alias', 'username', 'user', 'domain', 'id', '_id', 'account', 'accountId',
  'count', 'total', 'tag', 'tags'
]);

// One bounded GET per provider operation. `params` only ever contains keys the
// provider itself handed us (or asked for by name).
function tempmailRequest(providerId, operation, params) {
  const endpoint = TEMPMAIL_ENDPOINTS[providerId]?.[operation];
  if (!endpoint) throw new Error(`Unsupported temp mail operation "${operation}" for "${providerId}".`);
  const query = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    query[key] = String(value);
  }
  return dcFetch(endpoint, { params: query, timeout: TEMPMAIL_TIMEOUT_MS });
}

// `result` may hold the payload directly (temporary-mail) or the payload may be
// top level (guerrilla, mail.tm).
function unwrapTempmailPayload(data) {
  if (!data || typeof data !== 'object') return null;
  const inner = data.result ?? data.data;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
  return data;
}

function pickTempmailEmail(data) {
  const payload = unwrapTempmailPayload(data);
  if (!payload) return '';
  for (const key of ['email', 'address', 'mailbox', 'mail']) {
    const value = payload[key];
    if (typeof value === 'string' && EMAIL_PATTERN.test(value.trim())) return value.trim();
  }
  for (const value of Object.values(payload)) {
    if (typeof value === 'string' && EMAIL_PATTERN.test(value.trim())) return value.trim();
  }
  return '';
}

function pickTempmailExpiry(payload) {
  const raw = payload?.expires ?? payload?.expiresAt ?? payload?.expires_at ?? payload?.expiry ?? payload?.ttl;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 1e11 ? Date.now() + raw * 1000 : raw;   // seconds vs epoch-ms
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

// Normalized mailbox: the address is public, every credential stays private and
// is only ever replayed to the SAME provider that issued it.
function pickMailbox(data) {
  const payload = unwrapTempmailPayload(data);
  const email = pickTempmailEmail(data);
  if (!payload || !email) return null;
  const credentials = {};
  for (const [key, value] of Object.entries(payload)) {
    if (TEMPMAIL_PUBLIC_KEYS.has(key)) continue;
    if (typeof value === 'string' && value.trim() && value.trim() !== email) credentials[key] = value.trim();
    else if (typeof value === 'number' && Number.isFinite(value)) credentials[key] = String(value);
  }
  return {
    email,
    credentials,
    alias: typeof payload.alias === 'string' ? payload.alias.trim() : '',
    username: typeof payload.username === 'string' ? payload.username.trim() : '',
    domain: typeof payload.domain === 'string' ? payload.domain.trim() : '',
    types: Array.isArray(payload.types) ? payload.types.map((value) => String(value)).slice(0, 25) : [],
    note: typeof payload.note === 'string' ? payload.note.trim() : '',
    expiresAt: pickTempmailExpiry(payload)
  };
}

function pickStringField(entry, keys) {
  for (const key of keys) {
    const value = entry?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      const nested = value.address || value.email || value.name || value.text || value.value;
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    }
  }
  return '';
}

// `null` = this is not an inbox response at all (unreadable), `[]` = a real but
// empty inbox. The distinction matters: an empty inbox is not a failure.
function pickMessages(data) {
  const containers = [
    data, data?.result, data?.data,
    data?.messages, data?.emails, data?.mails, data?.list, data?.inbox, data?.items,
    data?.result?.messages, data?.result?.emails, data?.result?.mails, data?.result?.list, data?.result?.inbox, data?.result?.items,
    data?.data?.messages, data?.data?.emails, data?.data?.list
  ];
  let array = null;
  for (const container of containers) {
    if (Array.isArray(container)) { array = container; break; }
  }
  if (!array) return null;
  const messages = [];
  for (const entry of array) {
    if (typeof entry === 'string') {
      messages.push({ id: entry, idKey: MESSAGE_ID_KEYS[1], from: '', subject: entry, date: '', intro: '' });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    let id = '';
    let idKey = '';
    for (const key of MESSAGE_ID_KEYS) {
      const value = entry[key];
      if (typeof value === 'string' && value.trim()) { id = value.trim(); idKey = key; break; }
      if (typeof value === 'number' && Number.isFinite(value)) { id = String(value); idKey = key; break; }
    }
    messages.push({
      id,
      idKey,
      from: pickStringField(entry, MESSAGE_FROM_KEYS),
      subject: pickStringField(entry, MESSAGE_SUBJECT_KEYS),
      date: pickStringField(entry, MESSAGE_DATE_KEYS),
      intro: pickStringField(entry, MESSAGE_BODY_KEYS)
    });
    if (messages.length >= 25) break;
  }
  return messages;
}

// Single-message payload for the `message` endpoints.
function pickMessagePayload(data) {
  const payload = unwrapTempmailPayload(data);
  if (!payload) return null;
  const from = pickStringField(payload, MESSAGE_FROM_KEYS);
  const subject = pickStringField(payload, MESSAGE_SUBJECT_KEYS);
  const date = pickStringField(payload, MESSAGE_DATE_KEYS);
  const text = pickStringField(payload, MESSAGE_BODY_KEYS);
  const html = pickStringField(payload, MESSAGE_HTML_KEYS);
  if (!from && !subject && !text && !html) return null;
  let id = '';
  for (const key of MESSAGE_ID_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) { id = value.trim(); break; }
    if (typeof value === 'number' && Number.isFinite(value)) { id = String(value); break; }
  }
  const attachments = Array.isArray(payload.attachments) ? payload.attachments.length : 0;
  return { id, from, subject, date, text, html, attachments };
}

// `types` is provider metadata (address/domain types), never a mailbox creator.
// Confirmed live shape (temporary-mail/types):
//   { success, result: { default: 'gmail', types: {
//       gmail:      { code: '1', example: 'a.b.c@gmail.com' },
//       plus:       { code: '2', example: 'name+tag@gmail.com' },
//       googlemail: { code: '3', example: 'name@googlemail.com' },
//       domain:     { code: '4', example: 'name@custom-domain.com',
//                     note: 'optional domain= on change' } } } }
// A plain array of types is accepted too. Anything else returns null so an
// unreadable reply is never dressed up as a type list.
const TEMPMAIL_TYPE_SKIP_KEYS = new Set([
  'creator', 'success', 'status', 'note', 'message', 'error', 'timestamp',
  'default', 'types', 'domains', 'count', 'total', 'code', 'result', 'data'
]);

function isTempmailTypeMap(container) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return false;
  const entries = Object.entries(container).filter(([key]) => !TEMPMAIL_TYPE_SKIP_KEYS.has(String(key).toLowerCase()));
  if (!entries.length) return false;
  return entries.some(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
    && entries.every(([, value]) => value === null || ['object', 'string', 'number'].includes(typeof value));
}

function pickTempmailTypes(data) {
  const payload = unwrapTempmailPayload(data);
  const defaultName = String(payload?.default ?? data?.default ?? '').trim().toLowerCase();
  const containers = [data?.types, data?.result?.types, data?.data?.types, payload?.types, data?.domains, data?.result, data?.data, payload];
  for (const container of containers) {
    if (Array.isArray(container)) {
      const entries = container.slice(0, 30).map((entry) => {
        if (typeof entry === 'string' || typeof entry === 'number') {
          return { id: String(entry), label: String(entry), example: '', note: '', isDefault: false };
        }
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const id = String(entry.code ?? entry.id ?? entry.type ?? entry.name ?? entry.domain ?? entry.value ?? '').trim();
          const label = String(entry.label ?? entry.name ?? entry.type ?? entry.domain ?? entry.title ?? id).trim();
          return id || label ? {
            id: id || label,
            label: label || id,
            example: String(entry.example ?? entry.sample ?? '').trim(),
            note: String(entry.note ?? entry.description ?? '').trim(),
            isDefault: false
          } : null;
        }
        return null;
      }).filter(Boolean);
      if (entries.length) return entries;
      continue;
    }
    if (isTempmailTypeMap(container)) {
      const entries = Object.entries(container)
        .filter(([key]) => !TEMPMAIL_TYPE_SKIP_KEYS.has(String(key).toLowerCase()))
        .slice(0, 30)
        .map(([key, value]) => {
          const isDefault = String(key).toLowerCase() === defaultName;
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const code = String(value.code ?? value.id ?? value.type ?? '').trim();
            return {
              id: code || key,
              label: String(value.name ?? value.label ?? key).trim(),
              example: String(value.example ?? value.sample ?? '').trim(),
              note: String(value.note ?? value.description ?? '').trim(),
              isDefault
            };
          }
          if (typeof value === 'string' || typeof value === 'number') {
            return { id: String(value), label: key, example: '', note: '', isDefault };
          }
          return null;
        }).filter(Boolean);
      if (entries.length) return entries;
    }
  }
  return null;
}

// Action endpoints (delete/change/setuser) confirm through the API's own flags.
function pickTempmailAction(data) {
  if (!data || typeof data !== 'object') return { ok: false, message: 'The provider sent an unreadable reply.' };
  const status = Number(data.status ?? data.code ?? 0);
  const okFlag = data.success === true || data.deleted === true || data.ok === true;
  const badFlag = data.success === false || data.error === true;
  const message = pickApiMessage(data);
  if (badFlag) return { ok: false, message: message || 'The provider rejected that request.' };
  if (status >= 400) return { ok: false, message: message || `The provider answered with status ${status}.` };
  if (okFlag || (status > 0 && status < 400)) return { ok: true, message };
  return { ok: false, message: message || 'The provider did not confirm that action.' };
}

// When an endpoint asks for a parameter we did not send, read the parameter
// NAME out of the provider's own complaint. Nothing is guessed in code: the
// provider supplies the key, the caller supplies the value it already holds.
function missingTempmailParam(message, alreadySent) {
  const text = String(message || '');
  if (!text) return '';
  const sent = new Set(Object.keys(alreadySent || {}));
  const patterns = [
    /\b(?:parameter|param|field|query|key)\b[\s:'"`]+([a-z_][a-z0-9_]{1,30})/i,
    /\b([a-z_][a-z0-9_]{1,30})\s+(?:is\s+)?(?:required|missing|needed|expected|must be)\b/i,
    /\b(?:required|missing|needed|provide|pass|send|expects?)\b[\s:'"`]*(?:the\s+|a\s+|your\s+)?([a-z_][a-z0-9_]{1,30})/i
  ];
  // Plain English words are never mistaken for parameter names. Real key names
  // such as `email`, `address`, `username`, `token` or `id` are allowed through:
  // the provider asked for them by name.
  const blocked = new Set(['the', 'a', 'an', 'this', 'that', 'request', 'response', 'parameter', 'parameters', 'param', 'params', 'field', 'fields', 'value', 'values', 'data', 'json', 'body', 'payload', 'message', 'messages', 'error', 'errors', 'success', 'status', 'note', 'creator', 'invalid', 'valid', 'missing', 'required', 'please', 'try', 'again', 'with', 'for', 'and', 'you', 'your', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'it', 'be', 'not', 'no', 'or', 'if', 'then', 'than', 'some', 'any', 'all', 'must', 'should', 'could', 'would', 'have', 'has', 'had', 'we', 'us', 'our', 'cannot', 'unable', 'wrong', 'bad', 'null', 'empty', 'missing']);
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = String(match?.[1] || '').trim();
    if (!candidate || sent.has(candidate) || blocked.has(candidate.toLowerCase())) continue;
    return candidate;
  }
  return '';
}

module.exports = {
  // Constants
  DC_BASE,
  TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,

  // Helpers
  extractUrl,
  pickUrl,
  pickAudioUrl,
  pickTitle,
  pickThumb,
  pickLinks,
  pickItems,
  isUrl,
  isValidResult,
  pickHighestQuality,
  videoQualityRank,
  audioQualityRank,

  // Core
  dcFetch,
  dcFallback,
  dlBuffer,

  // YouTube
  ytMp3,
  ytMp4,
  ytGeneric,
  ytdlRapid,
  y2mateGeneric,
  y2mateMp3,
  y2mateMp4,
  downloadYtAudio,
  downloadYtVideo,

  // Music
  playMusic,
  songDownload,

  // Spotify
  spotifyDownload,
  spotifyV2Search,

  // TikTok
  tiktokDownload,

  // Facebook
  facebookDownload,

  // Twitter
  twitterDownload,

  // Instagram
  instagramDownload,

  // Pinterest
  pinterestDownload,

  // Mediafire
  mediafireDownload,

  // Google Drive
  gdriveDownload,

  // HD Video
  hdVideoDownload,

  // SoundCloud
  soundcloudDownload,
  soundcloudSearch,

  // Terabox
  teraboxDownload,

  // AIO
  aioDownload,

  // Others
  vibetikDownload,
  savetikDownload,
  savetubeDownload,
  snaptwittDownload,
  inthistweetDownload,
  seekinDownload,
  ytscribetoDownload,
  snapsaverDownload,
  websiteDownload,
  dafontDownload,

  // ── Movie / Series / Streaming ──
  movieWatch,
  // NaijaPrey
  naijapreySearch, naijapreyLatest, naijapreyInfo,
  // Net9ja
  net9jaSearch, net9jaLatest, net9jaInfo,
  // Nkiri
  nkiriSearch, nkiriLatest, nkiriInfo, nkiriDownload,
  // Stream-X
  streamxSearch, streamxLatest, streamxInfo,
  // CineSubz
  cinesubzSearch, cinesubzLatest, cinesubzInfo, cinesubzDownload,
  // GokuHD
  gokuSearch, gokuLatest, gokuInfo, gokuDownload,
  // RogMovies
  rogSearch, rogLatest, rogInfo, rogDownload,
  // XPrimeHub
  xprimeSearch, xprimeLatest, xprimeInfo, xprimeDownload,
  // O2TVSeries
  o2tvSearch, o2tvLatest, o2tvInfo, o2tvSeason, o2tvEpisode,
  // MovieBaaz
  moviebaazSearch, moviebaazLatest, moviebaazInfo,
  // SeriezLoaded
  seriezSearch, seriezLatest, seriezInfo,
  // TvShows4Mobile
  tvshows4mSearch, tvshows4mLatest, tvshows4mInfo, tvshows4mSeason, tvshows4mEpisode,
  // MoviesFoundOnline
  mfoSearch, mfoLatest, mfoInfo,
  // TamilMV
  tamilmvSearch, tamilmvLatest, tamilmvInfo, tamilmvForums,
  // YTS
  ytsSearch, ytsLatest, ytsDetails,
  // EZTV
  eztvSearch,
  // ApiBay / TPB
  apibaySearch,
  // Soap2Day
  soap2daySearch, soap2dayLatest, soap2dayInfo, soap2dayWatch,
  // VegaMovies
  vegaSearch, vegaLatest,
  // HDHub4u
  hdhub4uSearch, hdhub4uLatest,
  // TvMaze
  tvmazeSearch, tvmazeShow, tvmazeEpisodes,
  // VidSrc
  vidsrcUrl,
  // Subtitles
  subSearch, subInfo,
  // Zoom
  zoomSearch, zoomMovie,

  // ── Image Generation / Image Effects ──
  IMAGE_ENDPOINTS,
  IMAGE_TIMEOUT_MS,
  EFFECT_NAME_PATTERN,
  isImagePayload,
  pickImageUrl,
  pickImageMeta,
  pickApiMessage,
  // Text → Image
  animagineImage,
  epicrealismImage,
  fluxV2Image,
  flixierImage,
  writecreamImage,
  // Image → Image
  nanobanana2Edit,
  pixwithEdit,
  // Ephoto dynamic effect
  ephotoEffect,

  // ── Temp Mail Providers ──
  TEMPMAIL_ENDPOINTS,
  TEMPMAIL_TIMEOUT_MS,
  EMAIL_PATTERN,
  MESSAGE_ID_KEYS,
  tempmailRequest,
  unwrapTempmailPayload,
  pickTempmailEmail,
  pickMailbox,
  pickMessages,
  pickMessagePayload,
  pickTempmailTypes,
  pickTempmailAction,
  missingTempmailParam,
};
