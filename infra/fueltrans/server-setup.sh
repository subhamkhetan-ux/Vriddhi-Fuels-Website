#!/usr/bin/env bash
# Show the IOCL PC's FuelTrans screen on your phone, through this Oracle server
# (see infra/fueltrans/README.md). Run as the ubuntu user:
#
#   cd ~/Vriddhi-Fuels-Website && git pull
#   bash infra/fueltrans/server-setup.sh 'ssh-ed25519 AAAA... fueltrans@bctftsm'
#
# The key is the line infra/fueltrans/pc-setup.sh printed on the IOCL PC.
#
# - A `fueltrans` user that the PC's key may use for one thing only: opening
#   port 13000 on this server's localhost. No shell, and no reaching anything
#   else on the server.
# - Tailscale publishes that port at https://<this server>:10000/, to your own
#   signed-in devices only. Nothing is opened to the internet.
#
# Re-running is safe (a new key replaces the old one).
#   bash infra/fueltrans/server-setup.sh --remove    undoes all of it.
set -euo pipefail

USER_NAME=fueltrans
HOME_DIR=/var/lib/fueltrans
PORT=13000                  # the PC's ssh -R lands here (localhost only)
TS_PORT=10000               # Tailscale HTTPS port (443 is the Vriddhi Fuels app)
SSHD_CONF=/etc/ssh/sshd_config.d/05-fueltrans-keepalive.conf

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as the ubuntu user, not root (the script uses sudo where needed)."

if [ "${1:-}" = "--remove" ]; then
  say "Removing the FuelTrans tunnel"
  sudo tailscale serve --https="$TS_PORT" off >/dev/null 2>&1 || true
  sudo pkill -u "$USER_NAME" 2>/dev/null || true
  id "$USER_NAME" >/dev/null 2>&1 && sudo userdel -r "$USER_NAME" 2>/dev/null || true
  sudo rm -f "$SSHD_CONF"
  sudo systemctl try-reload-or-restart ssh 2>/dev/null || true
  echo "Done. On the IOCL PC:  sudo systemctl disable --now fueltrans-tunnel"
  exit 0
fi

PUBKEY="${1:-}"
[ -n "$PUBKEY" ] || die "Give the key pc-setup.sh printed on the IOCL PC, in single quotes:
  bash infra/fueltrans/server-setup.sh 'ssh-ed25519 AAAA... fueltrans@bctftsm'"
case "$PUBKEY" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *) ;;
  *) die "That doesn't look like a public key (it should start with ssh-ed25519)." ;;
esac
printf '%s\n' "$PUBKEY" | ssh-keygen -l -f /dev/stdin >/dev/null 2>&1 \
  || die "The key is damaged (a character lost when copying?). Copy it again from the PC."

say "1/4 The fueltrans user"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  sudo useradd --system --create-home --home-dir "$HOME_DIR" --shell /usr/sbin/nologin "$USER_NAME"
fi
sudo usermod -p '*' "$USER_NAME"     # no password, but not "locked" (that would refuse the key)
# restrict: no shell, terminal, agent or X11. Then only: open port $PORT here
# (-R), and nothing to reach (-L to a port nothing listens on).
OPTS="restrict,port-forwarding,permitlisten=\"$PORT\",permitopen=\"127.0.0.1:9\",command=\"/usr/sbin/nologin\""
sudo install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh"
printf '%s %s\n' "$OPTS" "$PUBKEY" \
  | sudo install -m 600 -o "$USER_NAME" -g "$USER_NAME" /dev/stdin "$HOME_DIR/.ssh/authorized_keys"
echo "The PC's key is allowed: $(printf '%s\n' "$PUBKEY" | ssh-keygen -l -f /dev/stdin)"

say "2/4 Dropping dead connections quickly"
# When the station's internet drops, the old connection would keep port $PORT
# for hours and the PC couldn't get it back. This closes it after ~90 s.
printf 'ClientAliveInterval 30\nClientAliveCountMax 3\n' | sudo install -m 644 /dev/stdin "$SSHD_CONF"
sudo sshd -t || { sudo rm -f "$SSHD_CONF"; die "sshd rejected the setting; nothing was changed."; }
sudo systemctl try-reload-or-restart ssh 2>/dev/null || true

say "3/4 Publishing it to your Tailscale devices (not the internet)"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
ts_field() { sudo tailscale status --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null || true; }
if [ "$(ts_field 'd.get("BackendState","")')" != "Running" ]; then
  echo "A login link appears below. Open it, sign in with your Tailscale account, and approve this server."
  sudo tailscale up
fi
TS_NAME="$(ts_field 'd["Self"]["DNSName"].rstrip(".")')"
[ -n "$TS_NAME" ] || die "Couldn't read this server's Tailscale name. Check: sudo tailscale status"
sudo tailscale serve --bg --https="$TS_PORT" "http://127.0.0.1:$PORT" >/dev/null

say "4/4 Waiting for the IOCL PC to connect (up to 1 minute)"
code=""
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
  [ -n "$code" ] && [ "$code" != "000" ] && break
  sleep 2
done
if [ -n "$code" ] && [ "$code" != "000" ]; then
  echo "FuelTrans answers through the tunnel (HTTP $code)."
else
  echo "Not connected yet. The PC retries every 15 s, so give it a minute and run:"
  echo "  curl -sI http://127.0.0.1:$PORT/ | head -1"
  echo "If it stays empty, on the PC run:  systemctl status fueltrans-tunnel"
fi

cat <<EOF

On your phone or laptop (signed in to the Tailscale app):
  https://$TS_NAME:$TS_PORT/tank-dashboard

Anyone signed in to your Tailscale network can open it, including the
Operations menu. Keep that network to your own devices.
EOF
