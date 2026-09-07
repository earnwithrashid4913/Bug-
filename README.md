# 𝙂𝙊𝘼𝙏𝙑𝙀𝙍𝙎𝙀 𝙈𝘿

A clean, configurable WhatsApp bot built with Baileys and maintained under the **Only Fixa Dev** project.

> Change the displayed bot name in `.env` with `BOT_NAME`. It is intentionally not hard-coded throughout the source.

## Project ownership

- **Developed By:** GOATS MODS
- **Global Owner:** configured by `OWNER_NAME`
- **Owner WhatsApp:** derived from `BOT_NUMBER` (`https://wa.me/<BOT_NUMBER>`)
- **WhatsApp Channel:** https://whatsapp.com/channel/0029VbBepCNBVJl5vGUHET3T

## Features

- **Web Pairing dashboard** — a themed, mobile-friendly pairing page (no QR scanning, no country selector) served by the bot itself
- **Seven anime themes** (Makima, Nami, Nezuko, Shinobu, Gojo, Sukuna, Asta) driven by one centralized registry: full-screen artwork that rotates every 5 seconds, theme-specific particles, glow and animation
- Multi-file Baileys authentication with web pairing (terminal QR remains an internal, CLI-only fallback)
- Single-owner configuration: `OWNER_NAME` and `BOT_NUMBER` are the only user-facing settings
- Configurable bot identity, owner records, command prefix, public/self mode, paths, and reconnect tuning
- Exponential, bounded reconnect handling that avoids looping on logout, bad-session, and connection-replaced events, plus a process supervisor that restarts the worker after a crash or `!restart`
- `SESSION_ID` support so ephemeral hosts (Heroku or Render without its persistent disk) keep their WhatsApp session across redeploys
- Persisted public/self mode (`data/mode.json`) that survives restarts
- Safe command handler for menu, ping, status, owner details, group mentions, group greetings, safe group administration, channel lookup, request forwarding, premium records, sticker conversion, and sticker-to-image conversion
- Owner-only public/self mode, premium management, and host-managed restart command
- Persistent premium and group-greeting data with atomic writes
- Deployment manifests for the supported managed hosts: Render (`render.yaml`) and Heroku (`app.json` + `Procfile`)

## Safety boundary

The supplied base contained commands and malformed WhatsApp payloads intended to force-close, freeze, or crash other clients. Those destructive capabilities, their menus, and unrelated third-party follow/media endpoints were deliberately removed during this migration. This repository retains benign bot administration and group-utility functionality only.

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
| `OWNER_NAME` | `Only Fixa Dev` | Global owner display name. |
| `BOT_NUMBER` | `923448170040` | The WhatsApp number the bot links to. **Country code included, no `+`.** |

`BOT_NUMBER` is validated strictly: `923001234567` is accepted, `+923001234567` is rejected with the guidance *"Enter your WhatsApp number with country code, without +."* There is no country selector or separate country-code field anywhere — the country code is part of the number. The owner number, owner link, and developer contact are all derived from it, so there are no duplicate identity fields. `PAIRING_NUMBER` is still read as a legacy alias for `BOT_NUMBER` so older deployments keep booting.

### Internal settings (optional, safe defaults built in)

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOT_NAME` | `𝙂𝙊𝘼𝙏𝙑𝙀𝙍𝙎𝙀 𝙈𝘿` | Display name for logs and commands. |
| `THEME` | `gojo` | Startup theme: `makima`, `nami`, `nezuko`, `shinobu`, `gojo`, `sukuna`, `asta`. |
| `PORT` | `3000` | Dashboard port. Provided automatically by Render, Heroku and similar hosts. |
| `WHATSAPP_CHANNEL` | supplied channel URL | Channel shown by `!owner` and `!menu`. |
| `COMMAND_PREFIX` | `!` | One to four non-whitespace command characters. |
| `STICKER_PACKNAME` | `𝙂𝙊𝘼𝙏𝙑𝙀𝙍𝙎𝙀 𝙈𝘿` | Sticker pack name used by `!sticker`. |
| `STICKER_AUTHOR` | `Only F!xa Dev` | Sticker publisher used by `!sticker`. |
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

Configuration validates phone numbers, URLs, booleans, delays, prefixes, and authentication method at startup. Invalid values fail early with an actionable error.

`!ai` is optional. It sends the command prompt to Groq only when you explicitly configure `GROQ_API_KEY`; do not submit secrets or sensitive personal data to an external AI provider.

## Authentication and session handling

### Web Pairing (the only user-facing flow)

Set the number you want to link, start the bot, and open the dashboard:

```dotenv
OWNER_NAME=Only Fixa Dev
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

1. Pair WhatsApp once with `EXPOSE_SESSION_ID=true`.
2. Open the dashboard's **Session** card and copy the `SESSION_ID` (or copy `session/creds.json` from disk).
3. Store it as the `SESSION_ID` environment variable, set `EXPOSE_SESSION_ID=false`, and restart.

The bot writes it to `AUTH_DIR/creds.json` at startup — the log shows `[session] Wrote credentials from SESSION_ID to …` — and reuses it on every later boot. An invalid `SESSION_ID` is reported in the log without crashing, so the dashboard stays reachable for a fresh pairing.

A `SESSION_ID` is a complete WhatsApp login. Never commit it, never paste it into a public chat, and re-pair if it leaks. Session export is off by default and requires an explicit `EXPOSE_SESSION_ID=true`.

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

- The active theme covers the **whole page**: full-screen artwork, dark overlay, theme gradient, glow, particles, cards, buttons, the pairing box and the *Developed By: GOATS MODS* credit.
- Artwork rotates every **5 seconds** on a single controlled timer with a crossfade, subtle scale/blur and preloading of the next frame. Timers and animation frames are cancelled when the tab is hidden or the page unloads.
- A frame that fails to load is skipped in favour of the next image **of the same theme**; if every image fails, the artwork layer hides and the themed gradient/glow/particles remain. No replacement URLs are ever invented.
- Switching theme repaints colours, glow, particles and branding through CSS transitions — no reload, no flash, no layout jump. The choice persists in `localStorage` and is mirrored to the server.
- There is no generic "Default" theme. Unknown or missing theme ids fall back internally to a real anime theme.

## Authorized-device compatibility testing

Use only WhatsApp accounts and groups you own or administer. After pairing a real account, test standard WhatsApp behaviors with `!menu`, `!ping`, `!owner`, and—inside an authorized group—`!hidetag` or `!tagall`. The bot uses standard text, message edits, mentions, and supported interactive-response parsing; it does not send malformed UI payloads. Automated tests validate the command parser and supported message shapes, but a real WhatsApp pairing/message exchange must be performed by the owner.

## Commands

Use the configured prefix (shown below as `!`).

| Command | Access | Description |
| --- | --- | --- |
| `!menu`, `!help` | Everyone in public mode | Show command help. |
| `!ping` | Everyone in public mode | Check command latency. |
| `!status`, `!alive`, `!runtime` | Everyone in public mode | Show basic process status. |
| `!owner`, `!creator` | Everyone in public mode | Show configured owner/contact details. |
| `!sticker`, `!s` | Everyone in public mode | Reply to an image to create a standard WebP sticker. |
| `!toimg`, `!sticker2img` | Everyone in public mode | Reply to a sticker to convert it to an image. |
| `!jid`, `!chatid` | Everyone in public mode | Show the current chat and sender JIDs. |
| `!getpp`, `!pp`, `!profilepic`, `!avatar` | Everyone in public mode | Show a profile picture from a group, quoted/mentioned user, or number. |
| `!setpp` | Owner | Reply to an image to update the bot profile picture. |
| `!ai`, `!ask`, `!ia`, `!groq` | Everyone in public mode | Ask Groq AI when `GROQ_API_KEY` is configured. |
| `!request <message>` | Everyone in public mode | Forward a rate-limited request to owners. |
| `!hidetag <message>` | Group admin/owner | Mention all group members without listing them. |
| `!tagall <message>` | Group admin/owner | Send a message that lists and mentions members. |
| `!welcome`, `!goodbye`, `!greet` | Group admin/owner | Configure safe group greetings. |
| `!group` | Group admin/owner | Show safe group management help. |
| `!gname`, `!gdesc`, `!add`, `!kick`, `!promote`, `!demote`, `!lock`, `!unlock`, `!grouplink` | Group admin/owner + bot admin | Perform the named group action. |
| `!idch <channel URL>` | Everyone in public mode | Look up a WhatsApp channel invite. |
| `!public`, `!self` | Owner | Toggle command visibility. |
| `!addprem <number> [30d]` | Owner | Add/extend premium access. Units: `s`, `m`, `h`, `d`. |
| `!delprem <number>` | Owner | Remove premium access. |
| `!listprem` | Owner | List active premium records. |
| `!restart` | Owner | Exit cleanly for a host-managed restart. |

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

Render injects `PORT` automatically; the dashboard binds `0.0.0.0` on that port. Render's filesystem is ephemeral without a disk, so a deployment/restart without persistent storage loses the WhatsApp session. Either attach a disk or pair once with `EXPOSE_SESSION_ID=true`, copy the SESSION_ID from the dashboard, and store it in the Render environment.

## Heroku deployment

Heroku wipes its filesystem on every dyno restart, so this host always runs from `SESSION_ID`. The repository ships [`app.json`](app.json) and a [`Procfile`](Procfile):

1. Click **Deploy to Heroku** on the repository (or `heroku create` + `git push heroku main`) so `app.json` supplies the template.
2. Fill in `OWNER_NAME` and `BOT_NUMBER`, choose the `THEME`, and leave `SESSION_ID` empty for now.
3. Set `EXPOSE_SESSION_ID=true`, deploy, and open the generated `*.herokuapp.com` URL.
4. Pair WhatsApp from the dashboard, then copy the **SESSION_ID** shown in the Session card.
5. Paste it into the `SESSION_ID` config var, set `EXPOSE_SESSION_ID=false`, and restart the dyno.

The bot restores that session on every boot, so redeploys no longer log it out.

## Troubleshooting

- **No pairing code:** confirm `BOT_NUMBER` is digits only with the country code (no `+`), that the dashboard shows *connecting/awaiting code* rather than *disconnected*, and that only one instance is running against the same `AUTH_DIR`. Wait 20 seconds between code requests — they are rate limited.
- **Dashboard shows "Status unavailable" or will not open:** check that `PORT` is free and that your host exposes the port; the server binds `0.0.0.0` by default.
- **Theme artwork does not appear:** the hosted images may be blocked by your network. The theme keeps its gradient, glow and particles, and no substitute artwork is invented.
- **Bot is logged out/re-pairs on every deploy:** your `AUTH_DIR` is ephemeral or being overwritten. Attach a single persistent disk/volume and do not run multiple replicas.
- **`Bad Session` / `connection replaced`:** stop the bot, delete only the configured authentication directory, restart, and link again. Automatic reconnect intentionally stops for these cases.
- **Commands do not respond:** check `COMMAND_PREFIX`, `PUBLIC_MODE`, `BOT_NUMBER` formatting, and the connection logs.
- **Premium data disappears:** persist `DATA_DIR` alongside `AUTH_DIR`.
- **A command appears unavailable:** the unsafe crash/force-close payload commands from the supplied base were intentionally not migrated.

For a complete A–Z deployment flow, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Credits

- **Developed By: GOATS MODS**
- Global project owner: configured through `OWNER_NAME`
- Character artwork is loaded from the project owner's hosted Catbox URLs listed in [`system/theme.js`](system/theme.js); no artwork is bundled in this repository.
- WhatsApp connectivity: [Baileys](https://github.com/WhiskeySockets/Baileys) and its respective maintainers
- The Apache-2.0 license file supplied with the base source is retained. Third-party dependency licenses remain with their respective authors.

## License

This repository is distributed under the [Apache License 2.0](LICENSE). Review the license and all third-party dependency licenses before redistribution.
