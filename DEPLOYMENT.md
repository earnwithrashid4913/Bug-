# ANIME MD Deployment Guide

ANIME MD requires Node.js 20.9 or newer. Install dependencies with `npm ci`
and start it with `npm start`.

## Pterodactyl

Use `npm start` as the startup command. Before starting, edit `config.js`:

- Set `whatsapp.authDir` and `database.dataDir` to paths on persistent storage.
- Enter Telegram credentials in `telegram` or set `telegram.enabled` to `false`.
- If your panel allocates a port for the optional legacy web pairing server, set
  `deployment.webPort` to it and explicitly enable `deployment.webPairingEnabled`.

The application does not read `.env` or panel environment variables for bot
configuration. Never paste session credentials or secrets into logs.
