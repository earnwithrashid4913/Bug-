#!/bin/sh
# ---------------------------------------------------------------------------
# ANIME MD — Termux / no-systemd supervisor loop.
#
# Keeps `node index.js` running with restart backoff on hosts that have
# neither systemd nor a reliable PM2 (native Termux, minimal containers).
# The app already restarts its own worker internally; this script only
# restarts the whole thing if the supervisor process itself ever exits.
#
# Usage (from the project root, or anywhere — it cds to the project root):
#   sh scripts/termux-run.sh
# Stop it with Ctrl+C (SIGINT) or `kill -TERM <pid>` — the signal is
# forwarded to the bot for a graceful shutdown and the loop exits instead
# of restarting.
#
# Termux tips (see DEPLOYMENT.md Guide B):
#   termux-wake-lock        # keep the CPU awake while the bot runs
#   Termux:Boot + exempt the app from battery optimization for reboot recovery.
# ---------------------------------------------------------------------------
set -u

cd "$(dirname "$0")/.." || exit 1

stop=0
child=""
trap 'stop=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null' INT TERM HUP

# Best-effort cleanup of a worker orphaned by a previous SIGKILLed supervisor
# (a SIGKILLed parent cannot clean up its children; the worker normally exits
# itself via the IPC 'disconnect' handler, this is the backstop for shells
# without pkill support it is simply skipped).
kill_stale_workers() {
  if command -v pkill >/dev/null 2>&1; then
    # Absolute project path so only THIS bot's workers can ever match.
    pkill -TERM -f "$(pwd)/index.js --child" 2>/dev/null
  fi
}

delay=5
while [ "$stop" -eq 0 ]; do
  kill_stale_workers
  node index.js & child=$!
  wait "$child"; code=$?; child=""
  if [ "$stop" -eq 1 ]; then
    echo "[termux-run] stopped by signal (last exit code $code); not restarting."
    exit 0
  fi
  echo "[termux-run] process exited (code $code); restarting in ${delay}s (Ctrl+C to stop)."
  sleep "$delay" || true
  if [ "$stop" -eq 1 ]; then
    echo "[termux-run] stopped while waiting; not restarting."
    exit 0
  fi
  if [ "$delay" -lt 300 ]; then
    delay=$((delay * 2))
    if [ "$delay" -gt 300 ]; then delay=300; fi
  fi
done
