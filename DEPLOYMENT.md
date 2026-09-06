# Black Clover ♣️ Deployment Guide

This application is a long-running WhatsApp client that also serves the **Web Pairing dashboard**, so deploy it as a **single web service** with persistent storage. It listens on `0.0.0.0` and the port given by `PORT` (default `3000`); `/health` is a suitable health-check path.

## 1. Clone the repository

```bash
git clone <your-repository-url>
cd Bug-
```

## 2. Install a supported Node.js version

Use Node.js **20.x LTS** (or a newer Node.js release that satisfies `package.json`'s `>=20` engine requirement).

```bash
node --version
npm --version
```

## 3. Install dependencies

For a normal local install:

```bash
npm install
```

For a reproducible CI/hosting install after `package-lock.json` is present:

```bash
npm ci
```

## 4. Configure the bot

```bash
cp .env.example .env
```

Only two values are user-facing:

```dotenv
OWNER_NAME=Only Fixa Dev
BOT_NUMBER=923001234567
```

- `BOT_NUMBER` is the WhatsApp number the bot links to. **Include the country code and do not add `+`.** There is no country selector or separate country-code field — `923001234567` is valid, `+923001234567` is rejected at startup with an explanatory error.
- The owner link, owner number used for owner-only commands, and developer contact are all derived from `BOT_NUMBER`. The developer credit is fixed: **Developed By: Goats Mods**.

Everything else (`THEME`, `PORT`, `AUTH_DIR`, `DATA_DIR`, prefix, sticker metadata, greetings, AI key, reconnect tuning) is optional and already has a safe default.

Keep `.env`, `session/`, and `data/` private. They are intentionally ignored by Git, and the dashboard never serves files from them.

## 5. Start and pair WhatsApp

### Web Pairing (the supported flow)

```bash
npm start
# [web] Pairing dashboard listening on http://0.0.0.0:3000 (theme: Gojo).
```

1. Open the dashboard (locally `http://localhost:3000`, on a host use its domain or the exposed port).
2. The number field is prefilled with `BOT_NUMBER`. Confirm it — country code included, no `+`.
3. Press **Generate pairing code**.
4. In WhatsApp: **Settings → Linked devices → Link a device → Link with phone number instead**, then type the code shown.

The status pill reflects the real socket state (`starting`, `connecting`, `awaiting code`, `connected`, `disconnected`, `logged out`). It only reads **Connected** after Baileys reports an open connection. Code requests are rate limited to one per 20 seconds per client. WhatsApp stores credentials in `AUTH_DIR`; do not delete that directory after a successful link.

### Terminal QR (internal fallback only)

```dotenv
AUTH_METHOD=qr
```

Run `npm start` in an interactive terminal and scan the printed QR code. This path exists for local recovery; it is never offered by the dashboard. Pairing requires real WhatsApp credentials and cannot be completed by the repository's automated tests.

## 6. Verify the connection

After logs report that the bot is connected, send:

```text
!menu
!ping
!owner
```

Use the prefix configured by `COMMAND_PREFIX` if it is not `!`.

## 7. Deploy to Render

`render.yaml` defines a **Web Service**, because the bot both keeps the WhatsApp WebSocket open and serves the pairing dashboard.

1. Push this repository to your Git provider.
2. In Render, create a Blueprint from the repository (or create a Web Service manually).
3. Confirm the build command is `npm ci`, the start command is `npm start`, and the health-check path is `/health`.
4. Attach a persistent disk at `/var/data`. The included Blueprint requests a 1 GB disk.
5. Configure these environment variables in Render:
   - `OWNER_NAME`
   - `BOT_NUMBER` (country code, no `+`)
   - `THEME` (optional: `makima`, `nami`, `nezuko`, `shinobu`, `gojo`, `sukuna`, `asta`)
   - `AUTH_METHOD=pairing`
   - `AUTH_DIR=/var/data/session`
   - `DATA_DIR=/var/data/data`
6. Deploy, open the service URL, and complete pairing from the dashboard. Render provides `PORT` automatically.

Render services use an ephemeral filesystem unless a persistent disk is attached. A durable session therefore requires the disk. Keep one instance: a Baileys session directory must not be shared or written by multiple running bot instances. Persistent disks are a paid Render feature, so check your Render plan before relying on them.

## 8. Deploy to Heroku

Heroku wipes the container filesystem on every dyno restart, so the WhatsApp session must travel in the `SESSION_ID` config var. The repository ships [`app.json`](app.json) (a deploy template) and a [`Procfile`](Procfile) (`web: npm start`).

1. Create the app from `app.json` (the "Deploy to Heroku" button, or `heroku create` + `git push heroku main`).
2. Set the required config vars:

   ```dotenv
   OWNER_NAME=Only Fixa Dev
   BOT_NUMBER=923001234567
   AUTH_METHOD=pairing
   EXPOSE_SESSION_ID=true
   ```

3. Deploy and open the generated `https://<app>.herokuapp.com/` URL.
4. Pair WhatsApp from the dashboard. The **Session** card shows your `SESSION_ID` because export is enabled.
5. Copy it, paste it into the `SESSION_ID` config var, set `EXPOSE_SESSION_ID=false`, then restart the dyno.

The bot writes that value to `AUTH_DIR/creds.json` at startup, so every later deploy reconnects without pairing.

## 9. Deploy to a panel (Pterodactyl)

This project needs no custom Docker image as long as the selected Node.js egg/image provides Node 20 or newer.

1. Download the repository as a zip, create a Node.js 20.9+ server, and upload the zip.
2. Extract it, then run `npm install` (or `npm ci` with the lockfile) in the panel terminal.
3. Create `.env` (or use the panel's environment variables):

   ```dotenv
   OWNER_NAME=Only Fixa Dev
   BOT_NUMBER=923001234567
   AUTH_METHOD=pairing
   ```

4. Start the server with `npm start`.
5. Allocate a port, open it in the browser, and pair from the dashboard.

Panel storage is persistent, so `AUTH_DIR` and `DATA_DIR` survive restarts. The owner-only `!restart` command works here: the bot supervises its own worker process and relaunches it.

## 10. Bot-Hosting.net, Katabump and Optiklink

All three are free Node.js hosts and use the same flow as a panel.

| Host | Steps |
| --- | --- |
| **Bot-Hosting.net** | Create a Node.js bot, upload/clone the project, `npm install`, set `OWNER_NAME` + `BOT_NUMBER`, start with `npm start`, then open the assigned port. |
| **Katabump** | Create a Node.js service, upload the project, `npm install`, `npm start`. |
| **Optiklink** | Create a Node.js service, upload the project, `npm install`, `npm start`, and expose the dashboard port. |

Set `PORT` to the port the host assigns. If the host resets its filesystem between starts, keep the session with `SESSION_ID` (section 11).

## 11. Termux, SSH and Ubuntu + pm2

```bash
# Termux
pkg update && pkg upgrade
pkg install nodejs-lts git

# Ubuntu / SSH
sudo apt update && sudo apt upgrade -y
sudo apt install -y nodejs npm git

git clone <your-repository-url>
cd Bug-
cp .env.example .env
npm install
npm start
```

For an always-on installation:

```bash
npm install -g pm2
pm2 start index.js
pm2 save
pm2 logs
```

Point `AUTH_DIR` and `DATA_DIR` at paths that survive restarts, open the dashboard port in your firewall, and never run a second copy of the bot against the same authentication directory.

## 12. Keep a session with SESSION_ID

Hosts with ephemeral storage (Heroku, Render free tier, panels without a volume) lose `session/` on every restart. `SESSION_ID` is the contents of `session/creds.json` — raw JSON or its base64 form.

1. Pair WhatsApp once on any host with `EXPOSE_SESSION_ID=true`.
2. Open the dashboard's **Session** card and copy the SESSION_ID (or copy `session/creds.json` from disk).
3. Store it in the host's environment as `SESSION_ID`, and set `EXPOSE_SESSION_ID=false` again.
4. Restart. The log shows `[session] Wrote credentials from SESSION_ID to …/creds.json`.

A SESSION_ID is a complete WhatsApp login. Never commit it, never paste it into a public chat, and rotate it (re-pair) if it leaks.

## Troubleshooting

| Symptom | Cause and resolution |
| --- | --- |
| `BOT_NUMBER must not contain "+"` | Remove the `+`; write the number as `923001234567`. |
| Dashboard will not open | Confirm `PORT` is free, the host exposes it, and the service bound `0.0.0.0`. |
| `Please wait Ns before requesting another code` | Pairing is rate limited to one code per 20 seconds per client. |
| Status stays on *disconnected* | Check host egress to WhatsApp, then the connection logs. The dashboard mirrors the real socket state. |
| Bot asks to pair again after deployment | `AUTH_DIR` is on ephemeral storage. Attach a volume/disk and point `AUTH_DIR` to it, or keep the session in `SESSION_ID`. |
| `Bad Session` or `logged out` | Stop the bot, remove only the configured authentication directory, restart, then pair again. |
| Bot ignores commands | Verify the configured prefix and `PUBLIC_MODE`. In self mode, only the owner/linked account can use commands. |
| Owner commands are denied | Confirm `BOT_NUMBER` uses digits only and includes the country code. The currently linked account is also accepted as an owner. |
| Theme artwork is missing | The hosted images are unreachable from that network. The theme keeps its gradient, glow and particles; no substitute artwork is used. |
| `npm ci` fails | Commit/use the generated `package-lock.json`, or use `npm install` for local development. |
| `restart` stops the bot | The bot relaunches its own worker under the built-in supervisor; on hosts that run `node index.js` directly, configure the platform/process manager to restart exited processes. The command intentionally does not delete your saved session. |

## Recommended hosting method

A **panel server** or a **VPS** with persistent storage is the most reliable choice: the session, bot mode, premium records and group greetings all survive restarts with no extra configuration. A **Render Web Service with a persistent disk** is the best managed option. **Heroku**, **Bot-Hosting.net**, **Katabump** and **Optiklink** work as well, but they reset their filesystem, so pair once and keep the session in `SESSION_ID`. A local machine or Termux installation is suitable for testing, but it must stay online for the bot to remain connected.
