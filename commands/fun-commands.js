'use strict';

const axios = require('axios');

async function handleCoupleCommand(socket, context) {
  if (!context.isGroup) return socket.sendMessage(context.chatId, { text: '❌ Groups only!' }, { quoted: context.raw });
  try {
    const meta = await socket.groupMetadata(context.chatId);
    const members = (meta.participants || []).map(p => p.id).filter(id => !id.endsWith('@lid'));
    if (members.length < 2) return socket.sendMessage(context.chatId, { text: '❌ Need at least 2 members.' }, { quoted: context.raw });

    const a = members[Math.floor(Math.random() * members.length)];
    let b = members[Math.floor(Math.random() * members.length)];
    let tries = 5;
    while (b === a && tries-- > 0) b = members[Math.floor(Math.random() * members.length)];

    const score = Math.floor(Math.random() * 101);
    const hearts = ['💖','💞','❤️','💗','💓','💕'];
    const heart = hearts[Math.floor(Math.random() * hearts.length)];
    const bar = '█'.repeat(Math.round(score / 5)).padEnd(20, '░');
    const verdict = score >= 95 ? '💍 Soulmates!' : score >= 80 ? '🔥 Hot couple!' : score >= 60 ? '😍 Great chemistry!' : score >= 40 ? '🤔 Maybe...' : score >= 20 ? '🌪️ Complicated' : '💔 Catastrophe';

    const text = '╔══════════════════╗\n   ' + heart + '  *COUPLE MATCH*  ' + heart + '\n╠══════════════════╣\n' +
      '👤 @' + a.split('@')[0] + '\n       ✦  +  ✦\n' +
      '👤 @' + b.split('@')[0] + '\n╠══════════════════╣\n' +
      '💯 Score: *' + score + '%*\n[' + bar + ']\n\n' + verdict + '\n╚══════════════════╝\n> *[ ANIME CORE ]*';

    await socket.sendMessage(context.chatId, { text, mentions: [a, b] }, { quoted: context.raw });
  } catch (e) { await socket.sendMessage(context.chatId, { text: '❌ Error: ' + e.message }, { quoted: context.raw }); }
}

async function handleTruthCommand(socket, context) {
  try {
    const res = await axios.get('https://apis.davidcyril.name.ng/truth', { timeout: 15000 });
    const question = res.data?.question || res.data?.truth || res.data?.result || 'Tell us about yourself!';
    const text = '╔══════════════════╗\n  🕵️ *TRUTH OR DARE — TRUTH*\n╠══════════════════╣\n\n❓ ' + question + '\n\n╚══════════════════╝\n> *[ ANIME CORE ]*';
    await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
  } catch {
    const truths = ['What is your biggest fear?', 'What is your most embarrassing moment?', 'What is a secret you have never told anyone?', 'What is the biggest lie you have ever told?'];
    await socket.sendMessage(context.chatId, { text: '🕵️ *TRUTH*\n\n❓ ' + truths[Math.floor(Math.random() * truths.length)] }, { quoted: context.raw });
  }
}

async function handleDareCommand(socket, context) {
  try {
    const res = await axios.get('https://apis.davidcyril.name.ng/dare', { timeout: 15000 });
    const question = res.data?.question || res.data?.dare || res.data?.result || 'Do something brave!';
    const text = '╔══════════════════╗\n  🔥 *TRUTH OR DARE — DARE*\n╠══════════════════╣\n\n🎯 ' + question + '\n\n╚══════════════════╝\n> *[ ANIME CORE ]*';
    await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
  } catch {
    const dares = ['Send a voice note singing your favorite song', 'Change your profile picture to something funny', 'Type everything in caps for the next 10 minutes'];
    await socket.sendMessage(context.chatId, { text: '🔥 *DARE*\n\n🎯 ' + dares[Math.floor(Math.random() * dares.length)] }, { quoted: context.raw });
  }
}

async function handleFactCommand(socket, context) {
  try {
    const res = await axios.get('https://apis.davidcyril.name.ng/fact', { timeout: 15000 });
    const fact = res.data?.fact || res.data?.result || 'The world is full of amazing facts!';
    await socket.sendMessage(context.chatId, { text: '╔══════════════════╗\n  💡 *RANDOM FACT*\n╠══════════════════╣\n\n' + fact + '\n\n╚══════════════════╝\n> *[ ANIME CORE ]*' }, { quoted: context.raw });
  } catch {
    const facts = ['🐙 Octopuses have three hearts and blue blood.', '🍯 Honey never spoils. Archaeologists found 3000-year-old honey still edible.', '⚡ A bolt of lightning is 5x hotter than the sun\'s surface.', '🌍 There are more stars in the universe than grains of sand on Earth.'];
    await socket.sendMessage(context.chatId, { text: '💡 *FACT*\n\n' + facts[Math.floor(Math.random() * facts.length)] }, { quoted: context.raw });
  }
}

async function handlePickupCommand(socket, context) {
  try {
    const res = await axios.get('https://apis.davidcyril.name.ng/pickupline', { timeout: 15000 });
    const line = res.data?.pickupline || res.data?.line || res.data?.result || 'Are you a magician? Because whenever I look at you, everyone else disappears!';
    await socket.sendMessage(context.chatId, { text: '╔══════════════════╗\n  💝 *PICKUP LINE*\n╠══════════════════╣\n\n💌 ' + line + '\n\n╚══════════════════╝\n> *[ ANIME CORE ]*' }, { quoted: context.raw });
  } catch {
    await socket.sendMessage(context.chatId, { text: '💌 *PICKUP LINE*\n\nAre you a camera? Because every time I look at you, I smile!' }, { quoted: context.raw });
  }
}

async function handleAnimevsCommand(socket, context, args) {
  const query = args.join(' ');
  const parts = query.split(' vs ');
  if (parts.length < 2) return socket.sendMessage(context.chatId, { text: '❌ Usage: *!animevs <anime1> vs <anime2>*\nEx: `!animevs Naruto vs One Piece`' }, { quoted: context.raw });

  const a1 = parts[0].trim();
  const a2 = parts[1].trim();
  const p1 = Math.floor(Math.random() * 40) + 60;
  const p2 = Math.floor(Math.random() * 40) + 60;
  const winner = p1 >= p2 ? a1 : a2;

  const text = '╔══════════════════╗\n  ⚔️ *ANIME VS ANIME*\n╠══════════════════╣\n\n' +
    '⚡ *' + a1 + '*\n   Power: ' + '█'.repeat(Math.floor(p1/10)) + ' ' + p1 + '/100\n\n  VS\n\n' +
    '💥 *' + a2 + '*\n   Power: ' + '█'.repeat(Math.floor(p2/10)) + ' ' + p2 + '/100\n\n' +
    '━━━━━━━━━━━━━━━━━━\n🏆 *WINNER: ' + winner + '*\n━━━━━━━━━━━━━━━━━━\n\n_Random result for fun!_\n╚══════════════════╝\n> *[ ANIME CORE ]*';
  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

async function handleShipCommand(socket, context, args) {
  const query = args.join(' ');
  const parts = query.split(' ');
  if (parts.length < 2) return socket.sendMessage(context.chatId, { text: '❌ Usage: *!ship <name1> <name2>*' }, { quoted: context.raw });
  const p1 = parts[0]; const p2 = parts.slice(1).join(' ');
  const pct = Math.floor(Math.random() * 41) + 60;
  const bar = '❤️'.repeat(Math.floor(pct / 10));
  const level = pct >= 90 ? '💍 LEGENDARY SOULMATES!' : pct >= 80 ? '💞 Perfect love!' : pct >= 70 ? '💕 Great compatibility!' : '💛 Good friends!';

  const text = '╔══════════════════╗\n  💕 *LOVE METER*\n╠══════════════════╣\n\n👤 *' + p1 + '*\n   ' + bar + ' ' + pct + '%\n👤 *' + p2 + '*\n\n' + level + '\n\n╚══════════════════╝\n> *[ ANIME CORE ]*';
  await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
}

async function handleMeteoCommand(socket, context, args) {
  const city = (args.join(' ') || '').trim();
  if (!city) return socket.sendMessage(context.chatId, { text: '⚠️ Indicate a city.\n_Ex: !meteo London_' }, { quoted: context.raw });
  try {
    const res = await axios.get('https://wttr.in/' + encodeURIComponent(city) + '?format=j1&lang=en', { timeout: 15000, headers: { 'User-Agent': 'curl/8.0' } });
    const c = res.data.current_condition?.[0];
    const area = res.data.nearest_area?.[0];
    const today = res.data.weather?.[0];
    if (!c) throw new Error('No data');

    const text = '╔══════════════════╗\n   🌤️  *WEATHER*\n╠══════════════════╣\n' +
      '📍 *' + (area?.areaName?.[0]?.value || city) + '*\n' +
      '🌡️ Temperature: *' + c.temp_C + '°C* (feels ' + c.FeelsLikeC + '°C)\n' +
      '📊 Min/Max: *' + today?.mintempC + '°C / ' + today?.maxtempC + '°C*\n' +
      '☁️ Status: *' + (c.weatherDesc?.[0]?.value || '') + '*\n' +
      '💧 Humidity: *' + c.humidity + '%*\n' +
      '💨 Wind: *' + c.windspeedKmph + ' km/h*\n' +
      '╚══════════════════╝\n> *[ ANIME CORE ]*';
    await socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
  } catch (e) {
    await socket.sendMessage(context.chatId, { text: '❌ Could not get weather for *' + city + '*.\n_' + e.message + '_' }, { quoted: context.raw });
  }
}

async function handleLyricsCommand(socket, context, args) {
  const songTitle = args.join(' ').trim();
  if (!songTitle) return socket.sendMessage(context.chatId, { text: '🔍 Indicate a song name!\n\nUsage: *!lyrics <song name>*' }, { quoted: context.raw });
  try {
    const { data } = await axios.get('https://lyricsapi.fly.dev/api/lyrics?q=' + encodeURIComponent(songTitle), { timeout: 15000 });
    const lyricsText = data?.result?.lyrics;
    if (!lyricsText) return socket.sendMessage(context.chatId, { text: '❌ Lyrics not found for "' + songTitle + '".' }, { quoted: context.raw });
    const output = lyricsText.length > 4000 ? lyricsText.slice(0, 3997) + '...' : lyricsText;
    await socket.sendMessage(context.chatId, { text: output }, { quoted: context.raw });
  } catch (e) {
    await socket.sendMessage(context.chatId, { text: '❌ Error fetching lyrics for "' + songTitle + '".' }, { quoted: context.raw });
  }
}

module.exports = {
  handleCoupleCommand,
  handleTruthCommand,
  handleDareCommand,
  handleFactCommand,
  handlePickupCommand,
  handleAnimevsCommand,
  handleShipCommand,
  handleMeteoCommand,
  handleLyricsCommand,
};
