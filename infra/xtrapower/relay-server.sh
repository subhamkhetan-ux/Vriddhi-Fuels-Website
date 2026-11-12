#!/usr/bin/env bash
# The relay server's half of infra/xtrapower/relay-setup.sh: lets the XtraPower
# monitor's server send its XtraPower traffic out through this one, when
# XtraPower's firewall rejects that server's address but not this one's.
# Run as the ubuntu user, on the server the traffic goes out through:
#
#   bash infra/xtrapower/relay-server.sh 'ssh-ed25519 AAAA... xtrapower-relay@...'
#
# The key is the line `relay-setup.sh --key` printed on the monitor's server.
# The script reads nothing else from this repository, so it also runs piped
# from another server (bash -s -- 'KEY'), on a server without the repo.
#
# - An `xprelay` user that the key may use for one thing only: opening
#   connections to XtraPower's site (the hosts below, ports 443 and 80). No
#   shell, terminal or anything else, and nothing else reachable from here.
# - Nothing listens here and nothing is opened to the internet: the monitor's
#   server connects in over SSH, as you do.
#
# Re-running is safe: a new key replaces the old one.
#   bash infra/xtrapower/relay-server.sh --remove    undoes it.
set -euo pipefail
# All in braces: piped into bash -s, the whole script is read before any of it
# runs (so no command in it can read the rest of it as its input).
{

USER_NAME=xprelay
HOME_DIR=/var/lib/xprelay
# XtraPower's site: what the key may reach. Keep in step with relay-setup.sh,
# which sends the same hosts here. More hosts can follow the key:
#   bash infra/xtrapower/relay-server.sh 'KEY' beta.iocxtrapower.com other.host
DEFAULT_HOSTS="beta.iocxtrapower.com"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as the ubuntu user, not root (the script uses sudo where needed)."

if [ "${1:-}" = "--remove" ]; then
  say "Removing the XtraPower relay"
  sudo pkill -u "$USER_NAME" 2>/dev/null || true
  id "$USER_NAME" >/dev/null 2>&1 && sudo userdel -r "$USER_NAME" 2>/dev/null || true
  echo "Done. On the monitor's server:  bash infra/xtrapower/relay-setup.sh --off"
  exit 0
fi

PUBKEY="${1:-}"
[ -n "$PUBKEY" ] || die "Give the key relay-setup.sh --key printed on the monitor's server, in single quotes:
  bash infra/xtrapower/relay-server.sh 'ssh-ed25519 AAAA... xtrapower-relay@...'"
case "$PUBKEY" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *) ;;
  *) die "That doesn't look like a public key (it should start with ssh-ed25519)." ;;
esac
printf '%s\n' "$PUBKEY" | ssh-keygen -l -f /dev/stdin >/dev/null 2>&1 \
  || die "The key is damaged (a character lost when copying?). Print it again with relay-setup.sh --key."
shift
HOSTS="${*:-$DEFAULT_HOSTS}"
for h in $HOSTS; do
  case "$h" in
    *[!a-zA-Z0-9.-]*|"") die "Not a host name: $h" ;;
  esac
done

say "1/2 The $USER_NAME user"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  sudo useradd --system --create-home --home-dir "$HOME_DIR" --shell /usr/sbin/nologin "$USER_NAME"
fi
sudo usermod -p '*' "$USER_NAME"     # no password, but not "locked" (that would refuse the key)
# restrict: no shell, terminal, agent or X11. Then only: connections out (the
# monitor's -D) to XtraPower's hosts, ports 443 and 80. sshd matches these
# names literally, as the monitor's Chromium sends them (it resolves nothing
# itself through the relay).
OPTS="restrict,port-forwarding"
for h in $HOSTS; do OPTS="$OPTS,permitopen=\"$h:443\",permitopen=\"$h:80\""; done
OPTS="$OPTS,command=\"/usr/sbin/nologin\""
sudo install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh"
printf '%s %s\n' "$OPTS" "$PUBKEY" \
  | sudo install -m 600 -o "$USER_NAME" -g "$USER_NAME" /dev/stdin "$HOME_DIR/.ssh/authorized_keys"
echo "Allowed: $(sudo ssh-keygen -l -f "$HOME_DIR/.ssh/authorized_keys")"
echo "It may reach: $HOSTS (ports 443 and 80), nothing else."

say "2/2 Checking XtraPower from here"
body="$(mktemp)"
code="$(curl -sS -m 30 -L -o "$body" -w '%{http_code}' "https://${HOSTS%% *}/" || true)"
if [ -z "$code" ] || [ "$code" = "000" ]; then
  echo "XtraPower didn't answer from this server just now (no connection)."
elif grep -qi "requested url was rejected" "$body"; then
  echo "XtraPower's firewall rejects this server too: the relay won't help until that lifts."
else
  echo "XtraPower answers this server (HTTP $code), no firewall rejection. Good."
fi
rm -f "$body"
echo
echo "Done. On the monitor's server:  bash infra/xtrapower/relay-setup.sh THIS_SERVER'S_IP"
}
