'use strict';

const { getQuestions } = require('./quiz-data');
const otaku = require('./otaku');

const groupSessions = new Map();
const JOIN_TIMEOUT = 45000;
const QUESTION_TIMEOUT = 30000;
const BETWEEN_QUESTIONS = 4000;
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const TOTAL_QUESTIONS = 10;

function sk(remoteJid) { return remoteJid; }

async function startQuiz(socket, context, args) {
  const category = (args[0] || 'random').toLowerCase();
  const difficulty = (args[1] || 'easy').toLowerCase();
  const organizer = context.sender;
  const organizerName = context.raw?.pushName || organizer.split('@')[0];

  if (groupSessions.has(sk(context.chatId))) {
    const existing = groupSessions.get(sk(context.chatId));
    if (existing.status === 'lobby') return socket.sendMessage(context.chatId, { text: '⚠️ A quiz is already in the join phase! Type *join* to join.' }, { quoted: context.raw });
    return socket.sendMessage(context.chatId, { text: '⚠️ A quiz is already running! Use *!quiz stop* to stop it.' }, { quoted: context.raw });
  }

  const questions = getQuestions(category, difficulty, TOTAL_QUESTIONS);
  if (!questions.length) return socket.sendMessage(context.chatId, { text: '❌ No questions found for this category.' }, { quoted: context.raw });

  const session = {
    status: 'lobby', organizer, players: new Map(),
    questions, currentIndex: 0, currentQuestionOpen: false,
    timer: null, lobbyTimer: null, remoteJid: context.chatId,
    category, difficulty,
  };

  session.players.set(organizer, { name: organizerName, score: 0, correctAnswers: 0, answered: false });
  groupSessions.set(sk(context.chatId), session);

  const diffText = difficulty === 'hard' ? '💀 HARD' : '⚡ NORMAL';
  await socket.sendMessage(context.chatId, {
    text: '╔══════════════════╗\n  🎌 *QUIZ OTAKU - MULTIPLAYER*\n╠══════════════════╣\n\n' +
      '📚 Category: *' + category.toUpperCase() + '*\n⚡ Difficulty: *' + diffText + '*\n' +
      '🔢 Questions: *' + TOTAL_QUESTIONS + '*\n👑 Organizer: *' + organizerName + '*\n\n' +
      '━━━━━━━━━━━━━━━━━━\nType *join* to join!\n' +
      '⏱️ *45 seconds* to register\n👥 Min: ' + MIN_PLAYERS + ' | Max: ' + MAX_PLAYERS + ' players\n' +
      '━━━━━━━━━━━━━━━━━━\n\n✅ *' + organizerName + '* joined! (1/' + MAX_PLAYERS + ')\n\n╚══════════════════╝'
  }, { quoted: context.raw });

  session.lobbyTimer = setTimeout(async () => { await launchQuizFromLobby(socket, context.chatId); }, JOIN_TIMEOUT);
}

async function joinQuiz(socket, context) {
  if (!groupSessions.has(sk(context.chatId))) return false;
  const session = groupSessions.get(sk(context.chatId));
  if (session.status !== 'lobby') return false;

  const player = context.sender;
  const playerName = context.raw?.pushName || player.split('@')[0];
  if (session.players.has(player)) { await socket.sendMessage(context.chatId, { text: '⚠️ *' + playerName + '*, you are already registered!' }, { quoted: context.raw }); return true; }
  if (session.players.size >= MAX_PLAYERS) { await socket.sendMessage(context.chatId, { text: '❌ Quiz is full (' + MAX_PLAYERS + ' players max).' }, { quoted: context.raw }); return true; }

  session.players.set(player, { name: playerName, score: 0, correctAnswers: 0, answered: false });
  const count = session.players.size;
  await socket.sendMessage(context.chatId, { text: '✅ *' + playerName + '* joined the quiz! (' + count + '/' + MAX_PLAYERS + ' players)' }, { quoted: context.raw });
  if (count >= MAX_PLAYERS) { clearTimeout(session.lobbyTimer); await launchQuizFromLobby(socket, context.chatId); }
  return true;
}

async function launchQuizFromLobby(socket, remoteJid) {
  const session = groupSessions.get(sk(remoteJid));
  if (!session || session.status !== 'lobby') return;
  const count = session.players.size;
  if (count < MIN_PLAYERS) {
    groupSessions.delete(sk(remoteJid));
    return socket.sendMessage(remoteJid, { text: '╔══════════════════╗\n  ❌ *QUIZ CANCELLED*\n╠══════════════════╣\n\nOnly *' + count + ' player(s)* — minimum ' + MIN_PLAYERS + ' required.\n\n_Type *!quiz* when more members are available!_\n╚══════════════════╝' });
  }

  session.status = 'running';
  const playerList = Array.from(session.players.values()).map((p, i) => (i+1) + '. *' + p.name + '*').join('\n');
  await socket.sendMessage(remoteJid, {
    text: '╔══════════════════╗\n  🚀 *QUIZ STARTED!*\n╠══════════════════╣\n\n' +
      '👥 *' + count + ' players registered:*\n' + playerList + '\n\n' +
      '📋 *Rules:*\n• Reply with *A*, *B*, *C* or *D*\n• The *first* to give the correct answer gets the point\n• 30 seconds per question\n\n' +
      '_Starting in 3 seconds..._\n╚══════════════════╝'
  });
  await new Promise(r => setTimeout(r, 3000));
  await sendGroupQuestion(socket, session, remoteJid);
}

async function sendGroupQuestion(socket, session, remoteJid) {
  const q = session.questions[session.currentIndex];
  const index = session.currentIndex + 1;
  const total = session.questions.length;
  for (const player of session.players.values()) player.answered = false;
  session.currentQuestionOpen = true;

  await socket.sendMessage(remoteJid, {
    text: '╔══════════════════╗\n  🎌 *QUESTION ' + index + '/' + total + '*\n╠══════════════════╣\n\n' +
      '❓ *' + q.q + '*\n\n' + q.choices.join('\n') + '\n\n' +
      '⏱️ *30 seconds*  •  💎 +' + q.xp + ' pts\n╚══════════════════╝'
  });

  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(async () => {
    session.currentQuestionOpen = false;
    await socket.sendMessage(remoteJid, {
      text: '⏱️ *Time\'s up!*\n\n❌ Nobody found the answer.\n✅ The answer was: *' + q.choices.find(c => c.startsWith(q.answer + '.')) + '*'
    });
    await showIntermediateRanking(socket, session, remoteJid);
    await nextQuestion(socket, session, remoteJid);
  }, QUESTION_TIMEOUT);
}

async function handleGroupAnswer(socket, context) {
  if (!groupSessions.has(sk(context.chatId))) return false;
  const session = groupSessions.get(sk(context.chatId));
  if (session.status !== 'running' || !session.currentQuestionOpen || !session.players.has(context.sender)) return false;

  const playerData = session.players.get(context.sender);
  if (playerData.answered) return false;

  const body = (context.raw?.message?.conversation || context.raw?.message?.extendedTextMessage?.text || '').trim().toUpperCase();
  const answer = /^[1-4]$/.test(body) ? 'ABCD'[Number(body) - 1] : body.charAt(0);
  if (!['A', 'B', 'C', 'D'].includes(answer)) return false;

  const q = session.questions[session.currentIndex];
  const isCorrect = answer === q.answer;
  playerData.answered = true;

  if (isCorrect) {
    await socket.sendMessage(context.chatId, { react: { text: '✅', key: context.raw.key } });
    session.currentQuestionOpen = false;
    if (session.timer) clearTimeout(session.timer);
    playerData.score += q.xp;
    playerData.correctAnswers += 1;
    otaku.addXP(context.sender, q.xp);
    if (q.hard) otaku.recordHardCorrect(context.sender);

    await socket.sendMessage(context.chatId, {
      text: '✅ *CORRECT ANSWER!*\n\n🏆 *' + playerData.name + '* earns *+' + q.xp + ' pts* !\n💡 Answer: *' + q.choices.find(c => c.startsWith(q.answer + '.')) + '*'
    });
    await showIntermediateRanking(socket, session, context.chatId);
    await nextQuestion(socket, session, context.chatId);
  } else {
    await socket.sendMessage(context.chatId, { react: { text: '❌', key: context.raw.key } });
  }
  return true;
}

async function showIntermediateRanking(socket, session, remoteJid) {
  const sorted = Array.from(session.players.entries()).sort((a, b) => b[1].score - a[1].score);
  const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  const remaining = session.questions.length - session.currentIndex - 1;
  let text = '📊 *RANKING — Q' + (session.currentIndex + 1) + '/' + session.questions.length + '*\n\n';
  sorted.forEach(function([jid, p], i) { text += (medals[i] || ((i+1) + '.')) + ' *' + p.name + '* — ' + p.score + ' pts (' + p.correctAnswers + ' ✅)\n'; });
  if (remaining > 0) text += '\n_' + remaining + ' question(s) remaining..._';
  await socket.sendMessage(remoteJid, { text });
}

async function nextQuestion(socket, session, remoteJid) {
  session.currentIndex++;
  if (session.currentIndex >= session.questions.length) { await endGroupQuiz(socket, session, remoteJid); return; }
  await new Promise(r => setTimeout(r, BETWEEN_QUESTIONS));
  await sendGroupQuestion(socket, session, remoteJid);
}

async function endGroupQuiz(socket, session, remoteJid) {
  groupSessions.delete(sk(remoteJid));
  const sorted = Array.from(session.players.entries()).sort((a, b) => b[1].score - a[1].score);
  const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  const winner = sorted[0];
  let text = '╔══════════════════╗\n  🏆 *FINAL RESULTS*\n╠══════════════════╣\n\n';
  if (winner) text += '👑 *WINNER: ' + winner[1].name + '* with *' + winner[1].score + ' pts* !\n\n';
  text += '📊 *Full Ranking:*\n\n';
  sorted.forEach(function([jid, p], i) {
    const level = otaku.getLevel(otaku.getUserProfile(jid).xp);
    text += (medals[i] || ((i+1) + '.')) + ' *' + p.name + '*\n   🏅 ' + p.score + ' pts  |  ' + p.correctAnswers + '/' + session.questions.length + ' ✅\n   💎 ' + level.name + '\n\n';
  });
  text += '━━━━━━━━━━━━━━━━━━\n_Type *!quiz* for a new game._\n╚══════════════════╝\n> *[ ANIME CORE ]*';

  for (const [jid, p] of sorted) {
    otaku.recordQuizResult(jid, sorted[0][0] === jid, session.category, p.correctAnswers, session.questions.length);
  }
  await socket.sendMessage(remoteJid, { text });
}

async function stopQuiz(socket, context) {
  if (!groupSessions.has(sk(context.chatId))) return socket.sendMessage(context.chatId, { text: '❌ No quiz running in this group.' }, { quoted: context.raw });
  const session = groupSessions.get(sk(context.chatId));
  if (session.organizer !== context.sender) return socket.sendMessage(context.chatId, { text: '❌ Only the organizer can stop the quiz.' }, { quoted: context.raw });
  if (session.timer) clearTimeout(session.timer);
  if (session.lobbyTimer) clearTimeout(session.lobbyTimer);
  groupSessions.delete(sk(context.chatId));
  await socket.sendMessage(context.chatId, { text: '🛑 *Quiz stopped.*\n_Type *!quiz* for a new game!_' }, { quoted: context.raw });
}

function isQuizActive(remoteJid) { return groupSessions.get(sk(remoteJid))?.status === 'running'; }
function isLobbyActive(remoteJid) { return groupSessions.get(sk(remoteJid))?.status === 'lobby'; }

module.exports = { startQuiz, joinQuiz, stopQuiz, handleGroupAnswer, isQuizActive, isLobbyActive };
