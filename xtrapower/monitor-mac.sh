#!/usr/bin/env bash
# Simple on/off switch for the XtraPower monitor on macOS.
#
#   ./xtrapower/monitor-mac.sh start    # turn monitoring ON (runs in the background)
#   ./xtrapower/monitor-mac.sh stop     # turn monitoring OFF
#   ./xtrapower/monitor-mac.sh status   # is it running? show recent activity
#   ./xtrapower/monitor-mac.sh logs     # watch the live log (Ctrl-C leaves the viewer; monitor keeps running)
#
# Unlike run-mac.sh (which runs in your Terminal and stops on Ctrl-C or when you
# close the window), 'start' keeps running in the background even after you close
# Terminal, and keeps the Mac awake while it runs. Only 'stop' turns it off.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

PIDFILE="xtrapower/monitor.pid"
LOGFILE="xtrapower/monitor.log"

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

case "${1:-}" in
  start)
    if is_running; then
      echo "● Already running (PID $(cat "$PIDFILE")). Nothing to do."
      exit 0
    fi
    if [ ! -d .venv ]; then
      echo "✗ No .venv found — run ./xtrapower/setup-mac.sh first."
      exit 1
    fi
    # Run the monitor in the background (nohup = survives closing Terminal).
    nohup .venv/bin/python -m xtrapower.monitor \
        --config xtrapower/config.json --announce >>"$LOGFILE" 2>&1 &
    PY=$!
    echo "$PY" >"$PIDFILE"
    # Keep the Mac awake (no idle sleep) for as long as the monitor runs.
    nohup caffeinate -i -w "$PY" >/dev/null 2>&1 &
    sleep 1
    if is_running; then
      echo "✓ Monitoring is ON (PID $PY)."
      echo "  It checks every 2 minutes and pings Telegram on any credit."
      echo "  Turn it off with:  ./xtrapower/monitor-mac.sh stop"
      echo "  See activity with: ./xtrapower/monitor-mac.sh status"
    else
      echo "✗ It didn't stay up. Last log lines:"
      tail -n 15 "$LOGFILE" 2>/dev/null || true
      rm -f "$PIDFILE"
      exit 1
    fi
    ;;

  stop)
    if is_running; then
      kill "$(cat "$PIDFILE")" 2>/dev/null || true
      rm -f "$PIDFILE"
      echo "✓ Monitoring is OFF. No more checks or alerts until you start it again."
    else
      echo "○ It wasn't running."
      rm -f "$PIDFILE"
    fi
    ;;

  status)
    if is_running; then
      echo "● Monitoring is ON (PID $(cat "$PIDFILE"))."
      echo "─ recent activity ─────────────────────────────"
      tail -n 8 "$LOGFILE" 2>/dev/null || echo "(no log yet)"
    else
      echo "○ Monitoring is OFF."
    fi
    ;;

  logs)
    echo "(showing live log — press Ctrl-C to leave this view; the monitor keeps running)"
    tail -n 40 -f "$LOGFILE"
    ;;

  *)
    echo "Usage: ./xtrapower/monitor-mac.sh {start|stop|status|logs}"
    exit 1
    ;;
esac
