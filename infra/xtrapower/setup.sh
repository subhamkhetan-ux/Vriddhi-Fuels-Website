#!/usr/bin/env bash
# One-time setup of the XtraPower CCMS monitor on the India server (the same
# Oracle Cloud machine as the GitHub runner; see infra/xtrapower/README.md).
#
#   cd ~/Vriddhi-Fuels-Website && bash infra/xtrapower/setup.sh
#
# Run as the default `ubuntu` user (needs sudo). The monitor runs as its own
# `xtrapower` user, so GitHub Actions jobs cannot read its passwords or drive
# its logged-in browsers. Re-running the script is safe and updates the code.
set -euo pipefail

HOME_DIR=/opt/xtrapower
SVC_USER=xtrapower
PORTAL="https://beta.iocxtrapower.com/"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
REPO_URL="$(git -C "$ROOT" remote get-url origin)"
REF="${XTRAPOWER_REF:-$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)}"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as the ubuntu user, not root (the script uses sudo where needed)."

say "1/6 Checking that this server can reach XtraPower"
body="$(mktemp)"
code="$(curl -sS -m 30 -L -o "$body" -w '%{http_code}' "$PORTAL" || true)"
if [ -z "$code" ] || [ "$code" = "000" ]; then
  rm -f "$body"; die "XtraPower did not answer from this server (no connection). Nothing was installed."
fi
if grep -qi "requested url was rejected" "$body" && grep -qi "support id" "$body"; then
  rm -f "$body"; die "XtraPower's firewall rejected this server (\"The requested URL was rejected\"). Nothing was installed."
fi
rm -f "$body"
echo "XtraPower answered with HTTP $code and no firewall rejection. Good."

say "2/6 Installing the virtual display (Xvfb)"
sudo apt-get update -q
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
  ca-certificates curl git python3 python3-venv xvfb iptables nano

say "3/6 Creating the '$SVC_USER' user and $HOME_DIR"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  sudo useradd --system --home-dir "$HOME_DIR" --shell /usr/sbin/nologin "$SVC_USER"
fi
sudo install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" "$HOME_DIR"

say "4/6 Fetching the monitor code ($REF)"
if [ -d "$HOME_DIR/app/.git" ]; then
  sudo -H -u "$SVC_USER" git -C "$HOME_DIR/app" fetch -q origin "$REF"
  sudo -H -u "$SVC_USER" git -C "$HOME_DIR/app" checkout -q -B "$REF" FETCH_HEAD
else
  sudo -H -u "$SVC_USER" git clone -q --branch "$REF" "$REPO_URL" "$HOME_DIR/app"
fi

say "5/6 Python environment and Chromium"
sudo -H -u "$SVC_USER" python3 -m venv "$HOME_DIR/venv"
sudo -H -u "$SVC_USER" "$HOME_DIR/venv/bin/python" -m pip install -q --upgrade pip
sudo -H -u "$SVC_USER" "$HOME_DIR/venv/bin/python" -m pip install -q -r "$HOME_DIR/app/xtrapower/requirements.txt"
sudo "$HOME_DIR/venv/bin/python" -m playwright install-deps chromium
sudo -H -u "$SVC_USER" "$HOME_DIR/venv/bin/python" -m playwright install chromium

say "6/6 Installing the xtrapower service"
if ! sudo test -f "$HOME_DIR/config.json"; then
  sudo install -m 600 -o "$SVC_USER" -g "$SVC_USER" \
    "$HOME_DIR/app/xtrapower/config.example.json" "$HOME_DIR/config.json"
  echo "Created $HOME_DIR/config.json from the example."
fi
sudo install -m 644 "$HOME_DIR/app/infra/xtrapower/xtrapower.service" /etc/systemd/system/xtrapower.service
sudo systemctl daemon-reload
sudo systemctl enable -q xtrapower

if sudo grep -q "PUT-YOUR" "$HOME_DIR/config.json"; then
  echo
  echo "Done, but the monitor is NOT started yet: config.json still has placeholders."
  echo "1. Stop the monitor on the Mac first:   ./xtrapower/monitor-mac.sh stop"
  echo "2. Paste your Mac's config.json here:  sudo -u $SVC_USER nano $HOME_DIR/config.json"
  echo "   (every account needs its username and password; Ctrl+O, Enter, Ctrl+X to save)"
  echo "3. Start it:                            sudo systemctl start xtrapower"
else
  sudo systemctl restart xtrapower
  echo
  echo "Done. The monitor is running; you should get a Telegram message shortly."
fi
mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
if [ "$mem_kb" -lt 3000000 ]; then
  echo
  echo "NOTE: this server has under 3 GB of memory. Each account runs its own Chromium"
  echo "window, so start with one watched account and move to an A1 server for more."
fi
echo "Logs: journalctl -u xtrapower -f        Status: systemctl status xtrapower"
