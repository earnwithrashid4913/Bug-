'use strict';

const { randomBytes } = require('node:crypto');
const { getContextInfo } = require('./message');
const netTools = require('./net-tools');
const local = require('./local-downloader');
const { config } = require('../config');
const { MediaError, youtubeUrl, createLocalProvider, classifyError, createProviderChain } = require('./youtube-engine');

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
const budget = createBudget();
const services = new WeakMap();
const directAudio = new Set(['ytmp3', 'yta', 'ytaudio', 'audio', 'mp3']);
const directVideo = new Set(['ytmp4', 'mp4']);
const duration = value => value ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : 'Unknown';
const safeError = error => error instanceof MediaError ? error.message : 'The media operation failed. Please try again later.';

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
  provider = createProviderChain([createLocalProvider()]),
  search = async query => {
    try { return await netTools.youtubeSearch(query, 1); }
    catch {
      try { return await local.searchVideo(query, undefined, 1); }
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
    // Only edit an existing text message; do not flood the chat if editing is
    // unsupported. The initial status remains the numbered-reply fallback.
    if (s.statusKey?.id && s.editable !== false) {
      try { await socket.sendMessage(s.ctx.chatId, { text: `*ANIME MD* • ${text}`, edit: s.statusKey }); return true; }
      catch { s.editable = false; log('EDIT_UNAVAILABLE', 'progress'); }
    }
    return false;
  }
  function bindMenu(s, message) {
    s.menuKey = message?.key?.id;
    s.expires = now() + ttlMs;
  }
  async function menu(s) {
    const text = `*ANIME MD • MEDIA SELECT*\n\n🎵 *${s.info.title}*\n👤 ${s.info.uploader}\n⏱ ${duration(s.info.duration)}\n🔗 ${s.info.url}\n\nChoose a format below:\n1. HD VIDEO\n2. AUDIO MP3\n3. VOICE TYPE\n\nReply to this message with 1, 2 or 3, or send:\n${s.id} 2\nExpires in ${Math.round(ttlMs / 60000)} minutes.`;
    let image;
    try { image = await thumbnail(s.info.thumbnail); }
    catch { log('THUMBNAIL_UNAVAILABLE', 'thumbnail'); }
    let message;
    if (image) {
      try { message = await send(s.ctx, { image, caption: text }); }
      catch { log('THUMBNAIL_SEND_FAILED', 'thumbnail'); }
    }
    if (!message) message = await send(s.ctx, { text: `${text}\n\nThumbnail unavailable; downloads are still available.` });
    bindMenu(s, message);
    s.state = 'selecting';
  }
  async function showQualities(s) {
    if (!s.info.qualities.length) throw new MediaError('QUALITY', 'No compatible MP4 with audio is available within the size limit.');
    const rows = s.info.qualities.map((f, index) => `${index + 1}. ${f.height}p`).join('\n');
    const message = await send(s.ctx, { text: `*ANIME MD • VIDEO QUALITY*\n${s.info.title}\n\n${rows}\n\nReply to this message with a number, or send ${s.id} 1.\nNo quality is substituted silently.` });
    bindMenu(s, message); s.state = 'quality';
  }
  async function deliver(s, kind, height) {
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
        const result = await send(s.ctx, {
          [kind === 'video' ? 'video' : 'audio']: { url: media.file },
          mimetype: media.mimetype, fileName: media.fileName,
          ...(kind === 'video' ? { caption: `*${s.info.title}* • ${height}p\nANIME MD` } : { ptt: kind === 'voice' })
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
      if (!await status(s, terminal)) await send(s.ctx, { text: `*ANIME MD* • ${terminal}` });
      return { ok: delivered, uploaded: true, state: s.state };
    } catch (error) {
      const uncertain = ['uploading', 'confirming'].includes(s.state);
      s.state = uncertain ? 'uncertain' : 'failed';
      log(error.code || 'OPERATION_FAILED', s.state);
      await status(s, uncertain ? 'Upload outcome unknown • no automatic resend' : 'Failed');
      if (!s.quiet) await send(s.ctx, { text: uncertain ? 'WhatsApp upload failed or was not confirmed. It may already have been accepted; this request will not resend automatically.' : `${safeError(error)}\nRetry this request: ${s.id} retry` });
      return { ok: false, state: s.state };
    } finally { if (media) await media.cleanup().catch(() => log('CLEANUP_FAILED', 'cleanup')); s.expires = now() + ttlMs; }
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
    const s = { id: randomBytes(6).toString('hex'), ctx, quiet: command.quiet, state: 'resolving', expires: now() + ttlMs };
    sessions.set(s.id, s);
    try {
      s.statusKey = (await send(ctx, { text: '*ANIME MD* • Searching / fetching media information…' }))?.key;
      s.info = await withSlot(async () => {
        let url;
        if (/^[a-z][a-z\d+.-]*:|^(www\.|youtube\.com|youtu\.be)|^\S+\.\S+\//i.test(input)) url = youtubeUrl(input);
        else {
          if (directAudio.has(command.name) || directVideo.has(command.name)) throw new MediaError('INPUT', 'This command requires a YouTube URL. Use play or video to search.');
          const found = await search(input);
          if (!Array.isArray(found) || !found[0]?.url) throw new MediaError('SEARCH', 'No YouTube results were found.');
          url = youtubeUrl(found[0].url);
        }
        return provider.inspect(url);
      });
      await menu(s); // Thumbnail and full menu always precede any media upload.
      await status(s, 'Choose a format from the media message');
      if (directAudio.has(command.name)) return deliver(s, 'audio');
      if (directVideo.has(command.name)) {
        if (!s.info.qualities.length) throw new MediaError('QUALITY', 'No compatible video formats are available.');
        const height = s.info.qualities[0].height;
        await status(s, `Direct video • choosing highest available ${height}p`);
        return deliver(s, 'video', height);
      }
      return { ok: true, pending: true, id: s.id };
    } catch (error) {
      s.state = 'failed'; s.expires = now() + ttlMs;
      log(error.code || 'RESOLUTION_FAILED', 'resolve');
      await status(s, 'Failed');
      if (!command.quiet) await send(ctx, { text: safeError(error) });
      return { ok: false, state: s.state };
    }
  }
  async function select(ctx) {
    const match = /^([a-f0-9]{12})\s+(\d{1,2}|retry)$/i.exec(ctx.text || '');
    const quoted = getContextInfo(ctx.raw?.message)?.stanzaId;
    let s = match ? sessions.get(match[1].toLowerCase()) :
      /^\d{1,2}$/.test(ctx.text || '') && quoted ? [...sessions.values()].find(entry => entry.menuKey === quoted) : null;
    if (!match && !s) return false;
    if (!s || s.expires <= now()) {
      if (s && !['working', 'uploading', 'confirming', 'resolving'].includes(s.state)) sessions.delete(s.id);
      await send(ctx, { text: 'This media selection expired. Start a new play or video request.' }); return true;
    }
    if (s.ctx.sender !== ctx.sender || s.ctx.chatId !== ctx.chatId) {
      await send(ctx, { text: 'This media selection belongs to another user or chat.' }); return true;
    }
    if (['working', 'uploading', 'confirming', 'resolving', 'completed', 'uncertain', 'unconfirmed'].includes(s.state)) return true;
    const value = match ? match[2].toLowerCase() : ctx.text;
    const previous = s.state;
    try {
      // Claim the session synchronously, before the first await, to block clicks
      // arriving while the quality message or provider operation is in flight.
      s.state = 'working';
      if (value === 'retry' && previous === 'failed' && s.kind) { await deliver(s, s.kind, s.height); return true; }
      if (previous === 'failed') { s.state = previous; await send(ctx, { text: 'Start a new request to refresh the source information.' }); return true; }
      const index = Number(value) - 1;
      if (previous === 'quality') {
        const quality = s.info.qualities[index];
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
  if (!/^([a-f0-9]{12})\s+(\d{1,2}|retry)$/i.test(context.text || '')) return false;
  await socket.sendMessage(context.chatId, { text: 'This media selection expired or the bot restarted. Start a new request.' }, { quoted: context.raw });
  return true;
}
module.exports = { select, createFlow, createBudget, receiptTracker, forSocket, directAudio, directVideo };
