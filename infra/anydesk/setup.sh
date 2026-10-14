#!/usr/bin/env bash
# Install (or update) the tank stock monitor on the India server: the AnyDesk
# client, a console login session it runs in, the monitor and its phone page
# (tank_stock/), published to your own Tailscale devices. It opens the IOCL
# automation PC with its unattended-access password and reads the tank stock
# screen. Nothing is installed on the IOCL PC. Re-running it is safe, and is
# how the monitor is updated after a change in the repo.
#
#   cd ~/Vriddhi-Fuels-Website && git pull && bash infra/anydesk/setup.sh
#
# This server's own AnyDesk gets no unattended password, so no one can
# connect *into* the server through it (there is no one to accept a request).
set -euo pipefail

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as the ubuntu user, not root (the script uses sudo where needed)."

say "1/7 Adding AnyDesk's official package source"
curl -fsSL https://keys.anydesk.com/repos/DEB-GPG-KEY | sudo gpg --dearmor --yes -o /usr/share/keyrings/anydesk.gpg
echo "deb [signed-by=/usr/share/keyrings/anydesk.gpg] https://deb.anydesk.com all main" \
  | sudo tee /etc/apt/sources.list.d/anydesk-stable.list >/dev/null
sudo apt-get update -q

say "2/7 Installing AnyDesk, the virtual display and screenshot tools"
# AnyDesk's post-install script ends by adding a desktop menu entry with
# xdg-desktop-menu; without it (a bare server) the script exits 1 and dpkg
# marks AnyDesk broken, although the service runs. Install those tools first.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q xdg-utils desktop-file-utils
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q anydesk xvfb xdotool imagemagick kbd \
  || { sudo dpkg --configure -a || true
       die "AnyDesk did not install cleanly on this $(uname -m) server. Send the lines above."; }

say "3/7 Installing the tank stock page's code"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
APP=/opt/agents/tank-stock/app
PORT=8790
id runner >/dev/null 2>&1 || die "No 'runner' user; run infra/india-runner/setup.sh first."
sudo install -d -o runner -g runner -m 750 /opt/agents/tank-stock
url="$(git -C "$repo" remote get-url origin)"
if sudo test -d "$APP/.git"; then
  sudo -u runner git -C "$APP" fetch -q origin main
  sudo -u runner git -C "$APP" reset -q --hard origin/main
else
  sudo -u runner git clone -q "$url" "$APP"
fi
echo "Code: $(sudo -u runner git -C "$APP" log -1 --format='%h %s')"

say "4/7 Starting the page in a console login session (AnyDesk won't start without one)"
sudo install -m 644 "$here/tank-stock-session.pam" /etc/pam.d/tank-stock-session
sudo install -m 644 "$here/tank-stock-session.service" /etc/systemd/system/tank-stock-session.service
sudo rm -f /opt/agents/tank-stock-session.sh          # replaced by tank_stock.service
TS_NAME="" TS_LOGIN=""
if command -v tailscale >/dev/null 2>&1; then
  ts() { sudo tailscale status --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null || true; }
  TS_NAME="$(ts 'd["Self"]["DNSName"].rstrip(".")')"
  TS_LOGIN="$(ts 'd["User"][str(d["Self"]["UserID"])]["LoginName"]')"
fi
printf 'TANK_STOCK_HOSTS=%s\nTANK_STOCK_USERS=%s\n' "$TS_NAME" "$TS_LOGIN" \
  | sudo install -m 644 /dev/stdin /opt/agents/tank-stock/page.env
sudo systemctl daemon-reload
sudo systemctl enable -q tank-stock-session.service
sudo systemctl restart tank-stock-session.service
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/state" || true)"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || die "The page didn't start. Send: journalctl -u tank-stock-session -n 40"

say "5/7 Publishing the phone page to your Tailscale devices (not the internet)"
if [ -n "$TS_NAME" ]; then
  sudo tailscale serve --bg --https=8443 "http://127.0.0.1:$PORT" >/dev/null
  PAGE="https://$TS_NAME:8443/"
  echo "Published: $PAGE (only for ${TS_LOGIN:-your Tailscale account})"
else
  PAGE=""
  echo "Tailscale isn't set up on this server: run infra/xtrapower/phone-setup.sh first, then this again."
fi

say "6/7 Updating the Vriddhi Fuels app (the XtraPower page, whose Tank stock tab is this page)"
# The XtraPower page runs from its own copy (/opt/xtrapower/app, user
# xtrapower). Update that copy too and restart the page only: the monitor and
# its logged-in Chrome windows carry on (they pick the code up on their next
# restart, e.g. infra/xtrapower/setup.sh).
APP_URL=""
if sudo test -d /opt/xtrapower/app/.git && systemctl is-enabled -q xtrapower-manage 2>/dev/null; then
  sudo -H -u xtrapower git -C /opt/xtrapower/app fetch -q origin main
  sudo -H -u xtrapower git -C /opt/xtrapower/app checkout -q -B main FETCH_HEAD
  echo "Code: $(sudo -H -u xtrapower git -C /opt/xtrapower/app log -1 --format='%h %s')"
  sudo systemctl restart xtrapower-manage
  for _ in $(seq 1 20); do
    title="$(curl -s http://127.0.0.1:8780/ | grep -o '<title>[^<]*' | sed 's/<title>//' || true)"
    [ -n "$title" ] && break
    sleep 1
  done
  echo "The app's page answers: ${title:-nothing yet (see journalctl -u xtrapower-manage -n 30)}"
  [ -n "$TS_NAME" ] && APP_URL="https://$TS_NAME/"
else
  echo "The XtraPower page isn't installed here (infra/xtrapower/phone-setup.sh); skipped."
fi

say "7/7 Checking"
bash "$repo/infra/india-runner/night-updates.sh" || echo "(couldn't move the automatic updates to the night)"
anydesk --version || true
systemctl is-active --quiet anydesk && echo "AnyDesk service is running." || echo "Note: the AnyDesk service is not running."
sid=$(loginctl list-sessions --no-legend | awk '$3 == "runner" {print $1; exit}')
if [ -n "$sid" ]; then
  echo "The runner user has a login session:"
  loginctl show-session "$sid" -p Seat -p VTNr -p Type -p Active -p State
  echo "Seat's active session: $(loginctl show-seat seat0 -p ActiveSession --value 2>/dev/null) (should be $sid)"
else
  echo "Note: no login session for runner yet. Send: systemctl status tank-stock-session"
fi
login=$(curl -s "http://127.0.0.1:$PORT/api/state" | python3 -c "import json,sys; print(json.load(sys.stdin)['login_saved'])" 2>/dev/null || true)
echo "The page is running (nothing connects until you ask). AnyDesk login saved for it: ${login:-unknown}."
echo
if [ "$login" != "True" ]; then
  echo "Next: in GitHub, Actions > 'Tank stock (AnyDesk -> decant)' > Run workflow,"
  echo "mode save-login (it copies ANYDESK_IDS and ANYDESK_PASSWORD to the page)."
fi
if [ -n "$APP_URL" ]; then
  echo "On your phone (with Tailscale on), open $APP_URL (the Vriddhi Fuels app: XtraPower and"
  echo "Tank stock tabs) and add it to the home screen. $PAGE still opens the tank stock page alone."
elif [ -n "$PAGE" ]; then
  echo "On your phone (with Tailscale on), open $PAGE and add it to the home screen."
fi
