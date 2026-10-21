#!/usr/bin/env bash
# Inside the Ubuntu virtual machine on the Mac (see infra/mac/README.md):
# the tank stock page and its AnyDesk captures, exactly as on the Oracle
# server, without the GitHub runner or the XtraPower monitor.
#
#   git clone https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website.git
#   cd Vriddhi-Fuels-Website && bash infra/mac/vm-setup.sh
#
# Run as the VM's own user (needs sudo). Re-running it is safe and updates
# the code; it asks for the AnyDesk login and the Telegram bot only once.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TS_HOSTNAME="${TS_HOSTNAME:-mac-tank}"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as your own user, not root (the script uses sudo where needed)."
. /etc/os-release
case "${ID}-${VERSION_ID}" in
  ubuntu-22.04|ubuntu-24.04) ;;
  *) die "Use Ubuntu Server 22.04 or 24.04 in the VM (found ${PRETTY_NAME})." ;;
esac
echo "This VM: $(uname -m), $(awk '/MemTotal/ {printf "%.1f GB", $2/1048576}' /proc/meminfo) of memory."

say "1/5 Python, Tesseract (the text reader) and software graphics (Mesa)"
sudo apt-get update -q
# AnyDesk draws the remote screen with OpenGL. On the Oracle server the
# graphics libraries came with Chromium's; without them the session's picture
# stays black although AnyDesk connects. Mesa draws it in software on the
# virtual screen.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
  ca-certificates curl git python3 python3-venv tesseract-ocr \
  libgl1 libglx-mesa0 libgl1-mesa-dri libegl1 libegl-mesa0 libgbm1 mesa-utils fonts-dejavu-core

# The clock: the VM pauses while the Mac sleeps and wakes up behind. A wrong
# clock breaks the secure connection to the decant app ("could not be reached")
# and stamps readings wrongly, so it is synced, and again every 5 minutes.
sudo timedatectl set-ntp true || true
sudo tee /etc/systemd/system/time-resync.service >/dev/null <<'UNIT'
[Unit]
Description=Sync the clock again (the VM may have slept with the Mac)
[Service]
Type=oneshot
ExecStart=/bin/systemctl restart systemd-timesyncd.service
UNIT
sudo tee /etc/systemd/system/time-resync.timer >/dev/null <<'UNIT'
[Unit]
Description=Sync the clock every 5 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now time-resync.timer >/dev/null 2>&1 || true

say "2/5 The 'runner' user the tank stock page runs as"
id runner >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash runner
sudo install -d -o runner -g runner /opt/agents
# The tank stock code needs nothing beyond Python's standard library.
sudo test -x /opt/agents/venv/bin/python || sudo -u runner -H python3 -m venv /opt/agents/venv

say "3/5 Tailscale (so your phone and the Oracle server reach this VM, and nothing else does)"
command -v tailscale >/dev/null 2>&1 || curl -fsSL https://tailscale.com/install.sh | sh
if ! sudo tailscale status >/dev/null 2>&1; then
  echo "Open the link below and sign in with the same Tailscale account as your phone:"
  sudo tailscale up --hostname="$TS_HOSTNAME"
fi
sudo tailscale status --self --peers=false | head -n 1

say "4/5 AnyDesk and the tank stock page (the Oracle server's own setup)"
bash "$ROOT/infra/anydesk/setup.sh"

say "5/5 The AnyDesk login and the Telegram bot"
if ! sudo test -f /opt/agents/tank-stock/login.json || [ "${ASK_AGAIN:-}" = "1" ]; then
  echo "The IOCL PC's AnyDesk numbers (both, comma separated) and its unattended-access"
  echo "password: the values of the GitHub secrets ANYDESK_IDS and ANYDESK_PASSWORD."
  read -rp "AnyDesk numbers: " ids
  read -rsp "AnyDesk password (input hidden): " pw; echo
  printf '%s\n%s\n' "$ids" "$pw" | sudo -u runner -H bash -c '
    cd /opt/agents/tank-stock/app && read -r ids && read -r pw &&
    ANYDESK_IDS="$ids" ANYDESK_PASSWORD="$pw" exec /opt/agents/venv/bin/python -m tank_stock.run --save-login'
  unset ids pw
else
  echo "The AnyDesk login is already saved (ASK_AGAIN=1 to change it)."
fi
if ! sudo test -f /opt/agents/tank-telegram.json || [ "${ASK_AGAIN:-}" = "1" ]; then
  echo "The XtraPower bot, for the private screenshots. On the Oracle server, show its"
  echo "token and chat id with (infra/mac/README.md part C):"
  echo "  sudo python3 -c \"import json; t=json.load(open('/opt/xtrapower/config.json'))['telegram']; print(t['token']); print(t['chat_id'])\""
  read -rsp "Bot token (input hidden): " token; echo
  read -rp "Chat id: " chat
  tmp="$(mktemp)"
  python3 -c 'import json,sys; print(json.dumps({"token": sys.argv[1].strip(), "chat_id": sys.argv[2].strip()}))' \
    "$token" "$chat" >"$tmp"
  sudo install -m 600 -o runner -g runner "$tmp" /opt/agents/tank-telegram.json
  rm -f "$tmp"; unset token chat
else
  echo "The Telegram bot is already set (ASK_AGAIN=1 to change it)."
fi

name="$(sudo tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
cat <<MSG

Done. This VM's tank stock page: https://$name:8443/
Try "Capture only" there first. When it works, point the Vriddhi Fuels app at it
(on the Oracle server, see infra/mac/README.md part C):

  bash infra/mac/use-mac-tank-stock.sh https://$name:8443
MSG
