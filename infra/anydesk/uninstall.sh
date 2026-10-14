#!/usr/bin/env bash
# Remove the tank stock agent and AnyDesk from the Oracle server completely;
# tank stock moves to the Mac (infra/mac/README.md).
#
#   cd ~/Vriddhi-Fuels-Website && git pull && bash infra/anydesk/uninstall.sh
#
# The e-Mitra jobs (GitHub runner), the XtraPower monitor and the Vriddhi
# Fuels app stay as they are; the app's Tank stock tab says tank stock is
# moving to the Mac until infra/mac/use-mac-tank-stock.sh points it there.
# The virtual display (Xvfb, the XtraPower monitor's) and Tesseract (e-Mitra's)
# stay installed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DROP_DIR=/etc/systemd/system/xtrapower-manage.service.d
DROP="$DROP_DIR/tank-stock-on-mac.conf"
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as the ubuntu user, not root (the script uses sudo where needed)."
before="$(free -m | awk '/^Mem:/ {print $7}')"

say "1/5 Stopping the tank stock page and its console login session"
sudo systemctl disable -q --now tank-stock-session.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/tank-stock-session.service /etc/pam.d/tank-stock-session
sudo systemctl daemon-reload
sudo systemctl reset-failed tank-stock-session.service 2>/dev/null || true
# Its own Xvfb (:98) and AnyDesk windows, if a capture was running.
sudo pkill -u runner -f "Xvfb :98" 2>/dev/null || true
sudo pkill -u runner -x anydesk 2>/dev/null || true

say "2/5 Removing AnyDesk"
sudo systemctl disable -q --now anydesk.service 2>/dev/null || true
if dpkg -s anydesk >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get purge -y -q anydesk
fi
sudo rm -f /etc/apt/sources.list.d/anydesk-stable.list /usr/share/keyrings/anydesk.gpg
sudo rm -rf /etc/anydesk /root/.anydesk ~runner/.anydesk ~runner/.config/anydesk 2>/dev/null || true
# The tools only the tank stock captures used (screen clicks, screenshots).
for pkg in xdotool imagemagick; do
  dpkg -s "$pkg" >/dev/null 2>&1 && sudo DEBIAN_FRONTEND=noninteractive apt-get purge -y -q "$pkg" || true
done
sudo DEBIAN_FRONTEND=noninteractive apt-get autoremove -y -q
sudo apt-get update -q

say "3/5 Removing the tank stock code, its data and its saved logins"
# login.json (the AnyDesk numbers and password) and the copy of the bot token
# go with it; the Mac's VM is given its own (infra/mac/vm-setup.sh).
sudo rm -rf /opt/agents/tank-stock /opt/agents/tank-telegram.json /opt/agents/tank-stock-session.sh
echo "Removed /opt/agents/tank-stock and /opt/agents/tank-telegram.json."

say "4/5 Taking the tank stock page off Tailscale"
if command -v tailscale >/dev/null 2>&1; then
  sudo tailscale serve --https=8443 off >/dev/null 2>&1 || true
  sudo tailscale serve status 2>/dev/null | head -n 5 || true
fi

say "5/5 The Vriddhi Fuels app: its Tank stock tab says tank stock is moving to the Mac"
if systemctl list-unit-files xtrapower-manage.service >/dev/null 2>&1 && \
   systemctl is-enabled -q xtrapower-manage 2>/dev/null; then
  sudo install -d "$DROP_DIR"
  printf '[Service]\nEnvironment=XTRAPOWER_TANK_STOCK=off\n' | sudo tee "$DROP" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl restart xtrapower-manage
  echo "Done; infra/anydesk/setup.sh on this server now only updates the app's page."
else
  echo "The app isn't installed here; skipped."
fi

after="$(free -m | awk '/^Mem:/ {print $7}')"
cat <<MSG

Done. AnyDesk and the tank stock agent are gone from this server
(memory available: ${before} MB before, ${after} MB now).
Still here: the GitHub runner (e-Mitra), the XtraPower monitor and the app.

When the Mac's VM is set up (infra/mac/README.md), point the app at it:
  bash infra/mac/use-mac-tank-stock.sh https://mac-tank.<your-tailnet>.ts.net:8443
To put tank stock back on this server instead:
  bash infra/mac/use-mac-tank-stock.sh --back && bash infra/anydesk/setup.sh
MSG
