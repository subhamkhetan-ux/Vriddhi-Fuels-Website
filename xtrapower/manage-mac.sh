#!/usr/bin/env bash
# Open the XtraPower account manager on this Mac: the page for adding,
# editing and deleting accounts, switching watching on/off, and editing the
# Telegram settings. Like the Tally apps, it runs only on this Mac
# (http://127.0.0.1:8780) — nothing else on the network can reach it.
#
#   ./xtrapower/manage-mac.sh        # start it and open the page; Ctrl-C to stop
#
# Changes reach the running monitor on its next check (about 2 minutes); you
# don't need to keep this page open or restart the monitor.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root
PY=".venv/bin/python"
[ -x "$PY" ] || PY="python3"     # standard library only; any Python 3 works
exec "$PY" -m xtrapower.manage "$@"
