#!/usr/bin/env bash
# One-time: install the AnyDesk client on the India server so the tank-stock
# job (tank_stock/, .github/workflows/tank-stock.yml) can open the IOCL
# automation PC with its unattended-access password and take a screenshot.
# Nothing is installed on the IOCL PC.
#
#   cd ~/Vriddhi-Fuels-Website && git pull && bash infra/anydesk/setup.sh
#
# This server's own AnyDesk gets no unattended password, so no one can
# connect *into* the server through it (there is no one to accept a request).
set -euo pipefail

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as the ubuntu user, not root (the script uses sudo where needed)."

say "1/4 Adding AnyDesk's official package source"
curl -fsSL https://keys.anydesk.com/repos/DEB-GPG-KEY | sudo gpg --dearmor --yes -o /usr/share/keyrings/anydesk.gpg
echo "deb [signed-by=/usr/share/keyrings/anydesk.gpg] https://deb.anydesk.com all main" \
  | sudo tee /etc/apt/sources.list.d/anydesk-stable.list >/dev/null
sudo apt-get update -q

say "2/4 Installing AnyDesk, the virtual display and screenshot tools"
# AnyDesk's post-install script ends by adding a desktop menu entry with
# xdg-desktop-menu; without it (a bare server) the script exits 1 and dpkg
# marks AnyDesk broken, although the service runs. Install those tools first.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q xdg-utils desktop-file-utils
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q anydesk xvfb xdotool imagemagick \
  || { sudo dpkg --configure -a || true
       die "AnyDesk did not install cleanly on this $(uname -m) server. Send the lines above."; }

say "3/4 Giving the runner user a login session (AnyDesk won't start without one)"
here="$(cd "$(dirname "$0")" && pwd)"
id runner >/dev/null 2>&1 || die "No 'runner' user; run infra/india-runner/setup.sh first."
sudo install -m 644 "$here/tank-stock-session.pam" /etc/pam.d/tank-stock-session
sudo install -m 644 "$here/tank-stock-session.service" /etc/systemd/system/tank-stock-session.service
sudo systemctl daemon-reload
sudo systemctl enable --now tank-stock-session.service
sudo systemctl restart tank-stock-session.service

say "4/4 Checking"
anydesk --version || true
systemctl is-active --quiet anydesk && echo "AnyDesk service is running." || echo "Note: the AnyDesk service is not running."
sleep 2
if loginctl list-sessions --no-legend | grep -qw runner; then
  echo "The runner user has a login session."
else
  echo "Note: no login session for runner yet. Send: systemctl status tank-stock-session"
fi
echo
echo "Done. Next, run: bash infra/anydesk/use-xtrapower-bot.sh"
echo "(reports go to the XtraPower bot). Then in GitHub add the secrets ANYDESK_IDS (both of the IOCL PC's"
echo "AnyDesk numbers, comma separated) and ANYDESK_PASSWORD (its unattended-access"
echo "password), then run the 'Tank stock (AnyDesk -> decant)' workflow."
