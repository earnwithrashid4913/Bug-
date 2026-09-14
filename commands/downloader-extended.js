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

module.exports = {
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
