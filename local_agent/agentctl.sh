#!/usr/bin/env bash
# agentctl.sh — a simple on/off switch for the Vriddhi payment logging agent.
#
#   bash local_agent/agentctl.sh on       # start now + start automatically at login
#   bash local_agent/agentctl.sh off      # stop now + stay off across reboots
#   bash local_agent/agentctl.sh status   # is it running?
#   bash local_agent/agentctl.sh restart   # reload the worker (after a code update)
#   bash local_agent/agentctl.sh logs      # show the agent's recent activity/errors
#
# It works in either mode automatically:
#   • app mode     — the agent runs from ~/Applications/VriddhiPaymentAgent.app
#                    (built by setup_login_app.sh; this is the normal macOS mode,
#                    needed so it can control Excel). Controlled via the app +
#                    Login Items.
#   • launchd mode — the older plain launchd agent, if the app isn't installed.
set -u

LABEL="com.vriddhi.paymentagent"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"
APP="$HOME/Applications/VriddhiPaymentAgent.app"
APP_NAME="VriddhiPaymentAgent"
WORKER="local_agent.mac_agent"
PB=/usr/libexec/PlistBuddy

app_mode()    { [ -d "$APP" ]; }
worker_pids() { pgrep -f "$WORKER" || true; }
app_pids()    { pgrep -f "$APP_NAME" || true; }

login_item_add() {
  osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$APP\", hidden:true}" >/dev/null 2>&1 || true
}
login_item_remove() {
  osascript -e "tell application \"System Events\" to delete (every login item whose name is \"$APP_NAME\")" >/dev/null 2>&1 || true
}

# Recent activity from the Supabase feed (works in app mode, which has no local
# log file). Reads the keys from the installed plist.
show_feed() {
  local url key
  url="$("$PB" -c "Print :EnvironmentVariables:SUPABASE_URL" "$PLIST" 2>/dev/null || true)"
  key="$("$PB" -c "Print :EnvironmentVariables:SUPABASE_KEY" "$PLIST" 2>/dev/null || true)"
  if [ -z "$url" ] || [ -z "$key" ]; then
    tail -n 30 "$HOME/Library/Logs/vriddhi-payment-agent.err.log" 2>/dev/null \
      || echo "No config found to read the activity feed."
    return
  fi
  /usr/bin/python3 - "$url" "$key" <<'PY' 2>/dev/null || echo "(couldn't reach the activity feed)"
import json, sys, urllib.request as u
url, key = sys.argv[1].rstrip("/"), sys.argv[2]
req = u.Request(url + "/rest/v1/pay_agent_events?select=kind,detail,created_at&order=created_at.desc&limit=12",
                headers={"apikey": key, "Authorization": "Bearer " + key})
for e in json.load(u.urlopen(req)):
    print(f"  {e['created_at'][11:19]}  {e['kind']:9}  {e.get('detail') or ''}")
PY
}

cmd="${1:-status}"

if app_mode; then
  case "$cmd" in
    on)
      login_item_add
      open "$APP"
      sleep 3
      if [ -n "$(worker_pids)" ]; then echo "✅ Agent ON (app running; starts at login)."
      else echo "◐ App launched; worker should come up shortly. Check: bash local_agent/agentctl.sh status"; fi
      ;;
    off)
      login_item_remove
      pkill -f "$APP_NAME" 2>/dev/null || true
      pkill -f "$WORKER" 2>/dev/null || true
      echo "🛑 Agent OFF — app stopped and removed from Login Items. Heartbeats stopped."
      ;;
    restart)
      if [ -n "$(app_pids)" ]; then
        pkill -f "$WORKER" 2>/dev/null || true   # the app relaunches the worker with new code
        sleep 6
        [ -n "$(worker_pids)" ] && echo "🔄 Worker reloaded." || echo "⚠️  Worker didn't restart — try: bash local_agent/agentctl.sh on"
      else
        login_item_add; open "$APP"; echo "🔄 App started."
      fi
      ;;
    status)
      if [ -n "$(worker_pids)" ]; then echo "✅ Agent is ON (app mode; worker pid $(worker_pids | tr '\n' ' '))."
      elif [ -n "$(app_pids)" ]; then echo "◐ App running, worker not up yet."
      else echo "🛑 Agent is OFF (app mode)."; fi
      ;;
    logs) show_feed ;;
    *) echo "Usage: bash local_agent/agentctl.sh {on|off|status|restart|logs}"; exit 2 ;;
  esac
else
  # ---- launchd mode (fallback when the app isn't installed) ----
  loaded() { launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; }
  case "$cmd" in
    on)
      [ -f "$PLIST" ] || { echo "No plist at $PLIST — run the setup steps first."; exit 1; }
      launchctl enable "${DOMAIN}/${LABEL}" 2>/dev/null
      launchctl bootstrap "${DOMAIN}" "$PLIST" 2>/dev/null
      loaded && echo "✅ Agent ON (launchd; runs at login)." || echo "⚠️  Could not start — check: bash local_agent/agentctl.sh logs"
      ;;
    off)
      launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null
      launchctl disable "${DOMAIN}/${LABEL}" 2>/dev/null
      echo "🛑 Agent OFF (launchd) — stopped and kept off across reboots."
      ;;
    restart)
      launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null
      launchctl enable "${DOMAIN}/${LABEL}" 2>/dev/null
      launchctl bootstrap "${DOMAIN}" "$PLIST" 2>/dev/null
      loaded && echo "🔄 Agent restarted." || echo "⚠️  Not running — check: bash local_agent/agentctl.sh logs"
      ;;
    status)
      if loaded; then echo "✅ Agent is ON (launchd; pid $(launchctl list | awk -v l="$LABEL" '$3==l{print $1}'))."
      else echo "🛑 Agent is OFF (launchd)."; fi
      ;;
    logs) show_feed ;;
    *) echo "Usage: bash local_agent/agentctl.sh {on|off|status|restart|logs}"; exit 2 ;;
  esac
fi
