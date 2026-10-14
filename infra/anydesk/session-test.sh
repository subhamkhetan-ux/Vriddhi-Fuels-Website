#!/usr/bin/env bash
# How long does AnyDesk keep a session open? Run it on the server (ssh in from
# Oracle Cloud Shell):
#
#   cd ~/Vriddhi-Fuels-Website && git pull && bash infra/anydesk/session-test.sh
#
# It starts live monitoring (the tank stock page's own; nothing new is
# installed), shows how long the AnyDesk session has been open every few
# minutes, and when it ends says how long it lasted and why. Every session is
# also kept in /opt/agents/tank-stock/sessions.jsonl and shown on the page
# ("AnyDesk sessions"), and the XtraPower bot gets a picture of what AnyDesk
# showed when it ended the session.
#
# Cloud Shell closes after about 20 minutes without typing, and an AnyDesk
# session may last hours, so run it where it keeps going without you:
#
#   nohup bash infra/anydesk/session-test.sh > ~/anydesk-session-test.log 2>&1 &
#   tail -f ~/anydesk-session-test.log        # (Ctrl+C stops watching, not the test)
#
# Or just start live monitoring on the page: the result is the same.
set -euo pipefail

BASE="${TANK_STOCK_URL:-http://127.0.0.1:8790}"
EVERY="${EVERY:-300}"            # seconds between progress lines
POLL="${POLL:-15}"               # seconds between looks

say() { printf '%s  %s\n' "$(date '+%d %b %H:%M:%S')" "$*"; }
state() { curl -fsS -m 20 "$BASE/api/state"; }
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

state >/dev/null 2>&1 || { echo "The tank stock page isn't running here. Run: bash infra/anydesk/setup.sh"; exit 1; }
csrf="$(curl -fsS -m 20 "$BASE/" | grep -o 'name="ts-csrf" content="[^"]*"' | sed 's/.*content="//; s/"$//')"
[ -n "$csrf" ] || { echo "Couldn't read the page's token."; exit 1; }
before="$(state | field '(d.get("live_last") or {}).get("ended", "")')"

if [ "$(state | field 'bool(d["live"])')" = "True" ]; then
  say "Live monitoring is already running: timing that session."
else
  out="$(curl -sS -m 20 -X POST -H "X-TS-CSRF: $csrf" -H 'Content-Type: application/json' \
         -d '{}' "$BASE/api/live/start")"
  case "$out" in *'"error"'*) echo "Couldn't start: $out"; exit 1;; esac
  say "Live monitoring started: connecting to the IOCL PC (about a minute)."
fi

started="$(date +%s)"
last=0
while :; do
  sleep "$POLL"
  s="$(state || true)"
  [ -n "$s" ] || { say "The page didn't answer; trying again."; continue; }
  if [ "$(printf '%s' "$s" | field 'bool(d["live"])')" = "False" ]; then
    ended="$(printf '%s' "$s" | field '(d.get("live_last") or {}).get("ended", "")')"
    [ "$ended" != "$before" ] || continue        # (not ended yet: still starting)
    say "Ended: $(printf '%s' "$s" | field '(lambda r: (r.get("reason") or "?") + " after " + str(r.get("lasted") or "?") + " (" + str(r.get("reads")) + " reads)")(d["live_last"])')"
    printf '%s' "$s" | python3 -c '
import json, sys
d = json.load(sys.stdin)
span = lambda s: "%d h %d min %d s" % (s // 3600, s % 3600 // 60, s % 60)
r = (d.get("sessions") or {}).get("recent") or []
if r and r[0].get("lasted_s") is not None:
    print("The AnyDesk session itself was open %s (ended by: %s)." % (span(r[0]["lasted_s"]), r[0]["by"]))
a = (d.get("sessions") or {}).get("anydesk")
if a:
    print("So far AnyDesk ended %d session(s) by itself: typically after %s, longest %s."
          % (a["count"], span(a["typical_s"]), span(a["longest_s"])))'
    exit 0
  fi
  now="$(date +%s)"
  if [ $((now - last)) -ge "$EVERY" ]; then
    last="$now"
    say "$(printf '%s' "$s" | field '(lambda l: ("connected since " + l["connected"] if l.get("connected") else "still connecting") + ", " + str(l.get("reads", 0)) + " reads" + (", last problem: " + l["last_error"] if l.get("last_error") else ""))(d["live"])')  ($(( (now - started) / 60 )) min since the test started)"
  fi
done
