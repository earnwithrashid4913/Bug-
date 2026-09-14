'use strict';

// ════════════════════════════════════════════════════════════════════════════
//  Movie & Series Commands
//
//  !movie <query>     — Search movies across multiple sources
//  !movielatest       — Latest movies from multiple sources
//  !series <query>    — Search TV series
//  !serieslatest      — Latest TV series
// ════════════════════════════════════════════════════════════════════════════

const dc = require('./davidcyril-api');
const { FOOTER } = require('../system/lib/presentation');

// ── Helpers ────────────────────────────────────────────────────────────────

function formatResults(items, max = 8) {
  if (!items || !items.length) return '';
  return items.slice(0, max).map((item, i) => {
    const title = item.title || item.name || item.movie || `Result ${i + 1}`;
    const year = item.year || item.release_date || item.premiered || item.date || '';
    const quality = item.quality || item.resolution || '';
    const url = item.url || item.link || item.page || '';
    const rating = item.rating ? `⭐${item.rating}` : '';
    const parts = [`${i + 1}. *${title}*`];
    if (year) parts[0] += ` (${typeof year === 'string' && year.length > 4 ? year.slice(0,4) : year})`;
    if (rating) parts.push(`   ${rating}`);
    if (quality) parts.push(`   🎬 ${quality}`);
    if (url) parts.push(`   🔗 ${url}`);
    return parts.join('\n');
  }).join('\n\n');
}

function pickSourceResult(data) {
  if (!data) return [];
  // Verified real format: { success, results: [...] } (NaijaPrey, CineSubz, Soap2Day, TvMaze)
  if (Array.isArray(data.results) && data.results.length) return data.results;
  // Standard format: { success, result: [...] }
  const items = dc.pickItems(data);
  if (items.length) return items;
  const obj = data?.result || data?.data || data;
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const key of ['movies', 'results', 'items', 'data', 'list']) {
      if (Array.isArray(obj[key])) return obj[key];
    }
  }
  return [];
}

// ── Movie Search (multi-source) ────────────────────────────────────────────

async function handleMovieSearchCommand(socket, context, args) {
  const query = (args || []).join(' ').trim();
  if (!query) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !movie <search term>\nEx: !movie Avengers' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '🎬 *Searching for movies...*' }, { quoted: context.raw });

  const sources = [
    { name: 'Nkiri', fn: () => dc.nkiriSearch(query) },
    { name: 'CineSubz', fn: () => dc.cinesubzSearch(query) },
    { name: 'GokuHD', fn: () => dc.gokuSearch(query) },
    { name: 'XPrimeHub', fn: () => dc.xprimeSearch(query) },
    { name: 'RogMovies', fn: () => dc.rogSearch(query) },
    { name: 'NaijaPrey', fn: () => dc.naijapreySearch(query) },
    { name: 'Net9ja', fn: () => dc.net9jaSearch(query) },
    { name: 'Soap2Day', fn: () => dc.soap2daySearch(query) },
    { name: 'MovieBaaz', fn: () => dc.moviebaazSearch(query) },
    { name: 'Stream-X', fn: () => dc.streamxSearch(query) },
  ];

  let allResults = [];
  for (const source of sources) {
    try {
      const data = await source.fn();
      const items = pickSourceResult(data);
      if (items.length) {
        allResults.push({ source: source.name, items });
      }
    } catch (e) { /* try next */ }
  }

  if (!allResults.length) {
    // Fallback: TvMaze
    try {
      const data = await dc.tvmazeSearch(query);
      const items = pickSourceResult(data);
      if (items.length) allResults.push({ source: 'TvMaze', items });
    } catch (e) { /* ignore */ }
  }

  if (!allResults.length) {
    return socket.sendMessage(context.chatId, { text: '❌ No movies found for "' + query + '".' }, { quoted: context.raw });
  }

  // Format output: show results from each source
  let text = `🎬 *Movie Search: ${query}*\n\n`;
  for (const { source, items } of allResults.slice(0, 3)) {
    text += `📡 *${source}*\n${formatResults(items, 5)}\n\n`;
  }
  text += `> ${FOOTER}`;

  // Truncate if too long for WhatsApp
  if (text.length > 4000) text = text.slice(0, 3997) + '...';

  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

// ── Movie Latest ───────────────────────────────────────────────────────────

async function handleMovieLatestCommand(socket, context) {
  await socket.sendMessage(context.chatId, { text: '🎬 *Fetching latest movies...*' }, { quoted: context.raw });

  const sources = [
    { name: 'Nkiri', fn: () => dc.nkiriLatest() },
    { name: 'CineSubz', fn: () => dc.cinesubzLatest() },
    { name: 'GokuHD', fn: () => dc.gokuLatest() },
    { name: 'XPrimeHub', fn: () => dc.xprimeLatest() },
    { name: 'RogMovies', fn: () => dc.rogLatest() },
    { name: 'NaijaPrey', fn: () => dc.naijapreyLatest() },
    { name: 'Net9ja', fn: () => dc.net9jaLatest() },
    { name: 'Soap2Day', fn: () => dc.soap2dayLatest() },
    { name: 'MovieBaaz', fn: () => dc.moviebaazLatest() },
    { name: 'Stream-X', fn: () => dc.streamxLatest() },
    { name: 'HDHub4u', fn: () => dc.hdhub4uLatest() },
    { name: 'VegaMovies', fn: () => dc.vegaLatest() },
  ];

  let allResults = [];
  for (const source of sources) {
    try {
      const data = await source.fn();
      const items = pickSourceResult(data);
      if (items.length) allResults.push({ source: source.name, items });
    } catch (e) { /* try next */ }
  }

  if (!allResults.length) {
    return socket.sendMessage(context.chatId, { text: '❌ Could not fetch latest movies right now.' }, { quoted: context.raw });
  }

  let text = '🎬 *Latest Movies*\n\n';
  for (const { source, items } of allResults.slice(0, 3)) {
    text += `📡 *${source}*\n${formatResults(items, 5)}\n\n`;
  }
  text += `> ${FOOTER}`;

  if (text.length > 4000) text = text.slice(0, 3997) + '...';

  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

// ── Series Search (multi-source) ───────────────────────────────────────────

async function handleSeriesSearchCommand(socket, context, args) {
  const query = (args || []).join(' ').trim();
  if (!query) return socket.sendMessage(context.chatId, { text: '❓ *Usage:* !series <search term>\nEx: !series Breaking Bad' }, { quoted: context.raw });

  await socket.sendMessage(context.chatId, { text: '📺 *Searching for TV series...*' }, { quoted: context.raw });

  const sources = [
    { name: 'O2TVSeries', fn: () => dc.o2tvSearch(query) },
    { name: 'TvShows4Mobile', fn: () => dc.tvshows4mSearch(query) },
    { name: 'SeriezLoaded', fn: () => dc.seriezSearch(query) },
    { name: 'TvMaze', fn: () => dc.tvmazeSearch(query) },
    { name: 'CineSubz', fn: () => dc.cinesubzSearch(query) },
    { name: 'GokuHD', fn: () => dc.gokuSearch(query) },
    { name: 'Soap2Day', fn: () => dc.soap2daySearch(query) },
  ];

  let allResults = [];
  for (const source of sources) {
    try {
      const data = await source.fn();
      const items = pickSourceResult(data);
      if (items.length) allResults.push({ source: source.name, items });
    } catch (e) { /* try next */ }
  }

  if (!allResults.length) {
    return socket.sendMessage(context.chatId, { text: '❌ No series found for "' + query + '".' }, { quoted: context.raw });
  }

  let text = `📺 *Series Search: ${query}*\n\n`;
  for (const { source, items } of allResults.slice(0, 3)) {
    text += `📡 *${source}*\n${formatResults(items, 5)}\n\n`;
  }
  text += `> ${FOOTER}`;

  if (text.length > 4000) text = text.slice(0, 3997) + '...';

  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

// ── Series Latest ──────────────────────────────────────────────────────────

async function handleSeriesLatestCommand(socket, context) {
  await socket.sendMessage(context.chatId, { text: '📺 *Fetching latest series...*' }, { quoted: context.raw });

  const sources = [
    { name: 'O2TVSeries', fn: () => dc.o2tvLatest() },
    { name: 'TvShows4Mobile', fn: () => dc.tvshows4mLatest() },
    { name: 'SeriezLoaded', fn: () => dc.seriezLatest() },
    { name: 'CineSubz', fn: () => dc.cinesubzLatest() },
    { name: 'GokuHD', fn: () => dc.gokuLatest() },
    { name: 'Soap2Day', fn: () => dc.soap2dayLatest() },
  ];

  let allResults = [];
  for (const source of sources) {
    try {
      const data = await source.fn();
      const items = pickSourceResult(data);
      if (items.length) allResults.push({ source: source.name, items });
    } catch (e) { /* try next */ }
  }

  if (!allResults.length) {
    return socket.sendMessage(context.chatId, { text: '❌ Could not fetch latest series right now.' }, { quoted: context.raw });
  }

  let text = '📺 *Latest Series*\n\n';
  for (const { source, items } of allResults.slice(0, 3)) {
    text += `📡 *${source}*\n${formatResults(items, 5)}\n\n`;
  }
  text += `> ${FOOTER}`;

  if (text.length > 4000) text = text.slice(0, 3997) + '...';

  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

module.exports = {
  handleMovieSearchCommand,
  handleMovieLatestCommand,
  handleSeriesSearchCommand,
  handleSeriesLatestCommand,
};
