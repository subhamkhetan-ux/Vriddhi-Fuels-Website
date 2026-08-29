#!/usr/bin/env bash
# setup_login_app.sh — one-time fix for the macOS "control Excel" permission.
#
# Why this exists: a launchd-run python3 has no stable app identity, so macOS
# silently denies its request to control Excel (error -1743) and never shows the
# permission prompt. The reliable fix is to run the agent from a real .app (an
# AppleScript applet). An app HAS an identity, so macOS shows the "control
# Microsoft Excel" prompt exactly ONCE; you click Allow once and it's remembered
# forever. The app also starts at login, so the agent stays fully hands-off.
#
# What this script does:
#   1. reads your existing config from the launchd plist (paths + Supabase keys),
#   2. builds ~/Applications/VriddhiPaymentAgent.app that runs the agent loop,
#   3. stops/disables the old launchd agent (the app replaces it as the runner),
#   4. adds the app to Login Items so it starts automatically,
#   5. launches it now so you can grant the Excel permission once.
#
# Run it once per Mac:  bash local_agent/setup_login_app.sh
set -euo pipefail

REPO="$HOME/Vriddhi-Fuels-Website"
PLIST="$HOME/Library/LaunchAgents/com.vriddhi.paymentagent.plist"
APP="$HOME/Applications/VriddhiPaymentAgent.app"
LABEL="com.vriddhi.paymentagent"
PB=/usr/libexec/PlistBuddy

[ -f "$PLIST" ] || { echo "!! No plist at $PLIST — run the main setup first."; exit 1; }

# 1) Reuse the exact values the launchd agent was configured with.
get() { "$PB" -c "Print :EnvironmentVariables:$1" "$PLIST"; }
LEDGER="$(get MASTER_LEDGER_PATH)"
SURL="$(get SUPABASE_URL)"
SKEY="$(get SUPABASE_KEY)"
PY="$(command -v python3 || echo /usr/bin/python3)"

echo "Repo   : $REPO"
echo "Ledger : $LEDGER"
echo "Python : $PY"
[ -e "$LEDGER" ] || { echo "!! Ledger not found at that path — fix MASTER_LEDGER_PATH first."; exit 1; }

# 2) Write the AppleScript that runs the daemon forever (config baked in via
#    'quoted form of', which shell-escapes safely — spaces in the path are fine).
WORK="$(mktemp -d)"
SCPT="$WORK/agent.applescript"
cat > "$SCPT" <<APPLE
on run
    repeat
        try
            do shell script "cd " & quoted form of "$REPO" & " && export MASTER_LEDGER_PATH=" & quoted form of "$LEDGER" & " && export SUPABASE_URL=" & quoted form of "$SURL" & " && export SUPABASE_KEY=" & quoted form of "$SKEY" & " && exec " & quoted form of "$PY" & " -m local_agent.mac_agent"
        end try
        delay 5
    end repeat
end run
APPLE

# 3) Compile into a real .app, make it a background (no-dock) agent, ad-hoc sign.
rm -rf "$APP"
mkdir -p "$HOME/Applications"
osacompile -o "$APP" "$SCPT"
"$PB" -c "Add :LSUIElement bool true" "$APP/Contents/Info.plist" 2>/dev/null \
  || "$PB" -c "Set :LSUIElement true" "$APP/Contents/Info.plist"
"$PB" -c "Add :NSAppleEventsUsageDescription string Logs approved payments into Master Ledger.xlsm via Excel." "$APP/Contents/Info.plist" 2>/dev/null || true
codesign --force --deep --sign - "$APP" 2>/dev/null || true

# 4) Stop the old launchd agent so only the app runs the agent (no duplicates).
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl disable "gui/$(id -u)/${LABEL}" 2>/dev/null || true

# 5) Start the app at login (hidden).
osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$APP\", hidden:true}" 2>/dev/null \
  && echo "Added to Login Items." \
  || echo "(Could not auto-add to Login Items — add $APP manually in System Settings > General > Login Items.)"

# 6) Launch it now to trigger the one-time permission prompt.
open "$APP"

cat <<DONE

✅ Built and launched: $APP

FINAL STEP (once):
  • Make sure Excel is open on the ledger.
  • Push ONE new entry from the app with "⤴ Log to Excel".
  • A macOS prompt "VriddhiPaymentAgent wants to control Microsoft Excel"
    will appear within ~20s → click ALLOW.
  That's it — from now on it logs automatically and starts at login.

Manage it later:
  • Stop  : osascript -e 'tell app "VriddhiPaymentAgent" to quit'   (or: pkill -f local_agent.mac_agent)
  • Start : open "$APP"
  • Disable at login: System Settings > General > Login Items > remove VriddhiPaymentAgent
DONE
