#!/usr/bin/env bash
# Started by xtrapower.service (see infra/xtrapower/README.md); not run by hand.
#
# Server equivalent of the Mac's launch-mac.sh + monitor-mac.sh: a virtual
# display (Xvfb) stands in for the Mac screen, one real (headed) Chromium window
# per account runs on it, and the unchanged xtrapower.monitor attaches to them
# over CDP and logs each account in with its saved username/password.
#
# If the monitor exits, this script exits and systemd restarts everything.
# A Chromium window that dies is relaunched within a minute.
set -euo pipefail

HOME_DIR="${XTRAPOWER_HOME:-/opt/xtrapower}"
APP="$HOME_DIR/app"
PY="$HOME_DIR/venv/bin/python"
CONFIG="$HOME_DIR/config.json"
cd "$APP"

# Xvfb and Chromium chatter (keymaps, D-Bus, GPU) goes to a file so the
# journal shows the monitor. Reset on each service start.
CHROME_LOG="$HOME_DIR/chromium.log"
: >"$CHROME_LOG"

export DISPLAY=:99
if [ ! -S /tmp/.X11-unix/X99 ]; then
  Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp >>"$CHROME_LOG" 2>&1 &
  for _ in $(seq 1 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.2; done
fi

# Playwright's own Chromium (Google Chrome has no Linux ARM build).
if [ -z "${XTRAPOWER_CHROME:-}" ]; then
  XTRAPOWER_CHROME="$("$PY" - <<'EOF'
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    print(p.chromium.executable_path)
EOF
)"
fi
export XTRAPOWER_CHROME
# Ubuntu 24.04 blocks Chromium's user-namespace sandbox for unconfined binaries;
# Playwright launches its Chromium the same way. basic = no keyring prompt.
export XTRAPOWER_CHROME_FLAGS="--no-sandbox --password-store=basic --disable-dev-shm-usage"

# "customer_id port" for every watched account in config.json.
watched() {
  "$PY" - "$CONFIG" <<'EOF'
import sys
from xtrapower.configfile import load
for a in load(sys.argv[1]).get("accounts", []):
    if a.get("watch", True):
        print(a.get("customer_id"), int(a["cdp_port"]))
EOF
}

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

launch() {
  "$PY" -m xtrapower.launch --config "$CONFIG" "$@" >>"$CHROME_LOG" 2>&1 || {
    echo "Launching Chromium failed; end of $CHROME_LOG:"; tail -n 5 "$CHROME_LOG"; return 1; }
}

launch
"$PY" -m xtrapower.monitor --config "$CONFIG" --announce &
MONITOR=$!
trap 'kill $(jobs -p) 2>/dev/null || true' EXIT

while kill -0 "$MONITOR" 2>/dev/null; do
  sleep 60
  # config.json may be edited while running (new accounts, ports, watch flags).
  watched | while read -r cid port; do
    if ! port_open "$port"; then
      echo "Chromium for $cid (port $port) is not running; relaunching it."
      launch --only "$cid" || true
    fi
  done || echo "config.json could not be read; skipping the window check."
done
wait "$MONITOR"
