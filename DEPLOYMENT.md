# ANIME MD Deployment Guide

ANIME MD runs as one long-lived web service. It serves the web pairing dashboard and maintains one WhatsApp connection.

## Deploy

1. Install Node.js 20.9+.
2. Run `npm ci`.
3. Configure a persistent directory for `AUTH_DIR` and `DATA_DIR`.
4. Start with `npm start`.
5. Open the service URL and complete Web Pairing.

No `BOT_NUMBER` environment variable is required. The account number is entered only in the pairing interface when a code is requested.

## Environment

Required infrastructure settings are usually supplied by the host:

```dotenv
PORT=3000
WEB_HOST=0.0.0.0
AUTH_DIR=/persistent/session
DATA_DIR=/persistent/data
AUTH_METHOD=pairing
```

Optional operator settings:

```dotenv
OWNER_NAME=Your Name
THEME=gojo
SESSION_ID=
```

Optional Telegram controller:

```dotenv
# Get the token from @BotFather.
TELEGRAM_BOT_TOKEN=
# Example: https://t.me/YourBotUsername
TELEGRAM_BOT_LINK=
# Numeric Telegram user ID(s), comma separated.
TELEGRAM_OWNER_IDS=123456789
```

## Render

The included `render.yaml` uses `npm ci`, `npm start`, and `/health`. Attach the configured disk at `/var/data`; it stores the session and JSON data. Keep a single service instance.

## Heroku

Use `Procfile` (`web: npm start`). Heroku storage is ephemeral, so configure `SESSION_ID` after first pairing or use another persistent storage solution. Never put a session value in Git.

## Verification

- `GET /health` returns a JSON health response.
- The dashboard shows actual connection state from WhatsApp.
- Request a pairing code only after the dashboard reports it is ready.
- Run `npm run check` before deployment.
