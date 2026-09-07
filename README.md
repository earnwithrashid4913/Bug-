# ANIME MD

ANIME MD is a WhatsApp bot built with Baileys. It includes a responsive web pairing dashboard, optional Telegram controller, group tools, media utilities, stickers, AI integration, and an anime-themed interface.

## Features

- Secure WhatsApp Web pairing from the built-in dashboard—enter the number only when requesting a code.
- Optional Telegram controller for authorized operators to request pairing codes and check the active session.
- Persistent session and JSON-backed bot settings, group settings, premium access, warnings, automation, and economy data.
- Mobile-friendly web dashboard with accessible controls, theme selection, request feedback, and live connection status.
- Group administration, menus, interactive WhatsApp buttons/lists, media and sticker tools, and optional Groq AI.

## Requirements

- Node.js 20.9 or later.
- An active WhatsApp account for pairing.
- Persistent storage for `AUTH_DIR` and `DATA_DIR` in production.
- Optional: a Telegram bot token and numeric Telegram owner ID(s).

## Install and run

```bash
git clone <repository-url>
cd Bug-
npm ci
cp .env.example .env
npm start
```

Open the service URL shown in the log. Locally it is normally `http://localhost:3000`.

## Configuration

All configuration is read from `.env` by `system/config.js`. Copy `.env.example`; never commit `.env`, session directories, or tokens.

`OWNER_NAME` is optional display text. You **do not** configure a WhatsApp number in Pterodactyl, Render, or another hosting panel to begin pairing. The person pairing enters the account number in the web dashboard or uses the Telegram `/pair <number>` command.

### Telegram controller (optional)

Set all of the following to enable remote Telegram control:

```dotenv
# STEP 1 — Get this secret from @BotFather and paste it after =.
TELEGRAM_BOT_TOKEN=

# STEP 2 — Enter your Telegram bot username link.
TELEGRAM_BOT_LINK=https://t.me/AnimeMD_Pairing_Bot

# STEP 3 — Enter your numeric Telegram User ID. Separate multiple IDs with commas.
TELEGRAM_OWNER_IDS=6531042566
```

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token to `TELEGRAM_BOT_TOKEN`.
2. Set `TELEGRAM_BOT_LINK` to the bot's public `https://t.me/...` link.
3. Put your numeric Telegram user ID in `TELEGRAM_OWNER_IDS`. Only these bootstrap owners can manage additional controllers.

Each authorized controller receives an isolated WhatsApp auth directory and socket. It supports `/start`, `/pair <number>`, `/status`, `/sessions`, `/addowner <id>`, `/delowner <id>`, `/stop <number>`, and `/help`. It replies with a code only after the underlying WhatsApp pairing request succeeds, and sends the connected image only after that controller's socket reports `open`.

## WhatsApp web pairing (temporarily disabled by default)

Set `WEB_PAIRING_ENABLED=true` only when you intentionally want to re-enable the existing dashboard routes. With the default `false`, it does not listen or issue pairing requests, so it cannot interfere with Telegram Pairing.

1. Start the bot and wait for the dashboard to show that it is ready for a pairing request.
2. Enter the WhatsApp number with country code and no `+`.
3. Select **Generate pairing code**.
4. In WhatsApp, open **Settings → Linked devices → Link a device → Link with phone number instead**, then enter the displayed code.

A pairing code is requested from WhatsApp only after the Baileys socket reaches the pairing stage. The dashboard never fabricates a code. WhatsApp delivers the normal pairing prompt to the entered account; the bot cannot send a WhatsApp chat message before that account is authenticated. The dashboard/API and Telegram controller report errors if the native request fails.

Only one unpaired account can be requested by a running bot instance at a time. Complete that flow, restart after a failed pairing, or wait for the pairing state to clear before requesting another number. Pairing endpoint requests are rate limited per client.

## Sessions and storage

- `AUTH_DIR` stores Baileys credentials. Keep it private and persistent.
- `DATA_DIR` stores bot state. Keep it private and persistent.
- `SESSION_ID` can restore a `creds.json` value on hosts with ephemeral disks. It is a complete login credential—never expose or commit it.
- When a session is connected, the bot sends its connection confirmation only after WhatsApp reports an actual open connection.

## Deployment

The project is a single web service: it keeps a WhatsApp WebSocket open and serves the dashboard. `npm start` is the production start command and `/health` is the health endpoint.

For Render, `render.yaml` configures `npm ci`, `npm start`, `/health`, and a persistent `/var/data` disk. Set `AUTH_DIR=/var/data/session` and `DATA_DIR=/var/data/data`. For Heroku, use the included `Procfile` and retain the session with `SESSION_ID` because the filesystem is ephemeral.

Deploy one instance per `AUTH_DIR`; concurrent instances must not write the same WhatsApp credentials.

## Troubleshooting

| Problem | Resolution |
| --- | --- |
| Dashboard says the client is still connecting | Wait for the pairing state, then request the code again. Check outbound network access to WhatsApp. |
| Invalid phone number | Enter 7–15 digits with country code and no `+`. |
| Pairing code request fails | Ensure only one bot instance uses the auth directory; check the server logs and wait for the rate limit. |
| Bot pairs again after deploy | Put `AUTH_DIR` on persistent storage or set a secure `SESSION_ID`. |
| Telegram controller is disabled | Set both `TELEGRAM_BOT_TOKEN` and at least one numeric `TELEGRAM_OWNER_IDS`. |
| Owner commands are denied | Use the WhatsApp account that is currently linked to this bot. |

## Security and identity

The permanent ANIME MD developer, author, and project identity is protected by `system/security.js` and cannot be changed with environment variables. This is separate from `OWNER_NAME`, Telegram controller owners, and the WhatsApp account selected at pairing time.

Do not commit `.env`, `SESSION_ID`, `AUTH_DIR`, `DATA_DIR`, Telegram tokens, API keys, private keys, or trusted identity manifests.

## Validation

```bash
npm run check
npm run build
npm run start:dry
```
