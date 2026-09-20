'use strict';

// ════════════════════════════════════════════════════════════════════════════
//  Extended Downloader Commands
//
//  TikTok, Facebook, Twitter/X, Instagram, Pinterest, SoundCloud, etc.
//  All use DavidCyril Tech APIs with complete fallback chains.
// ════════════════════════════════════════════════════════════════════════════

const dc = require('./davidcyril-api');
const { FOOTER } = require('../system/lib/presentation');

// ── TikTok ─────────────────────────────────────────────────────────────────

async function handleTiktokCommand(socket, context, argsText) {
  const url = dc.extractUrl(argsText) || dc.extractUrl(context.raw?.message?.conversation || '') || dc.extractUrl(context.raw?.message?.extendedTextMessage?.text || '');
  if (!url) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !tiktok <link>\nEx: !tiktok https://vm.tiktok.com/xxxxx' }, { quoted: context.raw });
  if (!/(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/i.test(url)) return socket.sendMessage(context.chatId, { text: '⚠️ This doesn\'t look like a TikTok link.' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '🚀 *Downloading TikTok...*' }, { quoted: context.raw });

  // Primary: tikwm.com (fast, direct)
  let result = null;
  try {
    const axios = require('axios');
    const params = new URLSearchParams({ url, hd: '1' });
    const res = await axios.post('https://www.tikwm.com/api/', params.toString(), { timeout: 45000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (res.data?.code === 0 && res.data?.data) {
      result = { videoUrl: res.data.data.hdplay || res.data.data.play, title: res.data.data.title || '', authorName: res.data.data.author?.nickname || '', authorUser: res.data.data.author?.unique_id || '' };
    }
  } catch (e) { console.warn('[TikTok] tikwm failed:', e?.message); }

  // Primary: DavidCyril TikTok pool (5 endpoints) - verified real format: result.video
  if (!result?.videoUrl) {
    try {
      const dcData = await dc.dcFetch('/download/tiktok?url=' + encodeURIComponent(url), { timeout: 30000 });
      if (dcData?.success && dcData?.result?.video) {
        result = { videoUrl: dcData.result.video, title: dcData.result.desc || '', authorName: dcData.result.author?.nickname || '', authorUser: '' };
      }
    } catch (e) { console.warn('[TikTok] DC primary failed:', e?.message); }
  }

  // Fallback: remaining DavidCyril TikTok endpoints
  if (!result?.videoUrl) {
    try {
      const dcResult = await dc.tiktokDownload(url);
      const mediaUrl = dcResult.url || dc.pickUrl(dcResult.data || dcResult);
      if (mediaUrl) {
        result = { videoUrl: mediaUrl, title: dcResult.title || dc.pickTitle(dcResult.data || dcResult), authorName: '', authorUser: '' };
      }
    } catch (e) { console.warn('[TikTok] DavidCyril pool failed:', e?.message); }
  }

  // Fallback: Savetik
  if (!result?.videoUrl) {
    try {
      const data = await dc.savetikDownload(url);
      const mediaUrl = dc.pickUrl(data);
      if (mediaUrl) result = { videoUrl: mediaUrl, title: dc.pickTitle(data), authorName: '', authorUser: '' };
    } catch (e) { console.warn('[TikTok] savetik failed:', e?.message); }
  }

  // Fallback: Vibetik
  if (!result?.videoUrl) {
    try {
      const data = await dc.vibetikDownload(url);
      const mediaUrl = dc.pickUrl(data);
      if (mediaUrl) result = { videoUrl: mediaUrl, title: dc.pickTitle(data), authorName: '', authorUser: '' };
    } catch (e) { console.warn('[TikTok] vibetik failed:', e?.message); }
  }

  // Fallback: AIO
  if (!result?.videoUrl) {
    try {
      const aioResult = await dc.aioDownload(url);
      const mediaUrl = dc.pickUrl(aioResult?.data || aioResult);
      if (mediaUrl) result = { videoUrl: mediaUrl, title: dc.pickTitle(aioResult?.data || aioResult), authorName: '', authorUser: '' };
    } catch (e) { console.warn('[TikTok] AIO failed:', e?.message); }
  }

  if (!result?.videoUrl) return socket.sendMessage(context.chatId, { text: '💔 Could not download this TikTok video.' }, { quoted: context.raw });

  try {
    const caption = '🎬 *TikTok Downloader*\n\n' +
      (result.authorName ? '👤 *Creator:* ' + result.authorName + ' (@' + result.authorUser + ')\n' : '') +
      '📝 *Title:* ' + result.title + '\n\n' +
      '> *[ ANIME CORE ]*';
    const videoBuf = await dc.dlBuffer(result.videoUrl);
    await socket.sendMessage(context.chatId, { video: videoBuf, caption, mimetype: 'video/mp4' }, { quoted: context.raw });
  } catch (e) {
    console.error('TikTok error:', e.message);
    await socket.sendMessage(context.chatId, { text: '🚨 TikTok error: ' + e.message }, { quoted: context.raw });
  }
}

// ── Facebook ───────────────────────────────────────────────────────────────

async function handleFacebookCommand(socket, context, argsText) {
  const url = dc.extractUrl(argsText) || dc.extractUrl(context.raw?.message?.conversation || '') || dc.extractUrl(context.raw?.message?.extendedTextMessage?.text || '');
  if (!url || !/(facebook\.com|fb\.com|fb\.watch)/i.test(url)) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !fb <Facebook link>\nEx: !fb https://fb.watch/xxx' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '📥 *Downloading from Facebook...*' }, { quoted: context.raw });

  // Primary + Fallback: DavidCyril Facebook pool (3 endpoints)
  try {
    const result = await dc.facebookDownload(url);
    const mediaUrl = result.url;
    if (!mediaUrl) throw new Error('No media URL');
    const buf = await dc.dlBuffer(mediaUrl);
    if (buf.length < 1000) throw new Error('Empty file');
    const title = result.title || dc.pickTitle(result.data);
    await socket.sendMessage(context.chatId, { video: buf, mimetype: 'video/mp4', caption: `*Facebook Download*\n${title ? '📝 ' + title + '\n' : ''}\n> ${FOOTER}` }, { quoted: context.raw });
  } catch (e) {
    // Fallback: AIO
    try {
      const aioResult = await dc.aioDownload(url);
      const aioUrl = dc.pickUrl(aioResult?.data || aioResult);
      if (!aioUrl) throw new Error('No media URL');
      const buf = await dc.dlBuffer(aioUrl);
      await socket.sendMessage(context.chatId, { video: buf, mimetype: 'video/mp4', caption: `*Facebook Download*\n\n> ${FOOTER}` }, { quoted: context.raw });
    } catch (e2) {
      await socket.sendMessage(context.chatId, { text: '❌ Facebook error: ' + e.message }, { quoted: context.raw });
    }
  }
}

// ── Twitter / X ────────────────────────────────────────────────────────────

async function handleXdlCommand(socket, context, argsText) {
  const url = dc.extractUrl(argsText) || dc.extractUrl(context.raw?.message?.conversation || '') || dc.extractUrl(context.raw?.message?.extendedTextMessage?.text || '');
  if (!url || !/(twitter\.com|x\.com|t\.co)/i.test(url)) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !xdl <Twitter/X link>' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '📥 *Downloading from X/Twitter...*' }, { quoted: context.raw });

  // Primary + Fallback: DavidCyril Twitter pool (5 endpoints)
  try {
    const result = await dc.twitterDownload(url);
    const mediaUrl = result.url;
    if (!mediaUrl) throw new Error('No media URL');
    const buf = await dc.dlBuffer(mediaUrl);
    if (buf.length < 1000) throw new Error('Empty file');
    const title = result.title || dc.pickTitle(result.data);
    await socket.sendMessage(context.chatId, { video: buf, mimetype: 'video/mp4', caption: `*X/Twitter Download*\n${title ? '📝 ' + title + '\n' : ''}\n> ${FOOTER}` }, { quoted: context.raw });
  } catch (e) {
    // Fallback: SnapTwitt
    try {
      const data = await dc.snaptwittDownload(url);
      const mediaUrl = dc.pickUrl(data);
      if (!mediaUrl) throw new Error('No media URL');
      const buf = await dc.dlBuffer(mediaUrl);
      await socket.sendMessage(context.chatId, { video: buf, mimetype: 'video/mp4', caption: `*X/Twitter Download*\n\n> ${FOOTER}` }, { quoted: context.raw });
    } catch (e2) {
      // Fallback: InThisTweet
      try {
        const data = await dc.inthistweetDownload(url);
        const mediaUrl = dc.pickUrl(data);
        if (!mediaUrl) throw new Error('No media URL');
        const buf = await dc.dlBuffer(mediaUrl);
        await socket.sendMessage(context.chatId, { video: buf, mimetype: 'video/mp4', caption: `*X/Twitter Download*\n\n> ${FOOTER}` }, { quoted: context.raw });
      } catch (e3) {
        await socket.sendMessage(context.chatId, { text: '❌ Download error: ' + e.message }, { quoted: context.raw });
      }
    }
  }
}

// ── Instagram ──────────────────────────────────────────────────────────────

async function handleInstagramCommand(socket, context, argsText) {
  const url = dc.extractUrl(argsText) || dc.extractUrl(context.raw?.message?.conversation || '') || dc.extractUrl(context.raw?.message?.extendedTextMessage?.text || '');
  if (!url || !/(instagram\.com|instagr\.am)/i.test(url)) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !ig <Instagram link>\nEx: !ig https://www.instagram.com/reel/xxxxx' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '📥 *Downloading from Instagram...*' }, { quoted: context.raw });

  try {
    const data = await dc.instagramDownload(url);
    const mediaUrl = dc.pickUrl(data);
    if (!mediaUrl) throw new Error('No media URL');
    const buf = await dc.dlBuffer(mediaUrl);
    const title = dc.pickTitle(data);
    const isImage = /\.(jpg|jpeg|png|webp)/i.test(mediaUrl) || dc.pickUrl(data)?.includes('image');
    if (isImage) {
      await socket.sendMessage(context.chatId, { image: buf, caption: `*Instagram Download*\n${title ? '📝 ' + title + '\n' : ''}\n> ${FOOTER}` }, { quoted: context.raw });
    } else {
      await socket.sendMessage(context.chatId, { video: buf, mimetype: 'video/mp4', caption: `*Instagram Download*\n${title ? '📝 ' + title + '\n' : ''}\n> ${FOOTER}` }, { quoted: context.raw });
    }
  } catch (e) {
    // Fallback: AIO
    try {
      const aioResult = await dc.aioDownload(url);
      const aioUrl = dc.pickUrl(aioResult?.data || aioResult);
      if (!aioUrl) throw new Error('No media URL');
      const buf = await dc.dlBuffer(aioUrl);
      await socket.sendMessage(context.chatId, { video: buf, mimetype: 'video/mp4', caption: `*Instagram Download*\n\n> ${FOOTER}` }, { quoted: context.raw });
    } catch (e2) {
      // Fallback: SnapSaver
      try {
        const data = await dc.snapsaverDownload(url);
        const mediaUrl = dc.pickUrl(data);
        if (!mediaUrl) throw new Error('No media URL');
        const buf = await dc.dlBuffer(mediaUrl);
        await socket.sendMessage(context.chatId, { video: buf, mimetype: 'video/mp4', caption: `*Instagram Download*\n\n> ${FOOTER}` }, { quoted: context.raw });
      } catch (e3) {
        await socket.sendMessage(context.chatId, { text: '❌ Instagram error: ' + e.message }, { quoted: context.raw });
      }
    }
  }
}

// ── Pinterest ──────────────────────────────────────────────────────────────

async function handlePinterestCommand(socket, context, argsText) {
  const url = dc.extractUrl(argsText) || dc.extractUrl(context.raw?.message?.conversation || '') || dc.extractUrl(context.raw?.message?.extendedTextMessage?.text || '');
  if (!url || !/(pinterest\.com|pin\.it)/i.test(url)) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !pin <Pinterest link>\nEx: !pin https://pin.it/xxxxx' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '📥 *Downloading from Pinterest...*' }, { quoted: context.raw });

  try {
    const data = await dc.pinterestDownload(url);
    const mediaUrl = dc.pickUrl(data);
    if (!mediaUrl) throw new Error('No media URL');
    const buf = await dc.dlBuffer(mediaUrl);
    const isVideo = /\.(mp4|webm|mov)/i.test(mediaUrl);
    if (isVideo) {
      await socket.sendMessage(context.chatId, { video: buf, mimetype: 'video/mp4', caption: `*Pinterest Download*\n\n> ${FOOTER}` }, { quoted: context.raw });
    } else {
      await socket.sendMessage(context.chatId, { image: buf, caption: `*Pinterest Download*\n\n> ${FOOTER}` }, { quoted: context.raw });
    }
  } catch (e) {
    await socket.sendMessage(context.chatId, { text: '❌ Pinterest error: ' + e.message }, { quoted: context.raw });
  }
}

// ── SoundCloud ─────────────────────────────────────────────────────────────

async function handleSoundcloudCommand(socket, context, argsText) {
  const url = dc.extractUrl(argsText) || dc.extractUrl(context.raw?.message?.conversation || '') || dc.extractUrl(context.raw?.message?.extendedTextMessage?.text || '');
  if (!url || !/(soundcloud\.com|snd\.sc)/i.test(url)) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !soundcloud <SoundCloud link>\nEx: !soundcloud https://soundcloud.com/artist/track' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '🎵 *Downloading from SoundCloud...*' }, { quoted: context.raw });

  try {
    const result = await dc.soundcloudDownload(url);
    const mediaUrl = result.url || dc.pickUrl(result.data || result);
    if (!mediaUrl) throw new Error('No media URL');
    const buf = await dc.dlBuffer(mediaUrl);
    const title = result.title || dc.pickTitle(result.data || result);
    await socket.sendMessage(context.chatId, { audio: buf, mimetype: 'audio/mpeg', ptt: false, fileName: `${title || 'soundcloud'}.mp3` }, { quoted: context.raw });
  } catch (e) {
    // Fallback: AIO
    try {
      const aioResult = await dc.aioDownload(url);
      const aioUrl = dc.pickUrl(aioResult?.data || aioResult);
      if (!aioUrl) throw new Error('No media URL');
      const buf = await dc.dlBuffer(aioUrl);
      await socket.sendMessage(context.chatId, { audio: buf, mimetype: 'audio/mpeg', ptt: false, fileName: 'soundcloud.mp3' }, { quoted: context.raw });
    } catch (e2) {
      await socket.sendMessage(context.chatId, { text: '❌ SoundCloud error: ' + e.message }, { quoted: context.raw });
    }
  }
}

// ── Mediafire ──────────────────────────────────────────────────────────────

async function handleMediafireCommand(socket, context, argsText) {
  const url = dc.extractUrl(argsText) || dc.extractUrl(context.raw?.message?.conversation || '') || dc.extractUrl(context.raw?.message?.extendedTextMessage?.text || '');
  if (!url || !/(mediafire\.com)/i.test(url)) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !mediafire <Mediafire link>\nEx: !mediafire https://www.mediafire.com/file/xxxxx' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '📥 *Downloading from Mediafire...*' }, { quoted: context.raw });

  try {
    const data = await dc.mediafireDownload(url);
    const mediaUrl = dc.pickUrl(data);
    if (!mediaUrl) throw new Error('No download URL');
    const title = dc.pickTitle(data) || 'mediafire_download';
    const buf = await dc.dlBuffer(mediaUrl);
    await socket.sendMessage(context.chatId, { document: buf, mimetype: 'application/octet-stream', fileName: title, caption: `*Mediafire Download*\n📝 ${title}\n\n> ${FOOTER}` }, { quoted: context.raw });
  } catch (e) {
    await socket.sendMessage(context.chatId, { text: '❌ Mediafire error: ' + e.message }, { quoted: context.raw });
  }
}

// ── Google Drive ───────────────────────────────────────────────────────────

async function handleGdriveCommand(socket, context, argsText) {
  const url = dc.extractUrl(argsText) || dc.extractUrl(context.raw?.message?.conversation || '') || dc.extractUrl(context.raw?.message?.extendedTextMessage?.text || '');
  if (!url || !/(drive\.google\.com|docs\.google\.com)/i.test(url)) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !gdrive <Google Drive link>' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '📥 *Downloading from Google Drive...*' }, { quoted: context.raw });

  try {
    const data = await dc.gdriveDownload(url);
    const mediaUrl = dc.pickUrl(data);
    if (!mediaUrl) throw new Error('No download URL');
    const title = dc.pickTitle(data) || 'gdrive_download';
    const buf = await dc.dlBuffer(mediaUrl);
    await socket.sendMessage(context.chatId, { document: buf, mimetype: 'application/octet-stream', fileName: title, caption: `*Google Drive Download*\n📝 ${title}\n\n> ${FOOTER}` }, { quoted: context.raw });
  } catch (e) {
    await socket.sendMessage(context.chatId, { text: '❌ Google Drive error: ' + e.message }, { quoted: context.raw });
  }
}

// ── Terabox ────────────────────────────────────────────────────────────────

async function handleTeraboxCommand(socket, context, argsText) {
  const url = dc.extractUrl(argsText) || dc.extractUrl(context.raw?.message?.conversation || '') || dc.extractUrl(context.raw?.message?.extendedTextMessage?.text || '');
  if (!url || !/(terabox\.com|teraboxapp\.com|1024terabox)/i.test(url)) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !terabox <Terabox link>' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '📥 *Downloading from Terabox...*' }, { quoted: context.raw });

  try {
    const data = await dc.teraboxDownload(url);
    const mediaUrl = dc.pickUrl(data);
    if (!mediaUrl) throw new Error('No download URL');
    const title = dc.pickTitle(data) || 'terabox_download';
    const buf = await dc.dlBuffer(mediaUrl);
    await socket.sendMessage(context.chatId, { document: buf, mimetype: 'application/octet-stream', fileName: title, caption: `*Terabox Download*\n📝 ${title}\n\n> ${FOOTER}` }, { quoted: context.raw });
  } catch (e) {
    await socket.sendMessage(context.chatId, { text: '❌ Terabox error: ' + e.message }, { quoted: context.raw });
  }
}

// ── ALL IN ONE Downloader (!aio) ───────────────────────────────────────────
//
// ONE entry point for any supported video/media link. A known platform is
// routed to the specialised handler that ALREADY owns that platform's complete
// fallback chain; anything else goes through a generic chain built from the
// APIs this project already ships (DavidCyril AIO v1/v2/v3 → HD → website →
// SaveTube → Cobalt). No second downloader layer and no new API surface.

const { requestCobalt, downloadRemoteFile } = require('../system/lib/net-tools');
const { config } = require('../system/config');
const sourceCommands = require('./source-commands');

// Long videos are sent as a document: WhatsApp rejects oversized video
// messages, and a document always delivers.
const AIO_VIDEO_SEND_LIMIT = 60 * 1024 * 1024;

const AIO_ROUTES = Object.freeze([
  { label: 'YouTube', test: /(?:youtube\.com|youtu\.be|yt\.be|youtube-nocookie\.com|m\.youtube\.com)/i },
  { label: 'TikTok', test: /(?:tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/i, handler: (...args) => handleTiktokCommand(...args) },
  { label: 'Facebook', test: /(?:facebook\.com|fb\.com|fb\.watch|fb\.me)/i, handler: (...args) => handleFacebookCommand(...args) },
  { label: 'X / Twitter', test: /(?:twitter\.com|x\.com|t\.co)/i, handler: (...args) => handleXdlCommand(...args) },
  { label: 'Instagram', test: /(?:instagram\.com|instagr\.am|ddinstagram\.com)/i, handler: (...args) => handleInstagramCommand(...args) },
  { label: 'Pinterest', test: /(?:pinterest\.com|pin\.it)/i, handler: (...args) => handlePinterestCommand(...args) },
  { label: 'SoundCloud', test: /(?:soundcloud\.com|snd\.sc)/i, handler: (...args) => handleSoundcloudCommand(...args) },
  { label: 'Mediafire', test: /mediafire\.com/i, handler: (...args) => handleMediafireCommand(...args) },
  { label: 'Google Drive', test: /(?:drive\.google\.com|docs\.google\.com)/i, handler: (...args) => handleGdriveCommand(...args) },
  { label: 'Terabox', test: /(?:terabox\.com|teraboxapp\.com|1024terabox|teraboxlink)/i, handler: (...args) => handleTeraboxCommand(...args) }
]);

// Media type from the real bytes first (the only trustworthy source), then the
// URL extension. Never guessed from the API's label.
function aioKindOf(buffer, mediaUrl) {
  const head = buffer.subarray(0, 12);
  if (head[0] === 0xFF && head[1] === 0xD8) return 'image';
  if (head[0] === 0x89 && head[1] === 0x50) return 'image';
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return 'video';
  if (head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF) return 'video';
  if (head.subarray(0, 3).toString('latin1') === 'ID3') return 'audio';
  if (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) return 'audio';
  if (/\.(mp3|m4a|opus|ogg|flac|wav)(?:[?#]|$)/i.test(mediaUrl)) return 'audio';
  if (/\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.test(mediaUrl)) return 'image';
  return 'video';
}

async function sendAioMedia(socket, context, buffer, mediaUrl, title, source) {
  const kind = aioKindOf(buffer, mediaUrl);
  const size = `${(buffer.length / 1024 / 1024).toFixed(2)} MB`;
  const caption = `*AIO DOWNLOAD COMPLETE* ✅\n${title ? `📝 ${title}\n` : ''}🔗 ${source}\n*Size:* ${size}\n\n> ${FOOTER}`;
  if (kind === 'image') {
    await socket.sendMessage(context.chatId, { image: buffer, caption }, { quoted: context.raw });
  } else if (kind === 'audio') {
    await socket.sendMessage(context.chatId, { audio: buffer, mimetype: 'audio/mpeg', ptt: false }, { quoted: context.raw });
    await socket.sendMessage(context.chatId, { text: caption }, { quoted: context.raw });
  } else if (kind === 'video' && buffer.length <= AIO_VIDEO_SEND_LIMIT) {
    await socket.sendMessage(context.chatId, { video: buffer, mimetype: 'video/mp4', caption }, { quoted: context.raw });
  } else {
    const name = `${(title || 'aio_download').replace(/[^\w\-. ]+/g, '').trim() || 'aio_download'}.${kind === 'image' ? 'jpg' : kind === 'audio' ? 'mp3' : 'mp4'}`;
    await socket.sendMessage(context.chatId, { document: buffer, mimetype: 'application/octet-stream', fileName: name, caption }, { quoted: context.raw });
  }
  return caption;
}

// Generic chain for every site without a specialised handler.
const AIO_GENERIC_PROVIDERS = Object.freeze([
  { label: 'AIO', run: (url) => dc.aioDownload(url), payload: (data) => data?.data || data },
  { label: 'HD Video', run: (url) => dc.hdVideoDownload(url), payload: (data) => data },
  { label: 'Website', run: (url) => dc.websiteDownload(url), payload: (data) => data },
  { label: 'SaveTube', run: (url) => dc.savetubeDownload(url), payload: (data) => data }
]);

async function aioGenericDownload(socket, context, url) {
  for (const provider of AIO_GENERIC_PROVIDERS) {
    try {
      const data = await provider.run(url);
      const payload = provider.payload(data);
      const mediaUrl = dc.pickUrl(payload);
      if (!mediaUrl) continue;
      const buffer = await dc.dlBuffer(mediaUrl);
      if (!buffer || buffer.length < 1000) continue;
      return await sendAioMedia(socket, context, buffer, mediaUrl, dc.pickTitle(payload), provider.label);
    } catch (error) {
      console.warn(`[AIO] ${provider.label} failed:`, error?.message);
    }
  }

  // Final fallback: Cobalt, the generic provider this project already uses for
  // !media — so an unsupported site still has one more real chance.
  try {
    const result = await requestCobalt(config.cobaltApiUrl, url);
    if (!result?.url) throw new Error('no file returned');
    const { buffer, type } = await downloadRemoteFile(result.url);
    if (!buffer?.length) throw new Error('empty file');
    const kind = String(type || '').includes('audio') ? 'audio' : String(type || '').includes('image') ? 'image' : 'video';
    const caption = `*AIO DOWNLOAD COMPLETE* ✅\n🔗 Cobalt\n*Format:* ${String(type || 'file').split(';')[0]}\n*Size:* ${(buffer.length / 1024 / 1024).toFixed(2)} MB\n\n> ${FOOTER}`;
    if (kind === 'image') await socket.sendMessage(context.chatId, { image: buffer, caption }, { quoted: context.raw });
    else if (kind === 'audio') await socket.sendMessage(context.chatId, { audio: buffer, mimetype: String(type || 'audio/mpeg'), ptt: false }, { quoted: context.raw });
    else if (buffer.length <= AIO_VIDEO_SEND_LIMIT) await socket.sendMessage(context.chatId, { video: buffer, mimetype: String(type || 'video/mp4'), caption }, { quoted: context.raw });
    else await socket.sendMessage(context.chatId, { document: buffer, mimetype: String(type || 'application/octet-stream'), fileName: result.filename || 'aio_download', caption }, { quoted: context.raw });
    return caption;
  } catch (error) {
    console.warn('[AIO] Cobalt failed:', error?.message);
    return null;
  }
}

async function handleAioCommand(socket, context, argsText, prefix = '!') {
  const url = dc.extractUrl(argsText)
    || dc.extractUrl(context.raw?.message?.conversation || '')
    || dc.extractUrl(context.raw?.message?.extendedTextMessage?.text || '');

  if (!url) {
    return socket.sendMessage(context.chatId, {
      text: [
        `❓ *Usage:* ${String(prefix || '!')}aio <link>`,
        '',
        'ALL IN ONE downloader — any supported video/media link:',
        'YouTube • TikTok • Instagram • Facebook • X/Twitter',
        'Pinterest • SoundCloud • Mediafire • Google Drive • Terabox',
        'and most other direct video pages.',
        '',
        `Ex: ${String(prefix || '!')}aio https://vm.tiktok.com/xxxxx`
      ].join('\n')
    }, { quoted: context.raw });
  }

  const route = AIO_ROUTES.find((entry) => entry.test.test(url));

  // YouTube already has a dedicated, well-tested download path (Cobalt first,
  // DavidCyril pool as fallback) — reuse it instead of duplicating it here.
  if (route?.label === 'YouTube') {
    await socket.sendMessage(context.chatId, { text: '🚀 *AIO* → YouTube' }, { quoted: context.raw });
    return sourceCommands.download(socket, context, { name: 'video', text: url, args: [url] });
  }

  if (route?.handler) {
    await socket.sendMessage(context.chatId, { text: `🚀 *AIO* → ${route.label}` }, { quoted: context.raw });
    return route.handler(socket, context, url);
  }

  await socket.sendMessage(context.chatId, { text: '🚀 *AIO* → detecting source…' }, { quoted: context.raw });
  const caption = await aioGenericDownload(socket, context, url);
  if (!caption) {
    return socket.sendMessage(context.chatId, {
      text: `❌ *AIO could not download that link.*\n\nThe site may be unsupported, private or rate-limited right now.\nTry a direct media link, or a dedicated command such as ${String(prefix || '!')}tiktok / ${String(prefix || '!')}ig / ${String(prefix || '!')}mediafire.\n\n> ${FOOTER}`
    }, { quoted: context.raw });
  }
  return undefined;
}

module.exports = {
  AIO_ROUTES,
  handleAioCommand,
  handleTiktokCommand,
  handleFacebookCommand,
  handleXdlCommand,
  handleInstagramCommand,
  handlePinterestCommand,
  handleSoundcloudCommand,
  handleMediafireCommand,
  handleGdriveCommand,
  handleTeraboxCommand,
};
