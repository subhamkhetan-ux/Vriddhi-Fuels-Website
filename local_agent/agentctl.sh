#!/usr/bin/env bash
# agentctl.sh — a simple on/off switch for the Vriddhi payment logging agent.
#
#   bash local_agent/agentctl.sh on       # start now + start automatically at login
#   bash local_agent/agentctl.sh off      # stop now + stay off across reboots
#   bash local_agent/agentctl.sh status   # is it running?
#   bash local_agent/agentctl.sh restart  # reload (use after editing the plist)
#   bash local_agent/agentctl.sh logs     # show the last errors
#
# "off" fully stops the agent, so heartbeats AND logging into Master Paid stop.
# "on" both starts it now and (re)enables it so it comes back after a reboot.
# Works on any Mac where the plist has been installed by the setup steps.
set -u

LABEL="com.vriddhi.paymentagent"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"
ERRLOG="$HOME/Library/Logs/vriddhi-payment-agent.err.log"

loaded() { launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; }

case "${1:-status}" in
  on)
    [ -f "$PLIST" ] || { echo "No plist at $PLIST — run the setup steps first."; exit 1; }
    launchctl enable "${DOMAIN}/${LABEL}" 2>/dev/null
    launchctl bootstrap "${DOMAIN}" "$PLIST" 2>/dev/null
    if loaded; then echo "✅ Agent ON (running, and will start at login)."
    else echo "⚠️  Could not start — check: bash local_agent/agentctl.sh logs"; fi
    ;;
  off)
    launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null
    launchctl disable "${DOMAIN}/${LABEL}" 2>/dev/null
    echo "🛑 Agent OFF — stopped now and kept off across reboots. Heartbeats stopped."
    ;;
  restart)
    launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null
    launchctl enable "${DOMAIN}/${LABEL}" 2>/dev/null
    launchctl bootstrap "${DOMAIN}" "$PLIST" 2>/dev/null
    if loaded; then echo "🔄 Agent restarted."
    else echo "⚠️  Not running after restart — check: bash local_agent/agentctl.sh logs"; fi
    ;;
  status)
    if loaded; then
      pid=$(launchctl list | awk -v l="$LABEL" '$3==l{print $1}')
      echo "✅ Agent is ON (pid ${pid:-?})."
    else
      echo "🛑 Agent is OFF."
    fi
    ;;
  logs)
    tail -n 30 "$ERRLOG" 2>/dev/null || echo "No error log yet at $ERRLOG"
    ;;
  *)
    echo "Usage: bash local_agent/agentctl.sh {on|off|status|restart|logs}"
    exit 2
    ;;
esac
