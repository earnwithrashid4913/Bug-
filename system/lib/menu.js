'use strict';

const CATEGORY_META = Object.freeze({
  general: { id: 'general', label: 'GENERAL', icon: '⚡', title: 'General' },
  mode: { id: 'mode', label: 'MESSAGE MODE', icon: '💬', title: 'Message Mode' },
  downloader: { id: 'downloader', label: 'DOWNLOADER', icon: '🎵', title: 'Downloader' },
  media: { id: 'media', label: 'MEDIA', icon: '🎬', title: 'Media' },
  converter: { id: 'converter', label: 'CONVERTER', icon: '🧰', title: 'Converter' },
  upload: { id: 'upload', label: 'UPLOAD', icon: '📤', title: 'Upload' },
  ai: { id: 'ai', label: 'AI', icon: '🤖', title: 'AI' },
  tools: { id: 'tools', label: 'TOOLS', icon: '🛠', title: 'Tools' },
  group: { id: 'group', label: 'GROUP', icon: '👥', title: 'Group' },
  anti: { id: 'anti', label: 'ANTI / SECURITY', icon: '🛡', title: 'Anti & Security' },
  automation: { id: 'automation', label: 'AUTOMATION', icon: '⚙️', title: 'Automation' },
  sticker: { id: 'sticker', label: 'STICKER', icon: '🎨', title: 'Sticker' },
  games: { id: 'games', label: 'GAMES', icon: '🎮', title: 'Games' },
  rpg: { id: 'rpg', label: 'RPG / ECONOMY', icon: '💰', title: 'RPG & Economy' },
  owner: { id: 'owner', label: 'OWNER', icon: '👑', title: 'Owner' },
  sudo: { id: 'sudo', label: 'SUDO', icon: '🔐', title: 'Sudo' },
  premium: { id: 'premium', label: 'PREMIUM', icon: '💎', title: 'Premium' },
  info: { id: 'info', label: 'INFO', icon: 'ℹ️', title: 'Info' },
  sessions: { id: 'sessions', label: 'JADIBOT / SESSIONS', icon: '🧩', title: 'Sessions' },
  telegram: { id: 'telegram', label: 'TELEGRAM', icon: '✈️', title: 'Telegram' },
  settings: { id: 'settings', label: 'SETTINGS', icon: '⚙️', title: 'Settings' },
  anime: { id: 'anime', label: 'ANIME / OTAKU', icon: '🍥', title: 'Anime & Otaku' },
  quiz: { id: 'quiz', label: 'QUIZ', icon: '❓', title: 'Quiz' },
  funextra: { id: 'funextra', label: 'FUN EXTRAS', icon: '🎭', title: 'Fun Extras' },
  other: { id: 'other', label: 'OTHER', icon: '✨', title: 'Other' }
});

function command(name, category, description, { aliases = [], usage = '', permission = 'public' } = {}) {
  return Object.freeze({ name, category, description, aliases: Object.freeze([...new Set(aliases)]), usage, permission });
}

const COMMANDS = Object.freeze([
  ...['fancy', 'encrypt', 'encrypt2', 'tempmail', 'getmail'].map(name => command(name, 'tools', 'Source API tool.', { usage: name === 'tempmail' ? '' : '<input>' })),
  command('upload', 'upload', 'Mirror a URL or upload replied media.', { aliases: ['mirror', 'host'], usage: '<url|reply>' }),
  command('store', 'media', 'Save replied audio/video.', { permission: 'owner', usage: '<name>' }),
  command('ad', 'media', 'Send stored audio.', { permission: 'owner', usage: '<name>' }),
  command('vd', 'media', 'Send stored video.', { permission: 'owner', usage: '<name> [-c]' }),
  command('list', 'media', 'List stored media.', { permission: 'owner' }),
  command('del', 'media', 'Delete stored media.', { permission: 'owner', usage: 'audio|video <name>' }),
  command('menu', 'general', 'Open the interactive command menu.', { aliases: ['help'], usage: '[category]' }),
  command('ping', 'general', 'Check bot latency.', { aliases: ['p'] }),
  command('request', 'general', 'Send a request or bug report to the owner.', { aliases: ['reportbug'], usage: '<message>' }),

  command('public', 'mode', 'Switch the bot to public mode.', { permission: 'owner' }),
  command('self', 'mode', 'Switch the bot to self/owner-only mode.', { aliases: ['private'], permission: 'owner' }),
  command('mode', 'mode', 'Show or change message mode.', { permission: 'owner', aliases: ['botmode'], usage: '<public|self>' }),

  command('play', 'downloader', 'Search and download audio from a supported video link or YouTube query.', { usage: '<query|url>' }),
  command('ytmp3', 'downloader', 'Download audio from a supported video URL.', { aliases: ['audio', 'mp3'], usage: '<url>' }),
  command('video', 'downloader', 'Download video from a supported video URL.', { aliases: ['ytmp4', 'mp4', 'ytvideo'], usage: '<query|url>' }),
  command('spotify', 'downloader', 'Search Spotify and return official track information/links.', { usage: '<query>' }),
  command('media', 'downloader', 'Download media from supported TikTok/Instagram/Facebook/video links.', { aliases: ['download', 'dl'], usage: '<url>' }),

  command('getpp', 'media', 'Get a user or group profile picture.', { aliases: ['pp', 'profilepic', 'avatar'], usage: '[number|mention|reply]' }),
  command('setpp', 'media', 'Update the bot profile picture from a replied image.', { permission: 'owner' }),
  command('vv', 'media', 'Reveal a replied view-once photo or video.', { aliases: ['hey', 'revealonce', 'retrieve', 'viewonce'] }),

  command('save', 'media', 'Save a replied status and send it to the connected owner.', { aliases: ['savestatus', 'downloadstatus'] }),
  command('tovid', 'converter', 'Convert a sticker to MP4 video (FFmpeg required).', { aliases: ['sticker2vid'] }),
  command('take', 'sticker', 'Change sticker pack and author without losing animation.', { aliases: ['steal'], usage: '[pack|author]' }),
  command('toimg', 'converter', 'Convert a replied sticker to an image.', { aliases: ['sticker2img', 'img'] }),
  command('convert', 'converter', 'Show conversion options.', { aliases: ['converter'] }),
  command('tts', 'converter', 'Convert text to speech audio.', { usage: '<text>' }),
  command('qr', 'converter', 'Create a QR code from text or a URL.', { aliases: ['qrcode'], usage: '<text>' }),

  command('tourl', 'upload', 'Upload a replied image/video/document and get a public URL.', { aliases: ['uploader', 'url', 'imgtourl', 'imageurl'], usage: '<reply>' }),

  command('ai', 'ai', 'Ask the configured Groq AI provider.', { aliases: ['ask', 'ia', 'groq', 'loveai', 'love', 'dark'], usage: '<question>' }),
  command('translate', 'ai', 'Translate text; replies are auto-detected and translated to English by default.', { aliases: ['tr', 'trans'], usage: '[lang] <text>' }),

  command('jid', 'tools', 'Show current chat and sender JIDs.', { aliases: ['chatid'] }),
  command('idch', 'tools', 'Fetch WhatsApp channel metadata.', { aliases: ['cekidch'], usage: '<channel url>' }),
  command('calc', 'tools', 'Safely calculate a math expression.', { aliases: ['calculate', 'math'], usage: '<expression>' }),
  command('ss', 'tools', 'Capture a screenshot of a website.', { aliases: ['screenshot'], usage: '<url>' }),
  command('short', 'tools', 'Shorten a URL.', { aliases: ['shorten', 'tinyurl'], usage: '<url>' }),
  command('uid', 'tools', 'Show your WhatsApp UID/JID.'),
  command('tools', 'tools', 'Show available tools.', { aliases: ['utils'] }),

  command('hidetag', 'group', 'Send a message mentioning every group member without visible tags.', { aliases: ['ht', 'tag'], usage: '<message>', permission: 'admin' }),
  command('tagall', 'group', 'Mention every group member with a visible list.', { aliases: ['everyone'], usage: '<message>', permission: 'admin' }),
  command('greet', 'group', 'Show welcome/goodbye status.', { permission: 'admin' }),
  command('welcome', 'group', 'Enable, disable, or check welcome messages.', { usage: '<on|off|status>', permission: 'admin' }),
  command('goodbye', 'group', 'Enable, disable, or check goodbye messages.', { usage: '<on|off|status>', permission: 'admin' }),
  command('group', 'group', 'Show group management help.', { permission: 'admin' }),
  command('gname', 'group', 'Change the group subject.', { usage: '<name>', permission: 'admin' }),
  command('gdesc', 'group', 'Change the group description.', { usage: '<description>', permission: 'admin' }),
  command('add', 'group', 'Add a participant by international number.', { usage: '<number>', permission: 'admin' }),
  command('kick', 'group', 'Remove a mentioned or replied participant.', { permission: 'admin' }),
  command('promote', 'group', 'Promote a participant to admin.', { permission: 'admin' }),
  command('demote', 'group', 'Demote an admin.', { permission: 'admin' }),
  command('lock', 'group', 'Set the group to admins-only chatting.', { permission: 'admin' }),
  command('unlock', 'group', 'Allow all participants to chat.', { permission: 'admin' }),
  command('grouplink', 'group', 'Get the group invite link.', { aliases: ['linkgc'], permission: 'admin' }),
  command('warn', 'group', 'Warn a group member.', { aliases: ['warning'], usage: '@user <reason>', permission: 'admin' }),
  command('unwarn', 'group', 'Remove warnings from a member.', { aliases: ['delwarn'], usage: '@user', permission: 'admin' }),
  command('warns', 'group', 'List warning counts.', { aliases: ['warnings'], permission: 'admin' }),

  command('antilink', 'anti', 'Toggle harmful-link protection.', { usage: '<on|off|status>', permission: 'admin' }),
  command('antispam', 'anti', 'Toggle repeated-message flood protection.', { usage: '<on|off|status>', permission: 'admin' }),
  command('antimention', 'anti', 'Toggle excessive-mention protection.', { aliases: ['antigroupmention'], usage: '<on|off|status>', permission: 'admin' }),
  command('antitag', 'anti', 'Toggle mass-tag protection.', { usage: '<on|off|status>', permission: 'admin' }),
  command('antidelete', 'anti', 'Recover deleted text/media to connected owner.', { aliases: ['antisupp'], usage: '<on|off|status>', permission: 'admin' }),

  command('autoreact', 'automation', 'Toggle automatic emoji reactions in this chat.', { aliases: ['autoreaction'], usage: '<on|off|status>', permission: 'admin' }),
  command('autowrite', 'automation', 'Toggle automatic typing presence for incoming non-command messages.', { aliases: ['autotype', 'fakewrite'], usage: '<on|off|status>' }),
  command('autostatus', 'automation', 'Status settings (status event routing requires approval).', { aliases: ['autostatusview', 'autostatusreact'], usage: '<on|off|status>', permission: 'owner' }),

  command('purge', 'group', 'Remove non-admin members in one batch.', { permission: 'admin' }),
  command('autopromote', 'group', 'Promote the caller (existing admin gate preserved).', { permission: 'admin' }),
  command('antidemote', 'anti', 'Restore demoted administrators.', { usage: '<on|off|status>', permission: 'admin' }),
  command('antipromote', 'anti', 'Reverse promotions.', { usage: '<on|off|status>', permission: 'admin' }),
  command('sticker', 'sticker', 'Create a sticker from a replied image.', { aliases: ['s', 'stiker'] }),

  command('dice', 'games', 'Roll a six-sided die.', { aliases: ['roll'] }),
  command('coin', 'games', 'Flip a coin.', { aliases: ['flip'] }),
  command('rps', 'games', 'Play rock, paper, scissors.', { usage: '<rock|paper|scissors>' }),
  command('guess', 'games', 'Start a simple number-guessing game.', { aliases: ['guessthenumber'], usage: '[start|guess|stop]' }),

  command('balance', 'rpg', 'Check wallet and bank balance.', { aliases: ['bal', 'wallet'] }),
  command('daily', 'rpg', 'Claim the daily coin reward.', { aliases: ['claim'] }),
  command('work', 'rpg', 'Work for coins.', { aliases: ['earn'] }),
  command('give', 'rpg', 'Transfer coins to another user.', { usage: '@user <amount>' }),
  command('rpg', 'rpg', 'Show economy commands.', { aliases: ['economy'] }),

  command('restart', 'owner', 'Restart the bot process.', { aliases: ['rst'], permission: 'owner' }),
  command('setname', 'owner', 'Set the WhatsApp profile display name.', { usage: '<name>', permission: 'owner' }),
  command('setprefix', 'owner', 'Set a custom command prefix.', { usage: '<prefix>', permission: 'owner' }),
  command('broadcast', 'owner', 'Send a global owner announcement to known private/session chat.', { aliases: ['bc'], usage: '<message>', permission: 'owner' }),

  command('sudo', 'sudo', 'Add a sudo number using number, mention or reply.', { aliases: ['addsudo', 'makesudo'], usage: '<number>', permission: 'owner' }),
  command('delsudo', 'sudo', 'Remove a sudo number or list current sudo users.', { aliases: ['removesudo', 'unsudo'], usage: '<number>', permission: 'owner' }),
  command('sudolist', 'sudo', 'List sudo numbers.', { aliases: ['listsudo', 'sudos'], permission: 'sudo' }),

  command('addprem', 'premium', 'Add premium access.', { usage: '<number> [30d]', permission: 'owner' }),
  command('delprem', 'premium', 'Remove premium access.', { usage: '<number>', permission: 'owner' }),
  command('listprem', 'premium', 'List active premium users.', { permission: 'owner' }),
  command('premium', 'premium', 'Show premium status for this chat/number.'),

  command('alive', 'info', 'Check uptime with an image and text fallback.'),
  command('status', 'info', 'Show bot status and uptime.', { aliases: ['runtime'] }),
  command('owner', 'info', 'Show owner and developer details.', { aliases: ['creator'] }),

  command('sessions', 'sessions', 'Show the active ANIME MD WhatsApp session.'),
  command('stopsession', 'sessions', 'Show the Telegram session-cleanup instructions.', { aliases: ['stop'], usage: '<number>', permission: 'owner' }),

  command('pairing', 'telegram', 'Show the authorized Telegram pairing controller link.', { aliases: ['tgpair'] }),
  command('telegram', 'telegram', 'Show Telegram controller setup status.', { aliases: ['tg'] }),

  // --- ANIME / OTAKU ---
  command('anime', 'anime', 'Search for an anime on MyAnimeList.', { usage: 'search|info|download <title> | top|trending|season|new|random|genres' }),
  command('manga', 'anime', 'Search for a manga on MyAnimeList.', { usage: '<title>' }),
  command('character', 'anime', 'Look up an anime character.', { aliases: ['char'], usage: '<name>' }),
  command('waifu', 'anime', 'Get a random waifu image.'),
  command('husbando', 'anime', 'Get a random husbando image.'),
  command('dailywaifu', 'anime', 'Get your daily waifu image.'),
  command('animequote', 'anime', 'Get a random anime/manga quote.', { aliases: ['quote'] }),
  command('animevs', 'anime', 'Compare two anime power levels.', { usage: '<anime1> vs <anime2>' }),
  command('profile', 'anime', 'View your otaku profile and stats.', { aliases: ['otakuprofile'] }),
  command('badges', 'anime', 'View your earned otaku badges.', { aliases: ['badge'] }),
  command('leaderboard', 'anime', 'View the top otaku leaderboard.', { aliases: ['lb', 'topplayers'] }),

  // --- QUIZ ---
  command('quizjoin', 'quiz', 'Join the active group quiz.'),
  command('quizstop', 'quiz', 'Stop the active group quiz.'),
  command('kickall', 'group', 'Remove non-admins progressively.', { aliases: ['kickall2'], permission: 'admin' }),
  command('demoteall', 'group', 'Demote eligible administrators except the caller and bot.', { permission: 'admin' }),
  command('promoteall', 'group', 'Promote non-admin members.', { permission: 'admin' }),
  command('opentime', 'group', 'Schedule opening the group.', { permission: 'admin', usage: '<duration|cancel>' }),
  command('closetime', 'group', 'Schedule closing the group.', { permission: 'admin', usage: '<duration|cancel>' }),
  command('quiz', 'quiz', 'Start an anime quiz session.', { aliases: ['startquiz'], usage: '[category] [easy|hard] | join | stop' }),

  // --- FUN EXTRAS ---
  command('couple', 'funextra', 'Match two random group members as a couple.', { aliases: ['lovemeter'] }),
  command('ship', 'funextra', 'Check love compatibility between two names.', { usage: '<name1> <name2>' }),
  command('truth', 'funextra', 'Get a random truth question.'),
  command('dare', 'funextra', 'Get a random dare challenge.'),
  command('fact', 'funextra', 'Get a random fun fact.', { aliases: ['randomfact'] }),
  command('pickup', 'funextra', 'Get a random pickup line.', { aliases: ['pickupline'] }),
  command('meteo', 'funextra', 'Get weather info for a city.', { aliases: ['weather'], usage: '<city>' }),
  command('lyrics', 'funextra', 'Search for song lyrics.', { aliases: ['lyric'], usage: '<song title>' }),
  command('tiktok', 'downloader', 'Download a TikTok video without watermark.', { aliases: ['tt', 'ttdl'], usage: '<link>' }),
  command('facebook', 'downloader', 'Download a Facebook video.', { aliases: ['fb', 'fbdl'], usage: '<link>' }),
  command('twitter', 'downloader', 'Download a Twitter/X video.', { aliases: ['xdl', 'twdl'], usage: '<link>' })
]);

const ALIAS_MAP = COMMANDS.reduce((map, entry) => {
  for (const value of [entry.name, ...entry.aliases]) {
    if (map[value]) throw new Error(`Duplicate command or alias: ${value}`);
    map[value] = entry;
  }
  return map;
}, Object.create(null));

function categoriesWithCommands() {
  const map = new Map();
  for (const entry of COMMANDS) {
    if (!map.has(entry.category)) map.set(entry.category, { ...CATEGORY_META[entry.category], commands: [] });
    map.get(entry.category).commands.push(entry);
  }
  return [...map.values()].map((category) => ({ ...category, commands: [...category.commands] }));
}

function getCategory(id) {
  return categoriesWithCommands().find((category) => category.id === id || category.label.toLowerCase() === String(id || '').toLowerCase());
}

function resolveCommand(name) {
  return ALIAS_MAP[String(name || '').toLowerCase()] || undefined;
}

function allAliases() {
  return Object.keys(ALIAS_MAP).sort();
}

function helpText(prefix = '!', categoryId = '') {
  const category = categoryId ? getCategory(categoryId) : undefined;
  if (category) {
    return [
      `*${configSafeName(category)}*`,
      '',
      ...category.commands.flatMap((entry) => [
        `${prefix}${entry.name}${entry.usage ? ` ${entry.usage}` : ''}${entry.aliases.length ? `  (${entry.aliases.map(alias => `${prefix}${alias}`).join(', ')})` : ''}`,
        entry.description,
        ''
      ]),
      `Type ${prefix}menu for all categories.`
    ].join('\n');
  }

  const categories = categoriesWithCommands();
  return [
    '*ANIME MD*',
    '',
    '*General commands*',
    ...categories.map((category, index) => `${index + 1}. ${category.icon} ${category.title} — ${prefix}menu ${category.id}`),
    '',
    `Type ${prefix}menu <category> or reply with a category number.`,
    '',
    `Owner: Rashid Hussain`,
    `Developer: F!xa Dev`
  ].join('\n');
}

function configSafeName(category) {
  return `${category.icon} ${category.label}`;
}

module.exports = {
  CATEGORY_META,
  COMMANDS,
  allAliases,
  categoriesWithCommands,
  getCategory,
  helpText,
  resolveCommand
};
