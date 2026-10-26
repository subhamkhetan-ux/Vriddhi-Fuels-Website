#!/usr/bin/env bash
# Tank stock from FuelTrans through the IOCL PC's tunnel, on this Oracle
# server, instead of AnyDesk (see infra/fueltrans/README.md). Run as the ubuntu
# user, after server-setup.sh (the tunnel) works:
#
#   cd ~/Vriddhi-Fuels-Website && git pull && bash infra/fueltrans/tank-stock-setup.sh
#
# - Installs or updates the tank stock monitor and phone page (tank_stock/)
#   as a plain service, `tank-stock`: a headless browser logs in to FuelTrans
#   at http://127.0.0.1:13000 and reads Tank Status. No AnyDesk, no console
#   login session.
# - Asks once for the FuelTrans login (user Dealer by default) and keeps it
#   owner-only in /opt/agents/tank-stock/login.json. ASK_AGAIN=1 asks again.
# - Publishes the page at https://<this server>:8443/ to your Tailscale
#   devices, and points the Vriddhi Fuels app's Tank stock tab back here (from
#   the Mac).
#
# Re-running is safe, and is how the monitor is updated after a change.
set -euo pipefail

TUNNEL=http://127.0.0.1:13000
HOME_DIR=/opt/agents/tank-stock
APP="$HOME_DIR/app"
VENV=/opt/agents/venv
PORT=8790
MAC_DROP=/etc/systemd/system/xtrapower-manage.service.d/tank-stock-on-mac.conf

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as the ubuntu user, not root (the script uses sudo where needed)."
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

say "1/7 Checking the tunnel and this server's Python"
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$TUNNEL/assets/data/config.json" || true)"
[ "$code" = "200" ] || die "FuelTrans doesn't answer through the tunnel (HTTP ${code:-none}).
Set up and check the tunnel first: bash infra/fueltrans/server-setup.sh"
echo "FuelTrans answers through the tunnel."
if ! id runner >/dev/null 2>&1 || ! sudo test -x "$VENV/bin/python"; then
  die "No runner user or $VENV yet: run infra/india-runner/setup.sh first (see its README)."
fi
sudo -u runner -H "$VENV/bin/python" -c "import playwright" 2>/dev/null \
  || sudo -u runner -H "$VENV/bin/python" -m pip install -q playwright
sudo "$VENV/bin/python" -m playwright install-deps chromium >/dev/null
sudo -u runner -H "$VENV/bin/python" -m playwright install chromium
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q tesseract-ocr imagemagick >/dev/null
echo "Python, Chromium, Tesseract and ImageMagick are ready."

say "2/7 The tank stock code"
sudo install -d -o runner -g runner -m 750 "$HOME_DIR"
url="$(git -C "$repo" remote get-url origin)"
if sudo test -d "$APP/.git"; then
  sudo -u runner git -C "$APP" fetch -q origin main
  sudo -u runner git -C "$APP" reset -q --hard origin/main
else
  sudo -u runner git clone -q "$url" "$APP"
fi
echo "Code: $(sudo -u runner git -C "$APP" log -1 --format='%h %s')"

say "3/7 The FuelTrans login"
have="$(sudo python3 -c "import json; d=json.load(open('$HOME_DIR/login.json')); print(d.get('source') == 'fueltrans' and bool(d.get('password')))" 2>/dev/null || echo False)"
if [ "$have" = "True" ] && [ -z "${ASK_AGAIN:-}" ]; then
  echo "Already saved (ASK_AGAIN=1 to change it)."
else
  read -rp "FuelTrans user [Dealer]: " ft_user
  read -rsp "FuelTrans password for ${ft_user:-Dealer} (hidden): " ft_pass; echo
  [ -n "$ft_pass" ] || die "No password given; nothing saved."
  FT_USER="${ft_user:-Dealer}" FT_PASS="$ft_pass" FT_URL="$TUNNEL" python3 -c '
import json, os
print(json.dumps({"source": "fueltrans", "url": os.environ["FT_URL"],
                  "user": os.environ["FT_USER"], "password": os.environ["FT_PASS"]}))' \
    | sudo install -m 600 -o runner -g runner /dev/stdin "$HOME_DIR/login.json"
  unset ft_pass
  echo "Saved (owner-only)."
fi

say "4/7 The tank-stock service (replacing the AnyDesk one)"
TS_NAME="" TS_LOGIN=""
if command -v tailscale >/dev/null 2>&1; then
  ts() { sudo tailscale status --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null || true; }
  TS_NAME="$(ts 'd["Self"]["DNSName"].rstrip(".")')"
  TS_LOGIN="$(ts 'd["User"][str(d["Self"]["UserID"])]["LoginName"]')"
fi
printf 'TANK_STOCK_HOSTS=%s\nTANK_STOCK_USERS=%s\n' "$TS_NAME" "$TS_LOGIN" \
  | sudo install -m 644 /dev/stdin "$HOME_DIR/page.env"
sudo systemctl disable -q --now tank-stock-session 2>/dev/null || true
sudo systemctl disable -q --now anydesk 2>/dev/null || true
sudo install -m 644 "$here/tank-stock.service" /etc/systemd/system/tank-stock.service
sudo systemctl daemon-reload
sudo systemctl enable -q tank-stock
sudo systemctl restart tank-stock
code=""
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/state" || true)"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || die "The page didn't start. Send: journalctl -u tank-stock -n 40"
echo "The page is running."

say "5/7 Telegram reports (the XtraPower bot)"
if sudo test -s /opt/agents/tank-telegram.json; then
  echo "Already set."
elif sudo test -f /opt/xtrapower/config.json; then
  bash "$repo/infra/anydesk/use-xtrapower-bot.sh" || echo "(no Telegram for now; the rest works)"
else
  echo "No XtraPower config here: tank stock works without Telegram reports."
fi

say "6/7 Publishing the page to your Tailscale devices, and the app's Tank stock tab"
PAGE=""
if [ -n "$TS_NAME" ]; then
  sudo tailscale serve --bg --https=8443 "http://127.0.0.1:$PORT" >/dev/null
  PAGE="https://$TS_NAME:8443/"
  echo "Published: $PAGE"
else
  echo "Tailscale isn't set up here: run infra/xtrapower/phone-setup.sh, then this again."
fi
if sudo test -f "$MAC_DROP"; then
  sudo rm -f "$MAC_DROP"
  sudo systemctl daemon-reload
  sudo systemctl restart xtrapower-manage 2>/dev/null || true
  echo "The Vriddhi Fuels app's Tank stock tab is this server again (it was the Mac)."
  MAC=1
fi

say "7/7 Reading the tanks once (a browser logs in to FuelTrans, as the service will)"
(cd /tmp && sudo -u runner -H env TANK_STOCK_HOME="$HOME_DIR" PYTHONPATH="$APP" "$VENV/bin/python" -m tank_stock.fueltrans) \
  || echo "The test read failed: send me the lines above (and: journalctl -u tank-stock -n 40)."

echo
[ -n "$PAGE" ] && echo "Tank stock page: $PAGE (also the Vriddhi Fuels app's Tank stock tab)."
if [ -n "${MAC:-}" ]; then
  cat <<'EOF'

IMPORTANT: stop the Mac's tank stock, or both will answer the decant app's
requests. In the Mac's Terminal:  ssh vf@<VM's IP>, then
  sudo systemctl disable --now tank-stock-session
(or simply shut the Tank stock VM down in Parallels).
EOF
fi
