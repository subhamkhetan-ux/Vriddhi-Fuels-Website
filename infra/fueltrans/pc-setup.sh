#!/usr/bin/env bash
# Run on the IOCL automation PC (see infra/fueltrans/README.md):
#
#   bash pc-setup.sh SERVER_PUBLIC_IP
#
# Keeps an SSH tunnel open from this PC to the Oracle server, so the server can
# show FuelTrans (localhost:3000 here) on your phone. Nothing is installed: it
# uses the ssh that Ubuntu already has, and a systemd service that starts it at
# boot and reconnects whenever the network drops. The PC only connects *out*;
# nothing on it is opened to the internet. Re-running it is safe.
set -euo pipefail

SERVER="${1:-}"
KEY="$HOME/.ssh/fueltrans"
REMOTE_PORT=13000           # where FuelTrans appears on the server (its localhost only)
LOCAL_PORT=3000             # FuelTrans on this PC
UNIT=/etc/systemd/system/fueltrans-tunnel.service

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ -n "$SERVER" ] || die "Give the Oracle server's public IP:  bash pc-setup.sh 1.2.3.4"
[ "$(id -u)" -ne 0 ] || die "Run as the normal login user (bctftsm), not root. It asks for sudo itself."
command -v ssh >/dev/null || die "ssh isn't on this PC."

port_open() { timeout 5 bash -c "</dev/tcp/$1/$2" 2>/dev/null; }

say "1/4 Checking FuelTrans and the server"
if port_open 127.0.0.1 "$LOCAL_PORT" || port_open ::1 "$LOCAL_PORT"; then
  echo "FuelTrans answers on localhost:$LOCAL_PORT."
else
  echo "WARNING: nothing answers on localhost:$LOCAL_PORT right now. Carrying on; the tunnel"
  echo "works as soon as FuelTrans is running."
fi
if port_open "$SERVER" 22; then
  echo "The server ($SERVER) is reachable on port 22."
else
  die "Can't reach $SERVER on port 22. Check the IP; if it's right, this network blocks SSH. Send a photo of this."
fi

say "2/4 Creating this PC's tunnel key"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
if [ -f "$KEY" ]; then
  echo "Already there: $KEY"
else
  ssh-keygen -q -t ed25519 -N "" -C "fueltrans@$(hostname)" -f "$KEY"
  echo "Created $KEY"
fi

say "3/4 Installing the tunnel service (sudo password needed)"
sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=FuelTrans tunnel to the Oracle server
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
User=$(id -un)
ExecStart=/usr/bin/ssh -NT -i $KEY -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$HOME/.ssh/fueltrans_known_hosts -R $REMOTE_PORT:localhost:$LOCAL_PORT fueltrans@$SERVER
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable fueltrans-tunnel >/dev/null 2>&1
sudo systemctl restart fueltrans-tunnel
echo "Installed. It keeps retrying every 15 s until the server accepts the key below."

say "4/4 Send this key to the server"
cat <<EOF
Copy the line below (select it, then Ctrl+Shift+C) and send it to yourself, for
example on WhatsApp Web or Gmail in Chromium. It is a public key: safe to send.

$(cat "$KEY.pub")

Then on the Oracle server run:
  bash infra/fueltrans/server-setup.sh '<the line above>'

Check the tunnel here any time:  systemctl status fueltrans-tunnel
EOF
