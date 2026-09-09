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
  const response = await fetchWithTimeout(`${apiBase}/`, {
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
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.text || payload.error || `Download service failed (${response.status}).`);
  return cobaltResult(payload);
}

async function downloadRemoteFile(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  const buffer = await readLimitedBuffer(response);
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

async function spotifySearch(query, limit = 5) {
  const tokenResponse = await fetchWithTimeout('https://open.spotify.com/get_access_token?reason=init&productType=web-player');
  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  const token = tokenPayload.accessToken;
  if (!token) throw new Error('Spotify search is temporarily unavailable.');
  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('q', query);
  url.searchParams.set('type', 'track');
  url.searchParams.set('limit', String(limit));
  const response = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${token}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || `Spotify search failed (${response.status}).`);
  return (payload.tracks?.items || []).map((track) => ({
    title: track.name,
    artist: track.artists?.map((artist) => artist.name).join(', '),
    album: track.album?.name,
    // The handler reads album.images[0].url for the link preview thumbnail, so
    // the album has to keep its image list instead of only its name.
    images: Array.isArray(track.album?.images) ? track.album.images : [],
    duration: track.duration_ms,
    url: track.external_urls?.spotify,
    preview: track.preview_url
  })).filter((track) => track.title && track.url);
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
  textToSpeech,
  translateText,
  uploadToCatbox,
  youtubeSearch
};
