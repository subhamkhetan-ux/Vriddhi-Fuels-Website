#!/usr/bin/env bash
# Send tank-stock screenshots to the XtraPower monitor's Telegram bot and chat.
# Copies only the bot token and chat id (not the portal logins) out of
# /opt/xtrapower/config.json into a file only the runner user can read.
# Re-run it if you change the XtraPower bot or chat.
#
#   cd ~/Vriddhi-Fuels-Website && git pull && bash infra/anydesk/use-xtrapower-bot.sh
set -euo pipefail

SRC=/opt/xtrapower/config.json
DEST=/opt/agents/tank-telegram.json

[ "$(id -u)" -ne 0 ] || { echo "Run as the ubuntu user, not root." >&2; exit 1; }
sudo test -f "$SRC" || { echo "ERROR: $SRC not found; set up XtraPower first." >&2; exit 1; }

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
sudo python3 - "$SRC" >"$tmp" <<'PY'
import json, sys
tg = json.load(open(sys.argv[1], encoding="utf-8")).get("telegram") or {}
token, chat = str(tg.get("token") or "").strip(), str(tg.get("chat_id") or "").strip()
if not token or not chat or "PUT-YOUR" in token + chat:
    sys.exit("ERROR: the XtraPower config has no Telegram token / chat id yet.")
print(json.dumps({"token": token, "chat_id": chat}))
PY
sudo install -m 600 -o runner -g runner "$tmp" "$DEST"
echo "Done: tank stock will now report to the XtraPower bot (copied to $DEST)."
