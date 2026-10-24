'use strict';

// Strict, file-backed YouTube adapter around the bot's existing local engine.
// Providers implement inspect(url), download(info, kind, height, progress).
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const local = require('./local-downloader');

class MediaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function youtubeUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new MediaError('INPUT', 'Please send a valid YouTube video URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)) {
    throw new MediaError('INPUT', 'Only YouTube video links are supported.');
  }
  const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) :
    /^\/(shorts|live|embed)\//.test(url.pathname) ? url.pathname.split('/')[2] :
      url.pathname === '/watch' ? url.searchParams.get('v') : '';
  if (!/^[\w-]{11}$/.test(id || '')) throw new MediaError('INPUT', 'Please send a single valid YouTube video link, not a playlist or channel.');
  return `https://www.youtube.com/watch?v=${id}`;
}
const h264 = f => /^(avc1|h264)/i.test(f.vcodec || '');
const aac = f => /^(mp4a|aac)/i.test(f.acodec || '');
function availableFormats(info, maxBytes) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const audios = formats.filter(f => f.ext === 'm4a' && aac(f) && f.vcodec === 'none' && /^[\w.-]+$/.test(String(f.format_id)));
  const withinLimit = (f, extra = 0) => !(Number(f.filesize || f.filesize_approx) > maxBytes - extra);
  const audio = audios.filter(f => withinLimit(f)).sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  const qualities = new Map();
  for (const f of formats) {
    if (f.ext !== 'mp4' || !h264(f) || !Number.isInteger(f.height) || !/^[\w.-]+$/.test(String(f.format_id))) continue;
    const combined = aac(f);
    if (!combined && !(f.acodec === 'none' && audio)) continue;
    const extra = combined ? 0 : Number(audio.filesize || audio.filesize_approx || 0);
    if (!withinLimit(f, extra)) continue;
    const existing = qualities.get(f.height);
    if (!existing || Number(f.tbr || 0) > existing.bitrate) {
      qualities.set(f.height, { height: f.height, selector: combined ? String(f.format_id) : `${f.format_id}+${audio.format_id}`, bitrate: Number(f.tbr || 0) });
    }
  }
  return [...qualities.values()].sort((a, b) => b.height - a.height);
}

// Bounded output, subprocess lifetime and aggregate temporary disk use, including
// intermediate streams. Never invoke a shell or log token-bearing stderr.
function run(command, args, { timeoutMs, directory, maxBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', failure, checking = false;
    const kill = error => { failure ||= error; child.kill('SIGKILL'); };
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-65536); });
    const timer = setTimeout(() => kill(new MediaError('TIMEOUT', 'The media operation timed out. Please try again.')), timeoutMs);
    const disk = directory && setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        let bytes = 0;
        for (const name of await fs.readdir(directory)) bytes += (await fs.stat(path.join(directory, name))).size;
        if (bytes > maxBytes) kill(new MediaError('SIZE', 'The download exceeds the temporary storage limit. Choose a smaller quality.'));
      } catch (error) { if (error.code !== 'ENOENT') kill(new MediaError('DISK', 'Temporary storage is unavailable.')); }
      finally { checking = false; }
    }, 250);
    function finish(error) {
      clearTimeout(timer); clearInterval(disk);
      if (error || failure) reject(failure || error); else resolve(stderr);
    }
    child.once('error', () => finish(new MediaError('ENGINE', 'The required media tool could not start. Ask the owner to check the download configuration.')));
    child.once('close', code => finish(code ? classifyError(stderr) : null));
  });
}
function classifyError(text) {
  if (/timed out|timeout|stalled/i.test(text)) return new MediaError('TIMEOUT', 'The media source timed out. Please try again.');
  if (/unreadable.*metadata|no metadata/i.test(text)) return new MediaError('METADATA', 'The source returned malformed or incomplete metadata.');
  if (/could not be started|not installed|not found|could not run|unrecognized.*js-runtimes|javascript runtime|challenge.*solver/i.test(text)) return new MediaError('ENGINE', 'The download engine could not run. Ask the owner to check yt-dlp and FFmpeg.');
  if (/429|5\d\d|temporar|connection reset/i.test(text)) return new MediaError('TRANSIENT', 'The media source is temporarily unavailable. Please try again later.');
  if (/403|404|not available|private|removed|sign in|age.restrict|not a bot|cookies|geo|region/i.test(text)) return new MediaError('RESTRICTED', 'YouTube refused this video. It may be restricted, unavailable, or require an authorized session.');
  if (/requested format|no.*format/i.test(text)) return new MediaError('QUALITY', 'That format is no longer available. Start a new request to refresh the qualities.');
  if (/exceed|max.file|too large/i.test(text)) return new MediaError('SIZE', 'That media is too large. Choose a smaller quality or a shorter video.');
  return new MediaError('MEDIA', 'The source or media processing failed. Please try another accessible video.');
}
async function retry(operation, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 1 || error.code !== 'TRANSIENT') throw error;
      await sleep(750 * 2 ** attempt);
    }
  }
}
async function validateFile(file, kind, ffmpeg, options) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || !stat.size) throw new MediaError('CORRUPT', 'The source returned an empty file.');
  if (stat.size > options.maxBytes) throw new MediaError('SIZE', 'The media exceeds the configured WhatsApp size limit.');
  const handle = await fs.open(file, 'r');
  const header = Buffer.alloc(64);
  try { await handle.read(header, 0, 64, 0); } finally { await handle.close(); }
  if (kind === 'video' ? header.toString('ascii', 4, 8) !== 'ftyp' :
      kind === 'voice' ? header.toString('ascii', 0, 4) !== 'OggS' :
        !(header.toString('ascii', 0, 3) === 'ID3' || (header[0] === 255 && (header[1] & 224) === 224))) {
    throw new MediaError('CORRUPT', 'The source returned an invalid media file.');
  }
  // Decode the entire file, not just its extension or an HTTP content-type.
  const diagnostic = await run(ffmpeg.command, ['-nostdin', '-nostats', '-v', 'info', '-xerror', '-protocol_whitelist', 'file,pipe', '-i', file,
    '-map', '0:a:0', ...(kind === 'video' ? ['-map', '0:v:0'] : ['-vn']), '-f', 'null', '-'], options);
  const input = diagnostic.split('Stream mapping:')[0];
  const codec = kind === 'video' ? /Video: h264/ : kind === 'voice' ? /Audio: opus/ : /Audio: mp3/;
  if (!codec.test(input) || (kind === 'video' && !/Audio: aac/.test(input))) throw new MediaError('CORRUPT', 'The output codecs are not compatible with the selected WhatsApp format.');
  if (options.expectedHeight && !new RegExp(`Video: h264[^\n]*\\b\\d+x${options.expectedHeight}\\b`).test(input)) {
    throw new MediaError('QUALITY', 'The output resolution did not match the requested quality.');
  }
  const duration = input.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const seconds = duration && Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  if (options.expectedDuration && (!seconds || Math.abs(options.expectedDuration - seconds) > Math.max(3, options.expectedDuration * 0.02))) {
    throw new MediaError('CORRUPT', 'The downloaded duration did not match the source; the file may be incomplete.');
  }
}

function createLocalProvider(overrides = {}) {
  const options = local.settings({ jsRuntime: process.execPath, ...overrides });
  return {
    name: 'yt-dlp',
    async inspect(input) {
      const url = youtubeUrl(input);
      const [raw, ffmpeg] = await Promise.all([
        retry(async () => { try { return await local.getInfo(url, options); } catch (e) { throw classifyError(e.message); } }),
        local.resolveFfmpeg(options)
      ]);
      if (raw?.id !== new URL(url).searchParams.get('v') || raw.is_live || !Array.isArray(raw.formats)) throw new MediaError('METADATA', 'The source returned incomplete metadata or a live stream.');
      if (!ffmpeg) throw new MediaError('ENGINE', 'FFmpeg is required for verified MP3, voice notes and MP4 delivery. Ask the owner to install FFmpeg.');
      const qualities = availableFormats(raw, options.maxBytes);
      return { url, title: local.safeTitle(raw.title), uploader: String(raw.uploader || raw.channel || 'Unknown uploader').slice(0, 160),
        duration: Number(raw.duration) || 0, thumbnail: `https://i.ytimg.com/vi/${new URL(url).searchParams.get('v')}/hqdefault.jpg`,
        qualities, audio: raw.formats.some(f => f.acodec && f.acodec !== 'none'), ffmpeg };
    },
    async download(info, kind, height, progress = async () => {}) {
      const url = youtubeUrl(info.url);
      const quality = info.qualities.find(f => f.height === height);
      if (kind === 'video' && !quality) throw new MediaError('QUALITY', 'The requested resolution is unavailable.');
      if (kind !== 'video' && !info.audio) throw new MediaError('AUDIO', 'No audio stream is available for this video.');
      const engine = await local.resolveEngine(options);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-youtube-'));
      const cleanup = () => fs.rm(directory, { recursive: true, force: true });
      const ext = kind === 'video' ? 'mp4' : kind === 'voice' ? 'ogg' : 'mp3';
      try {
        await progress('Downloading');
        await retry(async () => {
          for (const name of await fs.readdir(directory)) await fs.rm(path.join(directory, name), { force: true });
          await run(engine.command, [...(engine.prefixArgs || []), ...local.baseArgs(options), '--ignore-config',
            '--no-cache-dir', '--no-write-thumbnail', '--no-write-info-json', '--no-write-subs',
            '--ffmpeg-location', info.ffmpeg.command, '--max-filesize', String(options.maxBytes),
            '-f', kind === 'video' ? quality.selector : 'bestaudio/best',
            ...(kind === 'video' ? ['--merge-output-format', 'mp4'] : []),
            '-o', path.join(directory, 'source.%(ext)s'), '--', url],
          { ...options, directory, maxBytes: options.maxBytes * 3 });
        });
        const names = (await fs.readdir(directory)).filter(n => /^source\.[a-z0-9]+$/i.test(n));
        if (names.length !== 1) throw new MediaError('CORRUPT', 'The source did not produce a complete media file.');
        const source = path.join(directory, names[0]);
        if ((await fs.stat(source)).size > options.maxBytes) throw new MediaError('SIZE', 'That file exceeds the configured media size limit.');
        const file = path.join(directory, `ready.${ext}`);
        await progress('Processing and validating');
        await run(info.ffmpeg.command, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe', '-i', source,
          ...(kind === 'video' ? ['-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart'] :
            kind === 'voice' ? ['-vn', '-c:a', 'libopus', '-ac', '1', '-ar', '48000', '-b:a', '48k'] :
              ['-vn', '-c:a', 'libmp3lame', '-b:a', '128k']), '-fs', String(options.maxBytes + 1), file],
        { ...options, directory, maxBytes: options.maxBytes * 3 });
        await validateFile(file, kind, info.ffmpeg, { ...options, expectedHeight: kind === 'video' ? height : undefined, expectedDuration: info.duration });
        // Caller owns the file until WhatsApp has consumed it, then cleans up.
        return { file, fileName: `${info.title}.${ext}`, mimetype: kind === 'video' ? 'video/mp4' : kind === 'voice' ? 'audio/ogg; codecs=opus' : 'audio/mpeg', cleanup };
      } catch (error) { await cleanup(); throw error; }
    }
  };
}
// Keep fallback policy independent of the bot/session UI. Only trusted adapters
// supplied by the owner belong here; never accept a provider URL from chat.
// The checkout has one usable download adapter, so the default chain has one
// member. A fallback must resolve the SAME video and exact selected quality.
function createProviderChain(providers) {
  if (!Array.isArray(providers) || !providers.length) throw new Error('At least one media provider is required.');
  return {
    async inspect(input) {
      const url = youtubeUrl(input); let last;
      for (let index = 0; index < providers.length; index++) {
        try {
          const info = await providers[index].inspect(url);
          if (youtubeUrl(info.url) !== url || !Array.isArray(info.qualities)) throw new MediaError('METADATA', 'The provider returned incomplete or mismatched source information.');
          return { ...info, providerIndex: index };
        } catch (error) { last = error; if (['INPUT', 'SIZE'].includes(error.code)) break; }
      }
      throw last;
    },
    async download(info, kind, height, progress) {
      const order = [info.providerIndex ?? 0, ...providers.map((_, i) => i).filter(i => i !== (info.providerIndex ?? 0))];
      let last;
      for (const index of order) {
        try {
          const candidate = index === (info.providerIndex ?? 0) ? info : await providers[index].inspect(youtubeUrl(info.url));
          if (youtubeUrl(candidate.url) !== youtubeUrl(info.url)) throw new MediaError('METADATA', 'A fallback provider returned a different video.');
          if (kind === 'video' && !candidate.qualities.some(q => q.height === height)) throw new MediaError('QUALITY', 'The selected resolution is unavailable from this provider.');
          return await providers[index].download(candidate, kind, height, progress);
        } catch (error) {
          last = error;
          if (['INPUT', 'SIZE', 'DISK', 'BUSY'].includes(error.code)) break;
        }
      }
      throw last;
    }
  };
}
module.exports = { MediaError, youtubeUrl, availableFormats, run, retry, validateFile, createLocalProvider, classifyError, createProviderChain };
