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
Choose **🔗 Pair WhatsApp** and send the international WhatsApp number with
country code and no `+`, or use `/pair <number>`. Spaced and dashed forms such
as `92 300 1234567` or `92-300-1234567` are normalized automatically, and every
international country code is supported.

Every WhatsApp number receives its own isolated session (socket and credential
directory) below `whatsapp.authDir/telegram-pairings/<telegramId>/<number>`.
Pairing codes always come from the real Baileys/WhatsApp pairing flow. When
`telegram.pairingCode` in `config.js` is set to an exactly-8-character value
(the default `GOATMODS`), that code is issued through WhatsApp's native custom
pairing mechanism and is entered in WhatsApp as `GOAT-MODS`. A session is only
ever reported as connected after WhatsApp reports `connection: open`.

The pairing guide is available in both English and Roman Urdu through
`/guide` and the **📖 Pairing Guide** dashboard button.

Traffic is protected by concurrency limits, a bounded pairing queue, per-number
locks, per-controller cooldowns, pairing timeouts with automatic cleanup, and
reconnect backoff. Paired sessions survive bot restarts and are restored
automatically. Raw disconnect reasons stay in the server log; Telegram users
only see friendly ANIME MD status boxes.

### Telegram commands and buttons

Available Telegram commands are `/start`, `/pair [number]`, `/status [number]`,
`/sessions` (alias `/listsessions`), `/stop <number>` (alias `/delpair`),
`/restart <number>`, `/guide`, `/settings`, `/myid`, `/premium`, `/addowner`,
`/delowner`, `/addprem`, `/delprem`, `/listpaired`, and `/help`.

The dashboard and every list view use inline buttons — Pair WhatsApp, My
Sessions, Status, Pairing Guide, Settings, Help, Refresh, Back, Home, per
session Restart/Remove (with a confirmation step before credentials are
deleted), and owner settings toggles. Every button has a real handler, and
session ownership is re-resolved server-side on every callback: a user can
never manage another user's session.

### Multi-user access

- By default only the controllers configured in `telegram.ownerIds` (plus
  runtime `/addowner` entries) can pair.
- `telegram.publicMode: true` opens pairing to any Telegram user; each user
  still only manages their own sessions.
- `telegram.premiumOnly: true` restricts pairing to premium Telegram users.
  Bootstrap owners grant premium with `/addprem <id> [30d]` and revoke it
  with `/delprem <id>`.
- `telegram.requiredChannels` (empty by default) lists channels a user must
  join before pairing. Bootstrap owners skip this check.
- `/listpaired` (bootstrap owners only) lists every session on the bot, and
  bootstrap owners may restart or stop any session through the same
  owner-scoped operations with an admin override.

Pairing and session operations are owner-authorized and protected against
duplicate requests and rapid repeats. Telegram controller messages use
escaped HTML parse mode so phone numbers, errors, and user-provided values
cannot break Telegram entity parsing.

### WhatsApp interactive commands

The WhatsApp side keeps the full command set (`!menu` lists every category and
alias). The main menu is an interactive list; category pages list their
commands as selectable rows; and status, owner, tools, converter, RPG, group,
mode, greeting, anti-security, and automation replies carry quick-action
buttons. Every button sends a real command the bot already handles, and all
interactive ids follow the live command prefix set with `!setprefix`.

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
