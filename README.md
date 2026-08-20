# Black Clover ♣️

A clean, configurable WhatsApp bot built with Baileys and maintained under the **Only Fixa Dev** project.

> Change the displayed bot name in `.env` with `BOT_NAME`. It is intentionally not hard-coded throughout the source.

## Project ownership

- **Developer:** Rashid Hussain
- **Global Owner:** Only Fixa Dev
- **Owner WhatsApp:** https://wa.me/923448170040
- **WhatsApp Channel:** https://whatsapp.com/channel/0029VbBepCNBVJl5vGUHET3T

## Features

- Multi-file Baileys authentication with pairing-code and terminal QR options
- Configurable bot identity, owner records, command prefix, public/self mode, paths, and reconnect tuning
- Exponential, bounded reconnect handling that avoids looping on logout, bad-session, and connection-replaced events
- Safe command handler for menu, ping, status, owner details, group mentions, channel lookup, request forwarding, premium records, and image-to-sticker conversion
- Owner-only public/self mode, premium management, and host-managed restart command
- Persistent premium data with atomic writes and expiry cleanup
- Render Background Worker and Railway configuration
- Local Node.js, Termux, generic Node.js host, and Pterodactyl-friendly startup flow

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

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOT_NAME` | `Black Clover ♣️` | Display name for logs and commands. |
| `OWNER_NAME` | `Only Fixa Dev` | Global owner display name. |
| `OWNER_NUMBER` | `923448170040` | Primary owner number; digits only. |
| `OWNER_NUMBERS` | empty | Optional comma-separated additional owner numbers. |
| `AUTHOR_NAME` | `Rashid Hussain` | Developer display name. |
| `AUTHOR_NUMBER` | `923448170040` | Developer number; digits only. |
| `OWNER_LINK` | supplied wa.me URL | Owner contact shown by `!owner`. |
| `WHATSAPP_CHANNEL` | supplied channel URL | Channel shown by `!owner` and `!menu`. |
| `COMMAND_PREFIX` | `!` | One to four non-whitespace command characters. |
| `STICKER_PACKNAME` | `Black Clover ♣️` | Sticker pack name used by `!sticker`. |
| `STICKER_AUTHOR` | `Only Fixa Dev` | Sticker publisher used by `!sticker`. |
| `PUBLIC_MODE` | `true` | Set false for owner/self-only command handling. |
| `AUTH_METHOD` | `pairing` | `pairing` or `qr`. |
| `PAIRING_NUMBER` | unset | Required for pairing on a non-interactive host. |
| `AUTH_DIR` | `./session` | Baileys credentials path; keep private and persistent. |
| `DATA_DIR` | `./data` | Runtime data directory. |
| `PREMIUM_DB_PATH` | `DATA_DIR/premium.json` | Optional custom premium database file path. |
| `RECONNECT_BASE_DELAY_MS` | `3000` | Initial reconnect delay. |
| `RECONNECT_MAX_DELAY_MS` | `60000` | Maximum reconnect delay. |
| `LOG_LEVEL` | `info` | Pino log level. |

Configuration validates phone numbers, URLs, booleans, delays, prefixes, and authentication method at startup. Invalid values fail early with an actionable error.

## Authentication and session handling

### Pairing code

For a cloud host, set a real linking phone number:

```dotenv
AUTH_METHOD=pairing
PAIRING_NUMBER=your_linking_phone_number
```

Replace `your_linking_phone_number` with the phone being linked, then run `npm start` and enter the emitted code in WhatsApp. This is a connection setting, not an owner/contact field. The number must include its country code and contain digits only.

### QR code

For an interactive local terminal:

```dotenv
AUTH_METHOD=qr
```

Run `npm start` and scan the terminal QR code.

The `session/` directory contains authentication credentials and private keys. It is excluded from Git. If a session is invalid or logged out, stop the process, remove only the configured `AUTH_DIR`, restart, and pair again.

## Authorized-device compatibility testing

Use only WhatsApp accounts and groups you own or administer. After pairing a real account, test standard WhatsApp behaviors with `!menu`, `!ping`, `!owner`, and—inside an authorized group—`!hidetag` or `!tagall`. The bot uses standard text, message edits, mentions, and supported interactive-response parsing; it does not send malformed UI payloads. Automated tests validate the command parser and supported message shapes, but a real WhatsApp pairing/message exchange must be performed by the owner.

## Commands

Use the configured prefix (shown below as `!`).

| Command | Access | Description |
| --- | --- | --- |
| `!menu`, `!help` | Everyone in public mode | Show command help. |
| `!ping` | Everyone in public mode | Check command latency. |
| `!status` | Everyone in public mode | Show basic process status. |
| `!owner`, `!creator` | Everyone in public mode | Show configured owner/contact details. |
| `!sticker`, `!s` | Everyone in public mode | Reply to an image to create a standard WebP sticker. |
| `!request <message>` | Everyone in public mode | Forward a rate-limited request to owners. |
| `!hidetag <message>` | Group admin/owner | Mention all group members without listing them. |
| `!tagall <message>` | Group admin/owner | Send a message that lists and mentions members. |
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

To validate configuration and module loading without opening a WhatsApp connection:

```bash
npm run start:dry
npm test
npm run check
```

## Termux setup

Termux can run the bot if it provides Node.js 20.9 or newer and stays running:

```bash
pkg update && pkg upgrade
pkg install nodejs-lts git
git clone <your-repository-url>
cd Bug-
cp .env.example .env
npm install
npm start
```

Keep Termux awake/available if you need the bot to remain connected, and never upload its `session/` directory.

## Render deployment

This is a WebSocket worker, not an HTTP application. Use the included [`render.yaml`](render.yaml) as a **Background Worker** blueprint.

- Build: `npm ci`
- Start: `npm start`
- Node: `20.19.5` in the supplied Blueprint
- Persistent disk mount: `/var/data`
- Required production paths: `AUTH_DIR=/var/data/session` and `DATA_DIR=/var/data/data`

Set `PAIRING_NUMBER` in Render before the first pairing. Render's filesystem is ephemeral without a disk, so a deployment/restart without persistent storage loses the WhatsApp session. A disk is required for durable state and is subject to Render plan availability/cost.

## Railway deployment

Railway detects this Node.js project automatically and reads [`railway.toml`](railway.toml).

- Build: `npm ci`
- Start: `npm start`
- Add a Railway Volume at `/var/data`
- Set `AUTH_DIR=/var/data/session` and `DATA_DIR=/var/data/data`
- Set `PAIRING_NUMBER` before the first deployment

## Pterodactyl and generic Node.js hosting

Select a Node.js 20+ runtime/image, retain a persistent writable directory for authentication, configure the environment variables, and use:

```text
npm start
```

For a VPS or other Node.js host:

```bash
npm install
npm start
```

Use a process manager/platform restart policy if you use the owner-only `!restart` command.

## Troubleshooting

- **No pairing code on a cloud host:** set `PAIRING_NUMBER` (digits only) or pair locally with `AUTH_METHOD=qr` and then securely move the session to persistent host storage.
- **Bot is logged out/re-pairs on every deploy:** your `AUTH_DIR` is ephemeral or being overwritten. Attach a single persistent disk/volume and do not run multiple replicas.
- **`Bad Session` / `connection replaced`:** stop the bot, delete only the configured authentication directory, restart, and link again. Automatic reconnect intentionally stops for these cases.
- **Commands do not respond:** check `COMMAND_PREFIX`, `PUBLIC_MODE`, owner number formatting, and the connection logs.
- **Premium data disappears:** persist `DATA_DIR` alongside `AUTH_DIR`.
- **A command appears unavailable:** the unsafe crash/force-close payload commands from the supplied base were intentionally not migrated.

For a complete A–Z deployment flow, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Credits

- Project configuration and migration: **Rashid Hussain**
- Global project owner: **Only Fixa Dev**
- WhatsApp connectivity: [Baileys](https://github.com/WhiskeySockets/Baileys) and its respective maintainers
- The Apache-2.0 license file supplied with the base source is retained. Third-party dependency licenses remain with their respective authors.

## License

This repository is distributed under the [Apache License 2.0](LICENSE). Review the license and all third-party dependency licenses before redistribution.
