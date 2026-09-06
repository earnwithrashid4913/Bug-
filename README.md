# 𝙂𝙊𝘼𝙏𝙑𝙀𝙍𝙎𝙀 𝙈𝘿

<p align="center"><strong>One Bot. Infinite Themes.</strong></p>
<p align="center">
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-2563eb.svg"></a>
  <img alt="Node.js 20.9 or newer" src="https://img.shields.io/badge/node-%E2%89%A520.9-339933.svg">
  <img alt="Runtime: WhatsApp worker" src="https://img.shields.io/badge/runtime-WhatsApp%20worker-25D366.svg">
</p>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/earnwithrashid4913/Bug-/output/github-snake-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/earnwithrashid4913/Bug-/output/github-snake.svg">
  <img alt="Animated contribution snake" src="https://raw.githubusercontent.com/earnwithrashid4913/Bug-/output/github-snake.svg">
</picture>

> **Developer:** Only F!XA?? Dev &nbsp;•&nbsp; **Developer Identity:** RaShiD Hussain &nbsp;•&nbsp; **Community:** ONLY GOATS ?

## About

GOATVERSE MD is a Node.js WhatsApp bot built with Baileys. It runs as one long-lived outbound WebSocket worker, with pairing-code and terminal-QR authentication, persistent bot data, safe group administration, media conversion, and an optional Groq-powered AI command.

`𝙂𝙊𝘼𝙏𝙑𝙀𝙍𝙎𝙀 𝙈𝘿` is the only master bot name. `THEME` selects a presentation mode only; it never changes authorization or protected identity. The repository currently ships the `default` theme and is deliberately ready for reviewed future themes without bundling unimplemented assets.

## Features

- Pairing-code or terminal QR authentication, with authenticated-account identity verification.
- Persistent, atomic premium and group-greeting stores.
- Bounded reconnects that stop for logout, bad-session, and connection-replaced events.
- Commands for status, owners, safe group administration, greetings, stickers, profile photos, requests, premium access, and optional AI.
- Image/sticker conversion with input-size and pixel limits.
- Render Background Worker and Railway manifests; portable Node.js instructions for VPS and Pterodactyl.

## Architecture

| Area | Implementation |
| --- | --- |
| Entrypoint | `index.js` creates one Baileys socket, handles lifecycle signals, pairing, and reconnects. |
| Configuration | `system/config.js` validates environment values before connecting. |
| Commands | `system/handler.js` parses the configured prefix and applies access checks. |
| Identity | `system/security.js` holds protected developer metadata and verifies optional signed identity manifests. |
| State | `AUTH_DIR` holds Baileys credentials; `DATA_DIR` holds premium and group settings. |
| Themes | `system/theme.js` is data-only and cannot affect authorization. |

## Security and identity boundary

Deployment users may set instance presentation and instance-level ownership. They cannot set protected Global Owner, developer identity, authorization, or HMAC material through normal environment variables. Attempts to use protected owner/developer environment keys fail at startup. If a configured trusted identity manifest is absent, invalid, or tampered with, privileged functions lock without deleting sessions or source files.

The connected WhatsApp account **never** becomes Global Owner automatically. `BOT_NUMBER` is the single pairing and connection setting; the connected account is checked again after login. Keep `.env`, `AUTH_DIR`, `DATA_DIR`, and any trusted-manifest/HMAC inputs outside Git.

## Installation

**Requirements:** Node.js **20.9+** (Node 20 LTS recommended), npm, and a WhatsApp account. Use only accounts and groups you own or administer.

```bash
git clone <repository-url>
cd Bug-
cp .env.example .env
# edit .env with real numbers
npm ci
npm start
```

Use `npm install` only when developing or intentionally updating dependencies. Validate configuration without opening WhatsApp:

```bash
BOT_NUMBER=15551234567 npm run start:dry
npm run check
npm test
```

```bash
BOT_CONNECTION_NUMBER=15551234567 npm run start:dry
npm run check
npm test
```

Copy [`.env.example`](.env.example). The top **INSTANCE SETTINGS** block is the normal deployer-editable surface:

```dotenv
INSTANCE_OWNER_NAME=Your Name
INSTANCE_OWNER_NUMBER=15551234567
BOT_NUMBER=15551234567
THEME=default
```

| Variable | Required | Description |
| --- | --- | --- |
| `BOT_NUMBER` | Yes | 7–15 digit WhatsApp account number, including country code; must match the authenticated account. |
| `INSTANCE_OWNER_NAME`, `THEME` | No | Instance display identity and active visual mode; neither grants protected authorization. |
| `INSTANCE_OWNER_NUMBER` | No | Separately grants instance-owner commands only; it is not Global Owner or Developer authorization. |
| `AUTH_METHOD` | No | `pairing` (default) or `qr`. |
| `AUTH_DIR`, `DATA_DIR` | No | Private persistent paths for credentials and runtime data. |
| `COMMAND_PREFIX`, `PUBLIC_MODE`, `LOG_LEVEL` | No | Command/runtime controls validated at startup. |
| `GROQ_API_KEY`, `GROQ_MODEL` | No | Optional AI provider configuration; never commit the API key. |

`OWNER_LINK`, sticker metadata, greeting templates, database path overrides, and reconnect delays are also documented in [`.env.example`](.env.example). Do **not** add `GLOBAL_OWNER_NUMBER`, `GLOBAL_OWNER_NUMBERS`, `OWNER_NUMBER`, `OWNER_NUMBERS`, or developer overrides: startup rejects them.

## Pairing

### Cloud pairing code

Set `AUTH_METHOD=pairing` and `BOT_NUMBER`. Start the worker, copy the code from its logs, then enter it under WhatsApp **Linked devices** for that account. Persist `AUTH_DIR` before restarting.

### Local terminal QR

Set `AUTH_METHOD=qr`, run `npm start` from an interactive terminal, and scan the displayed QR code with the same account as `BOT_NUMBER`.

A real WhatsApp login cannot be automated by this repository's tests. On an invalid session or logout, stop the worker, remove **only** the configured private `AUTH_DIR`, and pair again.

## Deployment

### 🚀 Deployment paths

| Platform | Install | Start | Persistent storage | Status |
| --- | --- | --- | --- | --- |
| [Render](#render) | `npm ci` | `npm start` | Render disk at `/var/data` | NEEDS CONFIGURATION |
| [Railway](#railway) | `npm ci` | `npm start` | Railway Volume at `/var/data` | NEEDS CONFIGURATION |
| [Pterodactyl](#pterodactyl) | `npm ci` | `npm start` | Persistent server directory | NEEDS CONFIGURATION |
| [VPS / Linux](#vps--linux) | `npm ci` | `npm start` | Host directory | NEEDS CONFIGURATION |
| Docker | — | — | — | NOT SUPPORTED (no Dockerfile is supplied) |
| Koyeb | — | — | — | NOT SUPPORTED (no repository deployment configuration is supplied) |

> All supported paths require **one replica only**. Never share an `AUTH_DIR` between concurrent workers.

| 🟣 **Pterodactyl** | 🖥 **VPS / Linux** | 🚀 **Render** | 🚂 **Railway** |
| --- | --- | --- | --- |
| Persistent server storage | Full host control | Included worker Blueprint | Included start manifest |
| [Deploy guide](DEPLOYMENT.md#pterodactyl) | [Deploy guide](DEPLOYMENT.md#vps--linux) | [Deploy guide](DEPLOYMENT.md#render) | [Deploy guide](DEPLOYMENT.md#railway) |

Docker and Koyeb are not presented as deployment buttons because this repository contains no Docker or Koyeb configuration. Their unsupported status is documented honestly in the [deployment guide](DEPLOYMENT.md#unsupported-paths).

### Render

The included [`render.yaml`](render.yaml) defines a Background Worker, not an HTTP service.

1. Create a Render Blueprint from this repository and confirm `npm ci` / `npm start`.
2. Keep the supplied 1 GB disk mounted at `/var/data`.
3. Set `BOT_NUMBER` and optional instance settings in Render's environment UI.
4. Keep `AUTH_DIR=/var/data/session` and `DATA_DIR=/var/data/data`, deploy one worker, then pair from logs.
5. Restarts retain state only while that disk remains attached. For updates, pull the release, redeploy, and preserve the disk.

Render disks and worker availability depend on the selected Render plan; see the [Render Background Worker documentation](https://render.com/docs/background-workers) and [persistent disk documentation](https://render.com/docs/disks).

### Railway

[`railway.toml`](railway.toml) declares the `npm start` process.

1. Create a project from this repository; Railway builds with Nixpacks.
2. Add one Volume mounted at `/var/data`.
3. Set `BOT_NUMBER` and `AUTH_DIR=/var/data/session`, `DATA_DIR=/var/data/data`.
4. Deploy one replica and pair from logs. Preserve the Volume during redeploys and updates.

See [Railway Volumes](https://docs.railway.com/volumes) for the current volume workflow.

### Pterodactyl

Create one server using a Node.js **20.9+** egg/image and its ordinary persistent server filesystem. Upload or clone the repository, install with `npm ci`, set the configuration values in the server environment/startup panel, then use `npm start`. Pair from the console. Configure the panel's restart policy if you use `!restart`; it exits cleanly and does not restart itself.

### VPS / Linux

Install Node.js 20.9+, clone the repository, copy `.env.example`, run `npm ci`, and start with `npm start`. Set `AUTH_DIR` and `DATA_DIR` to protected directories that survive releases. Use a process manager such as systemd only after confirming `npm run start:dry`; configure it to restart failures and run one instance. For updates, stop the service, pull the reviewed release, run `npm ci`, validate with `npm run check` and `npm test`, then restart without deleting state.

For complete step-by-step deployment and recovery instructions, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Troubleshooting

| Symptom | Resolution |
| --- | --- |
| No cloud pairing code | Set a valid `BOT_NUMBER`; QR needs an interactive terminal. |
| Identity mismatch at connect | Pair/scan the account in `BOT_NUMBER`; the bot intentionally exits rather than substitute an identity. |
| Re-pair after deployment | Put both `AUTH_DIR` and `DATA_DIR` on the platform's persistent disk/volume. |
| Commands do not respond | Check the prefix, `PUBLIC_MODE`, access policy, and worker logs. The linked account is not implicitly an owner. |
| Bad session / logged out | Stop the worker, remove only configured `AUTH_DIR`, start once, and pair again. |
| `!restart` stops the bot | Configure the host restart policy; the command intentionally exits. |

## Commands

Use the configured prefix (`!` by default).

| Group | Commands |
| --- | --- |
| General | `menu`, `ping`, `status`, `owner`, `sticker`, `toimg`, `jid`, `getpp`, `ai`, `request` |
| Group admin | `hidetag`, `tagall`, `welcome`, `goodbye`, `greet`, `group`, `gname`, `gdesc`, `add`, `kick`, `promote`, `demote`, `lock`, `unlock`, `grouplink` |
| Instance-authorized owner | `setpp`, `public`, `self`, `addprem`, `delprem`, `listprem`, `restart` |

`!ai` requires `GROQ_API_KEY`. Group mutations also require the bot to be a group admin. Run `!menu` in WhatsApp for exact usage and aliases.

## Development

```bash
npm ci
BOT_NUMBER=15551234567 npm run start:dry
npm run check
npm test
```

Tests cover configuration validation, protected-identity failure behavior, command parsing, message shapes, media conversion, LID handling, group settings, and premium storage. Do not use production session files or real secrets in tests.

## Contribution

Keep changes small and reviewed. Preserve the protected identity/security architecture, do not add destructive WhatsApp payloads, and add or update tests for behavior changes. Run the development checks before opening a pull request.

## Contribution snake

The lightweight SVG above is generated daily by [`.github/workflows/snake.yml`](.github/workflows/snake.yml) and published to the repository `output` branch. It uses light/dark variants and adds no bot runtime dependency. If repository Actions are disabled or the workflow token cannot write repository contents, the animation simply remains unavailable; bot operation is unaffected.

## Credits

- **Protected developer brand:** Only F!XA?? Dev
- **Protected developer identity:** RaShiD Hussain
- **Community:** ONLY GOATS ?
- WhatsApp connectivity: [Baileys](https://github.com/WhiskeySockets/Baileys)

## License

Distributed under the [Apache License 2.0](LICENSE). Third-party dependencies retain their own licenses.
