# ANIME MD

ANIME MD is a Baileys WhatsApp bot with Telegram as its primary pairing and session-management interface. It includes group tools, media utilities, stickers, AI, persistent JSON state, and protected project identity.

## Deploy

```bash
npm ci
cp .env.example .env
npm start
```

Use persistent storage for `AUTH_DIR` and `DATA_DIR`. Do not run multiple instances against the same directories.

## Telegram setup

Telegram is disabled safely when its token is blank. In the repository-root `.env` (or Pterodactyl startup environment), configure:

```dotenv
# STEP 1 — Get this from @BotFather and paste it after =.
# STEP 1 — Get this secret from @BotFather and paste it after =.
TELEGRAM_BOT_TOKEN=

# STEP 2 — Enter your Telegram bot username link.
TELEGRAM_BOT_LINK=https://t.me/AnimeMD_Pairing_Bot

# STEP 3 — Enter your numeric Telegram User ID. Use commas for more IDs.
TELEGRAM_OWNER_IDS=6531042566
```

Environment variables supplied by Pterodactyl take precedence over `.env`. The token is never logged. Once configured, `/start` displays the existing Start image and commands. Use `/pair <number>` with country code and no `+`.
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

## Telegram pairing and sessions

Every authorized Telegram controller has an isolated Baileys socket and auth directory below `AUTH_DIR/telegram-pairings/<telegram-id>`. A controller cannot inspect or stop another controller's session.

1. Send `/start` then `/pair <number>`.
2. ANIME MD validates authorization and the phone number, waits for WhatsApp pairing readiness, and requests a real native pairing code.
3. The code is delivered privately to that Telegram chat. In WhatsApp, choose **Linked devices → Link with phone number instead**, then enter it.
4. The existing Connected image is sent only after that owner’s WhatsApp socket reports `connection: open`.

The bot supports `/start`, `/pair`, `/status`, `/sessions`, `/stop`, `/help`, `/addowner`, and `/delowner`. `/addowner` and `/delowner` remain restricted to bootstrap IDs from `TELEGRAM_OWNER_IDS`.

A WhatsApp chat notification cannot be sent to an unpaired account before authentication; WhatsApp’s native linked-device UI is the pairing-code entry mechanism. ANIME MD never claims a pairing succeeded before receiving the real socket-open event.

## Session and security notes

- `AUTH_DIR` and `DATA_DIR` contain private state and must be persistent and non-public.
- `SESSION_ID` can restore a primary `creds.json` for hosts with ephemeral storage; never commit or share it.
- The permanent developer/project identity is protected by `system/security.js` and cannot be overridden through environment variables.
- A temporary WhatsApp network failure retries with bounded backoff. Logged-out, invalid, and replaced sessions do not loop forever.

## Validation

```bash
npm run check
npm run build
npm run start:dry
```
