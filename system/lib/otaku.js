'use strict';

const fs = require('fs');
const path = require('path');

const OTAKU_DB_PATH = path.join(__dirname, '..', '..', 'data', 'otaku_db.json');

const LEVELS = [
  { name: 'Otaku Débutant 🌱', minXp: 0, rank: 1 },
  { name: 'Otaku Confirmé ⭐', minXp: 100, rank: 2 },
  { name: 'Otaku Avancé 🌟', minXp: 300, rank: 3 },
  { name: 'Maître Anime 🔥', minXp: 600, rank: 4 },
  { name: 'Otaku Légendaire 💎', minXp: 1000, rank: 5 },
  { name: 'Roi du Quiz 👑', minXp: 2000, rank: 6 },
  { name: 'Dieu Otaku ⚡', minXp: 5000, rank: 7 },
];

const ALL_BADGES = {
  debut_otaku:         { name: '🌱 Débutant Otaku', desc: 'Premier quiz complété' },
  quiz_master_10:      { name: '🎯 Quiz Master', desc: '10 quiz gagnés' },
  otaku_confirme_50:   { name: '⭐ Otaku Confirmé', desc: '50 quiz gagnés' },
  otaku_legendaire_100:{ name: '💎 Otaku Légendaire', desc: '100 quiz gagnés' },
  fan_naruto:          { name: '🍜 Fan Naruto', desc: '5 questions Naruto correctes' },
  fan_onepiece:        { name: '☠️ Fan One Piece', desc: '5 questions One Piece correctes' },
  fan_dragonball:      { name: '🐉 Fan Dragon Ball', desc: '5 questions Dragon Ball correctes' },
  fan_aot:             { name: '⚔️ Fan AOT', desc: '5 questions Attack on Titan correctes' },
  fan_demonslayer:     { name: '🗡️ Fan Demon Slayer', desc: '5 questions Demon Slayer correctes' },
  fan_mha:             { name: '🦸 Fan My Hero Academia', desc: '5 questions MHA correctes' },
  fan_isekai:          { name: '🌀 Fan Isekai', desc: '5 questions Isekai correctes' },
  anime_expert:        { name: '📚 Anime Expert', desc: '50 recherches anime effectuées' },
  hard_mode:           { name: '💀 Mode Hardcore', desc: '10 questions difficiles correctes' },
  streak_5:            { name: '🔥 En Feu !', desc: '5 bonnes réponses d\'affilée' },
  streak_10:           { name: '⚡ Invincible !', desc: '10 bonnes réponses d\'affilée' },
};

let db = { users: {}, sessionSettings: {} };

function loadDb() {
  try {
    if (fs.existsSync(OTAKU_DB_PATH)) {
      db = JSON.parse(fs.readFileSync(OTAKU_DB_PATH, 'utf-8'));
      if (!db.users) db.users = {};
      if (!db.sessionSettings) db.sessionSettings = {};
    }
  } catch (e) {
    console.error('[otaku] DB load error:', e.message);
    db = { users: {}, sessionSettings: {} };
  }
}

function saveDb() {
  try {
    const dir = path.dirname(OTAKU_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OTAKU_DB_PATH, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('[otaku] DB save error:', e.message);
  }
}

loadDb();

function getOrCreateUser(jid) {
  const userId = jid.split('@')[0];
  if (!db.users) db.users = {};
  if (!db.users[userId]) {
    db.users[userId] = {
      jid, xp: 0, level: 1,
      quizWins: 0, quizLosses: 0, quizTotal: 0,
      badges: [], favoriteAnime: null,
      animeSearchCount: 0, categoryCorrect: {},
      hardCorrect: 0, streak: 0, maxStreak: 0,
    };
    saveDb();
  }
  return db.users[userId];
}

function getLevel(xp) {
  let level = LEVELS[0];
  for (const l of LEVELS) { if (xp >= l.minXp) level = l; }
  return level;
}

function getNextLevel(xp) {
  for (const l of LEVELS) { if (xp < l.minXp) return l; }
  return null;
}

function addXP(jid, amount) {
  const user = getOrCreateUser(jid);
  user.xp += amount;
  user.level = LEVELS.filter(l => user.xp >= l.minXp).length;
  saveDb();
  return user;
}

function recordQuizResult(jid, won, category, correct, total) {
  const user = getOrCreateUser(jid);
  user.quizTotal += 1;
  won ? user.quizWins += 1 : user.quizLosses += 1;
  if (!user.categoryCorrect) user.categoryCorrect = {};
  if (!user.categoryCorrect[category]) user.categoryCorrect[category] = 0;
  user.categoryCorrect[category] += correct;
  const newBadges = checkBadges(user);
  saveDb();
  return { user, newBadges };
}

function updateStreak(jid, correct) {
  const user = getOrCreateUser(jid);
  if (correct) {
    user.streak = (user.streak || 0) + 1;
    if (user.streak > (user.maxStreak || 0)) user.maxStreak = user.streak;
  } else {
    user.streak = 0;
  }
  saveDb();
  return user.streak;
}

function recordHardCorrect(jid) {
  const user = getOrCreateUser(jid);
  user.hardCorrect = (user.hardCorrect || 0) + 1;
  saveDb();
}

function recordAnimeSearch(jid) {
  const user = getOrCreateUser(jid);
  user.animeSearchCount = (user.animeSearchCount || 0) + 1;
  checkBadges(user);
  saveDb();
}

function setFavoriteAnime(jid, anime) {
  const user = getOrCreateUser(jid);
  user.favoriteAnime = anime;
  saveDb();
}

function checkBadges(user) {
  const newBadges = [];
  const existing = user.badges || [];
  function tryUnlock(id) {
    if (!existing.includes(id)) { existing.push(id); newBadges.push(id); }
  }
  if (user.quizTotal >= 1) tryUnlock('debut_otaku');
  if (user.quizWins >= 10) tryUnlock('quiz_master_10');
  if (user.quizWins >= 50) tryUnlock('otaku_confirme_50');
  if (user.quizWins >= 100) tryUnlock('otaku_legendaire_100');
  const cat = user.categoryCorrect || {};
  if ((cat.naruto || 0) >= 5) tryUnlock('fan_naruto');
  if ((cat.onepiece || 0) >= 5) tryUnlock('fan_onepiece');
  if ((cat.dragonball || 0) >= 5) tryUnlock('fan_dragonball');
  if ((cat.aot || 0) >= 5) tryUnlock('fan_aot');
  if ((cat.demonslayer || 0) >= 5) tryUnlock('fan_demonslayer');
  if ((cat.mha || 0) >= 5) tryUnlock('fan_mha');
  if ((cat.general || 0) >= 5) tryUnlock('fan_isekai');
  if ((user.animeSearchCount || 0) >= 50) tryUnlock('anime_expert');
  if ((user.hardCorrect || 0) >= 10) tryUnlock('hard_mode');
  if ((user.streak || 0) >= 5) tryUnlock('streak_5');
  if ((user.streak || 0) >= 10) tryUnlock('streak_10');
  user.badges = existing;
  return newBadges;
}

function getLeaderboard(limit) {
  limit = limit || 10;
  if (!db.users) return [];
  return Object.values(db.users).sort((a, b) => (b.xp || 0) - (a.xp || 0)).slice(0, limit);
}

function getUserProfile(jid) { return getOrCreateUser(jid); }
function getAllUsers() { return db.users || {}; }

function getBotFont(botNumber) {
  if (!botNumber) return 1;
  if (!db.sessionSettings) db.sessionSettings = {};
  return db.sessionSettings[botNumber]?.botFont || 1;
}

function setBotFont(botNumber, fontId) {
  if (!botNumber) return;
  if (!db.sessionSettings) db.sessionSettings = {};
  if (!db.sessionSettings[botNumber]) db.sessionSettings[botNumber] = {};
  db.sessionSettings[botNumber].botFont = fontId;
  saveDb();
}

module.exports = {
  getOrCreateUser, getLevel, getNextLevel, addXP,
  recordQuizResult, updateStreak, recordHardCorrect,
  recordAnimeSearch, setFavoriteAnime, checkBadges,
  getLeaderboard, getUserProfile, getAllUsers,
  getBotFont, setBotFont,
  ALL_BADGES, LEVELS,
};
