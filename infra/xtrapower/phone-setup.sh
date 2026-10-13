#!/usr/bin/env bash
# Put the XtraPower account manager on your phone (see infra/xtrapower/README.md).
#
#   cd ~/Vriddhi-Fuels-Website && git pull && bash infra/xtrapower/phone-setup.sh
#
# Joins this server to your free Tailscale network and publishes the account
# manager page there, so only your own signed-in devices can open it. Nothing
# is opened to the internet. Run as the ubuntu user; re-running is safe.
set -euo pipefail

HOME_DIR=/opt/xtrapower
PORT=8780
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as the ubuntu user, not root (the script uses sudo where needed)."

say "1/5 Updating the monitor and page code"
bash "$HERE/setup.sh"

say "2/5 Installing Tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
else
  echo "Tailscale is already installed."
fi

ts_json() { sudo tailscale status --json 2>/dev/null || echo '{}'; }
ts_field() { ts_json | python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null || true; }

say "3/5 Connecting this server to your Tailscale network"
if [ "$(ts_field 'd.get("BackendState","")')" != "Running" ]; then
  echo "A login link appears below. Open it (on your phone is fine), sign in with the"
  echo "account you'll use in the Tailscale app, and approve this server."
  sudo tailscale up
fi
TS_NAME="$(ts_field 'd["Self"]["DNSName"].rstrip(".")')"
TS_LOGIN="$(ts_field 'd["User"][str(d["Self"]["UserID"])]["LoginName"]')"
[ -n "$TS_NAME" ] || die "Couldn't read this server's Tailscale name. Check: sudo tailscale status"
echo "This server is $TS_NAME (owner: ${TS_LOGIN:-unknown})."

say "4/5 Installing the account manager service"
tmp="$(mktemp)"
cp "$HERE/sudoers" "$tmp"
sudo visudo -cqf "$tmp" || { rm -f "$tmp"; die "The sudoers rule failed validation; nothing was changed."; }
sudo install -m 440 -o root -g root "$tmp" /etc/sudoers.d/xtrapower-manage
rm -f "$tmp"
printf 'XTRAPOWER_MANAGE_HOSTS=%s\nXTRAPOWER_MANAGE_USERS=%s\n' "$TS_NAME" "$TS_LOGIN" \
  | sudo install -m 640 -o root -g xtrapower /dev/stdin "$HOME_DIR/manage.env"
sudo install -m 644 "$HOME_DIR/app/infra/xtrapower/xtrapower-manage.service" \
  /etc/systemd/system/xtrapower-manage.service
sudo systemctl daemon-reload
sudo systemctl enable -q xtrapower-manage
sudo systemctl restart xtrapower-manage
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/state" || true)"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || die "The page didn't start. See: journalctl -u xtrapower-manage -n 30"
echo "The page is running."

say "5/5 Publishing the page to your Tailscale devices (not the internet)"
echo "If Tailscale prints a link to enable HTTPS / Serve, open it, click Enable, and wait."
sudo tailscale serve --bg "http://127.0.0.1:$PORT"

cat <<EOF

Done. On your phone:
  1. Install the Tailscale app and sign in as ${TS_LOGIN:-the same account}.
  2. Open  https://$TS_NAME/
  3. Add it to your home screen (iPhone: Share > Add to Home Screen;
     Android: menu > Install app / Add to Home screen).

Recommended: in the Tailscale admin console (login.tailscale.com > Machines),
open this server's ... menu and choose "Disable key expiry", so it doesn't
drop off your network in 6 months.
EOF
