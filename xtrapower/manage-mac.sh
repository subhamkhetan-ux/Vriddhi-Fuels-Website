#!/usr/bin/env bash
# On/off switch for the XtraPower account manager: the web page for adding,
# editing and deleting accounts, switching watching on/off, and editing the
# Telegram settings. Runs in the background so your phone can reach it.
#
#   ./xtrapower/manage-mac.sh start    # start it (this Mac + your phone over Tailscale)
#   ./xtrapower/manage-mac.sh stop     # stop it
#   ./xtrapower/manage-mac.sh status   # ON/OFF and the addresses to open
#   ./xtrapower/manage-mac.sh open     # open the page in this Mac's browser
#
# The phone address only works with Tailscale installed and signed in to the
# same account on both the Mac and the phone, and needs the PIN you set on the
# Mac (Settings section of the page).
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

PIDFILE="xtrapower/manage.pid"
LOGFILE="xtrapower/manage.log"
PORT=8780
PY=".venv/bin/python"
[ -x "$PY" ] || PY="python3"     # standard library only; any Python 3 works

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

tailscale_ip() {
  local t
  for t in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale \
           /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do
    if command -v "$t" >/dev/null 2>&1 || [ -x "$t" ]; then
      "$t" ip -4 2>/dev/null | head -n 1 && return 0
    fi
  done
  return 0
}

addresses() {
  echo "  On this Mac:   http://127.0.0.1:$PORT/"
  local ip
  ip="$(tailscale_ip)"
  if [ -n "$ip" ]; then
    echo "  On your phone: http://$ip:$PORT/   (Tailscale on, PIN required)"
  else
    echo "  On your phone: install Tailscale on this Mac and your phone, sign in to"
    echo "                 the same account, then run: ./xtrapower/manage-mac.sh stop && ./xtrapower/manage-mac.sh start"
  fi
}

case "${1:-}" in
  start)
    if is_running; then
      echo "● Account manager is already running (PID $(cat "$PIDFILE"))."
      addresses
      exit 0
    fi
    nohup "$PY" -m xtrapower.manage --remote --no-browser --port "$PORT" >>"$LOGFILE" 2>&1 &
    echo "$!" >"$PIDFILE"
    sleep 2
    if is_running; then
      echo "✓ Account manager is ON (PID $(cat "$PIDFILE"))."
      addresses
    else
      echo "✗ It didn't start. Last log lines:"
      tail -n 15 "$LOGFILE" 2>/dev/null || true
      rm -f "$PIDFILE"
      exit 1
    fi
    ;;

  stop)
    if is_running; then
      kill "$(cat "$PIDFILE")" 2>/dev/null || true
      rm -f "$PIDFILE"
      echo "✓ Account manager is OFF."
    else
      echo "○ It wasn't running."
      rm -f "$PIDFILE"
    fi
    ;;

  status)
    if is_running; then
      echo "● Account manager is ON (PID $(cat "$PIDFILE"))."
      addresses
    else
      echo "○ Account manager is OFF. Start it with: ./xtrapower/manage-mac.sh start"
    fi
    ;;

  open)
    open "http://127.0.0.1:$PORT/"
    ;;

  *)
    echo "Usage: ./xtrapower/manage-mac.sh {start|stop|status|open}"
    exit 1
    ;;
esac
