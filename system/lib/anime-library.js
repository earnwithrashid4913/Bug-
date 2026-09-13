'use strict';

const { parsePhoneNumberFromString } = require('libphonenumber-js/min');
const { isIP } = require('node:net');
const { font } = require('./presentation');

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_CANDIDATES = 100;
const cleanText = (value, limit = 120) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, limit) : '';
function normalizeAnimeConfig(value = {}) {
  return Object.freeze({
    enabled: value?.enabled === true,
    libraryApi: typeof value?.libraryApi === 'string' ? value.libraryApi.trim() : '',
    apiKey: typeof value?.apiKey === 'string' ? value.apiKey.trim() : '',
    gender: ['male', 'female', 'mixed'].includes(value?.gender) ? value.gender : 'mixed',
    quality: ['top', 'normal'].includes(value?.quality) ? value.quality : 'top',
    avoidRecent: Number.isInteger(value?.avoidRecent) ? Math.max(0, Math.min(50, value.avoidRecent)) : 5,
    timeoutMs: Number.isInteger(value?.timeoutMs) ? Math.max(100, Math.min(60000, value.timeoutMs)) : 15000
  });
}
class AnimeDeliveryError extends Error {
  constructor(code) { super(code); this.code = code; }
}
// Only absolute public HTTPS URLs, without credentials. Redirects on the
// authenticated API request are refused so its bearer token cannot be forwarded.
function publicHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new AnimeDeliveryError('INVALID_URL');
  let url;
  try { url = new URL(value); } catch { throw new AnimeDeliveryError('INVALID_URL'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || !host || host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) throw new AnimeDeliveryError('INVALID_URL');
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) throw new AnimeDeliveryError('INVALID_URL');
  } else if (isIP(host) === 6) {
    if (host === '::' || host === '::1' || /^(fc|fd|fe[89ab])/.test(host) || host.includes('ffff:')) throw new AnimeDeliveryError('INVALID_URL');
  } else if (!host.includes('.')) throw new AnimeDeliveryError('INVALID_URL');
  return url;
}
function detectCountry(number) {
  try {
    const raw = String(number ?? '').trim();
    if (!/^\+?[1-9]\d{6,14}$/.test(raw)) return 'WORLDWIDE';
    const parsed = parsePhoneNumberFromString(raw.startsWith('+') ? raw : `+${raw}`);
    return parsed?.country || 'WORLDWIDE';
  } catch { return 'WORLDWIDE'; }
}
function candidate(value) {
  if (!value || typeof value !== 'object' || value.enabled !== true || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.id)) return undefined;
  let videoUrl;
  try { videoUrl = publicHttpsUrl(value.videoUrl).href; } catch { return undefined; }
  const country = typeof value.country === 'string' ? value.country.toUpperCase() : 'WORLDWIDE';
  if (!/^[A-Z]{2}$/.test(country) && country !== 'WORLDWIDE') return undefined;
  const gender = value.gender === undefined ? 'mixed' : value.gender;
  if (!['male', 'female', 'mixed'].includes(gender)) return undefined;
  return {
    id: value.id, videoUrl, country, gender,
    anime: cleanText(value.anime), character: cleanText(value.character), label: cleanText(value.label, 180),
    quality: typeof value.quality === 'number' && Number.isFinite(value.quality) ? Math.max(0, Math.min(10, value.quality)) : 1,
    views: typeof value.views === 'number' && Number.isFinite(value.views) ? Math.max(0, Math.min(1e12, value.views)) : 0
  };
}
function candidatesFrom(data) {
  const values = Array.isArray(data) ? data : Array.isArray(data?.videos) ? data.videos : Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : [data?.data || data];
  const unique = new Map();
  for (const entry of values.slice(0, MAX_CANDIDATES)) {
    const parsed = candidate(entry);
    if (parsed && !unique.has(parsed.id)) unique.set(parsed.id, parsed);
  }
  return [...unique.values()];
}
function chooseVideo(videos, { gender = 'mixed', quality = 'top', recent = [], random = Math.random } = {}) {
  let pool = videos.filter(video => gender === 'mixed' || video.gender === gender || video.gender === 'mixed');
  const fresh = pool.filter(video => !recent.includes(video.id));
  if (fresh.length) pool = fresh;
  if (!pool.length) return undefined;
  // In mixed mode choose a gender bucket first, so a larger male catalog does
  // not permanently drown out the female edits (or vice versa).
  if (gender === 'mixed') {
    const genders = [...new Set(pool.map(video => video.gender))];
    const selectedGender = genders[Math.min(genders.length - 1, Math.floor(random() * genders.length))];
    pool = pool.filter(video => video.gender === selectedGender);
  }
  const weights = pool.map(video => quality === 'top' ? 1 + video.quality * 2 + Math.log10(video.views + 1) : 1);
  let draw = random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let i = 0; i < pool.length; i++) { draw -= weights[i]; if (draw < 0) return pool[i]; }
  return pool.at(-1);
}
function videoLabel(video) {
  return video.label || `「 ${font(video.anime || 'ANIME-MD')}${video.character ? ` • ${font(video.character)}` : ' ✨'} 」`;
}
async function limitedJson(response) {
  if (Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new AnimeDeliveryError('RESPONSE_TOO_LARGE');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new AnimeDeliveryError('RESPONSE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AnimeDeliveryError('INVALID_JSON'); }
}

class AnimeLibraryClient {
  constructor(options, { fetchImpl = globalThis.fetch, random = Math.random, now = Date.now, log = console } = {}) {
    this.options = normalizeAnimeConfig(options);
    this.fetch = fetchImpl;
    this.random = random;
    this.now = now;
    this.recentUpdatedAt = 0;
    this.log = log;
    this.recentVideoIds = [];
    this.queue = Promise.resolve();
    this.pending = 0;
  }
  get enabled() { return this.options.enabled && Boolean(this.options.libraryApi); }
  async request(country) {
    const url = publicHttpsUrl(this.options.libraryApi);
    url.searchParams.set('country', country);
    url.searchParams.set('gender', this.options.gender);
    url.searchParams.set('quality', this.options.quality);
    url.searchParams.set('avoid_recent', String(this.options.avoidRecent));
    if (this.recentVideoIds.length) url.searchParams.set('exclude_ids', this.recentVideoIds.join(','));
    const headers = { Accept: 'application/json' };
    if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    try {
      const response = await this.fetch(url.href, { headers, signal, redirect: 'error' });
      if ([204, 404].includes(response.status)) { await response.body?.cancel(); return []; }
      if (!response.ok) { await response.body?.cancel(); throw new AnimeDeliveryError(`HTTP_${response.status}`); }
      return candidatesFrom(await limitedJson(response));
    } catch (error) {
      if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) throw new AnimeDeliveryError('TIMEOUT');
      throw error;
    }
  }
  // Serial selection keeps concurrent connections from selecting the same
  // fresh ID. The bounded queue is memory-only and never blocks connection.open.
  deliver(number, sendVideo) {
    if (!this.enabled) return Promise.resolve({ status: 'off' });
    if (this.pending >= 20) { this.log.warn?.('[anime-edit] Optional delivery skipped (QUEUE_FULL).'); return Promise.resolve({ status: 'skipped' }); }
    this.pending++;
    const task = this.queue.then(() => this.deliverOne(number, sendVideo));
    this.queue = task.catch(() => undefined);
    return task.finally(() => { this.pending--; });
  }
  async deliverOne(number, sendVideo) {
    try {
      // Lazy expiry: short-lived recent IDs, without another timer/worker.
      if (this.now() - this.recentUpdatedAt >= 30 * 60_000) this.recentVideoIds = [];
      const country = detectCountry(number);
      let pool = await this.request(country);
      const suitable = video => (this.options.gender === 'mixed' || video.gender === this.options.gender || video.gender === 'mixed');
      let local = pool.filter(video => video.country === country && suitable(video));
      if (!local.length && country !== 'WORLDWIDE') {
        pool = await this.request('WORLDWIDE');
        local = pool.filter(video => video.country === 'WORLDWIDE' && suitable(video));
      }
      const video = chooseVideo(local, { ...this.options, recent: this.recentVideoIds, random: this.random });
      if (!video) throw new AnimeDeliveryError('NO_SUITABLE_VIDEO');
      try { await sendVideo(video.videoUrl, videoLabel(video)); }
      catch { throw new AnimeDeliveryError('TELEGRAM_SEND_FAILED'); }
      if (this.options.avoidRecent) {
        this.recentVideoIds = [...this.recentVideoIds.filter(id => id !== video.id), video.id].slice(-this.options.avoidRecent);
        this.recentUpdatedAt = this.now();
      }
      return { status: 'sent', id: video.id };
    } catch (error) {
      // Never log provider error bodies, URLs, token-bearing fetch messages,
      // phone numbers or arbitrary metadata. Only locally generated codes.
      const code = error instanceof AnimeDeliveryError ? error.code : 'NETWORK_OR_DELIVERY_ERROR';
      this.log.warn?.(`[anime-edit] Optional delivery skipped (${code}).`);
      return { status: 'failed' };
    }
  }
}
module.exports = { AnimeLibraryClient, normalizeAnimeConfig, publicHttpsUrl, detectCountry, candidate, candidatesFrom, chooseVideo, videoLabel, cleanText };
