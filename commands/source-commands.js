'use strict';

// Source command flows adapted to AnimeMD's existing dispatcher and transport.
const { performance } = require('node:perf_hooks');
const { FOOTER, font } = require('../system/lib/presentation');
const { sessionDashboard } = require('../system/lib/session-status');
const youtubeFlow = require('../system/lib/youtube-flow');

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
async function download(socket, context, command) {
  return youtubeFlow.forSocket(socket).start(context, command);
}
async function selectDownload(socket, context) {
  return youtubeFlow.select(socket, context);
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
module.exports = { FOOTER, font, react, ping, alive, download, selectDownload, upload, tools };
