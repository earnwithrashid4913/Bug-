'use strict';

// ---------------------------------------------------------------------------
// ANIME MD — PM2 process file for Ubuntu / VPS deployments.
//
// Use this ONLY on a normal Linux host with Node.js (Ubuntu VPS, proot Ubuntu
// inside Termux, Docker without Pterodactyl). On Pterodactyl the panel itself
// is the supervisor — do not run PM2 there. On native Termux use
// scripts/termux-run.sh instead (PM2 is unreliable on native Termux and there
// is no systemd for `pm2 startup`).
//
//   npm install -g pm2
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup        # Ubuntu with systemd only; follow its printed command
//
// The app already supervises its own worker (index.js spawns --child and
// restarts it with backoff), so PM2's only job is to restart the whole thing
// if the supervisor itself ever exits. Exactly ONE instance must run: Baileys
// sessions, the credential files and the Telegram long-poll loop cannot be
// shared between processes.
// ---------------------------------------------------------------------------

module.exports = {
  apps: [
    {
      name: 'anime-md',
      script: 'index.js',
      cwd: __dirname,

      // One process, always. Never cluster, never scale.
      instances: 1,
      exec_mode: 'fork',

      // Restart policy: unlimited restarts with exponential backoff, so a
      // crash always recovers but a broken deploy cannot hot-loop.
      autorestart: true,
      min_uptime: '30s',
      exp_backoff_restart_delay: 5000,
      max_restarts: 50, // within PM2's window; counting resets after min_uptime

      // Safety valve: restart if the supervisor ever grows past this.
      // Normal usage is ~120MB per process (supervisor + worker).
      max_memory_restart: '512M',

      // Never watch files in production: session/data writes would otherwise
      // trigger endless restarts.
      watch: false,
      ignore_watch: ['node_modules', 'session', 'data', 'logs'],

      // Graceful stop: PM2 sends SIGINT first; index.js handles SIGINT/SIGTERM/
      // SIGHUP, closes sockets, then exits. 10s covers the 5s force-exit cap.
      kill_timeout: 10000,
      shutdown_with_message: false,

      time: true,
      merge_logs: true,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
