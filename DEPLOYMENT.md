# ANIME MD Deployment Guide

ANIME MD requires Node.js 20.9 or newer. Install dependencies with `npm ci`
and start it with `node index.js` (the verified production entrypoint —
`npm start` runs the same file, but calling Node directly is preferred on
process managers so OS signals reach the bot instead of an npm wrapper).

Before starting, edit `config.js`:

- Set `whatsapp.authDir` and `database.dataDir` to paths on persistent storage.
- Enter Telegram credentials in `telegram` or set `telegram.enabled` to `false`.

This bot does not run an HTTP dashboard or web-pairing server, so
Pterodactyl port allocation is not required. It uses WhatsApp and Telegram
outbound APIs.

- If your panel allocates a port for the optional legacy web pairing server, set
  `deployment.webPort` to it and explicitly enable `deployment.webPairingEnabled`.

The application does not read `.env` or panel environment variables for bot
configuration. Never paste session credentials or secrets into logs.

> Status wording: production-hardened and tested for maximum practical 24/7
> reliability under the tested environments. No software can guarantee 100%
> uptime, especially on Android (see Guide B).

---

## GUIDE A — Pterodactyl (Wings)

**Verified entrypoint:** `index.js` (`package.json` → `"main": "index.js"`,
`"scripts": { "start": "node index.js" }`). `node index.js` starts a small
supervisor that spawns the worker (`node index.js --child`) and restarts it
with backoff. The process stays alive with zero paired sessions (idle
Telegram-pairing state) by design.

| Setting              | Value                                            |
|----------------------|--------------------------------------------------|
| Startup Command      | `node index.js`                                  |
| Install Command      | `npm ci`                                         |
| Node version         | 20.9+ (LTS 20.x recommended; also verified on 22.x) |
| Memory (suggestion)  | 512 MB minimum, 1024 MB comfortable              |
| Disk (suggestion)    | 1 GB minimum (sessions + JSON databases grow slowly) |
| Environment vars     | none required — all config lives in `config.js`  |

Why not `npm start` here: `npm` sits between Wings and Node as an extra
parent process and is known to swallow or delay SIGTERM/SIGINT on some
images, which turns a graceful stop into a SIGKILL. `node index.js` lets
the panel's signals reach the supervisor directly.

### Install steps

1. Create the server with a Node.js 20+ egg.
2. Upload the project (or use the egg's git-clone feature) so `index.js`,
   `config.js` and `package.json` are in the server root.
3. Run the install command (`npm ci`) from the panel console (or let the
   egg's install script do it).
4. Edit `config.js` on persistent storage (`session/` and `data/` must
   survive restarts — the default `./session` / `./data` paths are inside
   the container filesystem, which Wings keeps across restarts but not
   across reinstalls; back them up before reinstalling).
5. Set Startup Command to `node index.js` and start the server.

### Restart behavior

- Worker crash → supervisor restarts it in ~25ms; after 5 exits in a minute
  it cools off (60s, doubling to 5min max) and keeps the container ONLINE.
  It only gives up after 20 exits in 10 minutes (a deploy that genuinely
  cannot start), which needs human attention.
- Transient WhatsApp disconnects (timeouts, 500s, restarts) → automatic
  reconnect with capped exponential backoff; credentials are never deleted
  for transient errors.
- Telegram controller start failure → retried forever (5s → 10s → … capped
  at 5min); Telegram long-poll failures → 5s retry inside the poll loop.
- `!restart` (owner) → supervisor relaunches the worker without panel help.

### Logs / health checks

Watch the panel console for the stable tags: `[BOOT]` `[WHATSAPP]`
`[TELEGRAM]` `[RECONNECT]` `[SESSION]` `[DATABASE]` `[MEMORY]` `[SHUTDOWN]`
`[ERROR]`. Healthy signs: `[BOOT] … worker starting`, periodic `[MEMORY]
rss=… state=…` lines (every 10 min), no `[ERROR] [supervisor]` cool-off
messages. Pairing codes, tokens and credentials are never printed.

### Safe restart / stop procedure

1. Prefer the panel Stop button (sends SIGTERM): the supervisor forwards it
   to the worker, sockets close, Telegram polling stops, both processes exit
   0 within ~5s.
2. Then Start again. No cleanup step is needed; sessions resume from disk.
3. Never delete `session/` to "fix" a disconnect unless you intend to
   unpair — transient errors recover on their own.

---

## GUIDE B — Termux + Ubuntu

Android is not a VPS: the OS can kill background processes (battery
optimization, memory pressure, reboot, force-stop, Termux swiped away on
some OEMs). The setup below is the maximum practical reliability — it
recovers from every software-side failure automatically, but it cannot
overrule the Android OS. No 100% uptime is claimed.

Pick ONE of the two environments:

- **B1 — Ubuntu inside Termux (recommended):** `proot-distro` Ubuntu gives
  you a real Linux userland where Node, PM2 and the bot behave like a VPS.
- **B2 — Native Termux:** works, but PM2/systemd are unavailable, so use
  the bundled `scripts/termux-run.sh` loop instead.

### B1 — Ubuntu inside Termux (recommended)

```sh
# --- 1. Termux preparation (inside the Termux app) ---
pkg update -y && pkg upgrade -y
pkg install -y proot-distro termux-services
proot-distro install ubuntu
proot-distro login ubuntu

# --- 2. Inside Ubuntu: Node.js 20 + tools ---
apt update && apt upgrade -y
apt install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version   # expect v20.x (v22.x also verified)

# --- 3. Project installation ---
git clone <your-repo-url> anime-md   # or copy the project folder here
cd anime-md
npm ci

# --- 4. Environment setup ---
# Edit config.js: telegram token/owners (or telegram.enabled=false),
# whatsapp.authDir (default ./session) and database.dataDir (default ./data).
node -e "require('./system/config'); console.log('config OK')"
npm run start:dry   # validates config without opening WhatsApp

# --- 5. Process manager (PM2) ---
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 logs anime-md     # watch [BOOT]/[TELEGRAM]/[WHATSAPP] lines
pm2 status            # check online state
```

`pm2 startup` (reboot persistence) needs systemd, which proot Ubuntu does
not have — so after a device reboot, re-enter Ubuntu and run:

```sh
proot-distro login ubuntu -- bash -lc 'cd ~/anime-md && pm2 resurrect'
```

(Adjust the path to where you cloned the project.) Combine with
Termux:Boot below to make even that step automatic.

Useful PM2 commands:

```sh
pm2 status                 # is the bot online?
pm2 logs anime-md --lines 50
pm2 restart anime-md       # safe restart (SIGINT → graceful shutdown)
pm2 stop anime-md          # safe stop
pm2 delete anime-md        # remove from PM2 (also run `pm2 save`)
```

### B2 — Native Termux (no Ubuntu, no PM2)

```sh
# --- 1. Termux preparation ---
pkg update -y && pkg upgrade -y
pkg install -y nodejs git
node --version   # Termux ships a recent Node; 20.9+ required

# --- 2. Project installation ---
git clone <your-repo-url> anime-md && cd anime-md
npm ci

# --- 3. Configure + validate ---
# Edit config.js (telegram token/owners or telegram.enabled=false).
npm run start:dry

# --- 4. Run under the Termux supervisor loop ---
termux-wake-lock            # keep the CPU awake; see notes below
sh scripts/termux-run.sh    # restarts the bot on exit, 5s→300s backoff
```

Stop it with Ctrl+C (or `kill -TERM` on the script's PID): the signal
reaches Node, the bot shuts down gracefully, and the loop exits instead of
restarting. Logs go to the terminal — optionally append
`>> bot.log 2>&1` and `tail -f bot.log` from a second Termux session
(swipe right → New session).

> `sharp` (stickers) ships a native binary. If `npm ci` fails on native
> Termux, install build tools (`pkg install -y build-essential python`)
> and retry; on proot Ubuntu the `build-essential` step above covers it.

### Android reliability checklist (both B1 and B2)

1. **Wake lock:** run `termux-wake-lock` each time before starting the bot
   (it does not survive a reboot). Release with `termux-wake-unlock`.
2. **Battery optimization:** Android Settings → Apps → Termux → Battery →
   Unrestricted, and exempt Termux from any "background restrictions" /
   "auto-start manager" your OEM adds (Xiaomi/Oppo/Vivo are aggressive).
3. **Termux:Boot (optional, recommended):** install the Termux:Boot app,
   then place a start script at
   `~/.termux/boot/start-anime-md` (executable) that launches your B1 or
   B2 start command, so the bot comes back after a reboot.
4. **Network loss:** nothing to do — the bot stays alive offline and both
   WhatsApp and Telegram reconnect automatically when the network returns
   (verified by test: the process never exits on network errors).
5. **Safe shutdown:** Ctrl+C / SIGTERM; never force-stop Termux mid-write
   unless the process is hung.
6. **Monitoring:** check `pm2 status` / the terminal for the `[MEMORY]`
   heartbeat and the absence of `[ERROR]` lines.

### Quick command reference (Guide B)

| Task              | B1 (Ubuntu + PM2)              | B2 (native Termux)              |
|-------------------|--------------------------------|---------------------------------|
| Start             | `pm2 start ecosystem.config.js`| `sh scripts/termux-run.sh`      |
| Status            | `pm2 status`                   | `ps aux \| grep "node index"`   |
| Logs              | `pm2 logs anime-md`            | terminal / `tail -f bot.log`    |
| Safe restart      | `pm2 restart anime-md`         | Ctrl+C, then start again        |
| Safe stop         | `pm2 stop anime-md`            | Ctrl+C                          |
| After reboot      | `pm2 resurrect` in Ubuntu      | re-run the start command        |
| Update code       | `git pull && npm ci && pm2 restart anime-md` | `git pull && npm ci`, restart loop |

---

## Signal & exit-code reference (all hosts)

| Signal   | Behavior                                                        |
|----------|-----------------------------------------------------------------|
| SIGTERM  | Graceful shutdown (supervisor forwards to worker, exit 0)       |
| SIGINT   | Same as SIGTERM (Ctrl+C)                                        |
| SIGHUP   | Same as SIGTERM (no silent kill)                                |
| SIGKILL  | Last resort only; the supervisor (or PM2/panel/loop) restarts   |

Exit codes: `0` clean shutdown; `1` uncaught exception / crash-loop give-up
(20 worker exits in 10 min — read the log above it). The supervisor staying
up while a worker cool-off is in progress is normal and reported as
`instead of stopping — the container stays online`.
