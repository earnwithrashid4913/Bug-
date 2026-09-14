'use strict';

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedBuffer(response, maxBytes = MAX_DOWNLOAD_BYTES) {
  const total = Number(response.headers.get('content-length') || 0);
  if (total > maxBytes) throw new Error(`File is too large (${Math.ceil(total / 1024 / 1024)} MB). Limit is ${Math.floor(maxBytes / 1024 / 1024)} MB.`);

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Download exceeded the safe size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function youtubeSearch(query, limit = 5) {
  const url = new URL('https://www.youtube.com/results');
  url.searchParams.set('search_query', query);
  const response = await fetchWithTimeout(url, { headers: { 'user-agent': 'Mozilla/5.0 ANIME-MD' } });
  if (!response.ok) throw new Error(`YouTube search failed (${response.status}).`);
  const html = await response.text();
  const match = html.match(/var ytInitialData = (\{.*?\});<\/script>/s) || html.match(/ytInitialData"\]\s*=\s*(\{.*?\});/s);
  if (!match) throw new Error('Could not read YouTube search results.');
  const data = JSON.parse(match[1]);
  const items = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object' || items.length >= limit) return;
    if (value.videoRenderer?.videoId) {
      const video = value.videoRenderer;
      const title = video.title?.runs?.[0]?.text || video.title?.simpleText;
      const author = video.ownerText?.runs?.[0]?.text || video.longBylineText?.runs?.[0]?.text || 'YouTube';
      const length = video.lengthText?.simpleText || '';
      if (title && video.videoId) items.push({ id: video.videoId, title: decodeHtmlEntities(title), author, length, url: `https://www.youtube.com/watch?v=${video.videoId}` });
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === 'object') walk(child);
    }
  };
  walk(data);
  if (!items.length) throw new Error('No YouTube results found.');
  return items;
}

function cobaltResult(result) {
  if (result.status === 'stream' || result.status === 'tunnel' || result.status === 'redirect') {
    return { url: result.url, filename: result.filename || '' };
  }
  if (result.status === 'picker' && Array.isArray(result.picker)?.[0]?.url) {
    return { url: result.picker[0].url, filename: result.picker[0].type ? `media.${result.picker[0].type === 'photo' ? 'jpg' : 'mp4'}` : '' };
  }
  if (result.status === 'error') throw new Error(result.text || 'Download service refused this link.');
  throw new Error('Download service returned an unsupported response.');
}

async function requestCobalt(apiBase, url, { audio = false } = {}) {
  const endpoint = `${String(apiBase).replace(/\/$/, '')}/`;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          url,
          downloadMode: audio ? 'audio' : 'auto',
          audioFormat: audio ? 'mp3' : undefined,
          filenameStyle: 'basic',
          disableMetadata: false
        })
      }, 45_000);
      const contentType = response.headers.get('content-type') || '';
      const body = await response.text();
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; }
      catch {
        if (response.ok) throw new Error('Download service returned malformed data.');
      }
      if (response.ok && !contentType.toLowerCase().includes('json')) throw new Error('Download service returned an invalid response.');
      if (response.ok) return cobaltResult(payload);
      const retryable = response.status === 429 || response.status >= 500;
      lastError = new Error(payload.text || payload.error || `Download service failed (${response.status}).`);
      console.warn(`[Play] Download provider HTTP ${response.status}${retryable && attempt === 0 ? '; retrying once' : ''}`);
      if (!retryable || attempt === 1) throw lastError;
      const retryAfter = Number(response.headers.get('retry-after'));
      await new Promise(resolve => setTimeout(resolve, Number.isFinite(retryAfter) ? Math.min(5000, Math.max(250, retryAfter * 1000)) : 500));
    } catch (error) {
      lastError = error;
      if (attempt === 1 || (error?.message && /failed \(4\d\d\)/.test(error.message) && !/failed \((429)\)/.test(error.message))) throw error;
      console.warn(`[Play] Download provider request failed; retrying once`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error('Download service unavailable.');
}

async function downloadRemoteFile(url, maxBytes = MAX_DOWNLOAD_BYTES) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  const buffer = await readLimitedBuffer(response, maxBytes);
  // A zero-byte or truncated body would otherwise be sent to WhatsApp as an
  // unopenable file. Fail here so the user gets a message instead of a
  // corrupt attachment.
  if (buffer.length === 0) throw new Error('The download service returned an empty file.');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > 0 && buffer.length < declared) {
    throw new Error('The download was incomplete. Please try again.');
  }
  const type = response.headers.get('content-type') || 'application/octet-stream';
  return { buffer, type };
}

async function uploadToCatbox(uploadApiUrl, buffer, { filename = 'upload.bin', mimetype = 'application/octet-stream' }) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', new Blob([buffer], { type: mimetype }), filename);
  const response = await fetchWithTimeout(uploadApiUrl, { method: 'POST', body: form }, 60_000);
  const text = await response.text();
  if (!response.ok || !/^https?:\/\//.test(text)) throw new Error(`Upload failed: ${text.slice(0, 180)}`);
  return text.trim();
}

const MUSIC_SEARCH_TIMEOUT_MS = 10_000;

function musicError(message, code, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

async function publicJson(url, provider) {
  let response;
  try {
    response = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, MUSIC_SEARCH_TIMEOUT_MS);
  } catch (error) {
    throw musicError(`${provider} request failed.`, error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', true);
  }
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; }
  catch { throw musicError(`${provider} returned malformed data.`, 'MALFORMED_RESPONSE'); }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw musicError(`${provider} request failed (${response.status}).`, `HTTP_${response.status}`, retryable);
  }
  if (!contentType.toLowerCase().includes('json') || !payload || typeof payload !== 'object') {
    throw musicError(`${provider} returned an invalid response.`, 'MALFORMED_RESPONSE');
  }
  return payload;
}

function normalizeMusicItem(item) {
  return {
    title: item.title,
    artist: item.artist,
    album: item.album || '',
    duration: Number.isFinite(item.duration) ? item.duration : 0,
    images: item.artwork ? [{ url: item.artwork }] : [],
    url: item.url,
    preview: item.preview || ''
  };
}

async function searchItunes(query, limit) {
  const url = new URL('https://itunes.apple.com/search');
  url.searchParams.set('term', query);
  url.searchParams.set('media', 'music');
  url.searchParams.set('entity', 'song');
  url.searchParams.set('limit', String(limit));
  const payload = await publicJson(url, 'Music search');
  if (!Array.isArray(payload.results)) throw musicError('Music search returned an invalid result.', 'MALFORMED_RESPONSE');
  return payload.results.map(item => normalizeMusicItem({
    title: item.trackName,
    artist: item.artistName,
    album: item.collectionName,
    duration: Number(item.trackTimeMillis) || 0,
    artwork: item.artworkUrl100,
    url: item.trackViewUrl || item.collectionViewUrl
  })).filter(item => item.title && item.artist && item.url);
}

async function searchDeezer(query, limit) {
  const url = new URL('https://api.deezer.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  const payload = await publicJson(url, 'Music fallback search');
  if (!Array.isArray(payload.data)) throw musicError('Music fallback returned an invalid result.', 'MALFORMED_RESPONSE');
  return payload.data.map(item => normalizeMusicItem({
    title: item.title,
    artist: item.artist?.name,
    album: item.album?.title,
    duration: Number(item.duration) * 1000,
    artwork: item.album?.cover_medium,
    url: item.link,
    preview: item.preview
  })).filter(item => item.title && item.artist && item.url);
}

async function musicSearch(query, limit = 5) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];
  const safeLimit = Math.min(10, Math.max(1, Number(limit) || 5));
  let firstError;
  for (const provider of [searchItunes, searchDeezer]) {
    try {
      console.info(`[Spotify Search] Querying public music metadata provider`);
      const results = await provider(cleanQuery, safeLimit);
      // An empty first provider is not an outage; still try the fallback because
      // catalogues differ, then return an honest empty result if both are empty.
      if (results.length) return results;
    } catch (error) {
      firstError ||= error;
      console.warn(`[Spotify Search] Public provider failed: ${error.code || 'ERROR'}`);
      if (!error.retryable && error.code === 'MALFORMED_RESPONSE') continue;
    }
  }
  if (firstError && firstError.code !== 'HTTP_404') throw firstError;
  return [];
}

// Kept as the existing internal function name so the command registration and
// aliases remain unchanged. It now uses public metadata providers only.
const spotifySearch = musicSearch;

function spotifyUserError(error) {
  switch (error?.code) {
    case 'TIMEOUT': return 'Music search timed out. Please try again.';
    case 'HTTP_403': return 'Music search is temporarily unavailable.';
    case 'HTTP_429': return 'Music search is temporarily busy. Please try again shortly.';
    case 'NETWORK': case 'MALFORMED_RESPONSE': case 'HTTP_408': case 'HTTP_500': case 'HTTP_502': case 'HTTP_503': case 'HTTP_504': return 'Music search is temporarily unavailable.';
    default: return 'Music search is temporarily unavailable.';
  }
}

async function translateText(text, target = 'en') {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', target);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);
  const response = await fetchWithTimeout(url);
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data?.[0])) throw new Error('Translation service is unavailable.');
  const translated = data[0].map((part) => part?.[0] || '').join('');
  return { translated, source: data?.[2] || 'auto', target };
}

async function textToSpeech(text, language = 'en') {
  const url = new URL('https://translate.googleapis.com/translate_tts');
  url.searchParams.set('ie', 'UTF-8');
  url.searchParams.set('client', 'tw-ob');
  url.searchParams.set('tl', language);
  url.searchParams.set('q', text.slice(0, 400));
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error('Text-to-speech service is unavailable.');
  const buffer = await readLimitedBuffer(response, 10 * 1024 * 1024);
  return { buffer, mimetype: response.headers.get('content-type') || 'audio/mpeg' };
}

async function shortenUrl(longUrl) {
  const url = new URL('https://tinyurl.com/api-create.php');
  url.searchParams.set('url', longUrl);
  const response = await fetchWithTimeout(url);
  const text = await response.text();
  if (!response.ok || !/^https?:\/\//.test(text)) throw new Error('URL shortener is unavailable.');
  return text.trim();
}

async function screenshotUrl(targetUrl) {
  const parsed = new URL(targetUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Use an HTTP or HTTPS URL.');
  const endpoint = new URL('https://image.thum.io/get/width/1000/crop/1400/');
  endpoint.search = '';
  endpoint.pathname = `/get/width/1000/crop/1400/${parsed.href}`;
  const response = await fetchWithTimeout(endpoint.toString(), {}, 60_000);
  if (!response.ok) throw new Error(`Screenshot service failed (${response.status}).`);
  const buffer = await readLimitedBuffer(response, 15 * 1024 * 1024);
  return { buffer, mimetype: response.headers.get('content-type') || 'image/jpeg' };
}

function safeMath(expression) {
  const normalized = String(expression || '').replace(/\s+/g, '');
  if (!/^[\d+\-*/().%]+$/.test(normalized)) throw new Error('Only numbers and + - * / % ( ) are allowed.');
  if (normalized.includes('**')) throw new Error('Exponentiation is not allowed.');
  let position = 0;

  const consume = (token) => {
    if (normalized.slice(position, position + token.length) !== token) return false;
    position += token.length;
    return true;
  };
  const number = () => {
    const match = normalized.slice(position).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (!match) throw new Error('Expected a number.');
    position += match[0].length;
    return Number(match[0]);
  };
  const primary = () => {
    if (consume('(')) {
      const value = addSubtract();
      if (!consume(')')) throw new Error('Missing closing parenthesis.');
      return value;
    }
    if (consume('+')) return primary();
    if (consume('-')) return -primary();
    return number();
  };
  const multiplyDivide = () => {
    let value = primary();
    while (position < normalized.length) {
      if (consume('*')) value *= primary();
      else if (consume('/')) value /= primary();
      else if (consume('%')) value %= primary();
      else break;
    }
    return value;
  };
  const addSubtract = () => {
    let value = multiplyDivide();
    while (position < normalized.length) {
      if (consume('+')) value += multiplyDivide();
      else if (consume('-')) value -= multiplyDivide();
      else break;
    }
    return value;
  };
  const result = addSubtract();
  if (position !== normalized.length) throw new Error('Invalid expression.');
  if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('That expression did not produce a valid number.');
  return result;
}

module.exports = {
  MAX_DOWNLOAD_BYTES,
  downloadRemoteFile,
  fetchWithTimeout,
  readLimitedBuffer,
  requestCobalt,
  safeMath,
  screenshotUrl,
  shortenUrl,
  spotifySearch,
  spotifyUserError,
  textToSpeech,
  translateText,
  uploadToCatbox,
  youtubeSearch
};
