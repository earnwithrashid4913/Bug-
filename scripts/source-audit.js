'use strict';

// Read-only inventory tool for an external migration archive. The archive is
// deliberately never extracted into this repository: it can contain sessions,
// .env files, and other private source material. Pass its absolute path (or
// SOURCE_ARCHIVE_PATH) when it has been supplied to the migration environment.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const archivePath = path.resolve(process.argv[2] || process.env.SOURCE_ARCHIVE_PATH || 'abcd New Folder.zip');
const requiredRootFiles = [
  'func.js', 'app.json', 'README.md', 'welcome.js', 'config.js', '.env',
  'AnimeMd.js', 'index.js', 'case.js', 'settings.js', 'utils.js'
];
const requiredCommands = [
  'ai', 'alive', 'antidelete', 'antilink', 'antimention', 'antispam', 'antitag', 'autoreact', 'autostatus',
  'autowrite', 'convert', 'delsudo', 'greet', 'group', 'media', 'menu', 'mode', 'ping', 'play', 'save',
  'setname', 'setprefix', 'sudo', 'sudolist', 'tag', 'tools', 'uploader', 'url', 'utils', 'vv', 'warning',
  'ytmp3', 'ytmp4'
].map((name) => `commands/${name}.js`);
// Prompt 2 names 156 plugin files while describing a total of 158. Keeping the
// supplied names explicit and separately reporting archive-only plugins makes
// that two-file discrepancy visible rather than silently omitting either one.
const requiredPlugins = [
  '_antilink.js', '_antilink2.js', '_antiprivado.js', '_antistatus.js', '_audios.js', '_autolevelup.js', '_autoresponder.js', '_mute.js',
  'descargas-drive.js', 'descargas-fb.js', 'descargas-gitclone.js', 'descargas-ig.js', 'descargas-igstalk.js', 'descargas-imagen.js', 'descargas-mediafire.js', 'descargas-modapk.js', 'descargas-pinterest.js', 'descargas-play.js', 'descargas-play2.js', 'descargas-playlist.js', 'descargas-spotify.js', 'descargas-threads.js', 'descargas-tiktok.js', 'descargas-tiktoksearch.js', 'descargas-tiktokstalk.js', 'descargas.appmusic.js',
  'buscador-google.js', 'buscador-lyrics.js',
  'convertidor-toimg.js', 'convertidor-tomp3.js', 'convertidor-tourl.js', 'convertidor-tts.js', 'maker-txt.js',
  'fun-adivinar.js', 'fun-juegos.js', 'fun-randow.js',
  'game-cf.js', 'game-math.js', 'game-ppt.js', 'game-rt.js', 'game-slot.js', 'game-ttt.js',
  'grupo-config.js', 'grupo-delete.js', 'grupo-delwarn.js', 'grupo-demote.js', 'grupo-fantasmas.js', 'grupo-groupInfo.js', 'grupo-hidetag.js', 'grupo-kick.js', 'grupo-kicknum-kicknun.js', 'grupo-link.js', 'grupo-listwarn.js', 'grupo-mute.js', 'grupo-pin.js', 'grupo-promote.js', 'grupo-resetLink.js', 'grupo-setConfig.js', 'grupo-setdesc.js', 'grupo-sethorario.js', 'grupo-setname.js', 'grupo-setpp.js', 'grupo-setprompt.js', 'grupo-staff.js', 'grupo-tagall.js', 'grupo-warn.js',
  'herramienta-id.js', 'herramientas-base64.js', 'herramientas-chagpt.js', 'herramientas-dallE.js', 'herramientas-hd.js', 'herramientas-list.js', 'herramientas-ssweb.js', 'herramientas-superinspect.js', 'herramientas-translate.js', 'herramientas-whatmusic.js',
  'info-donar.js', 'info-estado.js', 'info-grouplist.js', 'info-gruposofc.js', 'info-infobot.js', 'info-instalarbot.js', 'info-ping.js', 'info-reporte.js', 'info-sc.js', 'info-speedtest.js', 'info-uptime.js',
  'jadi-bots.js', 'jadi-privacidad.js', 'jadi-setprimary.js', 'jadi-stop.js', 'jadibot.js',
  'main-menu.js', 'menu-audios.js',
  'owner-addowner.js', 'owner-autoadmin.js', 'owner-backup.js', 'owner-banUser.js', 'owner-banchat.js', 'owner-db.js', 'owner-exec.js', 'owner-exec2.js', 'owner-fetch.js', 'owner-getplugin.js', 'owner-join.js', 'owner-leavegc.js', 'owner-restart.js', 'owner-self.js', 'owner-setbotname.js', 'owner-setlogo.js', 'owner-setprefix.js', 'owner-test.js', 'owner-unbanchat.js', 'owner-update.js',
  'random-anime.js',
  'rpg-add.js', 'rpg-balance.js', 'rpg-banc.js', 'rpg-cofre.js', 'rpg-crime.js', 'rpg-daily.js', 'rpg-leaderboard.js', 'rpg-levelup.js', 'rpg-mine.js', 'rpg-pareja-divorce.js', 'rpg-pareja.js', 'rpg-perfil.js', 'rpg-reg.js', 'rpg-rob.js', 'rpg-shop.js', 'rpg-slut.js', 'rpg-transfer.js', 'rpg-work.js',
  'rpg-rw-Rantig.js', 'rpg-rw-harem.js', 'rpg-rw-regalar.js', 'rpg-rw-retirar.js', 'rpg-rw-vender.js', 'rpg-rw-vote.js', 'rpg-rw.js', 'rpg-top-rachas.js',
  'so-add-audio.js', 'sticker-attp y ttp.js', 'sticker-dado.js', 'sticker-emojimix.js', 'sticker-exif.js', 'sticker-hug.js', 'sticker-kill.js', 'sticker-kiss.js', 'sticker-pack.js', 'sticker-pat.js', 'sticker-qc.js', 'sticker-slap.js', 'sticker-sticker.js', 'sticker-telegram.js', 'stickers-random.js'
].map((name) => `plugins/${name}`);

function entriesFromArchive(file) {
  try {
    return execFileSync('unzip', ['-Z1', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split(/\r?\n/)
      .map((entry) => entry.replace(/^\.\//, ''))
      .filter(Boolean);
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    throw new Error(`Unable to list ZIP archive: ${detail}`);
  }
}

function hasSuffix(entries, suffix) {
  return entries.some((entry) => entry === suffix || entry.endsWith(`/${suffix}`));
}

function main() {
  if (!fs.existsSync(archivePath)) {
    console.error(`[source-audit] Archive not found: ${archivePath}`);
    console.error('[source-audit] Provide its absolute path as an argument or set SOURCE_ARCHIVE_PATH.');
    process.exitCode = 2;
    return;
  }

  const entries = entriesFromArchive(archivePath);
  const files = entries.filter((entry) => !entry.endsWith('/'));
  const commandFiles = files.filter((entry) => /(^|\/)commands\/[^/]+\.js$/i.test(entry));
  const pluginFiles = files.filter((entry) => /(^|\/)plugins\/[^/]+\.js$/i.test(entry));
  const nestedRoot = 'other functions/𝗟𝗲𝗮𝗰𝗸𝗲𝗱 𝗯𝘆 𝗝𝗮𝗺𝗲𝘀 🤣😂/';
  const nestedFiles = files.filter((entry) => entry.includes(nestedRoot));
  const missingRoot = requiredRootFiles.filter((file) => !hasSuffix(files, file));
  const missingCommands = requiredCommands.filter((file) => !hasSuffix(files, file));
  const missingPlugins = requiredPlugins.filter((file) => !hasSuffix(files, file));
  const unlistedPlugins = pluginFiles.filter((file) => !hasSuffix(requiredPlugins, file));

  console.log(`[source-audit] Archive: ${archivePath}`);
  console.log(`[source-audit] Files scanned: ${files.length}`);
  console.log(`[source-audit] Command files: ${commandFiles.length}`);
  console.log(`[source-audit] Plugin files: ${pluginFiles.length}`);
  console.log(`[source-audit] Prompt-named plugins present: ${requiredPlugins.length - missingPlugins.length}/${requiredPlugins.length}`);
  console.log(`[source-audit] Nested-tree files: ${nestedFiles.length}`);
  console.log(`[source-audit] Required root files missing: ${missingRoot.length ? missingRoot.join(', ') : 'none'}`);
  console.log(`[source-audit] Required command files missing: ${missingCommands.length ? missingCommands.join(', ') : 'none'}`);
  console.log(`[source-audit] Required plugin files missing: ${missingPlugins.length ? missingPlugins.join(', ') : 'none'}`);
  console.log(`[source-audit] Archive plugins not named by Prompt 2: ${unlistedPlugins.length ? unlistedPlugins.join(', ') : 'none'}`);
  console.log('[source-audit] Read-only inventory complete; no archive contents were extracted or committed.');
}

main();
