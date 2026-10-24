'use strict';

const { randomBytes } = require('node:crypto');
const { getContextInfo } = require('./message');
const netTools = require('./net-tools');
const local = require('./local-downloader');
const { config } = require('../config');
const { MediaError, youtubeUrl, classifyError } = require('./youtube-engine');
const { createRecoveredProvider, redactDiagnostic } = require('./youtube-recovered');
const { selection } = require('./youtube-ui');

// A single host-wide budget, including metadata requests. Fail fast rather than
// retaining an unbounded queue of WhatsApp messages or media jobs in memory.
function createBudget(limit = 2) {
  let active = 0;
  return async operation => {
    if (active >= limit) throw new MediaError('BUSY', 'The download slots are busy. Please try again shortly.');
    active++;
    try { return await operation(); } finally { active--; }
  };
}
const budget = createBudget(config.downloadsMaxConcurrent);
const services = new WeakMap();
const directAudio = new Set(['ytmp3', 'yta', 'ytaudio', 'audio', 'mp3']);
const directVideo = new Set(['ytmp4', 'mp4']);
// `video` and its aliases ask for a video, so they open the resolution card
// (thumbnail + real resolutions). `ytmp4`/`mp4` keep their historical
// immediate automatic download. None of them may open the audio menu — that was
// the reported "!video shows the AUDIO MP3 selector" bug.
const videoIntent = new Set(['video', 'yt', 'youtube', 'ytv', 'ytvideo']);
// A plain-number reply may select an offered format, but never while a group
// quiz is waiting for that same number as an answer.
function quizRunning(chatId) {
  try { return Boolean(require('../../commands/quiz').isQuizActive(chatId)); }
  catch { return false; }
}
const duration = value => value ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : 'Unknown';
// Never expose provider identifiers, raw exceptions or diagnostic codes in chat.
const safeError = error => ({
  INPUT: 'Please send a valid YouTube video link or use play to search.',
  SEARCH: 'No YouTube results were found. Try a more specific title.',
  BUSY: 'The download slots are busy. Please try again shortly.',
  SIZE: 'This file is too large. Choose a smaller quality or a shorter video.',
  QUALITY: 'That resolution is unavailable. Choose a listed quality or automatic video.',
  CHOICE: 'Choose one of the options on the latest card.',
  ENGINE: 'This format cannot be prepared right now. Try ordinary audio or automatic video.',
  RESTRICTED: 'This video has an age or regional restriction. Try another accessible video.',
  UNAVAILABLE: 'This video is unavailable. Choose another source.',
  AUTH: 'This source requires an authorized session. Try another accessible video.',
  // No source answered. Short and actionable, so a real host problem is not
  // hidden behind "try again shortly" forever.
  PROVIDERS: 'No source could deliver this video right now. Please try again later.',
  BOT_CHECK: 'YouTube challenged this connection. Please try again later.',
  NETWORK: 'The video source could not be reached. Please try again later.',
  TRANSIENT: 'The video source is rate-limiting or temporarily unavailable. Please try again in a minute.',
  TIMEOUT: 'The download took too long and was stopped. Please try again or pick a smaller quality.',
  CORRUPT: 'The source returned an unusable file. Please try another video or quality.',
  DISK: 'The bot host does not have enough temporary storage right now. Please try again later.',
  AUDIO: 'This video has no usable audio track. Try another video.'
}[error?.code] || '❌ Download failed. Please try again shortly.');
function progressStage(text) {
  if (/^Searching/i.test(text)) return ['🔍', 'Searching'];
  if (/^Resolving/i.test(text)) return ['🎵', 'Resolving media'];
  if (/^Choose a quality/i.test(text)) return ['🎬', 'Choose a video quality'];
  if (/^Choose/i.test(text)) return ['🎵', 'Choose a format'];
  if (/^Downloading/i.test(text)) return ['⬇️', 'Downloading'];
  if (/Processing|validating/i.test(text)) return ['⚙️', 'Preparing media'];
  if (/^Completed/i.test(text)) return ['✅', 'Completed • delivery confirmed'];
  if (/^Failed/i.test(text)) return ['❌', 'Download failed'];
  if (/^Upload outcome/i.test(text)) return ['❌', 'Upload not confirmed • no automatic resend'];
  if (/Uploaded|accepted|Direct video/i.test(text)) return ['📤', 'Sent • awaiting delivery confirmation'];
  if (/Uploading/i.test(text)) return ['📤', 'Sending'];
  return ['🎵', 'Preparing download'];
}

function receiptTracker(socket, timeoutMs = 45000) {
  const waiting = new Map(), recent = new Map();
  function update(id, chat, delivered) {
    if (!id || !delivered) return;
    recent.set(`${chat}:${id}`, Date.now());
    for (const [key, time] of recent) if (time < Date.now() - timeoutMs || recent.size > 256) recent.delete(key);
    waiting.get(`${chat}:${id}`)?.();
  }
  socket.ev?.on('messages.update', updates => {
    for (const { key, update: value } of updates || []) {
      if (key?.fromMe) update(key.id, key.remoteJid, Number(value?.status) >= 3);
    }
  });
  socket.ev?.on('message-receipt.update', updates => {
    for (const { key, receipt } of updates || []) {
      if (key?.fromMe) update(key.id, key.remoteJid, Boolean(receipt?.receiptTimestamp || receipt?.readTimestamp || receipt?.playedTimestamp));
    }
  });
  return (key, chat) => {
    if (!key?.id || !socket.ev) return Promise.resolve(false);
    const id = `${chat}:${key.id}`;
    if (recent.has(id)) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = value => { clearTimeout(timer); waiting.delete(id); resolve(value); };
      const timer = setTimeout(() => finish(false), timeoutMs);
      waiting.set(id, () => finish(true));
    });
  };
}

function createFlow(socket, {
  provider = createRecoveredProvider(),
  search = async query => {
    try { return await netTools.youtubeSearch(query, 5); }
    catch {
      try { return await local.searchVideo(query, undefined, 5); }
      catch (error) {
        if (/No .*results/i.test(error.message)) throw new MediaError('SEARCH', 'No YouTube results were found.');
        throw classifyError(error.message);
      }
    }
  },
  thumbnail = async url => {
    // The thumbnail URL is constructed from a validated video id, never from a
    // provider-controlled URL. Redirects are forbidden to prevent SSRF.
    if (!/^https:\/\/i\.ytimg\.com\/vi\/[\w-]{11}\/hqdefault\.jpg$/.test(url)) throw new Error('Unsafe thumbnail');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok || !/^image\/(jpeg|png)/i.test(response.headers.get('content-type') || '')) throw new Error('Thumbnail unavailable');
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { await response.body.cancel?.().catch(() => {}); throw new Error('Thumbnail too large'); }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (!(buffer[0] === 255 && buffer[1] === 216) && buffer.toString('ascii', 1, 4) !== 'PNG') throw new Error('Invalid thumbnail');
    return buffer;
  },
  withSlot = budget, now = Date.now, ttlMs = 5 * 60 * 1000,
  confirm = receiptTracker(socket), log = (code, stage) => console.warn(`[YouTube] ${stage}: ${code}`)
} = {}) {
  const sessions = new Map();
  function prune() {
    for (const [id, s] of sessions) {
      if (s.expires <= now() && !['working', 'uploading', 'confirming', 'resolving'].includes(s.state)) sessions.delete(id);
    }
  }
  const send = (ctx, payload) => socket.sendMessage(ctx.chatId, payload, { quoted: ctx.raw, mediaUploadTimeoutMs: config.downloadsTimeoutMs });
  async function status(s, text) {
    const [emoji, label] = progressStage(text);
    const rendered = `${emoji} ${label}`;
    if (s.lastStatus === rendered) return Boolean(s.statusKey?.id && s.editable !== false);
    s.lastStatus = rendered;
    if (s.lastReaction !== emoji) {
      s.lastReaction = emoji;
      try { await socket.sendMessage(s.ctx.chatId, { react: { text: emoji, key: s.ctx.raw.key } }); }
      catch { log('REACTION_UNAVAILABLE', 'progress'); }
    }
    if (!s.statusKey) {
      s.statusKey = (await send(s.ctx, { text: rendered }))?.key;
      return true;
    }
    if (s.statusKey.id && s.editable !== false) {
      try { await socket.sendMessage(s.ctx.chatId, { text: rendered, edit: s.statusKey }); return true; }
      catch { s.editable = false; log('EDIT_UNAVAILABLE', 'progress'); }
    }
    return false;
  }
  async function card(s, text, actions, options = {}) {
    s.revision = (s.revision || 0) + 1;
    const result = await selection(socket, s.ctx, { text, actions, token: s.id, revision: s.revision, log, ...options });
    s.menuKey = result.message?.key?.id;
    s.native = result.native;
    s.expires = now() + ttlMs;
  }
  async function menu(s) {
    let image;
    try { image = await thumbnail(s.info.thumbnail); }
    catch { log('THUMBNAIL_UNAVAILABLE', 'thumbnail'); }
    const text = `*ANIME MD • MEDIA SELECT*\n\n🎵 *${s.info.title}*\n👤 ${s.info.uploader}\n⏱ ${s.info.durationText || duration(s.info.duration)}\n🔗 ${s.info.url}\n\nChoose a format below.${image ? '' : '\nThumbnail unavailable.'}`;
    await card(s, text, [{ label: 'HD VIDEO', value: '1' }, { label: 'AUDIO MP3', value: '2' }, { label: 'VOICE TYPE', value: '3' }], { image });
    s.state = s.direct ? 'working' : 'selecting';
  }
  async function showQualities(s) {
    await status(s, 'Resolving media');
    if (provider.qualities) {
      try { s.info.qualities = await withSlot(() => provider.qualities(s.info)); }
      catch (error) { log(`${error.code || 'QUALITY_LOOKUP_FAILED'} | ${redactDiagnostic(error)}`, 'optional-quality'); }
    }
    s.qualityOptions = [...(s.info.qualities || [])];
    if (s.info.autoVideo) s.qualityOptions.push({ label: 'Automatic video', description: 'Source chooses quality; HD is not guaranteed' });
    if (!s.qualityOptions.length) throw new MediaError('QUALITY', 'No compatible formats available.');
    // The video card carries the same real thumbnail/title information as the
    // audio card; the reported bug was a quality list without either.
    let image;
    try { image = await thumbnail(s.info.thumbnail); }
    catch { log('THUMBNAIL_UNAVAILABLE', 'thumbnail'); }
    const meta = [s.info.uploader ? `👤 ${s.info.uploader}` : '', s.info.durationText || (s.info.duration ? duration(s.info.duration) : '')].filter(Boolean);
    const text = `*ANIME MD • VIDEO QUALITY*\n\n🎬 *${s.info.title}*\n${meta.join('\n')}${meta.length ? '\n' : ''}\nChoose an available quality.${image ? '' : '\nThumbnail unavailable.'}`;
    await card(s, text, s.qualityOptions.map((f, index) => ({ label: f.label || `${f.height}p`, description: f.description, value: String(index + 1) })), { list: true, image });
    s.state = 'quality';
  }
  async function showSources(s) {
    await card(s, '*ANIME MD • OTHER RESULTS*\nChoose a different source only if you want to change the requested video.', s.candidates.map((entry, index) => ({ label: entry.title || 'YouTube result', description: entry.url, value: String(index + 1) })), { list: true });
    s.state = 'sources';
  }
  async function deliver(s, kind, height) {
    if (s.jobActive || ['uploading', 'confirming', 'completed', 'uncertain', 'unconfirmed'].includes(s.state)) return { ok: false, duplicate: true };
    s.jobActive = true;
    s.state = 'working'; s.kind = kind; s.height = height;
    let media;
    try {
      await withSlot(async () => {
        await status(s, 'Preparing download');
        media = await provider.download(s.info, kind, height, text => status(s, text));
        if (!media?.file || typeof media.cleanup !== 'function') throw new MediaError('MEDIA', 'The provider returned no downloadable media.');
        s.state = 'uploading';
        await status(s, 'Uploading to WhatsApp');
        // Never retry an upload: an exception can occur after WhatsApp accepted
        // the media. A repeat click cannot cause a duplicate upload.
        if (media.notice) await send(s.ctx, { text: media.notice });
        const result = await send(s.ctx, {
          [media.asDocument ? 'document' : kind === 'video' ? 'video' : 'audio']: { url: media.file },
          mimetype: media.mimetype, fileName: media.fileName,
          ...(kind === 'video' ? { caption: `*${s.info.title}* • ${height === undefined ? 'automatic quality' : `${height}p`}\nANIME MD` } : { ptt: kind === 'voice' })
        });
        s.state = 'confirming';
        await status(s, 'Uploaded • waiting for WhatsApp delivery receipt');
        // Release the local file as soon as sendMessage has consumed it.
        await media.cleanup(); media = null;
        s.deliveryKey = result?.key;
      });
      const delivered = await confirm(s.deliveryKey, s.ctx.chatId);
      s.state = delivered ? 'completed' : 'unconfirmed';
      const terminal = delivered ? 'Completed • WhatsApp delivery confirmed ✓' : 'Upload accepted • delivery not confirmed; no automatic resend';
      if (!await status(s, terminal)) { const [emoji, label] = progressStage(terminal); await send(s.ctx, { text: `${emoji} ${label}` }); }
      return { ok: delivered, uploaded: true, state: s.state };
    } catch (error) {
      const uncertain = ['uploading', 'confirming'].includes(s.state);
      s.state = uncertain ? 'uncertain' : 'failed';
      log(`${error.code || 'OPERATION_FAILED'} | ${redactDiagnostic(error)}`, s.state);
      if (error.failures) log(JSON.stringify(error.failures), 'provider-summary');
      await status(s, uncertain ? 'Upload outcome unknown • no automatic resend' : 'Failed');
      if (!s.quiet) {
        if (uncertain) await send(s.ctx, { text: 'Upload not confirmed. It may already have been sent; no automatic resend.' });
        else await card(s, `Download failed. ${safeError(error)}`, [{ label: 'Try again', value: 'retry' }, ...(s.candidates?.length > 1 ? [{ label: 'Other results', value: 'sources' }] : [])]);
      }
      return { ok: false, state: s.state };
    } finally { if (media) await media.cleanup().catch(() => log('CLEANUP_FAILED', 'cleanup')); s.jobActive = false; s.expires = now() + ttlMs; }
  }
  async function start(ctx, command) {
    const input = String(command.text || '').trim().replace(/^(["'])(.*)\1$/s, '$2').trim();
    if (!input) return send(ctx, { text: `Usage: ${command.name} <YouTube URL or search query>` });
    prune();
    // Source message dedup also protects direct callers, not just the dispatcher.
    if ([...sessions.values()].some(s => s.ctx.chatId === ctx.chatId && s.ctx.raw?.key?.id === ctx.raw?.key?.id && ctx.raw?.key?.id)) return { ok: false, duplicate: true };
    if (sessions.size >= 200 || [...sessions.values()].filter(s => s.ctx.sender === ctx.sender && s.ctx.chatId === ctx.chatId && !['completed', 'unconfirmed', 'uncertain'].includes(s.state)).length >= 5) {
      return send(ctx, { text: 'Too many pending media requests. Wait for them to expire before starting another.' });
    }
    const s = { id: randomBytes(6).toString('hex'), ctx, quiet: command.quiet, direct: directAudio.has(command.name) || directVideo.has(command.name), state: 'resolving', expires: now() + ttlMs };
    sessions.set(s.id, s);
    try {
      await status(s, 'Searching');
      s.info = await withSlot(async () => {
        let url, seed = {};
        if (/^[a-z][a-z\d+.-]*:|^(www\.|youtube\.com|youtu\.be)|^\S+\.\S+\//i.test(input)) url = youtubeUrl(input);
        else {
          // Every downloader command accepts a search query: `!audio <query>`
          // used to be rejected with "send a valid YouTube link".
          const found = await search(input);
          if (!Array.isArray(found) || !found[0]?.url) throw new MediaError('SEARCH', 'No YouTube results were found.');
          s.candidates = found.filter(entry => entry?.url);
          seed = s.candidates[0];
          url = youtubeUrl(seed.url);
        }
        await status(s, 'Resolving media');
        return provider.inspect(url, seed);
      });
      // `!video <query|url>` goes straight to the resolution card; only the
      // audio-capable `!play` shows the AUDIO MP3 / VOICE TYPE menu.
      if (videoIntent.has(command.name)) {
        await showQualities(s);
        await status(s, 'Choose a quality from the video message');
        return { ok: true, pending: true, id: s.id, mode: 'video' };
      }
      await menu(s); // Thumbnail and full menu always precede any media upload.
      await status(s, 'Choose a format from the media message');
      if (directAudio.has(command.name)) return deliver(s, 'audio');
      if (directVideo.has(command.name)) {
        if (!s.info.qualities.length && !s.info.autoVideo) throw new MediaError('QUALITY', 'No compatible video formats are available.');
        const height = s.info.autoVideo ? undefined : s.info.qualities[0].height;
        await status(s, height === undefined ? 'Direct video • previous automatic format selection' : `Direct video • choosing highest available ${height}p`);
        return deliver(s, 'video', height);
      }
      return { ok: true, pending: true, id: s.id };
    } catch (error) {
      s.state = 'failed'; s.expires = now() + ttlMs;
      // Keep the real (redacted) cause in the server log; chat only sees the
      // short safe message below.
      log(`${error.code || 'RESOLUTION_FAILED'} | ${redactDiagnostic(error)}`, 'resolve');
      await status(s, 'Failed');
      if (!command.quiet) await send(ctx, { text: safeError(error) });
      return { ok: false, state: s.state };
    }
  }
  async function select(ctx) {
    const text = String(ctx.text || '').trim();
    const native = /^yt:([a-f0-9]{12}):(\d+):(\d{1,2}|retry|sources)$/i.exec(text);
    const legacy = /^([a-f0-9]{12})\s+(\d{1,2}|retry|sources)$/i.exec(text);
    const match = native ? [native[0], native[1], native[3]] : legacy;
    const quoted = getContextInfo(ctx.raw?.message)?.stanzaId;
    const pending = [...sessions.values()].filter(entry => entry.ctx.chatId === ctx.chatId && entry.ctx.sender === ctx.sender &&
      entry.expires > now() && ['selecting', 'quality', 'sources', 'failed'].includes(entry.state));
    let s = match ? sessions.get(match[1].toLowerCase()) :
      quoted && /^(\d{1,2}|retry|sources)$/i.test(text) ? [...sessions.values()].find(entry => entry.menuKey === quoted) : null;
    // Handsets whose buttons/list rows do not arrive simply reply "2". Accept
    // that when it can only mean one pending request; a running group quiz keeps
    // priority for the same bare numbers.
    if (!s && !match && /^[1-9]$/.test(text) && pending.length === 1 && !quizRunning(ctx.chatId)) s = pending[0];
    if (!match && !s) {
      if (/^yt:[a-f0-9]{12}:/i.test(text)) { await send(ctx, { text: 'This selection is invalid. Use the latest media card.' }); return true; }
      return false;
    }
    if (!s || s.expires <= now()) {
      if (s && !['working', 'uploading', 'confirming', 'resolving'].includes(s.state)) sessions.delete(s.id);
      await send(ctx, { text: 'This media selection expired. Start a new play or video request.' }); return true;
    }
    if (s.ctx.sender !== ctx.sender || s.ctx.chatId !== ctx.chatId) {
      await send(ctx, { text: 'This media selection belongs to another user or chat.' }); return true;
    }
    if (['working', 'uploading', 'confirming', 'resolving', 'completed', 'uncertain', 'unconfirmed'].includes(s.state)) return true;
    // An outdated card is answered instead of silently ignored: a dropped tap
    // looked exactly like "selecting Audio does nothing" on the handset.
    if (native && Number(native[2]) !== s.revision) {
      await send(ctx, { text: 'That card is out of date. Use the newest ANIME MD media card.' });
      return true;
    }
    // Text replies (quoted or the unique pending request above) stay valid even
    // when the offer was rendered with native buttons.
    const value = match ? match[2].toLowerCase() : text.toLowerCase();
    const previous = s.state;
    try {
      // Claim the session synchronously, before the first await, to block clicks
      // arriving while the quality message or provider operation is in flight.
      s.state = 'working';
      if (value === 'sources' && s.candidates?.length > 1) { await showSources(s); return true; }
      if (previous === 'sources') {
        const entry = s.candidates[Number(value) - 1];
        if (!entry) throw new MediaError('CHOICE', 'Choose one of the listed search results.');
        s.info = await withSlot(() => provider.inspect(youtubeUrl(entry.url), entry));
        if (s.kind) { await deliver(s, s.kind, s.height); return true; }
        await menu(s); return true;
      }
      if (value === 'retry' && previous === 'failed' && s.kind) { await deliver(s, s.kind, s.height); return true; }
      if (previous === 'failed') { s.state = previous; await send(ctx, { text: 'Start a new request to refresh the source information.' }); return true; }
      const index = Number(value) - 1;
      if (previous === 'quality') {
        const quality = s.qualityOptions[index];
        if (!quality) throw new MediaError('CHOICE', 'Choose one of the listed resolution numbers.');
        await deliver(s, 'video', quality.height);
      } else if (value === '1') await showQualities(s);
      else if (value === '2' || value === '3') await deliver(s, value === '2' ? 'audio' : 'voice');
      else throw new MediaError('CHOICE', 'Choose 1 for HD VIDEO, 2 for AUDIO MP3 or 3 for VOICE TYPE.');
    } catch (error) {
      s.state = previous;
      log(error.code || 'SELECTION_FAILED', 'selection');
      await send(ctx, { text: safeError(error) });
    }
    return true;
  }
  return { start, select };
}
function forSocket(socket) {
  if (!services.has(socket)) services.set(socket, createFlow(socket));
  return services.get(socket);
}
async function select(socket, context) {
  const flow = services.get(socket);
  if (flow) return flow.select(context);
  if (!/^(?:yt:[a-f0-9]{12}:\d+:|[a-f0-9]{12}\s+)(\d{1,2}|retry|sources)$/i.test(context.text || '')) return false;
  await socket.sendMessage(context.chatId, { text: 'This media selection expired or the bot restarted. Start a new request.' }, { quoted: context.raw });
  return true;
}
module.exports = { select, createFlow, createBudget, receiptTracker, forSocket, directAudio, directVideo, videoIntent, safeError, progressStage };
