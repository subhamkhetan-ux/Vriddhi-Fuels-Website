#!/usr/bin/env bash
# The tank stock page says "The decant database could not be reached"? Run
# this in the Mac's Ubuntu VM: it checks, in order, what that needs.
#
#   cd ~/Vriddhi-Fuels-Website && bash infra/mac/check-cloud.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ok() { printf '  OK    %s\n' "$*"; }
bad() { printf '  FIX   %s\n' "$*"; }
host="$(python3 -c 'import re,sys; m=re.search(r"SUPABASE_URL:\s*\"https://([^/\"]+)", open(sys.argv[1]).read()); print(m.group(1) if m else "")' \
  "$ROOT/decant/config.js")"
[ -n "$host" ] || { bad "decant/config.js has no Supabase project"; exit 1; }

echo "1. The clock"
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ]; then
  ok "synced ($(date '+%d %b %H:%M:%S %Z'))"
else
  bad "not synced ($(date '+%d %b %H:%M:%S %Z')): sudo timedatectl set-ntp true; sudo systemctl restart systemd-timesyncd"
fi

echo "2. The internet"
if curl -fsS -m 10 -o /dev/null https://www.google.com/generate_204; then
  ok "reachable"
else
  bad "no internet from the VM: check the Mac's connection, and the VM's network (Parallels: Shared Network)"
fi

echo "3. The decant cloud's name"
if getent hosts "$host" >/dev/null; then
  ok "found"
else
  bad "its name can't be looked up (DNS): sudo resolvectl flush-caches, or restart the VM"
fi

echo "4. The decant cloud itself"
code="$(curl -sS -m 15 -o /dev/null -w '%{http_code} in %{time_total}s' "https://$host/rest/v1/" 2>&1)"
case "$code" in
  [1-5][0-9][0-9]\ in*) ok "answers (HTTP $code)" ;;
  *) bad "no answer: $code" ;;
esac
# its clock against ours: a wrong clock here breaks the secure connection
theirs="$(curl -sSI -m 15 "https://$host/rest/v1/" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="date"{print $2}')"
if [ -n "$theirs" ]; then
  off=$(( $(date +%s) - $(date -d "$theirs" +%s) ))
  if [ "${off#-}" -le 120 ]; then ok "the clocks agree (${off} s)"; else bad "this VM's clock is ${off} s off: sudo systemctl restart systemd-timesyncd"; fi
fi

echo "5. The tank stock service's own way in"
if sudo test -d /opt/agents/tank-stock/app; then
  # (as the service's own user: its folder is closed to others)
  if out="$(sudo -u runner -H bash -c 'cd /opt/agents/tank-stock/app && exec /opt/agents/venv/bin/python -c \
      "from tank_stock import decant; print(len(decant.settings()[\"tanks\"]), \"tanks in the decant app\")"' 2>&1)"; then
    ok "$out"
  else
    bad "$(printf '%s' "$out" | tail -n 1)"
  fi
else
  bad "the tank stock page isn't installed here: bash infra/mac/vm-setup.sh"
fi
