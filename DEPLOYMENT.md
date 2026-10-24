# ANIME MD Deployment Guide

ANIME MD requires Node.js 20.9 or newer (Node 22 is recommended for the installed Baileys integration). Install dependencies with `npm ci`
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

Current scoped implementation/test evidence: [PLAY-VIDEO-REBUILD-REPORT.md](PLAY-VIDEO-REBUILD-REPORT.md).
Direct links attempt bounded watch-page metadata (4 seconds / 2 MiB), without
making it a prerequisite for download APIs. Missing metadata is labeled unknown,
not fabricated. Native video quality lists retain their image header. Text
compatibility uses quoted option numbers, not visible request/debug tokens.


The regression recovery restores the historical provider chains rather than
requiring the strict PR #61 yt-dlp adapter before any download can start:

- Audio: existing DavidCyril MP3 pool → existing Cobalt servers → the local
  downloader from pre-PR #61 commit `be909d2`.
- Automatic video: existing Cobalt servers → DavidCyril MP4 → DavidCyril AIO →
  the same pre-PR #61 local downloader.

A successful API download does **not** require yt-dlp metadata or FFmpeg. Search
uses the existing page helper with yt-dlp search fallback. Direct URLs do not
require a local extractor merely to open the menu. Search metadata is displayed
when present; a direct URL can show honest unknown title/uploader/duration labels.
Original API endpoints/helpers and dependency versions are unchanged.

FFmpeg is optional for ordinary downloads and required for voice-note conversion.
When it is present, final files are decoded before upload. Without it, signature,
stream-marker, nonempty and byte-limit checks still run; this is **not** equivalent
to a full decoder check. The older M4A fallback is retained with a visible notice
and correct MIME instead of being mislabeled MP3. WebM is sent as a file, not a
mislabeled MP4. Exact-resolution downloads use the retained strict adapter only
when explicitly chosen; failed optional format discovery leaves the previous
**Automatic video** path available and does not claim HD resolution.

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
environment outside the repository, on executable persistent storage. The optional exact-resolution adapter enables the current Node executable as
yt-dlp's JavaScript runtime and requires support for `--js-runtimes`. The
recovered local automatic path retains its historical format selectors and host
configuration. It now probes `--help` once per executable/version: Node is enabled
only if `--js-runtimes` is supported. Older binaries receive no unsupported flag;
explicit runtime settings/opt-out in the helper API are respected. This is runtime
compatibility, not a guarantee against BOT_CHECK. The Python `default` extra includes its matching
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
  (default 180000) bounds each local subprocess and the Baileys media upload.
  `downloads.providerTimeoutMs` (default 45000, allowed 1000–180000) cancels each
  recovered API attempt, including its endpoint pool, retry/backoff and media
  response body. Each configured Cobalt endpoint is a separate attempt; MP4
  and AIO pools are separate attempts too. This is not a 45-second whole-job
  deadline. Local extraction, processing and upload have separate bounds.
- `downloads.maxConcurrent` defaults to 2 (allowed 1–8); host-wide extraction/upload
  slots are shared across sockets in this bot process, not across separate workers. Temporary disk usage is
  bounded by the existing local engine and file-size checks for automatic mode;
  strict exact-quality jobs additionally use the storage watchdog. Budget six
  times the size limit per active job plus headroom. Recovered play/video API
  downloads now stream into private temporary files; the local fallback hands
  off its existing file instead of returning a whole-file Buffer. Shared legacy
  helper callers retain their buffer API. Header/stream-marker checks read 64 KiB
  chunks, followed by full FFmpeg decode when available. The local extractor
  additionally watches aggregate intermediate disk use (three times the file
  limit) and kills/cleans oversized jobs. Keep the OS temporary directory writable.
- Use a private, authorized Netscape cookie file via `downloads.cookiesFile`
  only when appropriate. Do not commit cookies or share signed media URLs.
- Requests expire after five minutes. `downloads.interactiveMode: 'auto'`
  prefers real native HD VIDEO / AUDIO MP3 / VOICE TYPE quick replies, then a
  native list. Numbered replies are used only if native relay/preparation fails.
  Set `'list'` to prefer native lists on a host where quick replies do not render;
  `'text'` explicitly enables last-resort compatibility. A relay acknowledgment
  cannot detect every unsupported handset, so rendering still needs a real-device
  check. Callbacks bind chat/sender/socket/request/revision; old taps cannot select
  a new menu's option and an outdated card is answered as out of date instead of
  being ignored. The offered options are also printed as body text, so a handset
  that renders the card without the buttons can still reply with the number.
  Quoting the media message with a number always works; a bare number is accepted
  when it can only mean one pending request for that sender in that chat, while a
  running group quiz keeps priority for the same numbers. Pending selections do
  not survive a restart.
- `play` opens the HD VIDEO / AUDIO MP3 / VOICE TYPE menu for a URL or a search
  query. `video` and its aliases (`yt`, `youtube`, `ytv`, `ytvideo`) open the
  resolution card instead — never the audio menu. `ytmp3` / audio aliases download
  directly after showing the thumbnail/menu and also accept a search query.
  `ytmp4` / `mp4` keep the previous automatic video selection. Automatic mode
  makes no promise about resolution.
- Explicit resolutions come from actual compatible local formats. A separate
  automatic option remains available if formats cannot be enumerated. VOICE TYPE
  uses FFmpeg to produce mono Ogg/Opus at 48 kHz; no fabricated voice note is sent
  if the converter is unavailable.
- A receipt is required for “Completed”. Upload acceptance alone is shown as
  unconfirmed after a 45-second receipt wait. No upload is retried blindly.
- Search failure can use yt-dlp's search instead of the page scraper. Download
  failure never silently changes to another video or a SoundCloud track.
  Search retrieves up to five results as before. If a download fails, the
  `<token> sources` action lets the user explicitly choose another result; no
  other YouTube video or SoundCloud track is silently substituted. DavidCyril,
  Cobalt and the historical local downloader are active in their recovered order.

For layered DNS/TCP/TLS and installed-tool evidence, first run
`node scripts/youtube-host-check.js --media-self-test` from this checkout. It
never starts WhatsApp or installs binaries; its generated media is synthetic,
not a YouTube download. A verified root HTTP response does not prove provider
availability. Share only its structured report and redacted download outcomes.
Do not disable TLS verification; an operator-approved CA bundle is appropriate
only after confirming a trust-store issue on the actual deployment. See the
latest follow-up section of YOUTUBE-INTERACTIVE-REPAIR.md for the sandbox control
comparison and the explicitly unverified production/device status.

Run these host-side checks before connecting the bot:

```sh
npm ci
npm run lint
npm test
npm run smoke
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' info
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' audio
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' video
node scripts/youtube-check.js 'New FunkS Latest 10 minutes' audio
node scripts/youtube-check.js 'memories hasan' audio
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' audio --provider=cobalt
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' formats
```

`info` prepares the request and reports the metadata source; it is **not** a
provider availability test. `formats` runs optional live quality discovery. Use
`audio`, `video` or `voice` to actually attempt a download. `--provider=davidcyril`,
`--provider=cobalt` or `--provider=local` isolates one provider family on the host.
These are CLI diagnostics, not chat-controlled endpoints. Files are deleted
after checks; **WhatsApp delivery is not verified by this script**. Start with `npm start`, or restart your existing supervisor
once after deployment. Do not delete the authentication/session directory.
See [YOUTUBE-INTERACTIVE-REPAIR.md](YOUTUBE-INTERACTIVE-REPAIR.md) for fresh
network findings, test coverage and the handset checklist.
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
