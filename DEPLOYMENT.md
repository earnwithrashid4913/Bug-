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
configuration. Never paste session credentials or secrets into logs.

## Command media requirements

The source-compatible `sticker` (video input), `tovid` and `sticker2vid`
commands require an **FFmpeg executable on PATH**, with `libwebp` and `libx264`
encoders. For a Debian/Ubuntu bot host, install it with:

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
