# ANIME MD

Anime-themed WhatsApp bot with optional Telegram pairing control.

## Configure and start

1. Open **[`config.js`](./config.js)**. It is the single configuration file.
2. To use Telegram pairing, replace `YOUR_TELEGRAM_BOT_TOKEN` and
   `YOUR_TELEGRAM_OWNER_ID` in its `telegram` section. Get the token from
   [@BotFather](https://t.me/BotFather) and use your numeric Telegram user ID.
   Set `telegram.enabled` to `true` when both values are present.
3. Run `npm install`, then `npm start`.

No `.env` file is read or required. Do not commit real tokens, session exports,
or API keys after adding them to `config.js`.

## Pairing

With Telegram enabled, open the configured HTTPS bot link and send `/start`.
Choose **Pair WhatsApp**, then send the international WhatsApp number with
country code and no `+`, or use `/pair <number>`. The bot creates one isolated
native Baileys pairing socket for that Telegram owner, sends the real pairing
code, and waits for WhatsApp to report `connection: open` before reporting
success. Credentials are persisted below `whatsapp.authDir`.

Available Telegram commands are `/start`, `/pair`, `/status`, `/sessions`,
`/stop`, `/help`, `/addowner`, and `/delowner`. Pairing and session operations
are owner-authorized and protected against duplicate requests and rapid repeats.
Telegram controller messages use escaped HTML parse mode so phone numbers,
errors, and user-provided values cannot break Telegram entity parsing.

## Deployment

The normal Pterodactyl/host startup command remains `npm start`. Configure
persistent `whatsapp.authDir` and `database.dataDir` in `config.js` for your
host's persistent volume. The bot does not expose an HTTP dashboard, so no
Pterodactyl port allocation is required. If an optional web pairing server is
used, set its panel-assigned port in `deployment.webPort`; it is disabled by
default.

Run `npm run start:dry` to validate `config.js` without opening WhatsApp.
Run `npm test` and `npm run lint` before deployment.

## External-runtime limitation

Automated tests use a mocked Baileys socket for isolation and lifecycle checks.
A real WhatsApp account, Telegram token, and network connection are required to
validate end-to-end pairing and Telegram delivery; those external operations
are not claimed as locally tested.
