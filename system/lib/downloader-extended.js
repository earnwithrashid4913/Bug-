'use strict';

const axios = require('axios');
const { config } = require('../config');

const DC_BASE = 'https://apis.davidcyril.name.ng';
const TIMEOUT = 90000;

function extractUrl(text) {
  if (!text) return '';
  var m = text.match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : '';
}

async function dlBuffer(url) {
  var res = await axios.get(url, {
    responseType: 'arraybuffer', timeout: TIMEOUT,
    maxContentLength: Infinity, maxBodyLength: Infinity,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0' },
  });
  return Buffer.from(res.data);
}

function pickUrl(data) {
  if (!data) return null;
  var obj = data.result || data.data || data;
  if (typeof obj === 'string' && obj.startsWith('http')) return obj;
  var fields = ['download_url','downloadUrl','videoUrl','video_url','url','hdUrl','mp4','media','link','playUrl'];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (obj[f] && typeof obj[f] === 'string' && obj[f].startsWith('http')) return obj[f];
    if (Array.isArray(obj[f]) && obj[f][0]?.url) return obj[f][0].url;
  }
  if (Array.isArray(obj.medias)) { var v = obj.medias.find(x => x.type === 'video'); if (v?.url) return v.url; if (obj.medias[0]?.url) return obj.medias[0].url; }
  return null;
}

function pickTitle(data) {
  var obj = data?.result || data?.data || data || {};
  return obj.title || obj.caption || obj.description || obj.name || '';
}

function pickThumb(data) {
  var obj = data?.result || data?.data || data || {};
  return obj.thumbnail || obj.thumb || obj.cover || obj.image || null;
}

async function tryApis(endpoints) {
  for (var i = 0; i < endpoints.length; i++) {
    try {
      var res = await axios.get(DC_BASE + endpoints[i], { timeout: TIMEOUT });
      var data = res.data;
      if (data && (data.success !== false)) {
        var url = pickUrl(data);
        if (url) return { url: url, data: data };
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

// TikTok downloader with triple fallback
async function handleTiktokCommand(socket, context, argsText) {
  var raw = argsText || '';
  var url = extractUrl(raw) || extractUrl(context.raw?.message?.conversation || '') || extractUrl(context.raw?.message?.extendedTextMessage?.text || '');
  if (!url) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !tiktok <link>\nEx: !tiktok https://vm.tiktok.com/xxxxx' }, { quoted: context.raw });
  if (!/(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/i.test(url)) return socket.sendMessage(context.chatId, { text: '⚠️ This doesn\'t look like a TikTok link.' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '🚀 *Downloading TikTok...*' }, { quoted: context.raw });
  try {
    var enc = encodeURIComponent(url);
    var result = null;

    // Try tikwm first
    try {
      var params = new URLSearchParams({ url: url, hd: '1' });
      var res = await axios.post('https://www.tikwm.com/api/', params.toString(), { timeout: 45000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (res.data?.code === 0 && res.data?.data) {
        result = { videoUrl: res.data.data.hdplay || res.data.data.play, title: res.data.data.title || '', authorName: res.data.data.author?.nickname || '', authorUser: res.data.data.author?.unique_id || '' };
      }
    } catch (e) { /* fallback */ }

    if (!result?.videoUrl) {
      var apiResult = await tryApis(['/download/tiktok?url=' + enc, '/download/tiktokv3?url=' + enc]);
      if (apiResult) result = { videoUrl: apiResult.url, title: pickTitle(apiResult.data), authorName: '', authorUser: '' };
    }

    if (!result?.videoUrl) return socket.sendMessage(context.chatId, { text: '💔 Could not download this TikTok video.' }, { quoted: context.raw });

    var caption = '🎬 *TikTok Downloader*\n\n' +
      '👤 *Creator:* ' + result.authorName + ' (@' + result.authorUser + ')\n' +
      '📝 *Title:* ' + result.title + '\n\n' +
      '> *[ ANIME CORE ]*';

    var videoBuf = await dlBuffer(result.videoUrl);
    await socket.sendMessage(context.chatId, { video: videoBuf, caption: caption, mimetype: 'video/mp4' }, { quoted: context.raw });
  } catch (e) {
    console.error('TikTok error:', e.message);
    await socket.sendMessage(context.chatId, { text: '🚨 TikTok error: ' + e.message }, { quoted: context.raw });
  }
}

// Facebook downloader
async function handleFacebookCommand(socket, context, argsText) {
  var raw = argsText || '';
  var url = extractUrl(raw) || extractUrl(context.raw?.message?.conversation || '') || extractUrl(context.raw?.message?.extendedTextMessage?.text || '');
  if (!url || !/(facebook\.com|fb\.com|fb\.watch)/i.test(url)) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !fb <Facebook link>\nEx: !fb https://fb.watch/xxx' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '📥 *Downloading from Facebook...*' }, { quoted: context.raw });
  try {
    var enc = encodeURIComponent(url);
    var result = await tryApis(['/facebook?url=' + enc, '/facebook2?url=' + enc, '/facebook3?url=' + enc]);
    if (!result) return socket.sendMessage(context.chatId, { text: '❌ Could not download.' }, { quoted: context.raw });

    var buf = await dlBuffer(result.url);
    if (buf.length < 1000) throw new Error('Empty file');
    await socket.sendMessage(context.chatId, { video: buf, mimetype: 'video/mp4', caption: '*Facebook Download*\n\n> *[ ANIME CORE ]*' }, { quoted: context.raw });
  } catch (e) {
    await socket.sendMessage(context.chatId, { text: '❌ Facebook error: ' + e.message }, { quoted: context.raw });
  }
}

// Twitter/X downloader
async function handleXdlCommand(socket, context, argsText) {
  var raw = argsText || '';
  var url = extractUrl(raw) || extractUrl(context.raw?.message?.conversation || '') || extractUrl(context.raw?.message?.extendedTextMessage?.text || '');
  if (!url || !/(twitter\.com|x\.com|t\.co)/i.test(url)) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !xdl <Twitter/X link>' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '📥 *Downloading from X/Twitter...*' }, { quoted: context.raw });
  try {
    var enc = encodeURIComponent(url);
    var result = await tryApis(['/twitter?url=' + enc, '/twitterV2?url=' + enc]);
    if (!result) return socket.sendMessage(context.chatId, { text: '❌ Could not download.' }, { quoted: context.raw });

    var buf = await dlBuffer(result.url);
    if (buf.length < 1000) throw new Error('Empty file');
    await socket.sendMessage(context.chatId, { video: buf, mimetype: 'video/mp4', caption: '*X/Twitter Download*\n\n> *[ ANIME CORE ]*' }, { quoted: context.raw });
  } catch (e) {
    await socket.sendMessage(context.chatId, { text: '❌ Download error: ' + e.message }, { quoted: context.raw });
  }
}

module.exports = { handleTiktokCommand, handleFacebookCommand, handleXdlCommand };
