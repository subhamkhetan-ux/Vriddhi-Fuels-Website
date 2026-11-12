#!/usr/bin/env bash
# XtraPower's site through another server, when XtraPower's firewall (F5)
# rejects this server's address ("The requested URL was rejected") but not the
# other's. The monitor stays here; only its Chromium's requests to XtraPower's
# site go out through the other server, over an SSH tunnel. Everything else
# (Telegram, the phone page, ...) goes straight out as before. Run as the
# ubuntu user on the monitor's server, after infra/xtrapower/setup.sh:
#
#   1. bash infra/xtrapower/relay-setup.sh --key
#        prints this server's relay key: allow it on the other server with
#        bash infra/xtrapower/relay-server.sh 'THE KEY'
#   2. bash infra/xtrapower/relay-setup.sh OTHER_SERVER_IP
#        starts the tunnel, checks XtraPower answers through it, and sends the
#        monitor's XtraPower traffic that way (the monitor restarts).
#
#   bash infra/xtrapower/relay-setup.sh --off     straight out again.
#
# If the tunnel drops, Chromium goes straight out meanwhile (what it did
# before), and the tunnel comes back by itself.
set -euo pipefail

HOME_DIR=/opt/xtrapower
SVC_USER=xtrapower
DIR="$HOME_DIR/relay"
ENV_FILE="$HOME_DIR/relay.env"       # read by run.sh: present = the monitor uses the relay
PORT=1080                            # as in xtrapower-relay.service
# XtraPower's site. Keep in step with relay-server.sh, which lets the key reach
# only these.
HOSTS="${XTRAPOWER_RELAY_HOSTS:-beta.iocxtrapower.com}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# (to stderr: --key prints only the key, to copy)
say() { printf '\n==> %s\n' "$*" >&2; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as the ubuntu user, not root (the script uses sudo where needed)."
id "$SVC_USER" >/dev/null 2>&1 || die "Install the XtraPower monitor first: bash infra/xtrapower/setup.sh"

ensure_key() {
  sudo install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$DIR"
  if ! sudo test -f "$DIR/id_ed25519"; then
    sudo -u "$SVC_USER" ssh-keygen -q -t ed25519 -N "" -C "xtrapower-relay@$(hostname)" -f "$DIR/id_ed25519"
  fi
}

case "${1:-}" in
  --key)
    ensure_key
    sudo cat "$DIR/id_ed25519.pub"
    exit 0 ;;
  --off)
    say "Sending XtraPower's traffic straight out again"
    sudo rm -f "$ENV_FILE"
    sudo systemctl disable -q --now xtrapower-relay 2>/dev/null || true
    sudo systemctl restart xtrapower
    echo "Done: the monitor reaches XtraPower straight from this server." >&2
    exit 0 ;;
  ""|-*)
    die "Usage: bash infra/xtrapower/relay-setup.sh --key | OTHER_SERVER_IP | --off" ;;
esac
RELAY="$1"
case "$RELAY" in
  *[!a-zA-Z0-9.:-]*) die "Not a server address: $RELAY" ;;
esac
ensure_key
PUB="$(sudo cat "$DIR/id_ed25519.pub")"

say "1/3 The tunnel to $RELAY"
printf 'RELAY_HOST=%s\n' "$RELAY" | sudo install -m 644 -o root -g root /dev/stdin "$DIR/target"
sudo install -m 644 "$HERE/xtrapower-relay.service" /etc/systemd/system/xtrapower-relay.service
sudo systemctl daemon-reload
sudo systemctl enable -q xtrapower-relay
sudo systemctl restart xtrapower-relay
# (only the xtrapower user may use the port)
port_up() { sudo -u "$SVC_USER" timeout 2 bash -c "exec 3<>/dev/tcp/127.0.0.1/$PORT" 2>/dev/null; }
up=""
for _ in $(seq 1 20); do
  if port_up; then up=1; break; fi
  sleep 1
done
if [ -z "$up" ]; then
  sudo systemctl stop xtrapower-relay
  why="$(sudo journalctl -u xtrapower-relay -n 20 --no-pager -o cat 2>/dev/null | grep -iE 'denied|refused|timed out|could not|no route|host key' | tail -n 1)"
  if printf '%s' "$why" | grep -qi denied; then
    die "$RELAY doesn't allow this server's key yet. On $RELAY run:
  bash infra/xtrapower/relay-server.sh '$PUB'
then this again."
  fi
  die "The tunnel to $RELAY didn't open${why:+: $why}. Nothing else was changed.
See: journalctl -u xtrapower-relay -n 30"
fi
echo "The tunnel is open." >&2

say "2/3 Checking XtraPower through it"
body="$(mktemp)"
# (as the xtrapower user, the only one the port takes; the page and then its
# status code, on a line of its own; written to our own file, on purpose)
# shellcheck disable=SC2024
sudo -u "$SVC_USER" curl -sS -m 40 -L --socks5-hostname "127.0.0.1:$PORT" -w '\nHTTP_CODE=%{http_code}\n' \
  "https://${HOSTS%% *}/" >"$body" 2>/dev/null || true
code="$(grep -o 'HTTP_CODE=[0-9]*' "$body" | tail -n 1 | cut -d= -f2 || true)"
if grep -qi "requested url was rejected" "$body"; then
  rm -f "$body"; sudo systemctl disable -q --now xtrapower-relay
  die "XtraPower's firewall rejects $RELAY too, so the relay can't help. Nothing else was changed."
fi
rm -f "$body"
case "$code" in
  2??|3??) echo "XtraPower answers through $RELAY (HTTP $code), no firewall rejection." >&2 ;;
  *) sudo systemctl disable -q --now xtrapower-relay
     die "XtraPower didn't answer through $RELAY (${code:-no answer}). Nothing else was changed.
If $RELAY ran relay-server.sh with other hosts, check they include ${HOSTS%% *}." ;;
esac

say "3/3 Sending the monitor's XtraPower traffic through it"
printf 'XTRAPOWER_RELAY_PORT=%s\nXTRAPOWER_RELAY_HOSTS="%s"\n' "$PORT" "$HOSTS" \
  | sudo install -m 640 -o root -g "$SVC_USER" /dev/stdin "$ENV_FILE"
# The monitor runs from its own copy of the code ($HOME_DIR/app, fetched by
# setup.sh), not this one: one fetched before the relay existed would start
# without it. Bring it to this copy's branch first, as setup.sh does.
APP="$HOME_DIR/app"
if ! sudo grep -q "relay.env" "$APP/infra/xtrapower/run.sh" 2>/dev/null; then
  REF="$(git -C "$HERE/../.." rev-parse --abbrev-ref HEAD)"
  echo "The monitor's code predates the relay: updating it ($REF)." >&2
  sudo -H -u "$SVC_USER" git -C "$APP" fetch -q origin "$REF"
  sudo -H -u "$SVC_USER" git -C "$APP" checkout -q -B "$REF" FETCH_HEAD
  sudo grep -q "relay.env" "$APP/infra/xtrapower/run.sh" \
    || die "The monitor's code still has no relay support. Update it: IGNORE_FIREWALL=1 bash infra/xtrapower/setup.sh"
fi
since="$(date '+%Y-%m-%d %H:%M:%S')"
sudo systemctl restart xtrapower
# (run.sh says so as it starts the monitor's Chromium with the relay)
used=""
for _ in $(seq 1 30); do
  if sudo journalctl -u xtrapower --since "$since" --no-pager -o cat 2>/dev/null | grep -q "through the relay server"; then used=1; break; fi
  sleep 1
done
[ -n "$used" ] || die "The monitor restarted but didn't say it uses the relay. See: journalctl -u xtrapower -n 40"
echo "Done: the monitor reaches $HOSTS through $RELAY (it restarted; Telegram says so)." >&2
echo "Straight out again: bash infra/xtrapower/relay-setup.sh --off" >&2
