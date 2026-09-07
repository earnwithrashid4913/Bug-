# ANIME MD

A clean, configurable WhatsApp bot built with Baileys and maintained by **F!xa Dev**.

> Change the displayed bot name in `.env` with `BOT_NAME`. It is intentionally not hard-coded throughout the source.

## Project ownership

- **Developed By:** F!xa Dev
- **Global Owner:** configured by `OWNER_NAME`
- **Owner WhatsApp:** derived from `BOT_NUMBER` (`https://wa.me/<BOT_NUMBER>`)
- **WhatsApp Channel:** https://whatsapp.com/channel/0029VbBepCNBVJl5vGUHET3T

## Features

- **Web Pairing dashboard** — a themed, mobile-friendly pairing page (no QR scanning, no country selector) served by the bot itself
- **Seven anime themes** (Makima, Nami, Nezuko, Shinobu, Gojo, Sukuna, Asta) driven by one centralized registry: full-screen artwork, theme-specific particles, glow and animation — no automatic rotation
- Multi-file Baileys authentication with web pairing (terminal QR remains an internal, CLI-only fallback)
- Single-owner configuration: `OWNER_NAME` and `BOT_NUMBER` are the only user-facing settings
- Configurable bot identity, owner records, command prefix, public/self mode, paths, and reconnect tuning
- Exponential, bounded reconnect handling that avoids looping on logout, bad-session, and connection-replaced events, plus a process supervisor that restarts the worker after a crash or `!restart`
- `SESSION_ID` support so ephemeral hosts (Heroku or Render without its persistent disk) keep their WhatsApp session across redeploys
- Persisted public/self mode (`data/mode.json`) that survives restarts
- Safe command handler for menu, ping, status, owner details, group mentions, group greetings, safe group administration, channel lookup, request forwarding, premium records, sticker conversion, and sticker-to-image conversion
- Owner-only public/self mode, premium management, and host-managed restart command
- Persistent premium and group-greeting data with atomic writes
- Optional authorized Telegram controller for pairing-code requests and single-session status/control; it delegates to the existing Baileys socket rather than creating a second WhatsApp client
- Deployment manifests for the supported managed hosts: Render (`render.yaml`) and Heroku (`app.json` + `Procfile`)

## Safety boundary

This repository intentionally provides benign bot administration and group-utility functionality only. It does not include commands or malformed WhatsApp payloads intended to force-close, freeze, or crash other clients, nor unrelated third-party follow/media endpoints.

## External-source migration intake

The source archive used for a migration is intentionally treated as external,
read-only input. It is **not** part of this repository and is never extracted
or committed automatically, because it may contain `.env` files, Baileys
credentials, API keys, or private data. Once the archive is available in the
execution environment, run:

```bash
npm run audit:source -- /absolute/path/to/abcd\ New\ Folder.zip
```

Alternatively set `SOURCE_ARCHIVE_PATH`. The command inventories every archive
entry, command and plugin file, and confirms that the requested root files and
33-command set are present without reading secrets into this repository. Prompt
2 says “158 plugins” but enumerates 156 filenames; the audit verifies every
named file and explicitly reports any archive-only plugin so the remaining two
can be inspected rather than silently skipped. Migration implementation must
only use this audited inventory and must convert any required settings to
environment variables.

## Requirements

- Node.js **20.9+ LTS** is recommended. The sticker converter uses Sharp, which requires Node.js 20.9 or newer.
- Baileys is pinned to the current official `7.0.0-rc14` release candidate. WhatsApp Web protocol changes can require a future upstream update.
- An active WhatsApp account to link to the bot.
- Persistent storage for `AUTH_DIR` in production.

## Installation

```bash
git clone <your-repository-url>
cd Bug-
cp .env.example .env
npm install
npm start
```

For a reproducible deployment after the lockfile is committed, use `npm ci` rather than `npm install`.

## Configuration

All runtime configuration is centralized in [`system/config.js`](system/config.js) and can be overridden through environment variables. Copy `.env.example` and edit it; do not commit `.env`.

### User-facing settings

The bot has exactly one owner, so only these two values need to be set.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OWNER_NAME` | `Rashid Hussain` | Owner display name. |
| `BOT_NUMBER` | `923448170040` | The WhatsApp number the bot links to. **Country code included, no `+`.** |

`BOT_NUMBER` is validated strictly: `923448170040` is accepted, `+923001234567` is rejected with the guidance *"Enter your WhatsApp number with country code, without +."* There is no country selector or separate country-code field anywhere — the country code is part of the number. The owner number and owner link are derived from it. The permanent developer identity is source-controlled as **F!xa Dev** and is never derived from owner configuration. `PAIRING_NUMBER` is still read as a legacy alias for `BOT_NUMBER` so older deployments keep booting.

### Internal settings (optional, safe defaults built in)

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOT_NAME` | `ANIME MD` | Display name for logs and commands. |
| `THEME` | `null` | Startup theme: `makima`, `nami`, `nezuko`, `shinobu`, `gojo`, `sukuna`, `asta`. |
| `PORT` | `3000` | Dashboard port. Provided automatically by Render, Heroku and similar hosts. |
| `WHATSAPP_CHANNEL` | supplied channel URL | Channel shown by `!owner` and `!menu`. |
| `COMMAND_PREFIX` | `!` | One to four non-whitespace command characters. |
| `STICKER_PACKNAME` | `ANIME MD` | Sticker pack name used by `!sticker`. |
| `STICKER_AUTHOR` | `F!xa Dev` | Sticker publisher used by `!sticker`. |
| `PUBLIC_MODE` | `true` | Set false for owner/self-only command handling. |
| `AUTH_METHOD` | `pairing` | Keep `pairing`. `qr` is an internal, terminal-only fallback that the dashboard never offers. |
| `AUTH_DIR` | `./session` | Baileys credentials path; keep private and persistent. |
| `DATA_DIR` | `./data` | Runtime data directory. |
| `PREMIUM_DB_PATH` | `DATA_DIR/premium.json` | Optional custom premium database file path. |
| `GROUP_SETTINGS_DB_PATH` | `DATA_DIR/groups.json` | Optional persistent group greeting settings file. |
| `WELCOME_MESSAGE` | supplied default | Greeting template; supports `@user` and `@group`. |
| `GOODBYE_MESSAGE` | supplied default | Farewell template; supports `@user` and `@group`. |
| `GROQ_API_KEY` | unset | Optional secret used by `!ai`; do not commit it. |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Groq model used by `!ai`. |
| `RECONNECT_BASE_DELAY_MS` | `3000` | Initial reconnect delay. |
| `RECONNECT_MAX_DELAY_MS` | `60000` | Maximum reconnect delay. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `CONNECTION_SUCCESS_IMAGE` | supplied Anime MD image | Image sent to the linked account only after Baileys reports a successful connection. |

Configuration validates phone numbers, URLs, booleans, delays, prefixes, and authentication method at startup. Invalid values fail early with an actionable error.

`!ai` is optional. It sends the command prompt to Groq only when you explicitly configure `GROQ_API_KEY`; do not submit secrets or sensitive personal data to an external AI provider.

### Optional Telegram controller

Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_LINK`, and at least one numeric `TELEGRAM_OWNER_IDS` value to enable long-polling control. Bootstrap owners are configured only through the environment; extra controllers added with `/addowner <telegram_id>` are persisted in `data/telegram-controllers.json` with private file permissions. The controller supports `/pair <number>`, `/sessions`, `/status`, `/addowner <telegram_id>`, `/delowner <telegram_id>`, `/stop <number>`, and `/help`. WhatsApp users can use `!pairing`, `!tgpair`, or `!telegram` to receive the configured controller link.

It controls the **same** Baileys socket as the dashboard. `/pair` therefore returns a real code only while that socket is ready and unpaired. `/stop` only removes an unpaired, matching local session and refuses to remove a connected account remotely, avoiding accidental logout and a competing multi-session architecture.

## Authentication and session handling

### Web Pairing (the only user-facing flow)

Set the number you want to link, start the bot, and open the dashboard:

```dotenv
OWNER_NAME=Enter Your Name
BOT_NUMBER=923001234567
```

```bash
npm start
# [web] Pairing dashboard listening on http://0.0.0.0:3000
```

Open the printed URL (or your host's domain), confirm the prefilled number, press **Generate pairing code**, then in WhatsApp go to **Settings → Linked devices → Link a device → Link with phone number instead** and type the code. The page shows the real socket state (`starting`, `connecting`, `awaiting code`, `connected`, `disconnected`, `logged out`) and never reports *connected* unless Baileys actually reported an open connection. Pairing requests are validated (digits only, no `+`) and rate limited to one code per 20 seconds per client.

There is no QR option and no country selector in the dashboard: the country code is part of `BOT_NUMBER`.

### SESSION_ID (persistent hosts without storage)

Heroku and a Render service without its persistent disk wipe `session/` on every restart. `SESSION_ID` is the contents of `session/creds.json` — raw JSON or its base64 form (a `PREFIX~~<base64>` wrapper is also accepted).

1. Pair WhatsApp once on a private host.
2. Copy `session/creds.json` securely from the host filesystem.
3. Store it as the `SESSION_ID` environment variable and restart.

The bot writes it to `AUTH_DIR/creds.json` at startup — the log shows `[session] Wrote credentials from SESSION_ID to …` — and reuses it on every later boot. An invalid `SESSION_ID` is reported in the log without crashing, so the dashboard stays reachable for a fresh pairing.

A `SESSION_ID` is a complete WhatsApp login. Never commit it, paste it into a public chat, or expose it through a web endpoint. Re-pair if it leaks.

### Terminal QR (internal fallback)

`AUTH_METHOD=qr` still prints a QR code in an interactive local terminal. It exists for CLI recovery only — it is never exposed by the dashboard, and cloud hosts should keep the default `pairing`.

The `session/` directory contains authentication credentials and private keys. It is excluded from Git, and the dashboard never reads or serves it. If a session is invalid or logged out, stop the process, remove only the configured `AUTH_DIR`, restart, and pair again.

## Themes

Theme configuration lives in one place: [`system/theme.js`](system/theme.js). It is the single source of truth for each character's artwork, palette, gradients, glow, particle profile and animation; the server serializes it through `/api/bootstrap` and the browser applies it as CSS custom properties, so no component duplicates theme values.

| Theme | Character | Palette | Motion |
| --- | --- | --- | --- |
| Makima | Chainsaw Man | red + dark | controlled cinematic dust |
| Nami | One Piece | ocean blue + amber | flowing wave drift |
| Nezuko | Demon Slayer | pink + crimson | soft floating aura |
| Shinobu | Demon Slayer | violet + lavender | butterfly flutter |
| Gojo | Jujutsu Kaisen | blue + violet | cosmic limitless drift |
| Sukuna | Jujutsu Kaisen | blood red + black | rising cursed embers |
| Asta | Black Clover | emerald + black | sharp anti-magic shards |

- The active theme covers the **whole page**: full-screen artwork, dark overlay, theme gradient, glow, particles, cards, buttons, the pairing box and the *Developed By: F!xa Dev* credit.
- Artwork displays the selected theme's primary image with a crossfade. Timers and animation frames are cancelled when the tab is hidden or the page unloads.
- A frame that fails to load is skipped in favour of the next image **of the same theme**; if every image fails, the artwork layer hides and the themed gradient/glow/particles remain. No replacement URLs are ever invented.
- Switching theme repaints colours, glow, particles and branding through CSS transitions — no reload, no flash, no layout jump. The choice persists in `localStorage` and is mirrored to the server.
- There is no generic "Default" theme. Unknown or missing theme ids remain unset until the user explicitly chooses one of the seven anime themes.

## Authorized-device compatibility testing

Use only WhatsApp accounts and groups you own or administer. After pairing a real account, test standard WhatsApp behaviors with `!menu`, `!ping`, `!owner`, and—inside an authorized group—`!hidetag` or `!tagall`. The bot uses standard text, message edits, mentions, and supported interactive-response parsing; it does not send malformed UI payloads. Automated tests validate the command parser and supported message shapes, but a real WhatsApp pairing/message exchange must be performed by the owner.

## Commands

Use the configured prefix (shown below as `!`). Type `!menu` to see all categories.

| Command | Access | Description |
| --- | --- | --- |
| **GENERAL** | | |
| `!menu`, `!help` | Everyone | Open the interactive command menu. |
| `!ping`, `!p` | Everyone | Check bot latency. |
| `!request <message>` | Everyone | Forward a rate-limited request to owners. |
| **MODE** | | |
| `!public`, `!self` | Owner | Toggle command visibility. |
| `!mode <public\|self>` | Owner | Show or change message mode. |
| **DOWNLOADER** | | |
| `!play <query\|url>` | Everyone | Search and download audio from YouTube. |
| `!video <query\|url>` | Everyone | Download video from a URL. |
| `!spotify <query>` | Everyone | Search Spotify for tracks. |
| `!media <url>` | Everyone | Download from TikTok/Instagram/Facebook/YouTube. |
| **MEDIA** | | |
| `!getpp`, `!pp` | Everyone | Get a user or group profile picture. |
| `!setpp` | Owner | Update the bot profile picture. |
| `!vv`, `!save` | Everyone | Reveal a view-once photo or video. |
| **CONVERTER** | | |
| `!sticker`, `!s` | Everyone | Reply to an image to create a sticker. |
| `!toimg`, `!img` | Everyone | Reply to a sticker to convert to image. |
| `!tts <text>` | Everyone | Text-to-speech. |
| `!qr <text>` | Everyone | Generate a QR code. |
| **UPLOAD** | | |
| `!tourl` | Everyone | Upload a replied file and get a public URL. |
| **AI** | | |
| `!ai`, `!ask` | Everyone | Ask Groq AI (requires `GROQ_API_KEY`). |
| `!translate [lang] <text>` | Everyone | Translate text. |
| **TOOLS** | | |
| `!jid`, `!chatid` | Everyone | Show chat and sender JIDs. |
| `!idch <url>` | Everyone | Fetch WhatsApp channel metadata. |
| `!calc <expr>` | Everyone | Calculate a math expression. |
| `!ss <url>` | Everyone | Capture a website screenshot. |
| `!short <url>` | Everyone | Shorten a URL. |
| **GROUP** | | |
| `!hidetag <msg>` | Group admin | Mention all members without visible tags. |
| `!tagall <msg>` | Group admin | Mention all members with a visible list. |
| `!welcome`, `!goodbye` | Group admin | Toggle group greeting messages. |
| `!group` | Group admin | Show group management help. |
| `!gname`, `!gdesc`, `!add`, `!kick`, `!promote`, `!demote`, `!lock`, `!unlock`, `!grouplink` | Group admin + bot admin | Perform the named group action. |
| `!warn`, `!unwarn`, `!warns` | Group admin | Manage group member warnings. |
| **ANTI / SECURITY** | | |
| `!antilink`, `!antispam`, `!antimention`, `!antitag`, `!antidelete` | Group admin | Toggle group protection features. |
| **AUTOMATION** | | |
| `!autoreact`, `!autowrite` | Group admin | Toggle automatic reactions/typing presence. |
| `!autostatus` | Owner | Toggle auto-read status updates. |
| **GAMES** | | |
| `!dice`, `!coin`, `!rps`, `!guess` | Everyone | Play quick games. |
| **RPG / ECONOMY** | | |
| `!balance`, `!daily`, `!work`, `!give` | Everyone | Economy system commands. |
| **OWNER** | | |
| `!theme <id>` | Owner | Set the dashboard theme. |
| `!restart`, `!rst` | Owner | Exit for host-managed restart. |
| `!setname <name>` | Owner | Set the WhatsApp profile name. |
| `!setprefix <prefix>` | Owner | Set a custom command prefix. |
| `!broadcast <msg>` | Owner | Send a global announcement. |
| **SUDO** | | |
| `!sudo <number>` | Owner | Grant sudo access. |
| `!delsudo <number>` | Owner | Revoke sudo access. |
| `!sudolist` | Sudo/owner | List sudo users. |
| **PREMIUM** | | |
| `!addprem <num> [30d]` | Owner | Add premium access. |
| `!delprem <number>` | Owner | Remove premium access. |
| `!listprem` | Owner | List premium users. |
| `!premium` | Everyone | Check premium status. |
| **INFO** | | |
| `!status`, `!alive` | Everyone | Show bot status and uptime. |
| `!owner`, `!creator` | Everyone | Show owner and developer details. |
| **SESSIONS** | | |
| `!sessions` | Everyone | Show active session info. |
| `!stopsession <number>` | Owner | Safe session cleanup. |
| **TELEGRAM** | | |
| `!pairing`, `!tgpair`, `!telegram` | Everyone | Show Telegram controller link. |

## Local setup

```bash
cp .env.example .env
# edit .env
npm install
npm start
```

To validate configuration and module loading without opening a WhatsApp connection or the dashboard:

```bash
npm run start:dry   # configuration smoke test
npm run lint        # syntax check across every JS file
npm test            # unit + dashboard + web API tests
npm run check       # lint and test together
```

The dashboard itself can be checked locally with `npm start` and a browser at `http://localhost:3000`.

## Render deployment

The bot keeps an outbound WhatsApp WebSocket **and** serves the pairing dashboard, so deploy the included [`render.yaml`](render.yaml) as a **Web Service** (health check: `/health`).

- Build: `npm ci`
- Start: `npm start`
- Node: `20.19.5` in the supplied Blueprint
- Persistent disk mount: `/var/data`
- Required production paths: `AUTH_DIR=/var/data/session` and `DATA_DIR=/var/data/data`
- Set `OWNER_NAME` and `BOT_NUMBER` (country code, no `+`) before the first pairing

Render injects `PORT` automatically; the dashboard binds `0.0.0.0` on that port. Render's filesystem is ephemeral without a disk, so a deployment/restart without persistent storage loses the WhatsApp session. Attach a disk, or securely copy `session/creds.json` from a private host and store it as `SESSION_ID` in the Render environment.

## Heroku deployment

Heroku wipes its filesystem on every dyno restart, so this host always runs from `SESSION_ID`. The repository ships [`app.json`](app.json) and a [`Procfile`](Procfile):

1. Click **Deploy to Heroku** on the repository (or `heroku create` + `git push heroku main`) so `app.json` supplies the template.
2. Fill in `OWNER_NAME` and `BOT_NUMBER`, choose the `THEME`, and leave `SESSION_ID` empty for now.
3. Pair WhatsApp on a private host and securely copy its `session/creds.json`.
4. Paste that credential as the `SESSION_ID` config var and restart the dyno.

The bot restores that session on every boot, so redeploys no longer log it out.

## Troubleshooting

- **No pairing code:** confirm `BOT_NUMBER` is digits only with the country code (no `+`), that the dashboard shows *connecting/awaiting code* rather than *disconnected*, and that only one instance is running against the same `AUTH_DIR`. Wait 20 seconds between code requests — they are rate limited.
- **Dashboard shows "Status unavailable" or will not open:** check that `PORT` is free and that your host exposes the port; the server binds `0.0.0.0` by default.
- **Theme artwork does not appear:** the hosted images may be blocked by your network. The theme keeps its gradient, glow and particles, and no substitute artwork is invented.
- **Bot is logged out/re-pairs on every deploy:** your `AUTH_DIR` is ephemeral or being overwritten. Attach a single persistent disk/volume and do not run multiple replicas.
- **`Bad Session` / `connection replaced`:** stop the bot, delete only the configured authentication directory, restart, and link again. Automatic reconnect intentionally stops for these cases.
- **Commands do not respond:** check `COMMAND_PREFIX`, `PUBLIC_MODE`, `BOT_NUMBER` formatting, and the connection logs.
- **Premium data disappears:** persist `DATA_DIR` alongside `AUTH_DIR`.
- **A command appears unavailable:** destructive crash/force-close payload commands are intentionally not supported.

For a complete A–Z deployment flow, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Credits

- **Developed By: F!xa Dev**
- Global project owner: configured through `OWNER_NAME`
- Character artwork uses only the supplied Catbox artwork URLs listed in [`system/theme.js`](system/theme.js).
- WhatsApp connectivity: [Baileys](https://github.com/WhiskeySockets/Baileys) and its respective maintainers
- The Apache-2.0 license and third-party dependency licenses remain with their respective authors.

## License

This repository is distributed under the [Apache License 2.0](LICENSE). Review the license and all third-party dependency licenses before redistribution.
