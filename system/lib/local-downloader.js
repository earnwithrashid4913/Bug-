'use strict';

// =============================================================================
// LOCAL MEDIA ENGINE
// =============================================================================
// Audio/video downloads are performed on the bot host by the yt-dlp executable.
// No third-party download API is called for these commands: yt-dlp talks to the
// source site directly, and FFmpeg (already required for sticker/video output)
// performs the final remux/transcode.
//
// Everything here is deliberately defensive:
//   * one process per request, never a shell string (arguments are passed as an
//     array, so a URL or title can never be interpreted by a shell),
//   * a hard timeout and an output size ceiling,
//   * a unique temporary directory that is always removed,
//   * short, user-safe error messages; raw stderr stays in the server log.

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { config } = require('../config');

const INFO_MAX_BUFFER = 32 * 1024 * 1024;
const RUN_MAX_BUFFER = 4 * 1024 * 1024;
const MAX_TITLE_LENGTH = 120;

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
    cookiesFile: config.downloadsCookiesFile,
    timeoutMs: config.downloadsTimeoutMs,
    maxBytes: config.downloadsMaxFileSizeMb * 1024 * 1024
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null && value !== '') merged[key] = value;
  }
  return merged;
}

function run(bin, args, { timeoutMs, maxBuffer }) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }
      if (error.code === 'ENOENT') {
        reject(new DownloadEngineError(
          `Download engine "${bin}" was not found.`,
          'The download engine (yt-dlp) is not installed on the bot host. Ask the owner to install yt-dlp, then try again.'
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
      const detail = String(stderr || error.message || '').trim();
      reject(engineError(detail, error));
    });
  });
}

function engineError(detail, cause) {
  const text = String(detail || '');
  let userMessage = 'Download failed. Please try a different link or try again later.';
  if (/ffmpeg|avconv/i.test(text)) {
    userMessage = 'FFmpeg is required on the bot host to prepare this media. Install ffmpeg, then try again.';
  } else if (/sign in to confirm|not a bot|cookies|login required/i.test(text)) {
    userMessage = 'The source site requires a signed-in session. Ask the owner to configure downloads.cookiesFile.';
  } else if (/private video|video unavailable|this video is unavailable|removed by the uploader/i.test(text)) {
    userMessage = 'This video is unavailable. Please try a different link.';
  } else if (/requested format is not available/i.test(text)) {
    userMessage = 'No compatible audio/video format was available for this link.';
  } else if (/url is not a valid url|unsupported url/i.test(text)) {
    userMessage = 'That link is not supported by the download engine.';
  }
  return new DownloadEngineError(`yt-dlp failed: ${text || 'unknown error'}`, userMessage);
}

function baseArgs(options) {
  const args = ['--no-playlist', '--no-warnings', '--no-progress', '--no-color', '--socket-timeout', '30', '--retries', '2'];
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

async function getInfo(url, options = settings()) {
  const { stdout } = await run(options.bin, [...baseArgs(options), '-J', url], {
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-md-dl-'));
  try {
    const info = await getInfo(url, options);
    const title = safeTitle(info.title || info.fulltitle);
    const args = [
      ...baseArgs(options),
      '--max-filesize', String(options.maxBytes),
      '-o', path.join(directory, 'media.%(ext)s')
    ];
    if (audio) {
      args.push('-f', 'bestaudio[ext=m4a]/bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '5');
    } else {
      args.push('-f', 'bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4]/b', '--merge-output-format', 'mp4');
    }
    args.push(url);

    await run(options.bin, args, { timeoutMs: options.timeoutMs, maxBuffer: RUN_MAX_BUFFER });
    const file = await outputFrom(directory, audio ? ['mp3', 'm4a', 'opus'] : ['mp4', 'mkv', 'webm']);
    const stat = await fs.stat(file);
    if (stat.size > options.maxBytes) {
      throw new DownloadEngineError(
        `Downloaded file is ${(stat.size / 1024 / 1024).toFixed(1)} MB, above the configured limit.`,
        'That file is too large to send. Please try a shorter video.'
      );
    }
    return {
      buffer: await fs.readFile(file),
      title,
      fileName: `${title}.${audio ? 'mp3' : 'mp4'}`,
      mimetype: audio ? 'audio/mpeg' : 'video/mp4'
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function downloadAudio(url, options) {
  return download(url, 'audio', options);
}

function downloadVideo(url, options) {
  return download(url, 'video', options);
}

module.exports = {
  DownloadEngineError,
  baseArgs,
  download,
  downloadAudio,
  downloadVideo,
  getInfo,
  safeTitle,
  settings
};
