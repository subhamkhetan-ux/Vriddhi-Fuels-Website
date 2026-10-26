#!/usr/bin/env bash
# Remove AnyDesk from this Oracle server, now that tank stock reads FuelTrans
# through the IOCL PC's tunnel (tank-stock-setup.sh). Run as the ubuntu user:
#
#   cd ~/Vriddhi-Fuels-Website && git pull && bash infra/fueltrans/remove-anydesk.sh
#
# Removes AnyDesk, its package source and settings, the console login session
# it needed (tank-stock-session) and xdotool (its clicks). Keeps everything the
# FuelTrans tank stock uses: the tank-stock service, its code, login and data
# in /opt/agents/tank-stock, the Telegram bot copy, ImageMagick and Tesseract
# (the card reader), and Xvfb (the XtraPower monitor's). Unlike
# infra/anydesk/uninstall.sh, which takes tank stock off the server altogether.
#
# To bring the AnyDesk reader back later: bash infra/anydesk/setup.sh, then the
# GitHub "Tank stock" workflow with mode save-login (the AnyDesk login).
set -euo pipefail

HOME_DIR=/opt/agents/tank-stock
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as the ubuntu user, not root (the script uses sudo where needed)."

say "1/4 Checking that tank stock reads FuelTrans (so nothing needs AnyDesk)"
source="$(sudo python3 -c "import json; print(json.load(open('$HOME_DIR/login.json')).get('source', ''))" 2>/dev/null || true)"
if [ "$source" != "fueltrans" ] || ! systemctl is-active -q tank-stock; then
  die "Tank stock isn't running from FuelTrans here yet (bash infra/fueltrans/tank-stock-setup.sh first).
AnyDesk is left as it is."
fi
echo "Tank stock runs from FuelTrans (service tank-stock is active)."
busy="$(curl -s -m 10 http://127.0.0.1:8790/api/state | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("an automatic decantation" if (d.get("auto") or {}).get("phase") in ("starting", "running")
      else "live monitoring" if d.get("live") else "")' 2>/dev/null || true)"
[ -z "$busy" ] || die "Tank stock is busy with $busy: run this again once it's done (the service restarts at the end)."
before="$(free -m | awk '/^Mem:/ {print $7}')"

say "2/4 Removing the console login session AnyDesk needed"
sudo systemctl disable -q --now tank-stock-session.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/tank-stock-session.service /etc/pam.d/tank-stock-session
sudo systemctl daemon-reload
sudo systemctl reset-failed tank-stock-session.service 2>/dev/null || true
sudo pkill -u runner -f "Xvfb :98" 2>/dev/null || true       # (AnyDesk's own display; XtraPower's is :99)
sudo pkill -u runner -x anydesk 2>/dev/null || true

say "3/4 Removing AnyDesk and xdotool"
sudo systemctl disable -q --now anydesk.service 2>/dev/null || true
if dpkg -s anydesk >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get purge -y -q anydesk >/dev/null
fi
sudo rm -f /etc/apt/sources.list.d/anydesk-stable.list /usr/share/keyrings/anydesk.gpg
sudo rm -rf /etc/anydesk /root/.anydesk ~runner/.anydesk ~runner/.config/anydesk 2>/dev/null || true
# AnyDesk's leftovers in the tank stock cache: the ID that worked last, its logs
sudo rm -f ~runner/.cache/tank_stock/last-id ~runner/.cache/tank_stock/anydesk-*.txt 2>/dev/null || true
if dpkg -s xdotool >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get purge -y -q xdotool >/dev/null
fi
sudo DEBIAN_FRONTEND=noninteractive apt-get autoremove -y -q >/dev/null
if dpkg -s anydesk >/dev/null 2>&1; then
  die "AnyDesk is still installed; send the lines above."
fi
echo "AnyDesk is gone."

say "4/4 The page's list of live sessions starts afresh"
# The AnyDesk sessions are kept aside (sessions-anydesk.jsonl), not shown any more.
if sudo test -s "$HOME_DIR/sessions.jsonl" && ! sudo test -e "$HOME_DIR/sessions-anydesk.jsonl"; then
  sudo mv "$HOME_DIR/sessions.jsonl" "$HOME_DIR/sessions-anydesk.jsonl"
fi
sudo systemctl restart tank-stock
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/api/state || true)" = "200" ] && break
  sleep 1
done
systemctl is-active -q tank-stock \
  || die "The tank-stock service didn't come back: send journalctl -u tank-stock -n 40"
echo "Tank stock (FuelTrans) is running."

after="$(free -m | awk '/^Mem:/ {print $7}')"
cat <<MSG

Done. AnyDesk is gone from this server (memory available: ${before} MB before,
${after} MB now). Tank stock goes on reading FuelTrans through the PC's tunnel.
AnyDesk stays on the IOCL PC. To bring the AnyDesk reader back here later:
  bash infra/anydesk/setup.sh, then the GitHub "Tank stock" workflow with mode save-login
MSG
