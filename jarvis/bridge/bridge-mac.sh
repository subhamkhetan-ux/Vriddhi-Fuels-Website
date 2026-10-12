#!/usr/bin/env bash
# On/off switch for the Jarvis bridge on the Mac (like xtrapower/monitor-mac.sh).
#
#   ./jarvis/bridge/bridge-mac.sh setup          # once: makes config.json (then fill in the login)
#   ./jarvis/bridge/bridge-mac.sh test           # one check-in — shows whether the login works
#   ./jarvis/bridge/bridge-mac.sh start          # run in the background (survives closing Terminal)
#   ./jarvis/bridge/bridge-mac.sh stop
#   ./jarvis/bridge/bridge-mac.sh status
#   ./jarvis/bridge/bridge-mac.sh logs           # watch it live (Ctrl-C leaves the viewer)
#   ./jarvis/bridge/bridge-mac.sh autostart on   # start at every login, restart if it stops
#   ./jarvis/bridge/bridge-mac.sh autostart off
#
# Standard library only — no virtual environment needed (macOS's python3).
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

PIDFILE="jarvis/bridge/bridge.pid"
LOGFILE="jarvis/bridge/bridge.log"
CONFIG="jarvis/bridge/config.json"
LABEL="com.vriddhi.jarvisbridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PY="$(command -v python3 || true)"

need_python() {
  if [ -z "$PY" ]; then
    echo "✗ Python 3 isn't installed. Run: xcode-select --install — then try again."
    exit 1
  fi
}
need_config() {
  if [ ! -f "$CONFIG" ]; then
    echo "✗ No $CONFIG yet — run: ./jarvis/bridge/bridge-mac.sh setup"
    exit 1
  fi
}
is_running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
autostarted() { [ -f "$PLIST" ]; }

case "${1:-}" in
  setup)
    need_python
    if [ -f "$CONFIG" ]; then
      echo "✓ $CONFIG already exists — leaving it as is."
    else
      cp jarvis/bridge/config.example.json "$CONFIG"
      chmod 600 "$CONFIG"
      echo "✓ Created $CONFIG"
    fi
    echo "  Put the bridge's login (a Jarvis member's email + password) in it:"
    echo "    open -e $CONFIG"
    echo "  Then: ./jarvis/bridge/bridge-mac.sh test"
    ;;

  test)
    need_python; need_config
    "$PY" -m jarvis.bridge.bridge --once
    ;;

  start)
    need_python; need_config
    if autostarted; then
      launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || launchctl load "$PLIST"
      echo "✓ The bridge is ON (started at login by macOS)."
      exit 0
    fi
    if is_running; then echo "● Already running (PID $(cat "$PIDFILE"))."; exit 0; fi
    nohup "$PY" -m jarvis.bridge.bridge >>"$LOGFILE" 2>&1 &
    echo $! >"$PIDFILE"
    sleep 2
    if is_running; then
      echo "✓ The Jarvis bridge is ON (PID $(cat "$PIDFILE")). Jarvis can now reach this Mac."
    else
      echo "✗ It didn't stay up. Last log lines:"; tail -n 15 "$LOGFILE" 2>/dev/null || true
      rm -f "$PIDFILE"; exit 1
    fi
    ;;

  stop)
    if autostarted; then
      launchctl unload "$PLIST" 2>/dev/null || true
      echo "✓ Stopped (it starts again at the next login — 'autostart off' to stop that)."
    fi
    if is_running; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; echo "✓ The Jarvis bridge is OFF."
    elif ! autostarted; then echo "○ It wasn't running."; fi
    rm -f "$PIDFILE"
    ;;

  status)
    if is_running; then echo "● The bridge is ON (PID $(cat "$PIDFILE"))."
    elif autostarted && launchctl list "$LABEL" >/dev/null 2>&1; then echo "● The bridge is ON (autostart)."
    else echo "○ The bridge is OFF."; fi
    echo "─ recent activity ─────────────────────────────"
    tail -n 8 "$LOGFILE" 2>/dev/null || echo "(no log yet)"
    ;;

  logs)
    tail -n 40 -f "$LOGFILE"
    ;;

  autostart)
    case "${2:-}" in
      on)
        need_python; need_config
        if is_running; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; fi
        mkdir -p "$HOME/Library/LaunchAgents"
        cat >"$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>-m</string><string>jarvis.bridge.bridge</string></array>
  <key>WorkingDirectory</key><string>$(pwd)</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(pwd)/$LOGFILE</string>
  <key>StandardErrorPath</key><string>$(pwd)/$LOGFILE</string>
</dict></plist>
PL
        launchctl unload "$PLIST" 2>/dev/null || true
        launchctl load "$PLIST"
        echo "✓ The bridge now starts at every login (and restarts if it stops)."
        ;;
      off)
        if autostarted; then launchctl unload "$PLIST" 2>/dev/null || true; rm -f "$PLIST"; fi
        echo "✓ Autostart is off. (Start it by hand with: ./jarvis/bridge/bridge-mac.sh start)"
        ;;
      *) echo "Usage: ./jarvis/bridge/bridge-mac.sh autostart {on|off}"; exit 1 ;;
    esac
    ;;

  *)
    echo "Usage: ./jarvis/bridge/bridge-mac.sh {setup|test|start|stop|status|logs|autostart on|off}"
    exit 1
    ;;
esac
