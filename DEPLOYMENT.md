# ANIME MD Deployment Guide

ANIME MD is a long-running WhatsApp worker. Telegram is the primary pairing interface; no web server or Web Pairing dashboard is included.

## Pterodactyl / standard deployment

1. Install Node.js 20.9 or newer.
2. Run `npm ci`.
3. Keep `AUTH_DIR` and `DATA_DIR` on persistent private storage.
4. Add the three Telegram variables below in the Pterodactyl environment or the repository-root `.env`.
5. Run `npm start`, open the Telegram bot, and use `/pair <number>`.

```dotenv
AUTH_DIR=/persistent/session
DATA_DIR=/persistent/data
AUTH_METHOD=pairing

# Get this secret from @BotFather.
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_LINK=https://t.me/AnimeMD_Pairing_Bot
TELEGRAM_OWNER_IDS=6531042566
```

Pterodactyl environment values override `.env`. A blank token only disables Telegram cleanly; it does not crash normal WhatsApp startup.

## Verification

- `/start` sends the configured Telegram Start image.
- `/pair <number>` returns a real WhatsApp pairing code only after the socket is ready.
- The Connected image appears only after WhatsApp reports an open connection.
- `/status`, `/sessions`, and `/stop` are scoped to the requesting authorized Telegram user.
- Run `npm run check` before deploying.
