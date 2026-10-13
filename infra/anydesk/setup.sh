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

say "1/3 Adding AnyDesk's official package source"
curl -fsSL https://keys.anydesk.com/repos/DEB-GPG-KEY | sudo gpg --dearmor --yes -o /usr/share/keyrings/anydesk.gpg
echo "deb [signed-by=/usr/share/keyrings/anydesk.gpg] https://deb.anydesk.com all main" \
  | sudo tee /etc/apt/sources.list.d/anydesk-stable.list >/dev/null
sudo apt-get update -q

say "2/3 Installing AnyDesk, the virtual display and screenshot tools"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q anydesk xvfb xdotool imagemagick \
  || die "AnyDesk could not be installed on this server ($(uname -m)). AnyDesk's Linux packages cover x86-64; on an ARM server check deb.anydesk.com."

say "3/3 Checking"
anydesk --version || true
systemctl is-active --quiet anydesk && echo "AnyDesk service is running." || echo "Note: the AnyDesk service is not running."
echo
echo "Done. Next, in GitHub add the secrets ANYDESK_ID and ANYDESK_PASSWORD"
echo "(the IOCL PC's AnyDesk number and unattended-access password), then run"
echo "the 'Tank stock (AnyDesk -> decant)' workflow."
