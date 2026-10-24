'use strict';

// =============================================================================
// LOCAL MEDIA ENGINE
// =============================================================================
// Audio/video downloads are performed on the bot host by the yt-dlp executable.
// No third-party download API is called for these commands: yt-dlp talks to the
// source site directly.
//
// The engine is self-provisioning, because a fresh host (a panel, a VPS, a
// container) normally has no yt-dlp binary and the bot must not dead-end there:
//
//   1. an absolute/relative path from `downloads.ytDlpPath` is authoritative and
//      is never replaced,
//   2. a plain command name is looked up on PATH,
//   3. the bundled copy in `downloads.binDir` (default `<dataDir>/bin`) is used,
//   4. a Python installation that already has the `yt_dlp` module is used,
//   5. otherwise the official standalone yt-dlp release for this platform is
//      downloaded once into `downloads.binDir` and verified with `--version`.
//
// FFmpeg is optional for !play/!video: when it is missing the engine downloads a
// ready-to-play M4A (audio) or a progressive MP4 (video) instead of merging or
// transcoding. FFmpeg is still used when present because it produces MP3 and
// merged high-quality MP4 output.
//
// Everything else is deliberately defensive:
//   * one process per request, never a shell string (arguments are passed as an
//     array, so a URL or title can never be interpreted by a shell),
//   * a hard timeout and an output size ceiling,
//   * a unique temporary directory that is always removed,
//   * one automatic retry with a relaxed format when the first format is gone,
//   * short, user-safe error messages; raw stderr stays in the server log.

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { config } = require('../config');

const INFO_MAX_BUFFER = 32 * 1024 * 1024;
const RUN_MAX_BUFFER = 4 * 1024 * 1024;
const PROBE_MAX_BUFFER = 1024 * 1024;
const MAX_TITLE_LENGTH = 120;
const PROBE_TIMEOUT_MS = 20_000;
const PROVISION_TIMEOUT_MS = 120_000;
const MIN_ENGINE_BYTES = 512 * 1024;
const MIN_FFMPEG_BYTES = 5 * 1024 * 1024;
const FFMPEG_CACHE_MS = 5 * 60 * 1000;
const FFMPEG_RETRY_BACKOFF_MS = 5 * 60 * 1000;

// Official standalone builds. `ANIME_MD_YTDLP_URL` / `ANIME_MD_FFMPEG_URL` may
// point at a mirror when a host cannot reach GitHub; they are never required.
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const FFMPEG_RELEASE_BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0';

const RETRYABLE = /requested format is not available|no such format|unable to extract|signature extraction failed|http error 403|failed to extract|no video formats found|only images are available/i;
const BOT_CHECK = /sign in to confirm|not a bot|cookies|login required|confirm your age|age-restricted/i;

class DownloadEngineError extends Error {
  constructor(message, userMessage) {
    super(message);
    this.name = 'DownloadEngineError';
    this.userMessage = userMessage;
  }
}

function settings(overrides = {}) {
  const merged = {
    bin: config.downloadsYtDlpPath,
    binDir: config.downloadsBinDir,
    autoInstall: config.downloadsAutoInstall,
    ffmpegPath: config.downloadsFfmpegPath,
    cookiesFile: config.downloadsCookiesFile,
    timeoutMs: config.downloadsTimeoutMs,
    maxBytes: config.downloadsMaxFileSizeMb * 1024 * 1024,
    ffmpeg: undefined,
    fetchImpl: undefined,
    engineUrl: undefined,
    minBytes: undefined,
    explicitBin: false
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'bin') merged.explicitBin = true;
    merged[key] = value;
  }
  return merged;
}

function isPathLike(value) {
  return path.isAbsolute(value) || value.includes('/') || value.includes('\\');
}

function spawnEngine(engine, args, { timeoutMs, maxBuffer }) {
  const command = engine.command;
  const fullArgs = [...(engine.prefixArgs || []), ...args];
  return new Promise((resolve, reject) => {
    execFile(command, fullArgs, { timeout: timeoutMs, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }
      if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM') {
        reject(new DownloadEngineError(
          `Download engine "${command}" could not be started (${error.code}).`,
          'The download engine (yt-dlp) is not available on the bot host. Please try again shortly; if it keeps failing, install yt-dlp or set downloads.ytDlpPath.'
        ));
        return;
      }
      if (error.killed || error.signal) {
        reject(new DownloadEngineError(
          `Download engine timed out after ${Math.round(timeoutMs / 1000)}s.`,
          'The download timed out. Please try again.'
        ));
        return;
      }
      reject(engineError(String(stderr || error.message || '').trim()));
    });
  });
}

async function probe(engine, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await spawnEngine(engine, ['--version'], { timeoutMs, maxBuffer: PROBE_MAX_BUFFER });
    const version = String(stdout || '').trim().split(/\s+/)[0];
    return version || 'unknown';
  } catch {
    return null;
  }
}

function probeFfmpeg(command, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(command, ['-version'], { timeout: timeoutMs, maxBuffer: PROBE_MAX_BUFFER, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const text = String(stdout || '');
      const match = text.match(/ffmpeg version (\S+)/i);
      resolve(match ? match[1] : 'unknown');
    });
  });
}

function pythonEngineCandidates() {
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push({ command: 'py', prefixArgs: ['-3', '-m', 'yt_dlp'] });
    candidates.push({ command: 'python', prefixArgs: ['-m', 'yt_dlp'] });
  }
  candidates.push({ command: 'python3', prefixArgs: ['-m', 'yt_dlp'] });
  candidates.push({ command: 'python', prefixArgs: ['-m', 'yt_dlp'] });
  return candidates;
}

function platformEngineAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform !== 'linux') return null;
  let musl = false;
  try {
    musl = !process.report?.getReport?.()?.header?.glibcVersionRuntime;
  } catch {
    musl = false;
  }
  if (arch === 'arm64') return musl ? 'yt-dlp_musllinux_aarch64' : 'yt-dlp_linux_aarch64';
  if (arch === 'x64') return musl ? 'yt-dlp_musllinux' : 'yt-dlp_linux';
  if (arch === 'arm') return musl ? 'yt-dlp_musllinux_armv7l' : 'yt-dlp_linux_armv7l';
  return null;
}

function platformFfmpegAsset(platform = process.platform, arch = process.arch) {
  const supported = new Set(['x64', 'arm64', 'arm', 'ia32']);
  if (!supported.has(arch)) return null;
  if (platform === 'win32') return `ffmpeg-win32-${arch}`;
  if (platform === 'darwin') return `ffmpeg-darwin-${arch}`;
  if (platform === 'linux') return `ffmpeg-linux-${arch}`;
  return null;
}

async function downloadAsset({ url, target, minBytes, message, fetchImpl, timeoutMs }) {
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation is available to download the binary.');
  await fs.mkdir(path.dirname(target), { recursive: true });
  console.info(`[Download] Installing ${message} into ${path.dirname(target)} (one-time setup).`);
  const response = await fetchImpl(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'ANIME-MD' },
    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
  });
  if (!response || !response.ok) {
    throw new Error(`${message} download failed (HTTP ${response ? response.status : 'unknown'}).`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < minBytes) {
    throw new Error(`${message} download was incomplete (${buffer.length} bytes).`);
  }
  const temporary = `${target}.${process.pid}.download`;
  await fs.writeFile(temporary, buffer, { mode: 0o755 });
  await fs.chmod(temporary, 0o755).catch(() => {});
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o755).catch(() => {});
}

async function provisionEngine({
  binDir = config.downloadsBinDir,
  fetchImpl = globalThis.fetch,
  url,
  platform = process.platform,
  arch = process.arch,
  timeoutMs = PROVISION_TIMEOUT_MS,
  minBytes = MIN_ENGINE_BYTES
} = {}) {
  const asset = url || process.env.ANIME_MD_YTDLP_URL || (() => {
    const name = platformEngineAsset(platform, arch);
    return name ? `${RELEASE_BASE}/${name}` : null;
  })();
  if (!asset) throw new Error(`No standalone yt-dlp build is published for ${platform}/${arch}.`);

  const executable = path.join(binDir, platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  await downloadAsset({ url: asset, target: executable, minBytes, message: 'yt-dlp', fetchImpl, timeoutMs });

  const engine = { command: executable, prefixArgs: [] };
  const version = await probe(engine);
  if (!version) {
    await fs.rm(executable, { force: true }).catch(() => {});
    throw new Error('The downloaded yt-dlp binary could not run on this host; downloads.binDir may be mounted noexec.');
  }
  return { ...engine, version, source: 'provisioned' };
}

async function provisionFfmpeg({
  binDir = config.downloadsBinDir,
  fetchImpl = globalThis.fetch,
  url,
  platform = process.platform,
  arch = process.arch,
  timeoutMs = PROVISION_TIMEOUT_MS,
  minBytes = MIN_FFMPEG_BYTES
} = {}) {
  const asset = url || process.env.ANIME_MD_FFMPEG_URL || (() => {
    const name = platformFfmpegAsset(platform, arch);
    return name ? `${FFMPEG_RELEASE_BASE}/${name}` : null;
  })();
  if (!asset) throw new Error(`No standalone FFmpeg build is published for ${platform}/${arch}.`);

  const executable = path.join(binDir, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  await downloadAsset({ url: asset, target: executable, minBytes, message: 'FFmpeg', fetchImpl, timeoutMs });

  const version = await probeFfmpeg(executable);
  if (!version) {
    await fs.rm(executable, { force: true }).catch(() => {});
    throw new Error('The downloaded FFmpeg binary could not run on this host.');
  }
  return { command: executable, version, source: 'provisioned' };
}

const engineCache = new Map();

function cacheKey(options) {
  return [options.bin, options.binDir, options.autoInstall, options.explicitBin].join('|');
}

async function resolveUncached(options) {
  const bin = String(options.bin || 'yt-dlp').trim() || 'yt-dlp';

  // An owner-supplied path always wins and is never replaced behind their back.
  if (isPathLike(bin)) {
    const version = await probe({ command: bin, prefixArgs: [] });
    if (version) return { command: bin, prefixArgs: [], version, source: 'config' };
    throw new DownloadEngineError(
      `Download engine "${bin}" was not found.`,
      'The download engine (yt-dlp) is not installed at the configured downloads.ytDlpPath. Fix that path or install yt-dlp, then try again.'
    );
  }

  const onPath = await probe({ command: bin, prefixArgs: [] });
  if (onPath) return { command: bin, prefixArgs: [], version: onPath, source: 'path' };

  if (options.binDir) {
    const bundled = { command: path.join(options.binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'), prefixArgs: [] };
    const version = await probe(bundled);
    if (version) return { ...bundled, version, source: 'bundled' };
  }

  for (const candidate of pythonEngineCandidates()) {
    const version = await probe(candidate);
    if (version) return { ...candidate, version, source: 'python' };
  }

  if (options.autoInstall) {
    try {
      return await provisionEngine({
        binDir: options.binDir,
        fetchImpl: options.fetchImpl,
        url: options.engineUrl,
        minBytes: options.minBytes
      });
    } catch (error) {
      console.warn('[Download] Automatic yt-dlp setup failed:', error?.message || error);
      throw new DownloadEngineError(
        `Download engine "yt-dlp" is not installed and could not be downloaded: ${error?.message || error}`,
        'The download engine (yt-dlp) is not installed and its automatic setup failed. Check the host connection, then try again; the owner can also install yt-dlp or set downloads.ytDlpPath.'
      );
    }
  }

  throw new DownloadEngineError(
    `Download engine "${bin}" was not found.`,
    'The download engine (yt-dlp) is not installed on the bot host. Enable downloads.autoInstall, install yt-dlp, or set downloads.ytDlpPath, then try again.'
  );
}

async function resolveEngine(options = settings()) {
  const key = cacheKey(options);
  const cached = engineCache.get(key);
  if (cached) return cached;
  const pending = resolveUncached(options);
  engineCache.set(key, pending);
  // A failed resolution (offline host, GitHub blocked) must be retried on the
  // next command instead of poisoning the process for its whole lifetime.
  pending.catch(() => engineCache.delete(key));
  return pending;
}

const ffmpegEngineCache = new Map();
let ffmpegRetryAfter = 0;

async function resolveFfmpegUncached(options) {
  if (options.ffmpeg === true) return { command: 'ffmpeg', version: 'assumed', source: 'assumed' };
  const configured = String(options.ffmpegPath || '').trim();
  if (configured) {
    const version = await probeFfmpeg(configured);
    if (version) return { command: configured, version, source: 'config' };
    console.warn(`[Download] downloads.ffmpegPath "${configured}" is not usable; looking elsewhere.`);
  }
  const onPath = await probeFfmpeg('ffmpeg');
  if (onPath) return { command: 'ffmpeg', version: onPath, source: 'path' };

  if (options.binDir) {
    const bundled = path.join(options.binDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const version = await probeFfmpeg(bundled);
    if (version) return { command: bundled, version, source: 'bundled' };
  }

  if (options.autoInstall && Date.now() >= ffmpegRetryAfter) {
    try {
      return await provisionFfmpeg({
        binDir: options.binDir,
        fetchImpl: options.fetchImpl,
        url: options.ffmpegUrl,
        minBytes: options.minFfmpegBytes
      });
    } catch (error) {
      ffmpegRetryAfter = Date.now() + FFMPEG_RETRY_BACKOFF_MS;
      console.warn('[Download] Automatic FFmpeg setup failed (media still works in reduced quality):', error?.message || error);
    }
  }
  return null;
}

async function resolveFfmpeg(options = settings()) {
  if (options.ffmpeg === false) return null;
  const key = [options.ffmpegPath, options.binDir, options.autoInstall].join('|');
  const cached = ffmpegEngineCache.get(key);
  if (cached) return cached;
  const pending = resolveFfmpegUncached(options);
  ffmpegEngineCache.set(key, pending);
  pending.then((value) => { if (!value) ffmpegEngineCache.delete(key); }).catch(() => ffmpegEngineCache.delete(key));
  return pending;
}

function resetEngineCache() {
  engineCache.clear();
  ffmpegEngineCache.clear();
  ffmpegRetryAfter = 0;
  ffmpegState = { value: null, at: 0 };
}

let ffmpegState = { value: null, at: 0 };
function detectFfmpeg({ bin = 'ffmpeg', timeoutMs = 10_000 } = {}) {
  const now = Date.now();
  if (process.env.ANIME_MD_FFMPEG === '0') return Promise.resolve(false);
  if (process.env.ANIME_MD_FFMPEG === '1') return Promise.resolve(true);
  if (ffmpegState.value !== null && now - ffmpegState.at < FFMPEG_CACHE_MS) return Promise.resolve(ffmpegState.value);
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: timeoutMs, maxBuffer: PROBE_MAX_BUFFER, windowsHide: true }, (error) => {
      const value = !error;
      ffmpegState = { value, at: Date.now() };
      resolve(value);
    });
  });
}

function engineError(detail, cause) {
  const text = String(detail || '');
  let userMessage = 'Download failed. Please try a different link or try again later.';
  if (/ffmpeg|avconv/i.test(text)) {
    userMessage = 'The media could not be prepared on the bot host. Please try again in a moment.';
  } else if (BOT_CHECK.test(text)) {
    userMessage = 'The source site requires a signed-in session. Ask the owner to configure downloads.cookiesFile.';
  } else if (/private video|video unavailable|this video is unavailable|removed by the uploader|has been removed/i.test(text)) {
    userMessage = 'This video is unavailable. Please try a different link.';
  } else if (/requested format is not available|no such format/i.test(text)) {
    userMessage = 'No compatible audio/video format was available for this link.';
  } else if (/larger than max-filesize|exceeds the maximum file size/i.test(text)) {
    userMessage = 'That file is too large to send. Please try a shorter video.';
  } else if (/url is not a valid url|unsupported url/i.test(text)) {
    userMessage = 'That link is not supported by the download engine.';
  } else if (/http error 429|too many requests/i.test(text)) {
    userMessage = 'The source site is rate-limiting right now. Please try again in a minute.';
  } else if (/timed out|temporary failure|getaddrinfo|network is unreachable|connection reset|connection refused/i.test(text)) {
    userMessage = 'The bot host could not reach the source site. Please try again in a moment.';
  }
  return new DownloadEngineError(`yt-dlp failed: ${text || 'unknown error'}`, userMessage);
}

function baseArgs(options) {
  const args = ['--no-playlist', '--no-warnings', '--no-progress', '--no-color', '--socket-timeout', '30', '--retries', '2'];
  if (options.jsRuntime) args.push('--js-runtimes', `node:${options.jsRuntime}`);
  if (options.cookiesFile) args.push('--cookies', options.cookiesFile);
  return args;
}

function safeTitle(value) {
  return String(value || 'media')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH) || 'media';
}

function audioFormatArgs(hasFfmpeg) {
  return hasFfmpeg
    ? ['-f', 'bestaudio[ext=m4a]/bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '5']
    : ['-f', 'bestaudio[ext=m4a]/bestaudio[ext=opus]/bestaudio/best'];
}

function videoFormatArgs(hasFfmpeg) {
  return hasFfmpeg
    ? ['-f', 'bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4]/b', '--merge-output-format', 'mp4']
    : ['-f', 'b[ext=mp4][acodec!=none][vcodec!=none][height<=720]/18/b[ext=mp4]/b'];
}

function fallbackFormatArgs(audio, hasFfmpeg) {
  if (audio) return ['-f', 'bestaudio/best'];
  return hasFfmpeg ? ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'] : ['-f', 'b[ext=mp4]/18/b'];
}

function mimetypeFor(extension, audio) {
  const ext = String(extension || '').toLowerCase();
  if (audio) {
    if (ext === 'mp3') return 'audio/mpeg';
    if (ext === 'm4a' || ext === 'aac') return 'audio/mp4';
    if (ext === 'ogg' || ext === 'opus') return 'audio/ogg';
    if (ext === 'webm') return 'audio/webm';
    if (ext === 'wav') return 'audio/wav';
    return 'audio/mpeg';
  }
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mkv') return 'video/x-matroska';
  return 'video/mp4';
}

async function getInfo(url, options = settings()) {
  const engine = await resolveEngine(options);
  const { stdout } = await spawnEngine(engine, [...baseArgs(options), '-J', url], {
    timeoutMs: options.timeoutMs,
    maxBuffer: INFO_MAX_BUFFER
  });
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new DownloadEngineError('yt-dlp returned unreadable metadata.', 'Download failed. Please try again later.');
  }
  if (!info || typeof info !== 'object') throw new DownloadEngineError('yt-dlp returned no metadata.', 'Download failed. Please try again later.');
  if (info._type === 'playlist') throw new DownloadEngineError('Playlist links are not supported.', 'Please send a single video link, not a playlist.');
  return info;
}

async function searchByPrefix(prefix, query, options, limit, label) {
  const text = String(query || '').trim();
  if (!text) throw new DownloadEngineError('Empty search query.', 'Please send a song or video name.');
  const count = Math.min(Math.max(Number(limit) || 1, 1), 10);
  const engine = await resolveEngine(options);
  const { stdout } = await spawnEngine(engine, [...baseArgs(options), '--flat-playlist', '-J', `${prefix}${count}:${text}`], {
    timeoutMs: options.timeoutMs,
    maxBuffer: INFO_MAX_BUFFER
  });
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new DownloadEngineError('yt-dlp returned unreadable search results.', `No ${label} result was found for that query.`);
  }
  const entries = Array.isArray(data?.entries) ? data.entries.filter((item) => item && (item.id || item.url)) : [];
  if (!entries.length) throw new DownloadEngineError('No search results', `No ${label} result was found for that query.`);
  return entries;
}

async function searchVideo(query, options = settings(), limit = 1) {
  const entries = await searchByPrefix('ytsearch', query, options, limit, 'YouTube');
  return entries.map((entry) => ({
    title: entry.title || 'media',
    url: entry.webpage_url || entry.url || `https://www.youtube.com/watch?v=${entry.id}`
  }));
}

// SoundCloud is the second local source for audio. It needs no account and no
// API key, and it is used only when YouTube itself refuses the request, so a
// blocked YouTube session does not take !play down with it. Because SoundCloud
// search is fuzzy, a result is only accepted when it really matches the query;
// a wrong song is worse than an honest failure.
const AUDIO_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'song', 'songs', 'video', 'music', 'official', 'latest', 'full', 'audio', 'mp3', 'new', 'all', 'one', 'best', 'mix', 'remix', 'lyrics']);

function searchTokens(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !AUDIO_STOPWORDS.has(token));
}

function audioMatchScore(query, title) {
  const wanted = searchTokens(query);
  const found = new Set(searchTokens(title));
  if (!wanted.length) {
    // Non-Latin queries keep their natural order: token overlap cannot be
    // measured reliably, so the source ranking is used unchanged.
    return String(title || '').toLowerCase().includes(String(query || '').toLowerCase().trim()) ? 1 : 0;
  }
  const hits = wanted.filter((token) => found.has(token)).length;
  return hits / wanted.length;
}

async function searchAudio(query, options = settings(), limit = 3) {
  const entries = await searchByPrefix('scsearch', query, options, 10, 'audio');
  return entries
    .filter((entry) => !Number.isFinite(entry.duration) || entry.duration <= 15 * 60)
    .map((entry) => ({
      title: entry.title || entry.track || 'media',
      url: entry.webpage_url || entry.url || '',
      score: audioMatchScore(query, entry.title || entry.track || '')
    }))
    .filter((entry) => entry.url && entry.score >= 0.6)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Number(limit) || 3))
    .map(({ title, url }) => ({ title, url }));
}

async function outputFrom(directory, preferredExtensions) {
  const entries = await fs.readdir(directory);
  const usable = entries.filter((name) => !name.endsWith('.part') && !name.startsWith('.'));
  if (!usable.length) throw new DownloadEngineError('yt-dlp produced no output file.', 'Download failed. Please try again later.');
  const preferred = usable.find((name) => preferredExtensions.includes(path.extname(name).slice(1).toLowerCase()));
  const chosen = preferred || usable[0];
  const file = path.join(directory, chosen);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size === 0) throw new DownloadEngineError('yt-dlp produced an empty file.', 'Download failed. Please try again later.');
  return file;
}

async function download(url, mode, options = settings()) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new DownloadEngineError('Invalid media URL.', 'Please send a valid http(s) link.');
  }
  const audio = mode === 'audio';
  // Both tools are resolved together so a first-run install of yt-dlp and
  // FFmpeg happens in parallel instead of one after the other.
  const [engine, ffmpeg] = await Promise.all([resolveEngine(options), resolveFfmpeg(options)]);
  const hasFfmpeg = Boolean(ffmpeg);
  const ffmpegArgs = ffmpeg && !['path', 'assumed'].includes(ffmpeg.source) ? ['--ffmpeg-location', ffmpeg.command] : [];
  const info = await getInfo(url, options);
  const title = safeTitle(info.title || info.fulltitle);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-md-dl-'));
  try {
    const outputTemplate = path.join(directory, 'media.%(ext)s');
    const attempts = [
      audio ? audioFormatArgs(hasFfmpeg) : videoFormatArgs(hasFfmpeg),
      fallbackFormatArgs(audio, hasFfmpeg)
    ];
    let lastError = null;
    for (let index = 0; index < attempts.length; index += 1) {
      const args = [
        ...baseArgs(options),
        ...ffmpegArgs,
        '--max-filesize', String(options.maxBytes),
        '-o', outputTemplate,
        ...attempts[index],
        url
      ];
      try {
        await spawnEngine(engine, args, { timeoutMs: options.timeoutMs, maxBuffer: RUN_MAX_BUFFER });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (index === attempts.length - 1) break;
        // Only a format/extractor problem is worth a second attempt; a bot check,
        // an unavailable video or a timeout will fail again immediately.
        if (!(error instanceof DownloadEngineError) || !RETRYABLE.test(String(error.message || ''))) break;
        await fs.rm(directory, { recursive: true, force: true });
        await fs.mkdir(directory, { recursive: true });
        console.warn('[Download] Retrying with a relaxed format after:', error.message);
      }
    }
    if (lastError) throw lastError;

    const file = await outputFrom(directory, audio ? ['mp3', 'm4a', 'opus', 'ogg', 'webm'] : ['mp4', 'mkv', 'webm']);
    const stat = await fs.stat(file);
    if (stat.size > options.maxBytes) {
      throw new DownloadEngineError(
        `Downloaded file is ${(stat.size / 1024 / 1024).toFixed(1)} MB, above the configured limit.`,
        'That file is too large to send. Please try a shorter video.'
      );
    }
    const extension = path.extname(file).slice(1).toLowerCase() || (audio ? 'mp3' : 'mp4');
    return {
      buffer: await fs.readFile(file),
      title,
      fileName: `${title}.${extension}`,
      mimetype: mimetypeFor(extension, audio)
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function downloadAudio(url, options) {
  return download(url, 'audio', settings(options));
}

function downloadVideo(url, options) {
  return download(url, 'video', settings(options));
}

module.exports = {
  DownloadEngineError,
  audioFormatArgs,
  audioMatchScore,
  baseArgs,
  detectFfmpeg,
  download,
  downloadAudio,
  downloadVideo,
  getInfo,
  mimetypeFor,
  platformEngineAsset,
  platformFfmpegAsset,
  probe,
  probeFfmpeg,
  provisionEngine,
  provisionFfmpeg,
  resetEngineCache,
  resolveEngine,
  resolveFfmpeg,
  safeTitle,
  searchAudio,
  searchVideo,
  settings,
  videoFormatArgs
};
