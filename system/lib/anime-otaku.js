'use strict';

const axios = require('axios');
const otaku = require('./otaku');

const JIKAN_API = 'https://api.jikan.moe/v4';
const cache = new Map();

async function jikanGet(endpoint, params) {
  params = params || {};
  const key = endpoint + JSON.stringify(params);
  if (cache.has(key)) return cache.get(key);
  await new Promise(r => setTimeout(r, 500));
  const res = await axios.get(JIKAN_API + endpoint, { params, timeout: 10000 });
  cache.set(key, res.data);
  setTimeout(() => cache.delete(key), 5 * 60 * 1000);
  return res.data;
}

function formatAnime(anime) {
  const title = anime.title || 'Unknown';
  const titleEn = anime.title_english ? ' (' + anime.title_english + ')' : '';
  const score = anime.score ? '⭐ ' + anime.score + '/10' : '⭐ N/A';
  const episodes = anime.episodes ? '📺 ' + anime.episodes + ' episodes' : '📺 Ongoing';
  const status = anime.status || 'Unknown';
  const aired = anime.aired?.string || 'Date unknown';
  const genres = anime.genres?.map(g => g.name).join(', ') || 'N/A';
  const synopsis = anime.synopsis ? anime.synopsis.slice(0, 300) + (anime.synopsis.length > 300 ? '...' : '') : 'No synopsis available.';
  const rank = anime.rank ? '🏆 Rank #' + anime.rank : '';
  const imageUrl = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url;

  var text = '╔══════════════════╗\n' +
    '  🎌 *' + title + '*' + titleEn + '\n' +
    '╠══════════════════╣\n\n' +
    score + '\n' + episodes + '\n📅 ' + aired + '\n🔄 Status: ' + status + '\n' +
    '🎭 Genres: ' + genres + '\n' + rank + '\n\n' +
    '📖 *Synopsis:*\n' + synopsis + '\n\n' +
    '╚══════════════════╝\n' +
    '🔗 _MyAnimeList: mal.to/anime/' + anime.mal_id + '_';

  return { text, imageUrl };
}

async function handleAnimeCommand(socket, context, args) {
  const sub = (args[0] || 'search').toLowerCase();
  const query = args.slice(1).join(' ');

  switch (sub) {
    case 'search':
    case 'info': {
      if (!query) return socket.sendMessage(context.chatId, { text: '❌ Usage: *!anime search <name>*' }, { quoted: context.raw });
      await socket.sendMessage(context.chatId, { text: '🔍 Searching for *' + query + '*...' }, { quoted: context.raw });
      try {
        const data = await jikanGet('/anime', { q: query, limit: 1 });
        if (!data.data?.length) return socket.sendMessage(context.chatId, { text: '❌ No anime found.' }, { quoted: context.raw });
        const result = formatAnime(data.data[0]);
        otaku.recordAnimeSearch(context.sender);
        if (result.imageUrl) await socket.sendMessage(context.chatId, { image: { url: result.imageUrl }, caption: result.text }, { quoted: context.raw });
        else await socket.sendMessage(context.chatId, { text: result.text }, { quoted: context.raw });
      } catch (e) { await socket.sendMessage(context.chatId, { text: '❌ Error: ' + e.message }, { quoted: context.raw }); }
      return;
    }
    case 'top': {
      await socket.sendMessage(context.chatId, { text: '🏆 Loading Top Anime...' }, { quoted: context.raw });
      try {
        const data = await jikanGet('/top/anime', { limit: 10 });
        const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
        let text = '╔══════════════════╗\n🏆 *TOP 10 ANIME*\n╠══════════════════╣\n\n';
        data.data.forEach((a, i) => { text += medals[i] + ' *' + a.title + '*\n   ⭐ ' + a.score + ' | 📺 ' + (a.episodes || '?') + ' eps\n\n'; });
        text += '╚══════════════════╝';
        await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
      } catch (e) { await socket.sendMessage(context.chatId, { text: '❌ Error: ' + e.message }, { quoted: context.raw }); }
      return;
    }
    case 'trending': {
      await socket.sendMessage(context.chatId, { text: '📈 Loading trends...' }, { quoted: context.raw });
      try {
        const data = await jikanGet('/top/anime', { filter: 'bypopularity', limit: 8 });
        let text = '╔══════════════════╗\n📈 *TRENDING ANIME*\n╠══════════════════╣\n\n';
        data.data.forEach((a, i) => { text += '*' + (i+1) + '. ' + a.title + '*\n   ⭐ ' + (a.score || 'N/A') + ' | 👥 #' + a.popularity + '\n\n'; });
        text += '╚══════════════════╝';
        const imageUrl = data.data[0]?.images?.jpg?.large_image_url;
        if (imageUrl) await socket.sendMessage(context.chatId, { image: { url: imageUrl }, caption: text }, { quoted: context.raw });
        else await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
      } catch (e) { await socket.sendMessage(context.chatId, { text: '❌ Error: ' + e.message }, { quoted: context.raw }); }
      return;
    }
    case 'season':
    case 'new': {
      await socket.sendMessage(context.chatId, { text: '📅 Loading current season...' }, { quoted: context.raw });
      try {
        const data = await jikanGet('/seasons/now', { limit: 8 });
        let text = '╔══════════════════╗\n📅 *CURRENT SEASON ANIME*\n╠══════════════════╣\n\n';
        data.data.slice(0, 8).forEach((a, i) => { text += '*' + (i+1) + '. ' + a.title + '*\n   ⭐ ' + (a.score || 'N/A') + ' | 🎭 ' + (a.genres?.map(g=>g.name).join(', ')||'N/A') + '\n\n'; });
        text += '╚══════════════════╝';
        await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
      } catch (e) { await socket.sendMessage(context.chatId, { text: '❌ Error: ' + e.message }, { quoted: context.raw }); }
      return;
    }
    case 'random': {
      await socket.sendMessage(context.chatId, { text: '🎲 Random anime...' }, { quoted: context.raw });
      try {
        const data = await jikanGet('/random/anime');
        const result = formatAnime(data.data);
        otaku.recordAnimeSearch(context.sender);
        if (result.imageUrl) await socket.sendMessage(context.chatId, { image: { url: result.imageUrl }, caption: result.text }, { quoted: context.raw });
        else await socket.sendMessage(context.chatId, { text: result.text }, { quoted: context.raw });
      } catch (e) { await socket.sendMessage(context.chatId, { text: '❌ Error: ' + e.message }, { quoted: context.raw }); }
      return;
    }
    case 'genres': {
      const genres = ['🎬 Action','🏃 Adventure','😂 Comedy','👹 Demons','🎭 Drama','🔮 Fantasy','👻 Horror','🤖 Mecha','🎵 Music','🧐 Mystery','💘 Romance','🚀 Sci-Fi','🥊 Shounen','🌊 Slice of Life','⚽ Sports','😱 Supernatural','🌀 Isekai','🎮 Game','🌸 Shoujo'];
      const text = '╔══════════════════╗\n🎭 *ANIME GENRES*\n╠══════════════════╣\n\n' + genres.join('\n') + '\n\n╚══════════════════╝\n_Use *!anime search <genre>* to search_';
      await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
      return;
    }
    case 'download': {
      if (!query) return socket.sendMessage(context.chatId, { text: '📥 *ANIME DOWNLOAD*\n\nUsage: *!anime download <name>*' }, { quoted: context.raw });
      await socket.sendMessage(context.chatId, { text: '🔍 Searching for *' + query + '*...' }, { quoted: context.raw });
      try {
        const jikanData = await jikanGet('/anime', { q: query, limit: 1 });
        const animeInfo = jikanData.data?.[0];
        if (!animeInfo) return socket.sendMessage(context.chatId, { text: '❌ No anime found.' }, { quoted: context.raw });
        const title = animeInfo.title || query;
        const titleEn = animeInfo.title_english || animeInfo.title;
        const imageUrl = animeInfo.images?.jpg?.large_image_url;
        var dlText = '╔══════════════════╗\n📥 *ANIME DOWNLOAD*\n╠══════════════════╣\n\n' +
          '🎌 *' + title + '*\n🔤 EN: _' + titleEn + '_\n' +
          '⭐ ' + (animeInfo.score || 'N/A') + ' | 📺 ' + (animeInfo.episodes || '?') + ' eps\n\n' +
          '▶️ *GogoAnime:*\nhttps://gogoanime3.co/search.html?keyword=' + encodeURIComponent(query) + '\n\n' +
          '🎬 *AnimePahe (HD):*\nhttps://animepahe.ru/search?q=' + encodeURIComponent(query) + '\n\n' +
          '🧲 *Nyaa.si (torrent):*\nhttps://nyaa.si/?f=0&c=1_2&q=' + encodeURIComponent(titleEn || title) + '\n\n╚══════════════════╝';
        if (imageUrl) await socket.sendMessage(context.chatId, { image: { url: imageUrl }, caption: dlText }, { quoted: context.raw });
        else await socket.sendMessage(context.chatId, { text: dlText }, { quoted: context.raw });
      } catch (e) { await socket.sendMessage(context.chatId, { text: '❌ Error: ' + e.message }, { quoted: context.raw }); }
      return;
    }
    default: {
      const help = '╔══════════════════╗\n🎌 *ANIME - HELP*\n╠══════════════════╣\n\n!anime search <name>\n!anime top\n!anime trending\n!anime season\n!anime random\n!anime genres\n!anime download <name>\n\n╚══════════════════╝';
      await socket.sendMessage(context.chatId, { text: help }, { quoted: context.raw });
    }
  }
}

async function handleMangaCommand(socket, context, args) {
  const sub = (args[0] || 'search').toLowerCase();
  const query = args.slice(1).join(' ');

  switch (sub) {
    case 'search':
    default: {
      const q = sub === 'search' ? query : args.join(' ');
      if (!q) return socket.sendMessage(context.chatId, { text: '❌ Usage: *!manga search <name>*' }, { quoted: context.raw });
      await socket.sendMessage(context.chatId, { text: '🔍 Searching for *' + q + '*...' }, { quoted: context.raw });
      try {
        const data = await jikanGet('/manga', { q, limit: 1 });
        if (!data.data?.length) return socket.sendMessage(context.chatId, { text: '❌ No manga found.' }, { quoted: context.raw });
        const manga = data.data[0];
        const title = manga.title || 'Unknown';
        const score = manga.score ? '⭐ ' + manga.score + '/10' : '⭐ N/A';
        const volumes = manga.volumes ? '📚 ' + manga.volumes + ' volumes' : '📚 Ongoing';
        const chapters = manga.chapters ? '📄 ' + manga.chapters + ' chapters' : '📄 Ongoing';
        const synopsis = manga.synopsis ? manga.synopsis.slice(0, 300) + '...' : 'No synopsis.';
        const imageUrl = manga.images?.jpg?.large_image_url || manga.images?.jpg?.image_url;
        var text = '╔══════════════════╗\n  📚 *' + title + '*\n╠══════════════════╣\n\n' +
          score + '\n' + volumes + '\n' + chapters + '\n🔄 Status: ' + (manga.status || 'Unknown') + '\n🎭 Genres: ' + (manga.genres?.map(g=>g.name).join(', ') || 'N/A') + '\n\n📖 *Synopsis:*\n' + synopsis + '\n\n╚══════════════════╝';
        if (imageUrl) await socket.sendMessage(context.chatId, { image: { url: imageUrl }, caption: text }, { quoted: context.raw });
        else await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
      } catch (e) { await socket.sendMessage(context.chatId, { text: '❌ Error: ' + e.message }, { quoted: context.raw }); }
      return;
    }
    case 'top': {
      await socket.sendMessage(context.chatId, { text: '🏆 Loading Top Manga...' }, { quoted: context.raw });
      try {
        const data = await jikanGet('/top/manga', { limit: 10 });
        const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
        let text = '╔══════════════════╗\n🏆 *TOP 10 MANGA*\n╠══════════════════╣\n\n';
        data.data.forEach((m, i) => { text += medals[i] + ' *' + m.title + '*\n   ⭐ ' + m.score + ' | 📚 ' + (m.volumes || '?') + ' vols\n\n'; });
        text += '╚══════════════════╝';
        await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
      } catch (e) { await socket.sendMessage(context.chatId, { text: '❌ Error: ' + e.message }, { quoted: context.raw }); }
      return;
    }
  }
}

async function handleCharacterCommand(socket, context, args) {
  const query = args.join(' ');
  if (!query) return socket.sendMessage(context.chatId, { text: '❌ Usage: *!character <name>*\nEx: `!character naruto`' }, { quoted: context.raw });
  await socket.sendMessage(context.chatId, { text: '🔍 Searching for *' + query + '*...' }, { quoted: context.raw });
  try {
    await new Promise(r => setTimeout(r, 500));
    const res = await axios.get(JIKAN_API + '/characters', { params: { q: query, limit: 1 }, timeout: 10000 });
    const characters = res.data?.data;
    if (!characters?.length) return socket.sendMessage(context.chatId, { text: '❌ No character found.' }, { quoted: context.raw });
    const char = characters[0];
    const animes = char.anime?.slice(0, 3).map(a => a.anime.title).join(', ') || 'Unknown';
    const about = char.about ? char.about.slice(0, 300) + '...' : 'No description available.';
    const imageUrl = char.images?.jpg?.image_url;
    let text = '╔══════════════════╗\n  🎭 *' + char.name + '*\n';
    if (char.name_kanji) text += '  _' + char.name_kanji + '_\n';
    text += '╠══════════════════╣\n\n🎌 Anime: *' + animes + '*\n';
    if (char.favorites) text += '❤️ ' + char.favorites + ' fans\n';
    text += '\n📖 *About:*\n' + about + '\n\n╚══════════════════╝';
    if (imageUrl) await socket.sendMessage(context.chatId, { image: { url: imageUrl }, caption: text }, { quoted: context.raw });
    else await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
  } catch (e) { await socket.sendMessage(context.chatId, { text: '❌ Error: ' + e.message }, { quoted: context.raw }); }
}

async function handleProfileCommand(socket, context) {
  const sender = context.sender;
  const userName = context.raw?.pushName || sender.split('@')[0];
  const user = otaku.getUserProfile(sender);
  const level = otaku.getLevel(user.xp);
  const nextLevel = otaku.getNextLevel(user.xp);
  const allUsers = Object.values(otaku.getAllUsers());
  const sortedUsers = allUsers.sort((a, b) => (b.xp || 0) - (a.xp || 0));
  const globalRank = sortedUsers.findIndex(u => u.jid === sender) + 1;
  const winRate = user.quizTotal > 0 ? Math.round((user.quizWins / user.quizTotal) * 100) : 0;
  const unlockedBadges = (user.badges || []).map(id => otaku.ALL_BADGES[id]).filter(Boolean);
  const badgesText = unlockedBadges.length > 0 ? unlockedBadges.map(b => b.name).join('\n   ') : 'No badges yet...';

  let text = '╔══════════════════╗\n  🎌 *OTAKU PROFILE*\n╠══════════════════╣\n\n';
  text += '👤 *' + userName + '*\n📱 ' + sender.split('@')[0] + '\n\n';
  text += '╔═══ 📊 STATS ═══╗\n';
  text += '║ 💎 XP Total: *' + user.xp + '*\n';
  text += '║ 🏅 Level: *' + level.name + '*\n';
  if (nextLevel) text += '║ ⬆️ Next: *' + (nextLevel.minXp - user.xp) + ' XP*\n';
  text += '╚═══════════════════╝\n\n';
  text += '╔═══ 🎯 QUIZ ═══╗\n';
  text += '║ 🏆 Wins: *' + user.quizWins + '*\n';
  text += '║ 💔 Losses: *' + user.quizLosses + '*\n';
  text += '║ 📈 Win Rate: *' + winRate + '%*\n';
  text += '╚═══════════════════╝\n\n';
  text += '╔═══ 🌍 RANKING ═══╗\n';
  text += '║ 🏅 Global Rank: *#' + (globalRank || '?') + '*\n';
  text += '╚═══════════════════╝\n\n';
  text += '╔═══ 🎖️ BADGES (' + unlockedBadges.length + '/' + Object.keys(otaku.ALL_BADGES).length + ') ═══╗\n';
  text += '   ' + badgesText + '\n';
  text += '╚═══════════════════╝\n';
  text += '\n> *[ ANIME CORE ]*';

  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

async function handleBadgesCommand(socket, context) {
  const user = otaku.getUserProfile(context.sender);
  const userBadges = user.badges || [];
  const allBadges = otaku.ALL_BADGES;
  let text = '╔══════════════════╗\n  🎖️ *BADGE COLLECTION*\n╠══════════════════╣\n\n';
  text += '📊 *' + userBadges.length + '/' + Object.keys(allBadges).length + ' badges unlocked*\n\n';
  const unlocked = [];
  const locked = [];
  for (const [id, badge] of Object.entries(allBadges)) {
    userBadges.includes(id) ? unlocked.push(badge) : locked.push(badge);
  }
  if (unlocked.length > 0) {
    text += '✅ *UNLOCKED:*\n';
    unlocked.forEach(b => { text += '  ' + b.name + '\n  _' + b.desc + '_\n\n'; });
  }
  if (locked.length > 0) {
    text += '🔒 *TO UNLOCK:*\n';
    locked.forEach(b => { text += '  🔒 ???\n  _' + b.desc + '_\n\n'; });
  }
  text += '╚══════════════════╝\n> *[ ANIME CORE ]*';
  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

async function handleLeaderboardCommand(socket, context) {
  const top = otaku.getLeaderboard(10);
  if (!top.length) return socket.sendMessage(context.chatId, { text: '📊 No data yet. Play quiz to appear here!' }, { quoted: context.raw });
  const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  let text = '╔══════════════════╗\n  🏆 *GLOBAL LEADERBOARD*\n╠══════════════════╣\n\n';
  top.forEach((user, i) => {
    const level = otaku.getLevel(user.xp);
    const num = user.jid ? user.jid.split('@')[0] : '???';
    text += medals[i] + ' *+' + num + '*\n   💎 ' + user.xp + ' XP | ' + level.name + '\n   🏅 ' + user.quizWins + 'W / ' + user.quizLosses + 'L\n\n';
  });
  text += '╚══════════════════╝\n> *[ ANIME CORE ]*';
  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

// Waifu/Husbando
const DAILY_WAIFUS = [
  { name: "Nezuko Kamado", anime: "Demon Slayer", desc: "The little sister turned demon who kept her kindness. 🌸" },
  { name: "Hinata Hyuga", anime: "Naruto", desc: "The shy and courageous ninja of the Hyuga clan. 💜" },
  { name: "Mikasa Ackerman", anime: "Attack on Titan", desc: "The legendary warrior of AOT. ⚔️" },
  { name: "Zero Two", anime: "Darling in the FranXX", desc: "The mysterious pilot with oni horns. 🌹" },
  { name: "Rem", anime: "Re:Zero", desc: "The loyal blue-haired maid. 💙" },
  { name: "Asuna Yuuki", anime: "Sword Art Online", desc: "The Flash Lightning warrior of SAO. ⚡" },
  { name: "Erza Scarlet", anime: "Fairy Tail", desc: "The S-Rank mage of Fairy Tail. 🛡️" },
  { name: "Nami", anime: "One Piece", desc: "The navigator of the Straw Hat crew. 🍊" },
];

const HUSBANDOS = [
  { name: "Itachi Uchiha", anime: "Naruto", desc: "The eldest Uchiha who sacrificed himself for peace. 🌙" },
  { name: "Levi Ackerman", anime: "Attack on Titan", desc: "The strongest soldier of humanity. ⚔️" },
  { name: "Gojo Satoru", anime: "Jujutsu Kaisen", desc: "The strongest with infinite blue eyes. 💙" },
  { name: "Zoro Roronoa", anime: "One Piece", desc: "The future greatest swordsman. ⚔️" },
  { name: "Deku", anime: "My Hero Academia", desc: "From quirkless nerd to legendary hero. 💪" },
];

async function handleWaifuCommand(socket, context, command) {
  if (command === 'dailywaifu') {
    const dayIndex = new Date().getDay();
    const w = DAILY_WAIFUS[dayIndex % DAILY_WAIFUS.length];
    const caption = '🌸 *WAIFU OF THE DAY*\n\n👑 *' + w.name + '*\n🎌 Anime: *' + w.anime + '*\n\n' + w.desc + '\n\n_Come back tomorrow for a new waifu!_';
    try {
      const res = await axios.get('https://api.waifu.pics/sfw/waifu', { timeout: 8000 });
      const imageUrl = res.data?.url;
      if (imageUrl) await socket.sendMessage(context.chatId, { image: { url: imageUrl }, caption }, { quoted: context.raw });
      else await socket.sendMessage(context.chatId, { text: caption }, { quoted: context.raw });
    } catch { await socket.sendMessage(context.chatId, { text: caption }, { quoted: context.raw }); }
    return;
  }
  if (command === 'husbando') {
    const h = HUSBANDOS[Math.floor(Math.random() * HUSBANDOS.length)];
    await socket.sendMessage(context.chatId, { text: '💪 *HUSBANDO: ' + h.name + '*\n🎌 Anime: ' + h.anime + '\n\n' + h.desc }, { quoted: context.raw });
    return;
  }
  // waifu
  try {
    const res = await axios.get('https://api.waifu.pics/sfw/waifu', { timeout: 8000 });
    const imageUrl = res.data?.url;
    if (imageUrl) await socket.sendMessage(context.chatId, { image: { url: imageUrl }, caption: '🌸 *RANDOM WAIFU*\n\n_Use *!dailywaifu* for the waifu of the day!_' }, { quoted: context.raw });
    else throw new Error('no url');
  } catch {
    const w = DAILY_WAIFUS[Math.floor(Math.random() * DAILY_WAIFUS.length)];
    await socket.sendMessage(context.chatId, { text: '🌸 *WAIFU: ' + w.name + '*\n🎌 Anime: ' + w.anime + '\n\n' + w.desc }, { quoted: context.raw });
  }
}

// Anime quote
const ANIME_QUOTES = [
  { quote: "I'm gonna be the King of the Pirates!", char: "Monkey D. Luffy", anime: "One Piece" },
  { quote: "The ones who aren't able to abandon anything are the ones who can't change anything.", char: "Armin Arlert", anime: "Attack on Titan" },
  { quote: "It's not the face that makes someone a monster; it's the choices they make.", char: "Naruto Uzumaki", anime: "Naruto" },
  { quote: "I am the hero who wins with one punch.", char: "Saitama", anime: "One Punch Man" },
  { quote: "EXPLOSION!!!", char: "Megumin", anime: "KonoSuba" },
  { quote: "If you don't take risks, you can't create a future.", char: "Monkey D. Luffy", anime: "One Piece" },
  { quote: "The only power I have is to never give up.", char: "Gon Freecss", anime: "Hunter x Hunter" },
  { quote: "I'll leave tomorrow's problems to tomorrow's me.", char: "Saitama", anime: "One Punch Man" },
];

async function handleQuoteCommand(socket, context) {
  const q = ANIME_QUOTES[Math.floor(Math.random() * ANIME_QUOTES.length)];
  const text = '╔══════════════════╗\n  💬 *ANIME QUOTE*\n╠══════════════════╣\n\n' +
    '❝ ' + q.quote + ' ❞\n\n— *' + q.char + '*\n🎌 _' + q.anime + '_\n\n╚══════════════════╝';
  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

module.exports = {
  handleAnimeCommand,
  handleMangaCommand,
  handleCharacterCommand,
  handleProfileCommand,
  handleBadgesCommand,
  handleLeaderboardCommand,
  handleWaifuCommand,
  handleQuoteCommand,
};
