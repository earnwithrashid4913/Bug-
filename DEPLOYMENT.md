# 𝙂𝙊𝘼𝙏𝙑𝙀𝙍𝙎𝙀 𝙈𝘿 — Deployment Guide

GOATVERSE MD pairs a high-performance WhatsApp WebSocket engine with an integrated Web Pairing server (running on port 3000). Every supported deployment must use Node.js **20.9+**, one running replica, and persistent private storage for both authentication and runtime data.

## Before deploying

1. Use Node.js 20.9+ (`node --version`).
2. Install from the lockfile: `npm ci`.
3. Copy `.env.example` locally or configure the same values in the platform environment UI.
4. Set `BOT_NUMBER` to the WhatsApp account that will run the bot.
5. The Web Pairing interface binds to port `PORT` (defaults to 3000) for real-time browser pairing and character theme selection.
6. Keep `AUTH_DIR` and `DATA_DIR` on a private persistent disk/volume. Do not run a second copy against the same `AUTH_DIR`.

Minimal cloud configuration:

```dotenv
INSTANCE_OWNER_NAME=Your Name
INSTANCE_OWNER_NUMBER=15551234567
BOT_NUMBER=15551234567
AUTH_METHOD=pairing
AUTH_DIR=/var/data/session
DATA_DIR=/var/data/data
```

`INSTANCE_OWNER_NUMBER` is instance-level authorization only. It does not become Global Owner, and neither the connected account nor pairing number grants Global Owner access. Do not configure protected owner/developer environment keys; startup rejects them.

## Validation and first pairing

Run the non-network validation before a first deploy:

```bash
BOT_NUMBER=15551234567 npm run start:dry
npm run check
npm test
```

Start with `npm start`. For `AUTH_METHOD=pairing`, copy the printed code into WhatsApp **Linked devices** for `BOT_NUMBER`. For local `AUTH_METHOD=qr`, scan the terminal QR with that same account. After the connection log appears, test `!menu`, `!ping`, and `!owner`.

## Render

**Requirements:** Render Background Worker, Node 20.19.5 (set in `render.yaml`), one persistent disk.

The included [`render.yaml`](render.yaml) is a worker Blueprint with `npm ci`, `npm start`, and a `/var/data` disk.

1. Create a Blueprint from the repository.
2. Keep the 1 GB disk at `/var/data` and one worker instance.
3. Add `BOT_NUMBER` in the Render environment UI; set optional instance settings there too.
4. Keep `AUTH_DIR=/var/data/session` and `DATA_DIR=/var/data/data`.
5. Deploy, pair from logs, and preserve the disk across restarts and updates.

**Common error:** without the disk, Render's filesystem is ephemeral and the session/data disappear on redeploy. Consult [Render Background Workers](https://render.com/docs/background-workers) and [Render disks](https://render.com/docs/disks) for plan and disk details.

**Update:** redeploy the reviewed revision; do not delete or replace the persistent disk.

## Railway

**Requirements:** Railway Node/Nixpacks build, one Volume mounted at `/var/data`.

[`railway.toml`](railway.toml) starts the process with `npm start`; Nixpacks installs the project from `package.json`/the lockfile.

1. Create a project from the repository and add one Volume at `/var/data`.
2. Set `BOT_NUMBER`, optional instance settings, `AUTH_DIR=/var/data/session`, and `DATA_DIR=/var/data/data`.
3. Deploy one replica and obtain the pairing code from logs.
4. Keep the Volume attached for restarts and updates.

**Common error:** multiple replicas or a missing Volume can corrupt or lose the persistent login state. See [Railway Volumes](https://docs.railway.com/volumes).

**Update:** deploy the reviewed revision while retaining the same Volume.

## Pterodactyl

**Requirements:** one server with a Node.js 20.9+ egg/image and persistent server storage.

1. Upload/clone the repository into the server directory.
2. Run `npm ci` in the installation step.
3. Add the configuration values in the Pterodactyl environment/startup panel.
4. Use `npm start` as the startup command.
5. Keep `AUTH_DIR` and `DATA_DIR` inside the server's persistent filesystem, then pair from the console.

**Restart:** configure Pterodactyl's normal restart policy if using `!restart`; the command exits cleanly for the host to restart.

**Update:** stop the server, replace with the reviewed release, run `npm ci`, run `npm run check`, then start it again without deleting state.

## VPS / Linux

**Requirements:** Linux, Node.js 20.9+, npm, and a process supervisor for production availability.

```bash
git clone <repository-url>
cd Bug-
cp .env.example .env
# edit .env; use private persistent paths for AUTH_DIR and DATA_DIR
npm ci
BOT_NUMBER=15551234567 npm run start:dry
npm start
```

For production, run one process under your existing systemd/PM2-equivalent policy after the dry run succeeds. The supervisor should restart failures; it must not start concurrent copies sharing a session path.

**Update:** stop the process, fetch the reviewed revision, run `npm ci`, `npm run check`, and `npm test`, then restart. Preserve `.env`, `AUTH_DIR`, and `DATA_DIR`.

## Unsupported paths

- **Docker:** no Dockerfile or compose file is included, so Docker is not claimed as a supported path.
- **Koyeb:** no Koyeb configuration is included, so Koyeb is not claimed as a supported path.
- **Serverless / Lambda:** not appropriate; this bot requires a continuous WebSocket session and event loop.

## Recovery and troubleshooting

| Problem | Action |
| --- | --- |
| No pairing code in cloud logs | Set a valid `BOT_NUMBER` (digits and country code). |
| Connection identity mismatch | Pair the exact account in `BOT_NUMBER`; this is an intentional fail-closed check. |
| Session disappears after deploy | Mount persistent storage and point both `AUTH_DIR` and `DATA_DIR` to it. |
| `Bad Session` / logout | Stop the process, remove only configured `AUTH_DIR`, restart, and pair again. |
| Commands ignored | Check `COMMAND_PREFIX`, `PUBLIC_MODE`, authorization settings, and worker logs. |
| `!restart` leaves bot stopped | Configure the host/supervisor restart policy. |
| Protected identity verification fails | Investigate the trusted manifest/HMAC outside the repository; privileged functions stay locked and no files are deleted. |

## Deployment matrix

| Platform | Install | Start | Persistent Storage | Status |
| --- | --- | --- | --- | --- |
| Render | `npm ci` (manifest) | `npm start` (manifest) | `/var/data` disk | NEEDS CONFIGURATION |
| Railway | Nixpacks/lockfile | `npm start` (manifest) | `/var/data` Volume | NEEDS CONFIGURATION |
| Pterodactyl | `npm ci` | `npm start` | Server filesystem | NEEDS CONFIGURATION |
| VPS/Linux | `npm ci` | `npm start` | Host filesystem | NEEDS CONFIGURATION |
| Docker | — | — | — | NOT SUPPORTED |
| Koyeb | — | — | — | NOT SUPPORTED |

The `NEEDS CONFIGURATION` status is intentional: live WhatsApp authentication and each provider's disk/volume attachment require the deployer's account and cannot be validated in repository CI.
