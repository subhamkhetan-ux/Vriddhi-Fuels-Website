#!/usr/bin/env bash
# On the Oracle server: let the Mac's VM do the tank stock work (infra/mac/README.md).
#
#   bash infra/mac/use-mac-tank-stock.sh https://mac-tank.<tailnet>.ts.net:8443
#   bash infra/mac/use-mac-tank-stock.sh --back        # the Oracle server again
#
# The Vriddhi Fuels app keeps its address; its Tank stock tab shows the Mac's
# page. The Oracle server's own tank stock page and AnyDesk are stopped, which
# frees their memory for the XtraPower monitor and the e-Mitra jobs.
set -euo pipefail

DROP_DIR=/etc/systemd/system/xtrapower-manage.service.d
DROP="$DROP_DIR/tank-stock-on-mac.conf"
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as the ubuntu user, not root."
[ $# -eq 1 ] || die "Give the Mac's tank stock address (https://...:8443), or --back."

if [ "$1" = "--back" ]; then
  say "Tank stock back on this server"
  sudo rm -f "$DROP"
  sudo systemctl daemon-reload
  sudo systemctl enable -q --now anydesk 2>/dev/null || true
  sudo systemctl enable -q --now tank-stock-session
  sudo systemctl restart xtrapower-manage
  echo "Done. The app's Tank stock tab is this server's page again."
  exit 0
fi

url="${1%/}"
case "$url" in https://*) ;; *) die "The address starts with https:// (the one vm-setup.sh printed)." ;; esac

say "1/3 Checking that the Mac's page answers this server"
code="$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$url/api/state" || true)"
case "$code" in
  200) echo "It answers. Good." ;;
  403) die "The Mac's page refused this server (HTTP 403). Is this server signed in to Tailscale
with the same account as your phone? Check: sudo tailscale status" ;;
  *) die "No answer from $url (HTTP ${code:-none}). Is the Mac on, the VM running and in Tailscale?" ;;
esac

say "2/3 Pointing the Vriddhi Fuels app's Tank stock tab at the Mac"
sudo install -d "$DROP_DIR"
printf '[Service]\nEnvironment=XTRAPOWER_TANK_STOCK=%s\n' "$url" | sudo tee "$DROP" >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart xtrapower-manage

say "3/3 Stopping this server's tank stock page and AnyDesk (their memory goes to the monitor)"
sudo systemctl disable -q --now tank-stock-session 2>/dev/null || true
sudo systemctl disable -q --now anydesk 2>/dev/null || true
free -h | head -n 2
echo
echo "Done. Open the Vriddhi Fuels app as usual: its Tank stock tab is now the Mac."
echo "Back to this server any time: bash infra/mac/use-mac-tank-stock.sh --back"
