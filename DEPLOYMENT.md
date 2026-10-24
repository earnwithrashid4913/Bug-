# ANIME MD Deployment Guide

ANIME MD requires Node.js 20.9 or newer. Install dependencies with `npm ci`
and start it with `npm start`.

## Pterodactyl

Use `npm start` as the startup command. Before starting, edit `config.js`:

- Set `whatsapp.authDir` and `database.dataDir` to paths on persistent storage.
- Enter Telegram credentials in `telegram` or set `telegram.enabled` to `false`.

This bot does not run an HTTP dashboard or web-pairing server, so Pterodactyl
port allocation is not required. It uses WhatsApp and Telegram outbound APIs.

- If your panel allocates a port for the optional legacy web pairing server, set
  `deployment.webPort` to it and explicitly enable `deployment.webPairingEnabled`.

The application does not read `.env` or panel environment variables for bot
configuration, with two deliberate path-only exceptions used by the Render
manifest: `ANIME_MD_AUTH_DIR` and `ANIME_MD_DATA_DIR`. They select where the
WhatsApp session and bot databases live; every other setting remains in
`config.js`. Never paste session credentials or secrets into logs.

### Render

`render.yaml` mounts a 1 GB disk at `/var/data` (outside the checkout) and sets
`ANIME_MD_AUTH_DIR=/var/data/session` and `ANIME_MD_DATA_DIR=/var/data/data`, so
sessions and databases survive deploys instead of living on the ephemeral
filesystem. Do not remove those variables while the disk is in use, or Render
will silently start from an empty session and an empty database.

## Command media requirements

`!play`, `!video` and their aliases download media **on your host** through
[yt-dlp](https://github.com/yt-dlp/yt-dlp). No third-party download API or API
key is used.

The repaired commands require **both yt-dlp and FFmpeg**. The existing engine
can find tools on PATH, use `downloads.ytDlpPath` / `downloads.ffmpegPath`, or
attempt automatic installation when `downloads.autoInstall` is true. Automatic
installation is best-effort, **not a guarantee**: executable mounts, architecture,
release download access and host permissions must permit it. FFmpeg is required
to make genuine MP3/Opus and validate the full output; these commands do not
silently relabel M4A as MP3 or WebM as MP4.

### Install and verify tools

Debian/Ubuntu, with a user-owned Python environment (no global pip override):

```sh
sudo apt-get update
sudo apt-get install -y python3-venv ffmpeg
python3 -m venv "$HOME/.venvs/anime-media"
"$HOME/.venvs/anime-media/bin/pip" install --upgrade 'yt-dlp[default]'
"$HOME/.venvs/anime-media/bin/yt-dlp" --version
ffmpeg -version
```

Set `downloads.ytDlpPath` in `config.js` to the **absolute path** of that yt-dlp
executable. Set `downloads.ffmpegPath` if FFmpeg is not on PATH. Keep the Python
environment outside the repository, on executable persistent storage. The repaired adapter explicitly enables the current Node executable as
yt-dlp's JavaScript runtime; use a current yt-dlp release supporting
`--js-runtimes`. The verified Python `default` extra includes its matching
`yt-dlp-ejs` challenge solver (official standalone releases bundle it). Cookies cannot bypass every bot
check or regional/age restriction.

Termux: use native packages rather than a Linux/glibc static binary:

```sh
pkg update
pkg install nodejs-lts python ffmpeg
python -m pip install --upgrade 'yt-dlp[default]'
yt-dlp --version
ffmpeg -version
```

Use the absolute paths reported by `command -v yt-dlp` and `command -v ffmpeg`
in `config.js`, and set `downloads.autoInstall: false`. This avoids the existing
auto-installer choosing a Linux standalone build incompatible with Android.
Termux installation and WhatsApp delivery were not exercised in the sandbox.

### Hosting, limits, and verification

- Outbound access must include YouTube, its thumbnail/media CDNs, and WhatsApp.
  Tool installation may additionally require GitHub release asset hosts / PyPI.
- `downloads.binDir` defaults to `<database.dataDir>/bin`; keep it persistent.
- `downloads.maxFileSizeMb` (default 50) caps final media. `downloads.timeoutMs`
  (default 180000) bounds each subprocess and the Baileys media upload.
- Two host-wide extraction/upload slots are used. Temporary disk usage is
  monitored at three times the final-size limit per job (source, output and
  merge intermediates). Budget at least six times the size limit plus operating
  headroom for two jobs. The OS temp directory must be writable and have room.
- Use a private, authorized Netscape cookie file via `downloads.cookiesFile`
  only when appropriate. Do not commit cookies or share signed media URLs.
- Requests expire after five minutes. Reply **to the media message** with its
  number, or send the displayed request token and number. Unquoted bare numbers
  remain reserved for existing bot menus/quizzes. Pending selections do not
  survive a restart.
- `play` / `video` and their search aliases open the menu. `ytmp3` / audio
  aliases download directly after showing the thumbnail/menu. `ytmp4` / `mp4`
  download the highest compatible available resolution, explicitly announced.
  Choose HD VIDEO from `play` / `video` for manual resolution selection.
- Only real H.264/AAC MP4 qualities are offered, with merging when necessary.
  Audio is transcoded to MP3; VOICE TYPE is mono Ogg/Opus at 48 kHz.
- A receipt is required for “Completed”. Upload acceptance alone is shown as
  unconfirmed after a 45-second receipt wait. No upload is retried blindly.
- Search failure can use yt-dlp's search instead of the page scraper. Download
  failure never silently changes to another video or a SoundCloud track.
  Existing unrelated API helpers remain intact. The provider-chain interface
  permits trusted replacement adapters; only yt-dlp is enabled in this checkout.

Run these host-side checks before connecting the bot:

```sh
npm ci
npm run lint
npm test
npm run smoke
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' info
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' audio
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' video 144
```

The example clip's qualities can change: use the `info` output to choose an
available height. The check deletes its temporary outputs and **does not verify
WhatsApp delivery**. Start with `npm start`, or restart your existing supervisor
once after deployment. Do not delete the authentication/session directory.
Perform an actual `!play`, choose audio, video/quality and voice in WhatsApp,
and confirm playback and receipt-confirmed completion. Keep yt-dlp current via
the same package/install method; update the bundled auto-install copy only while
the bot is stopped. Never delete the entire data directory to update a tool.

The source-compatible `sticker` (video input), `tovid` and `sticker2vid`
commands still require an **FFmpeg executable on PATH**, with `libwebp` and
`libx264` encoders. Installing the system package is the reliable way to get
those encoders; for a Debian/Ubuntu bot host:

```sh
sudo apt-get update
sudo apt-get install ffmpeg
ffmpeg -version
```

No Baileys upgrade or extra npm sticker package is required. Image conversion
and sticker EXIF editing reuse the installed `sharp` and `node-webpmux`.
The real media-conversion regression test requires FFmpeg too; it deliberately
fails instead of pretending conversion works when that executable is missing.

Saved statuses and stored audio/video live below the configured runtime data
directory (`saved_status/` and `user_media/`). Preserve that directory across
restarts. Temporary FFmpeg files are removed after each request, including
failed conversions.

BotTracker is local-only by default. Its optional `BOT_API_URL` environment
variable is a command-tracking exception to the general configuration rule
above: when explicitly set to an HTTPS endpoint, it receives command counts,
uptime and the first tracked connected account's phone identifier. Leave it
unset for local-only tracking. Never place API keys in command source files.

## Optional connection media

Both settings live in **config.js only**; there is no `.env` override for them.
See `CONNECTION-MEDIA-REPORT.md` for the full API contract and tested behavior.

- `telegramAnimeEdit.enabled: false` (default), **or an empty `libraryApi`**, means
  no Anime Library requests and no additional anime video. The existing real
  pairing success notification still works.
- To enable, set `enabled: true` and `libraryApi` to your authorized server's
  complete public HTTPS `/api/anime/random` URL. `apiKey`, when supplied, goes
  in `Authorization: Bearer …`, never the URL. Keep deployment secrets out of Git.
  Use a direct endpoint (redirects are rejected) and publicly accessible MP4
  video URLs that Telegram can fetch without your private API key.
- `connectionWelcomeVideo` is independent. Its shipped example uses
  `enabled: true`, `source: 'local'`, `path: './media/connection/welcome.mp4'`.
  Supply your own authorized short Gojo/anime MP4 there; it is ignored by Git.
  With `source: 'url'`, set `url` to a trusted direct public HTTPS MP4. Missing or
  rejected media falls back to the existing self-chat welcome image/text/menu.
  No video is supplied by this repository.
- Use H.264 video/AAC audio in MP4. Local and remote welcome size is limited to
  50 MiB. Remote welcome bytes are transient memory only; allow sufficient RAM
  for concurrent paired welcomes and Baileys upload/thumbnail buffers.
- `npm ci` installs the newly pinned `libphonenumber-js@1.13.13`; the existing
  Baileys version is unchanged. Node 20.9+ is required. FFmpeg should remain on
  PATH for existing media commands and Baileys video-thumbnail preparation.
  These features do not install, transcode, scrape or generate an anime library.
- Keep existing auth/session and database directories on persistent storage.
  Keep the user-supplied local welcome on persistent storage too. No anime
  selection history or library files need a database/volume.
- Recent anime IDs are process-local (default 5, at most 50), expire lazily after
  30 minutes without a successful anime delivery, and reset on restart. The
  once-per-account welcome/optional-video guards reset on process restart too;
  a restored authenticated session may therefore receive one welcome again.
- Use only trusted, authorized library/media hosts. URL validation rejects
  non-HTTPS, embedded credentials, localhost/private IP literals and local host
  suffixes; it is not a DNS-pinning/network firewall. Apply deployment-level
  egress restrictions if untrusted DNS or media providers are in scope.
