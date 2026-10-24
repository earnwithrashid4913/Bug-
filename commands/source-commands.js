'use strict';

// Source command flows adapted to AnimeMD's existing dispatcher and transport.
const { performance } = require('node:perf_hooks');
const netTools = require('../system/lib/net-tools');
const { FOOTER, font } = require('../system/lib/presentation');
const { sessionDashboard } = require('../system/lib/session-status');
const localDownloader = require('../system/lib/local-downloader');

function mediaErrorMessage(error, mode) {
  const message = String(error?.message || '');
  if (/Invalid YouTube URL/i.test(message)) return 'Invalid YouTube URL. Please send a YouTube link.';
  if (/No (search results|YouTube results)/i.test(message)) return 'No YouTube result was found for that query.';
  if (/all (audio|video) download sources failed/i.test(message)) {
    return mode === 'video'
      ? 'Video download failed: all configured providers are unavailable. Please try again later.'
      : 'Audio download failed: all configured providers are unavailable. Please try again later.';
  }
  if (/timed out|stalled/i.test(message)) return `${mode === 'video' ? 'Video' : 'Audio'} download timed out. Please try again.`;
  if (/yt-dlp|download engine/i.test(message)) return 'The download engine is starting up or could not run on the bot host. Please try again in a minute; the owner can check DEPLOYMENT.md if it keeps failing.';
  return mode === 'video'
    ? 'Video download failed. Please try a different link or try again later.'
    : 'Audio download failed. Please try a different link or try again later.';
}
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
  // Uptime/status are resolved by the one authoritative session renderer from
  // this socket's live session mirror (or, when a socket has none, from that
  // socket's real identity and the process runtime) — never a placeholder.
  const text = `❤️ *${font('ANIME-MD')}*\n\n${sessionDashboard(socket.animeSessionStatus, { socket, compact: true })}\n\n> ${FOOTER}`;
  await imageOrText(socket, context, 'https://i.ibb.co/5WN6ZV1h/a17b5bc5feb6.jpg', text);
}

async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`API HTTP ${response.status}`);
  return response.json();
}
async function sendAudioMedia(socket, context, media, title) {
  const audioTitle = title || media.title || 'audio';
  if (audioTitle && audioTitle !== 'audio') await socket.sendMessage(context.chatId, { text: `🎵 ${audioTitle}` }, { quoted: context.raw });
  await socket.sendMessage(context.chatId, {
    audio: media.buffer,
    mimetype: media.mimetype || 'audio/mpeg',
    ptt: false,
    fileName: media.fileName
  }, { quoted: context.raw });
}
async function download(socket, context, command) {
  const reply = text => socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
  if (!command.text) return reply(`Usage: ${command.name} ${command.name === 'ytmp3' || command.name === 'audio' || command.name === 'mp3' ? '<YouTube URL>' : '<search query or YouTube URL>'}`);
  try {
    const audioOnly = ['ytmp3', 'audio', 'mp3'].includes(command.name);
    // All documented video aliases must remain video commands.  Previously
    // !yt, !youtube and !ytv silently entered the audio branch and were then
    // reported as an audio-provider failure.
    const videoMode = ['video', 'ytmp4', 'mp4', 'ytvideo', 'yt', 'youtube', 'ytv'].includes(command.name);
    let candidates;
    let searched = false;
    if (audioOnly || /^https?:\/\//i.test(command.text)) {
      let parsed;
      try { parsed = new URL(command.text); } catch { throw new Error('Invalid YouTube URL'); }
      if (!['https:', 'http:'].includes(parsed.protocol) || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(parsed.hostname)) throw new Error('Invalid YouTube URL');
      candidates = [{ url: command.text, title: '' }];
    } else {
      searched = true;
      await react(socket, context, '🔍');
      let found;
      try {
        found = await netTools.youtubeSearch(command.text, 5);
      } catch (searchError) {
        // The page scraper can be blocked by a consent page or a markup change;
        // the local engine can search YouTube itself, so a name still works.
        console.warn('[Play] Page search failed, using the local engine:', searchError?.message || searchError);
        found = await localDownloader.searchVideo(command.text, undefined, 5);
      }
      candidates = (found || []).filter((entry) => entry?.url).map((entry) => ({ url: entry.url, title: entry.title || '' }));
      if (!candidates.length) throw new Error('No search results');
    }
    await react(socket, context, '⬇️');

    let lastError;
    for (const candidate of candidates) {
      try {
        let media;
        if (videoMode) {
          // ── VIDEO: !video — downloaded and merged locally by yt-dlp + FFmpeg.
          // No third-party download API is involved; the file is sent only after
          // it has been produced and validated by the local engine.
          media = await localDownloader.downloadVideo(candidate.url);
          await socket.sendMessage(context.chatId, {
            video: media.buffer,
            mimetype: media.mimetype || 'video/mp4',
            caption: `✅ ${candidate.title || media.title || 'Video'}\n> ${FOOTER}`
          }, { quoted: context.raw });
        } else {
          // ── AUDIO: !play — extracted to MP3 locally by yt-dlp + FFmpeg.
          media = await localDownloader.downloadAudio(candidate.url);
          await sendAudioMedia(socket, context, media, candidate.title);
        }
        await react(socket, context, '✅');
        return { ok: true, title: candidate.title || media.title || (videoMode ? 'video' : 'audio') };
      } catch (error) {
        lastError = error;
        // A single blocked or removed search result must not fail the command when
        // another result can still be delivered; direct links only have one shot.
        if (!shouldTryNextCandidate(error)) break;
        console.warn('[Play] Trying the next search result:', error?.message || error);
      }
    }
    // YouTube sometimes refuses every result for a host (bot check) even though
    // the query is valid. Audio can come from the second local source instead of
    // failing the command; an explicit link is never replaced by another track.
    if (searched && !videoMode && shouldTryNextCandidate(lastError)) {
      console.warn('[Play] YouTube refused every result; trying the local SoundCloud source.');
      let tracks = [];
      try {
        tracks = await localDownloader.searchAudio(command.text, undefined, 3);
      } catch (searchError) {
        console.warn('[Play] SoundCloud search failed:', searchError?.message || searchError);
      }
      for (const track of tracks) {
        try {
          const media = await localDownloader.downloadAudio(track.url);
          await sendAudioMedia(socket, context, media, track.title);
          await react(socket, context, '✅');
          return { ok: true, title: track.title || media.title, source: 'soundcloud' };
        } catch (error) {
          lastError = error;
          if (!shouldTryNextCandidate(error)) break;
        }
      }
    }
    throw lastError || new Error('No search results');
  } catch (error) {
    console.error('[Play] Download failed:', error?.message || error);
    await react(socket, context, '❌');
    const userMessage = error?.userMessage || mediaErrorMessage(error, videoModeForCommand(command.name));
    if (!command.quiet) await reply(`Download failed: ${userMessage}`);
    return { ok: false, error };
  }
}

function shouldTryNextCandidate(error) {
  const message = String(error?.message || '');
  return /sign in to confirm|not a bot|video unavailable|private video|removed|requested format|no compatible|http error 403|only images are available/i.test(message);
}
function videoModeForCommand(name) {
  return ['video', 'ytmp4', 'mp4', 'ytvideo', 'yt', 'youtube', 'ytv'].includes(String(name).toLowerCase()) ? 'video' : 'audio';
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
    // tempmail/getmail now run through the universal temp mail provider system
    // (commands/temp-mail.js); the legacy single-provider routes are retired.
    if (command.name === 'fancy') {
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
    if (data.styles) {
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
