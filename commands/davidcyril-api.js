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

function pickUrl(data) {
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
  // Deep scan for nested download URLs
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const f of fields) {
        if (val[f] && typeof val[f] === 'string' && /^https?:\/\//i.test(val[f])) return val[f];
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
  return pickUrl(data);
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
};
