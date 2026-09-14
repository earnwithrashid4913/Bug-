'use strict';

// Source command flows adapted to AnimeMD's existing dispatcher and transport.
const { performance } = require('node:perf_hooks');
const { downloadRemoteFile, requestCobalt, youtubeSearch } = require('./net-tools');
const { FOOTER, font } = require('./presentation');
const { sessionDashboard } = require('./session-status');
async function react(socket, context, text) {
  try { await socket.sendMessage(context.chatId, { react: { text, key: context.raw.key } }); } catch { /* Reactions must not prevent the actual response. */ }
}
async function imageOrText(socket, context, url, text) {
  try { await socket.sendMessage(context.chatId, { image: { url }, caption: text }, { quoted: context.raw }); }
  catch { await socket.sendMessage(context.chatId, { text }, { quoted: context.raw }); }
}
async function ping(socket, context) {
  const started = performance.now();
  try {
    await socket.sendMessage(context.chatId, { react: { text: '⭐', key: context.raw.key } });
  } catch {
    await socket.sendMessage(context.chatId, { text: 'Ping — checking message delivery.' }, { quoted: context.raw });
  }
  const latency = Math.round(performance.now() - started);
  const index = latency <= 500 ? 0 : latency <= 1000 ? 1 : latency <= 2000 ? 2 : 3;
  const urls = ['https://i.ibb.co/KxDP90wf/37fe119a1c79.jpg', 'https://i.ibb.co/dwwcKFsC/52a445e39696.jpg', 'https://i.ibb.co/CK6ks0Cd/9fbbd0c276b6.jpg', 'https://i.ibb.co/0RkR9kV9/0baea924809e.jpg'];
  await imageOrText(socket, context, urls[index], `> *${font('PONG!')}* ${['⚡', '📡', '🐢', '😴'][index]}\n\n> Latence: ${latency}ms\n> Message-send latency\n\n> ${FOOTER}`);
}
async function alive(socket, context) {
  const number = socket.user?.id?.split(':')[0]?.split('@')[0];
  const text = `❤️ *${font('ANIME-MD')}*\n\n${sessionDashboard(socket.animeSessionStatus || { state: 'error', lastEvent: 'Unavailable', lastUpdate: Date.now() }, { number, compact: true })}\n\n> ${FOOTER}`;
  await imageOrText(socket, context, 'https://i.ibb.co/5WN6ZV1h/a17b5bc5feb6.jpg', text);
}

async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`API HTTP ${response.status}`);
  return response.json();
}
async function download(socket, context, command) {
  const reply = text => socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
  if (!command.text) return reply(`Usage: ${command.name} ${command.name === 'ytmp3' || command.name === 'audio' || command.name === 'mp3' ? '<YouTube URL>' : '<search query or YouTube URL>'}`);
  try {
    const audioOnly = ['ytmp3', 'audio', 'mp3'].includes(command.name);
    const videoMode = ['video', 'ytmp4', 'mp4', 'ytvideo'].includes(command.name);
    let url = command.text;
    let video;
    if (audioOnly || /^https?:\/\//i.test(url)) {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol) || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(parsed.hostname)) throw new Error('Invalid YouTube URL');
    } else {
      await react(socket, context, '🔍');
      [video] = await youtubeSearch(url, 1);
      if (!video) throw new Error('No search results');
      url = video.url;
    }
    await react(socket, context, '⬇️');
    // The former third-party download endpoint was returning provider HTTP 500
    // and is intentionally no longer used.
    // Use the configured Cobalt-compatible service, which returns a short-lived
    // authorized media URL instead of pretending Spotify or YouTube provide MP3s.
    const providers = [...new Set([
      process.env.COBALT_API_URL || 'https://cobalt-api.kwiatekmiki.com',
      process.env.COBALT_FALLBACK_API_URL
    ].filter(Boolean))];
    let result;
    let providerError;
    for (const provider of providers) {
      try {
        result = await requestCobalt(provider, url, { audio: !videoMode });
        break;
      } catch (error) {
        providerError = error;
        console.warn('[Play] Configured audio provider failed:', error?.message || error);
      }
    }
    if (!result) throw providerError || new Error('No audio provider is available.');
    if (!result?.url) throw new Error('The download service returned no media.');
    if (videoMode) {
      await socket.sendMessage(context.chatId, { video: { url: result.url }, mimetype: 'video/mp4', caption: `✅ ${video?.title || result.filename || 'Video'}\n> ${FOOTER}` }, { quoted: context.raw });
    } else {
      if (video?.title) await socket.sendMessage(context.chatId, { text: `🎵 ${video.title}` }, { quoted: context.raw });
      const media = await downloadRemoteFile(result.url, 25 * 1024 * 1024);
      await socket.sendMessage(context.chatId, { audio: media.buffer, mimetype: media.type || 'audio/mpeg', ptt: false, fileName: result.filename || `${video?.title || 'audio'}.mp3` }, { quoted: context.raw });
    }
    await react(socket, context, '✅');
    return { ok: true, title: video?.title || result.filename || 'audio' };
  } catch (error) {
    console.error('[Play] Download failed:', error?.message || error);
    await react(socket, context, '❌');
    const userMessage = /Invalid YouTube URL|No search results|No YouTube results/i.test(error?.message || '')
      ? error.message
      : 'Audio download is temporarily unavailable. Please try another source/query.';
    if (!command.quiet) await reply(`Download failed: ${userMessage}`);
    return { ok: false, error };
  }
}
async function upload(socket, context, command, uploadQuoted) {
  if (!command.text) return uploadQuoted(socket, context);
  try {
    const url = new URL(command.args[0]);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Provide an HTTP(S) URL');
    for (const service of ['kitc', 'uguu', 'tmp', 'put']) {
      try {
        const data = await request(`https://apis-starlights-team.koyeb.app/starlight/uploader-${service}?url=${encodeURIComponent(url.href)}`);
        if (!data.url) continue;
        await socket.sendMessage(context.chatId, { text: `📤 ${font('Upload successful')}\nService: ${service}\n${data.url}\n\n> ${FOOTER}` }, { quoted: context.raw });
        await react(socket, context, '✅');
        return;
      } catch { /* Preserve the source's next-service retry. */ }
    }
    throw new Error('All upload services failed');
  } catch (error) {
    await socket.sendMessage(context.chatId, { text: `Upload failed: ${error.message}` }, { quoted: context.raw });
  }
}
async function tools(socket, context, command) {
  const reply = text => socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
  const base = 'https://apis-keith.vercel.app';
  const query = command.text;
  try {
    let endpoint;
    if (command.name === 'tempmail') endpoint = '/tempmail';
    else if (command.name === 'getmail') {
      if (!query) return reply('Usage: getmail <session ID>');
      endpoint = `/get_inbox_tempmail?q=${encodeURIComponent(query)}`;
    } else if (command.name === 'fancy') {
      if (command.args[0]?.toLowerCase() === 'styles') {
        if (!command.args[1]) return reply('Usage: fancy styles <text>');
        endpoint = `/fancytext/styles?q=${encodeURIComponent(command.args.slice(1).join(' '))}`;
      } else {
        const style = command.args.at(-1);
        if (command.args.length < 2 || !/^\d+$/.test(style)) return reply('Usage: fancy <text> <style number> | fancy styles <text>');
        endpoint = `/fancytext?q=${encodeURIComponent(command.args.slice(0, -1).join(' '))}&style=${style}`;
      }
    } else {
      if (!query) return reply(`Usage: ${command.name} <code>`);
      endpoint = `/tools/${command.name}?q=${encodeURIComponent(query)}`;
    }
    const data = await request(base + endpoint);
    if (data.status === false) throw new Error('Provider rejected the request');
    let text;
    if (command.name === 'tempmail') {
      if (!Array.isArray(data.result) || !data.result[0]) throw new Error('Invalid email response');
      text = data.result.join('\n');
    } else if (command.name === 'getmail') {
      text = data.emails?.length ? data.emails.map((mail, i) => `${i + 1}. ${mail.from || 'Unknown'}\n${mail.subject || 'No subject'}\n${mail.date || ''}`).join('\n\n') : 'No emails';
    } else if (data.styles) {
      text = data.styles.slice(0, 10).map((style, i) => `${i + 1}. ${style.name}\n${style.result}`).join('\n\n');
    } else {
      if (typeof data.result !== 'string' || !data.result) throw new Error('Empty provider response');
      text = data.result;
    }
    await reply(text);
    await react(socket, context, '✅');
  } catch (error) {
    await react(socket, context, '❌');
    await reply(`Tool failed: ${error.message}`);
  }
}
module.exports = { FOOTER, font, react, ping, alive, download, upload, tools };
