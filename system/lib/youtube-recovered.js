'use strict';

// Recovery adapter, not a replacement extractor. Provider order and response
// parsing are recovered from 8d3bb2f:commands/source-commands.js; local downloads
// delegate to the pre-PR61 engine from be909d2. UI remains in youtube-flow.js.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const dc = require('../../commands/davidcyril-api');
const net = require('./net-tools');
const local = require('./local-downloader');
const { config } = require('../config');
const { assertValidDownload } = require('./media-validation');
const { MediaError, youtubeUrl, classifyError, createLocalProvider, run } = require('./youtube-engine');

function cobaltProviders() {
  // This is the historical configured/environment/fallback order, unchanged.
  return [...new Set([config.cobaltApiUrl, process.env.COBALT_API_URL,
    process.env.COBALT_FALLBACK_API_URL, 'https://cobalt-api.kwiatekmiki.com']
    .filter(value => typeof value === 'string' && /^https:\/\//i.test(value)))];
}
function mediaType(buffer, kind) {
  try { assertValidDownload(buffer, 'Media provider'); }
  catch { throw new MediaError('CORRUPT', 'The provider returned empty media or an error page instead of a file.'); }
  const text = buffer.toString('latin1', 0, 16);
  if (buffer[0] === 255 && (buffer[1] & 0xf6) === 0xf0) {
    if (kind === 'video') throw new MediaError('CORRUPT', 'Audio returned for video.');
    return { ext: 'aac', mimetype: 'audio/aac', asDocument: true };
  }
  if (text.startsWith('ID3') || (buffer[0] === 255 && (buffer[1] & 224) === 224)) {
    if (kind === 'video') throw new MediaError('CORRUPT', 'The video provider returned audio instead of video.');
    return { ext: 'mp3', mimetype: 'audio/mpeg' };
  }
  if (text.startsWith('OggS')) {
    if (kind === 'video') throw new MediaError('CORRUPT', 'The video provider returned audio instead of video.');
    return buffer.includes(Buffer.from('OpusHead')) ? { ext: 'ogg', mimetype: 'audio/ogg; codecs=opus' } : { ext: 'ogg', mimetype: 'audio/ogg', asDocument: true };
  }
  if (buffer.toString('ascii', 4, 8) === 'ftyp' && buffer.includes(Buffer.from('moov')) && buffer.includes(Buffer.from('mdat'))) {
    if (!buffer.includes(Buffer.from('soun')) || (kind === 'video' && !buffer.includes(Buffer.from('vide')))) throw new MediaError('CORRUPT', 'The file is missing the requested media stream.');
    if (kind !== 'video' && buffer.includes(Buffer.from('vide'))) throw new MediaError('CORRUPT', 'The audio provider returned a video file.');
    return kind === 'video' ? { ext: 'mp4', mimetype: 'video/mp4', asDocument: !(buffer.includes(Buffer.from('avc1')) && buffer.includes(Buffer.from('mp4a'))) } : { ext: 'm4a', mimetype: 'audio/mp4' };
  }
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    const matroska = buffer.includes(Buffer.from('matroska'));
    return { ext: matroska ? 'mkv' : 'webm', mimetype: matroska ? (kind === 'video' ? 'video/x-matroska' : 'audio/x-matroska') : (kind === 'video' ? 'video/webm' : 'audio/webm'), asDocument: true };
  }
  throw new MediaError('CORRUPT', 'The provider returned unrecognized or corrupt media.');
}
// Inspect signatures/stream markers with bounded chunks, not fs.readFile on
// a whole download. FFmpeg below remains the full integrity/codec validator.
async function mediaTypeFile(file, kind, maxBytes) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || !stat.size) throw new MediaError('CORRUPT', 'The downloaded file is empty or invalid.');
  if (stat.size > maxBytes) throw new MediaError('SIZE', 'The downloaded file exceeds the configured limit.');
  const markers = ['moov', 'mdat', 'soun', 'vide', 'avc1', 'mp4a', 'OpusHead', 'matroska'];
  const found = new Set(); let head, tail = Buffer.alloc(0), bytes = 0;
  for await (const chunk of require('node:fs').createReadStream(file, { highWaterMark: 64 * 1024 })) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new MediaError('SIZE', 'The downloaded file exceeds the configured limit.');
    head ||= chunk.subarray(0, 512);
    const scan = Buffer.concat([tail, chunk]);
    for (const marker of markers) if (scan.includes(Buffer.from(marker))) found.add(marker);
    tail = scan.subarray(-16);
  }
  if (!head || bytes !== stat.size) throw new MediaError('CORRUPT', 'The downloaded file changed during validation.');
  return mediaType(Buffer.concat([head, ...[...found].map(value => Buffer.from(value))]), kind);
}
function redactDiagnostic(error) {
  return [error?.message || error || '', error?.code, error?.cause?.code, error?.cause?.message].filter(Boolean).join(' | ').replace(/https?:\/\/[^\s'"<>]+/gi, '[url]')
    .replace(/(?:authorization|cookie)\s*[:=]\s*(?:Bearer\s+)?[^\r\n,;|]+/gi, '[credential redacted]')
    .replace(/(?:token|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '[credential redacted]')
    .replace(/--cookies\s+\S+/gi, '--cookies [file]').replace(/[\r\n]+/g, ' ').slice(0, 500);
}
function createRecoveredProvider(overrides = {}, deps = {}) {
  const options = local.settings(overrides);
  const api = deps.dc || dc, tools = deps.net || net, engine = deps.local || local;
  const log = deps.log || ((name, error) => console.warn('[YouTube recovery]', JSON.stringify({ provider: name, code: error.code || 'PROVIDER_FAILED', detail: error.diagnostic })));
  const advanced = deps.advanced || (() => createLocalProvider({ ...overrides, autoInstall: false }));
  const providers = deps.cobaltProviders || cobaltProviders;
  async function apiMedia(result, requestOptions) {
    if (!result?.url || result.ok === false) throw result?.error || new MediaError('PROVIDER', 'The provider returned no downloadable URL.');
    const url = new URL(result.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new MediaError('PROVIDER', 'The provider returned an invalid media URL.');
    // Reuse the existing bounded download helper, including incomplete-body,
    // idle timeout and size checks, rather than handing an unchecked URL to WA.
    if (tools.downloadRemoteFile === net.downloadRemoteFile) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-recovered-'));
      const cleanup = () => fs.rm(directory, { recursive: true, force: true });
      try {
        const file = path.join(directory, 'source.bin');
        await tools.downloadRemoteFile(url.href, options.maxBytes, { signal: requestOptions?.signal, file });
        return { file, cleanup, title: result.title };
      } catch (error) { await cleanup(); throw error; }
    }
    const media = await tools.downloadRemoteFile(url.href, options.maxBytes, { signal: requestOptions?.signal });
    return { buffer: media.buffer, title: result.title, filename: result.filename };
  }
  async function prepare(media, info, kind, progress) {
    const buffer = media.buffer;
    if (media.file && typeof media.cleanup !== 'function') throw new MediaError('MEDIA', 'File ownership is missing.');
    const directory = media.file ? path.dirname(media.file) : await fs.mkdtemp(path.join(os.tmpdir(), 'anime-recovered-'));
    const cleanup = media.cleanup || (() => fs.rm(directory, { recursive: true, force: true }));
    try {
      let type, file;
      if (media.file) { file = media.file; type = await mediaTypeFile(file, kind, options.maxBytes); }
      else {
        if (!Buffer.isBuffer(buffer) || !buffer.length) throw new MediaError('CORRUPT', 'The provider returned an empty file.');
        if (buffer.length > options.maxBytes) throw new MediaError('SIZE', 'The file exceeds the configured media size limit.');
        type = mediaType(buffer, kind);
        file = path.join(directory, `media.${type.ext}`);
        await fs.writeFile(file, buffer, { mode: 0o600 });
      }
      // No first-use binary installation or metadata extraction on a successful
      // API download. FFmpeg is optional for ordinary audio/video, as before.
      const ffmpeg = await engine.resolveFfmpeg(engine.settings({ ...overrides, autoInstall: false }));
      if (kind === 'voice' || (kind === 'audio' && type.ext !== 'mp3' && ffmpeg)) {
        if (!ffmpeg) throw new MediaError('ENGINE', 'VOICE TYPE requires FFmpeg. AUDIO MP3 / ordinary audio downloads remain available.');
        await progress('Processing audio');
        const voice = kind === 'voice';
        const output = path.join(directory, voice ? 'voice.ogg' : 'audio.mp3');
        await run(ffmpeg.command, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe', '-i', file, '-vn',
          ...(voice ? ['-c:a', 'libopus', '-ac', '1', '-ar', '48000', '-b:a', '48k'] : ['-c:a', 'libmp3lame', '-b:a', '128k']),
          '-fs', String(options.maxBytes + 1), output], options).catch(error => {
          if (['TIMEOUT', 'ENGINE', 'SIZE'].includes(error.code)) throw error;
          throw new MediaError('CONVERSION', 'Media conversion failed.');
        });
        file = output;
        type = voice ? { ext: 'ogg', mimetype: 'audio/ogg; codecs=opus' } : { ext: 'mp3', mimetype: 'audio/mpeg' };
      }
      if ((await fs.stat(file)).size > options.maxBytes) throw new MediaError('SIZE', 'The prepared file exceeds the configured size limit.');
      if (ffmpeg) {
        await progress('Validating media');
        const diagnostic = await run(ffmpeg.command, ['-nostdin', '-nostats', '-v', 'info', '-xerror', '-protocol_whitelist', 'file,pipe', '-i', file,
          '-map', '0:a:0', ...(kind === 'video' ? ['-map', '0:v:0'] : ['-vn']), '-f', 'null', '-'], options).catch(error => {
          if (['TIMEOUT', 'ENGINE', 'SIZE'].includes(error.code)) throw error;
          throw new MediaError('CORRUPT', 'The downloaded media could not be decoded.');
        });
        const input = diagnostic.split('Stream mapping:')[0];
        if (kind === 'video') type.asDocument = type.ext !== 'mp4' || !(/Video: h264[^\n]*\byuv420p(?:[,(\s])/.test(input) && /Audio: aac/.test(input));
        if (kind === 'voice' && !/Audio: opus/.test(input)) throw new MediaError('CORRUPT', 'Voice conversion did not produce Opus.');
      }
      const notice = kind === 'audio' && type.ext !== 'mp3' ? `MP3 conversion unavailable; sending original ${type.ext.toUpperCase()} audio, as supported by the previous downloader.` : type.asDocument ? 'Sending the original media as a file for playback compatibility.' : undefined;
      return { file, fileName: `${engine.safeTitle(info.metadataSource && info.metadataSource !== 'fallback' ? info.title : media.title || info.title)}.${type.ext}`, ...type, notice, cleanup };
    } catch (error) { await cleanup(); throw error; }
  }
  return {
    name: 'recovered-api-and-local',
    async inspect(input, seed = {}) {
      const url = youtubeUrl(input);
      let metadataSource = seed.title ? 'search' : 'fallback';
      const metadata = deps.metadata || (!deps.local && tools.youtubeMetadata);
      if (!seed.title && metadata) {
        try { seed = { ...seed, ...await metadata(url) }; metadataSource = 'watch-page'; }
        catch (error) { log('metadata', { code: 'METADATA_UNAVAILABLE', diagnostic: redactDiagnostic(error) }); }
      }
      // IMPORTANT: yt-dlp refusal is not a prerequisite for reaching an API.
      // Use existing search metadata, with honest text defaults for direct URLs.
      return { url, metadataSource, title: engine.safeTitle(seed.title || 'YouTube media'),
        uploader: seed.author || seed.uploader || 'Unknown uploader', duration: Number(seed.duration) || 0,
        durationText: seed.length || '', thumbnail: `https://i.ytimg.com/vi/${new URL(url).searchParams.get('v')}/hqdefault.jpg`,
        audio: true, qualities: [], autoVideo: true };
    },
    async qualities(info) {
      // Optional feature only. Failure must leave the old auto-video route usable.
      const source = await advanced().inspect(info.url);
      info.advancedInfo = source;
      // Successful format discovery also refreshes direct-link metadata.
      for (const field of ['title', 'uploader', 'duration']) if (source[field]) info[field] = source[field];
      return source.qualities;
    },
    async download(info, kind, height, progress = async () => {}) {
      const url = youtubeUrl(info.url);
      if (height !== undefined) {
        // Exact qualities use the existing opt-in strict adapter, never a
        // downgrade to an API's unknown/default resolution.
        const source = info.advancedInfo || await advanced().inspect(url);
        return advanced().download(source, kind, height, progress);
      }
      const cobalt = () => providers().map(endpoint => [`cobalt`, async requestOptions => apiMedia(await tools.requestCobalt(endpoint, url, { audio: kind !== 'video', signal: requestOptions.signal, timeoutMs: requestOptions.timeout }), requestOptions)]);
      const dcAudio = ['davidcyril-audio', async requestOptions => apiMedia(await api.downloadYtAudio(url, requestOptions), requestOptions)];
      const dcVideo = ['davidcyril-video', async requestOptions => apiMedia(await api.downloadYtVideo(url, requestOptions), requestOptions)];
      const aio = ['davidcyril-aio', async requestOptions => {
        const result = await api.aioDownload(url, requestOptions); const data = result?.data || result;
        return apiMedia({ url: api.pickUrl(data), title: api.pickTitle(data) }, requestOptions);
      }];
      const legacy = ['local-pre61', () => kind === 'video' ? engine.downloadVideo(url, { ...overrides, fileBacked: true }) : engine.downloadAudio(url, { ...overrides, fileBacked: true })];
      let attempts = kind === 'video' ? [...cobalt(), dcVideo, aio, legacy] : [dcAudio, ...cobalt(), legacy];
      if (deps.onlyProvider) attempts = attempts.filter(([name]) => name.startsWith(deps.onlyProvider));
      if (!attempts.length) throw new MediaError('PROVIDER', 'The selected provider does not support this media kind.');
      const failures = [];
      for (const [name, operation] of attempts) {
        try {
          await progress(`Downloading • ${name}`);
          const timeout = overrides.providerTimeoutMs || config.downloadsProviderTimeoutMs;
          const signal = AbortSignal.timeout(timeout);
          const media = await operation({ signal, timeout, quietLogs: true });
          const ready = await prepare(media, info, kind, progress);
          ready.provider = name;
          return ready;
        } catch (error) {
          const status = error.httpStatus || error.response?.status;
          const classified = error instanceof MediaError ? error : classifyError(`${status ? `HTTP ${status}: ` : ''}${error.message || ''}`);
          classified.diagnostic = redactDiagnostic(error);
          failures.push({ provider: name, code: classified.code }); log(name, classified);
          // Changing provider before upload is safe; changing source is not.
          if (classified.code === 'SIZE' || (kind === 'voice' && classified.code === 'ENGINE')) throw classified;
        }
      }
      // When every source failed for the SAME actionable reason (e.g. YouTube's
      // bot check for this host), keep that code so the chat shows the real
      // cause instead of a generic "no source" message. Mixed/unclear
      // failures stay aggregated, and the per-provider summary is always logged.
      const actionable = new Set(['BOT_CHECK', 'AUTH', 'RESTRICTED', 'UNAVAILABLE', 'QUALITY', 'TIMEOUT', 'NETWORK']);
      const codes = [...new Set(failures.map(failure => failure.code))];
      const sole = codes.length === 1 && actionable.has(codes[0]) ? codes[0] : 'PROVIDERS';
      const error = new MediaError(sole, `All download providers failed (${failures.map(f => `${f.provider}: ${f.code}`).join('; ')}). No different video or SoundCloud track was substituted.`);
      error.failures = failures;
      throw error;
    }
  };
}
module.exports = { createRecoveredProvider, cobaltProviders, mediaType, mediaTypeFile, redactDiagnostic };
