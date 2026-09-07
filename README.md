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
TELEGRAM_BOT_TOKEN=

# STEP 2 — Enter your Telegram bot username link.
TELEGRAM_BOT_LINK=https://t.me/AnimeMD_Pairing_Bot

# STEP 3 — Enter your numeric Telegram User ID. Use commas for more IDs.
TELEGRAM_OWNER_IDS=6531042566
```

Environment variables supplied by Pterodactyl take precedence over `.env`. The token is never logged. Once configured, `/start` displays the existing Start image and commands. Use `/pair <number>` with country code and no `+`.

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
