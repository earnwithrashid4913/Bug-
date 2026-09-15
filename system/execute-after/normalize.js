'use strict';

// =============================================================================
// EXECUTEAFTER — UNIVERSAL NORMALIZED RESULT
// =============================================================================
// Every provider response is converted into exactly this shape:
//
// {
//   source, sourceName, id, title, description, thumbnail, duration,
//   pageUrl, streamUrl, downloadUrl, embedUrl, quality, type, metadata, raw
// }
//
// Rules:
//   * a missing field stays null — never undefined, never '' , never invented
//   * nothing is fabricated: values come from the provider response only
//   * `raw` keeps the untouched provider item for debugging
//
// Field lookup order for every provider:
//   1. the explicit path you declared in execute-after.config.js
//      (contract.fields.<field>, e.g. 'snippet.title')
//   2. the documented alias table below (framework-level discovery)
//   3. null
//
// The alias table is NOT a claim about any specific provider API — it is a list
// of well-known key names used only when you did not declare a path.
// =============================================================================

const FIELD_ALIASES = Object.freeze({
  id: ['id', '_id', 'videoId', 'video_id', 'slug', 'key', 'code', 'imdbId', 'imdb_id', 'tmdbId', 'mal_id'],
  title: ['title', 'name', 'video_title', 'videoTitle', 'caption', 'heading', 'label', 'movie_title', 'series_title'],
  description: ['description', 'desc', 'summary', 'overview', 'plot', 'snippet'],
  thumbnail: ['thumbnail', 'thumbnailUrl', 'thumb', 'thumbUrl', 'poster', 'posterUrl', 'image', 'imageUrl', 'cover', 'coverUrl'],
  duration: ['duration', 'length', 'runtime', 'time', 'video_length', 'seconds'],
  pageUrl: ['pageUrl', 'page_url', 'permalink', 'watchUrl', 'watch_url', 'webUrl', 'web_url', 'url', 'link'],
  streamUrl: ['streamUrl', 'stream_url', 'stream', 'playUrl', 'play_url', 'videoUrl', 'video_url', 'file', 'source', 'hls', 'm3u8', 'playerUrl'],
  downloadUrl: ['downloadUrl', 'download_url', 'download', 'dlUrl', 'dl_url', 'fileUrl'],
  embedUrl: ['embedUrl', 'embed_url', 'embed', 'iframe', 'iframeUrl', 'player'],
  quality: ['quality', 'resolution', 'definition', 'label', 'height'],
  type: ['type', 'kind', 'mediaType', 'media_type', 'mimeType', 'mimetype', 'format']
});

// Documented unwrap table: some APIs wrap a scalar in a small object
// ({ rendered: '...' }, { text: '...' }, { value: '...' }).
const UNWRAP_KEYS = Object.freeze(['text', 'rendered', 'plain_text', 'value', 'name', 'url', 'href']);

const MAX_LENGTHS = Object.freeze({ title: 300, description: 1200, url: 2000, id: 190, other: 120 });

const FIELDS = Object.freeze([
  'source',
  'sourceName',
  'id',
  'title',
  'description',
  'thumbnail',
  'duration',
  'pageUrl',
  'streamUrl',
  'downloadUrl',
  'embedUrl',
  'quality',
  'type',
  'metadata',
  'raw'
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Reads a dot path ('data.results.0.title'). Returns undefined when absent.
function readPath(object, path) {
  if (!path) return undefined;
  let current = object;
  for (const part of String(path).split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function sanitizeText(value, field) {
  let text = value;
  if (isPlainObject(text)) {
    for (const key of UNWRAP_KEYS) {
      if (typeof text[key] === 'string' || typeof text[key] === 'number') {
        text = text[key];
        break;
      }
    }
  }
  if (Array.isArray(text)) {
    const first = text.find((entry) => ['string', 'number'].includes(typeof entry));
    if (first === undefined) return null;
    text = first;
  }
  if (typeof text === 'number' || typeof text === 'boolean') text = String(text);
  if (typeof text !== 'string') return null;
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!clean) return null;
  const limit = MAX_LENGTHS[field] || MAX_LENGTHS.other;
  return clean.length > limit ? clean.slice(0, limit) : clean;
}

function sanitizeValue(value, field) {
  // URLs and ids are strings; duration may stay numeric so nothing is reformatted.
  if (field === 'duration' && typeof value === 'number' && Number.isFinite(value)) return value;
  return sanitizeText(value, field);
}

function pickField(item, field, contractFields) {
  if (!isPlainObject(item) && !Array.isArray(item)) return null;
  const declared = contractFields ? contractFields[field] : '';
  if (declared) {
    const direct = readPath(item, declared);
    const fromDirect = sanitizeValue(direct, field);
    if (fromDirect !== null) return fromDirect;
  }
  for (const alias of FIELD_ALIASES[field] || []) {
    if (!isPlainObject(item)) break;
    if (!Object.prototype.hasOwnProperty.call(item, alias)) continue;
    const value = sanitizeValue(item[alias], field);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Converts one provider item into the universal normalized result.
 * Missing fields are always null and nothing is invented.
 */
function normalizeResult(item, { slot, mode = '', index = 0, contract = {}, discovery = {}, total = null } = {}) {
  const contractFields = contract?.fields || {};
  const source = slot?.id || '';
  const sourceName = sanitizeText(slot?.label, 'other') || source;
  const value = isPlainObject(item) ? item : { value: item };
  const result = {
    source: source || null,
    sourceName: sourceName || null,
    id: null,
    title: null,
    description: null,
    thumbnail: null,
    duration: null,
    pageUrl: null,
    streamUrl: null,
    downloadUrl: null,
    embedUrl: null,
    quality: null,
    type: null,
    metadata: {
      provider: source || null,
      mode: mode || null,
      index,
      listPath: discovery.listPath || null,
      discovered: discovery.discovered === true,
      total: Number.isFinite(total) ? total : null
    },
    raw: item === undefined ? null : item
  };
  for (const field of Object.keys(FIELD_ALIASES)) {
    result[field] = pickField(value, field, contractFields);
  }
  // A scalar item (array of URLs) is used as the media/page URL, never invented.
  if (!isPlainObject(item) && typeof item === 'string') {
    result.pageUrl = sanitizeText(item, 'url');
    if (/\.(mp4|m3u8|mp3|m4a|webm|mov)(\?|$)/i.test(item)) result.streamUrl = sanitizeText(item, 'url');
  }
  return result;
}

// An item with no usable information at all is reported as empty, not returned.
function isEmptyResult(result) {
  return !result || !['title', 'pageUrl', 'streamUrl', 'downloadUrl', 'embedUrl', 'id'].some((field) => result[field] !== null);
}

function emptyNormalizedResult() {
  const result = {};
  for (const field of FIELDS) result[field] = null;
  result.metadata = null;
  return result;
}

// The URL that can actually be streamed/downloaded. A page URL is never used
// as a media URL (see media-engine validation).
function mediaUrlOf(result) {
  return result?.streamUrl || result?.downloadUrl || null;
}

function pageUrlOf(result) {
  return result?.pageUrl || result?.embedUrl || null;
}

module.exports = {
  FIELD_ALIASES,
  FIELDS,
  MAX_LENGTHS,
  UNWRAP_KEYS,
  emptyNormalizedResult,
  isEmptyResult,
  isPlainObject,
  mediaUrlOf,
  normalizeResult,
  pageUrlOf,
  pickField,
  readPath,
  sanitizeText
};
