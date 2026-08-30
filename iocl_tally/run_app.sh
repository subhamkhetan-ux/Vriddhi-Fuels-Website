#!/usr/bin/env bash
# Launch the IOCL PAD -> Tally web app on your Mac.
#
#   iocl_tally/run_app.sh            # start the app and open the browser
#   iocl_tally/run_app.sh --port 9001
#
# It runs a tiny local server (127.0.0.1 only) and opens a browser tab. Drop the
# month's PAD PDF in, and it hands you IOCL_import.xml for Tally. Ctrl-C to stop.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PY="${PYTHON:-python3}"

if ! "$PY" -c "import pymupdf" >/dev/null 2>&1; then
  echo "Installing PDF reader (pymupdf)..."
  "$PY" -m pip install --quiet "pymupdf>=1.24"
fi

exec "$PY" -m iocl_tally.server "$@"
