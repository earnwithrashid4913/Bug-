# Black Clover ♣️ Deployment Guide

This application is a long-running WhatsApp client. It is best deployed as a **single background worker** with persistent storage. It does not provide an HTTP website, so a web-service deployment is not the appropriate default.

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

At minimum, set `BOT_NAME` to the name you want to display. The supplied owner defaults are:

- Global Owner: **Only Fixa Dev**
- Developer: **Rashid Hussain**
- Owner number: `923448170040`
- Owner link: `https://wa.me/923448170040`
- Channel: `https://whatsapp.com/channel/0029VbBepCNBVJl5vGUHET3T`

Keep `.env`, `session/`, and `data/` private. They are intentionally ignored by Git.

## 5. Start and pair WhatsApp

### Pairing-code flow (recommended for cloud hosts)

Set these values in `.env` or your host's environment-variable page:

```dotenv
AUTH_METHOD=pairing
PAIRING_NUMBER=your_linking_phone_number
```

`PAIRING_NUMBER` is the phone that will be linked to the bot. Replace the placeholder with that device's real number; do not copy an owner/contact number here unless it is genuinely the account being linked. It must be digits only and include the country code.

Start the process:

```bash
npm start
```

Copy the pairing code from the logs, then enter it in WhatsApp on the phone being linked. WhatsApp stores credentials in `AUTH_DIR`; do not delete that directory after a successful link.

### QR flow (best for an interactive local terminal)

```dotenv
AUTH_METHOD=qr
```

Run `npm start` and scan the terminal QR code. Pairing/QR login requires real WhatsApp credentials and cannot be completed by the repository's automated tests.

## 6. Verify the connection

After logs report that the bot is connected, send:

```text
!menu
!ping
!owner
```

Use the prefix configured by `COMMAND_PREFIX` if it is not `!`.

## 7. Deploy to Render

`render.yaml` defines a **Background Worker**, which matches this bot's architecture.

1. Push this repository to your Git provider.
2. In Render, create a Blueprint from the repository (or create a Background Worker manually).
3. Confirm the build command is `npm ci` and start command is `npm start`.
4. Attach a persistent disk at `/var/data`. The included Blueprint requests a 1 GB disk.
5. Configure these environment variables in Render:
   - `BOT_NAME`
   - `AUTH_METHOD=pairing`
   - `PAIRING_NUMBER` for the first link
   - `AUTH_DIR=/var/data/session`
   - `DATA_DIR=/var/data/data`
6. Deploy and complete pairing from the worker logs.

Render services use an ephemeral filesystem unless a persistent disk is attached. A durable session therefore requires the disk. Keep one worker instance: a Baileys session directory must not be shared or written by multiple running bot instances. Persistent disks are a paid Render feature, so check your Render plan before relying on them.

## 8. Deploy to Railway

Railway discovers the application through `package.json`; `railway.toml` sets the same build and start commands.

1. Create a Railway project from this repository.
2. Add a **Volume** mounted at `/var/data`.
3. Add the same environment variables used for Render:

   ```dotenv
   AUTH_METHOD=pairing
   PAIRING_NUMBER=your_linking_phone_number
   AUTH_DIR=/var/data/session
   DATA_DIR=/var/data/data
   ```

4. Set `BOT_NAME` and any other configuration values you want to override.
5. Deploy and obtain the pairing code from Railway logs.

A Railway volume is required if you want the WhatsApp session and premium database to survive redeployments.

## 9. Deploy to Pterodactyl

This project needs no custom Docker image as long as the selected Node.js egg/image provides Node 20 or newer.

1. Create one server with a Node.js 20.9+ image and persistent server storage.
2. Upload/clone the repository.
3. Install dependencies with `npm install` (or `npm ci` when using the lockfile).
4. Set the environment variables in Pterodactyl's startup/configuration panel.
5. Use this startup command:

   ```text
   npm start
   ```

6. Pair through the server console and keep `AUTH_DIR` inside the server's persistent volume.

## 10. Generic Node.js host or VPS

Use a process manager that restarts a failed process, then run:

```bash
npm install
npm start
```

Set `AUTH_DIR` and `DATA_DIR` to paths that survive restarts and deployments. Do not run a second copy of the bot against the same authentication directory.

## Troubleshooting

| Symptom | Cause and resolution |
| --- | --- |
| `PAIRING_NUMBER is not set` | Set it on non-interactive/cloud hosts, or use `AUTH_METHOD=qr` in a local terminal. |
| Bot asks to pair again after deployment | `AUTH_DIR` is on ephemeral storage. Attach a volume/disk and point `AUTH_DIR` to it. |
| `Bad Session` or `logged out` | Stop the bot, remove only the configured authentication directory, restart, then pair again. |
| Bot ignores commands | Verify the configured prefix and `PUBLIC_MODE`. In self mode, only the owner/linked account can use commands. |
| Owner commands are denied | Confirm `OWNER_NUMBER` uses digits only and includes the country code. The currently linked account is also accepted as an owner. |
| `npm ci` fails | Commit/use the generated `package-lock.json`, or use `npm install` for local development. |
| `restart` stops the bot | Configure the platform/process manager to restart exited processes. The command intentionally does not delete your saved session. |

## Recommended hosting method

A single Railway service with a persistent volume or a Render Background Worker with a persistent disk is recommended. Both match a long-running WebSocket process and can retain the WhatsApp authentication state. A local machine/Termux installation is suitable for testing, but it must remain online for the bot to remain connected.
