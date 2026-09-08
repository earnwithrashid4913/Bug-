# ANIME MD

Anime-themed WhatsApp bot with optional Telegram pairing control.

## Configure and start

1. Open **[`config.js`](./config.js)**. It is the single configuration file.
2. To use Telegram pairing, replace `YOUR_TELEGRAM_BOT_TOKEN` and
   `YOUR_TELEGRAM_OWNER_ID` in its `telegram` section. Get the token from
   [@BotFather](https://t.me/BotFather) and use your numeric Telegram user ID.
   Alternatively set `telegram.enabled` to `false` to run without Telegram.
3. Run `npm install`, then `npm start`.

No `.env` file is read or required. Do not commit real tokens, session exports,
or API keys after adding them to `config.js`.

## Pairing

With Telegram enabled, open the configured bot link and use `/pair <number>`
with a country code and no `+`. The phone number remains dynamic and is never
stored as a static configuration value. Telegram supports `/start`, `/pair`,
`/status`, `/sessions`, `/stop`, `/help`, `/addowner`, and `/delowner`.

## Deployment

The normal Pterodactyl/host startup command remains `npm start`. Configure
persistent `whatsapp.authDir` and `database.dataDir` in `config.js` for your
host's persistent volume. The bot does not expose an HTTP dashboard, so no
Pterodactyl port allocation is required.
host's persistent volume. If an optional web pairing server is used, set its
panel-assigned port in `deployment.webPort`; it is disabled by default.

Run `npm run start:dry` to validate `config.js` without opening WhatsApp.
