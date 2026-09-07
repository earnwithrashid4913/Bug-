# ANIME MD Deployment Guide

ANIME MD is a long-running WhatsApp worker. Telegram is the primary pairing interface; no web server or Web Pairing dashboard is included.
ANIME MD runs as one long-lived service. It maintains the main WhatsApp bot and, when configured, isolated Telegram pairing sessions.

## Pterodactyl / standard deployment

1. Install Node.js 20.9 or newer.
2. Run `npm ci`.
3. Keep `AUTH_DIR` and `DATA_DIR` on persistent private storage.
4. Add the three Telegram variables below in the Pterodactyl environment or the repository-root `.env`.
5. Run `npm start`, open the Telegram bot, and use `/pair <number>`.
3. Configure a persistent directory for `AUTH_DIR` and `DATA_DIR`.
4. Start with `npm start`.
5. Configure Telegram Pairing, or use a pre-existing `SESSION_ID` / terminal QR session for the main bot.

No `BOT_NUMBER` environment variable is required. The account number is entered only in the pairing interface when a code is requested.

## Environment

Required infrastructure settings are usually supplied by the host:

```dotenv
AUTH_DIR=/persistent/session
DATA_DIR=/persistent/data
AUTH_METHOD=pairing

# Get this secret from @BotFather.
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_LINK=https://t.me/AnimeMD_Pairing_Bot
WEB_PAIRING_ENABLED=false
```

Optional operator settings:

```dotenv
OWNER_NAME=Your Name
THEME=gojo
SESSION_ID=
```

Optional Telegram controller:

```dotenv
# STEP 1 — Get the token from @BotFather, then paste it after =.
TELEGRAM_BOT_TOKEN=
# STEP 2 — Enter your Telegram bot username link.
TELEGRAM_BOT_LINK=https://t.me/AnimeMD_Pairing_Bot
# STEP 3 — Enter your numeric Telegram User ID(s), comma separated.
TELEGRAM_OWNER_IDS=6531042566
```

Pterodactyl environment values override `.env`. A blank token only disables Telegram cleanly; it does not crash normal WhatsApp startup.

## Verification

- `/start` sends the configured Telegram Start image.
- `/pair <number>` returns a real WhatsApp pairing code only after the socket is ready.
- The Connected image appears only after WhatsApp reports an open connection.
- `/status`, `/sessions`, and `/stop` are scoped to the requesting authorized Telegram user.
- Run `npm run check` before deploying.
- `GET /health` returns a JSON health response.
- With `WEB_PAIRING_ENABLED=false`, the legacy dashboard remains off and does not create a competing pairing flow.
- Request a Telegram pairing code with `/pair <number>` after opening the configured Telegram bot.
- Run `npm run check` before deployment.
