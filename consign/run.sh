#!/usr/bin/env bash
# Launch the standalone consignment-note app on your Mac.
#
#   consign/run.sh            # start the app and open the browser
#   consign/run.sh --port 9000
#
# It runs a tiny local server (127.0.0.1 only) and opens a browser tab. Leave the
# terminal window open while you use it; press Ctrl-C to stop.
set -euo pipefail

# Repo root = the parent of this script's folder.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY="${PYTHON:-python3}"

# Ensure the one runtime dependency (PDF text extraction) is present.
if ! "$PY" -c "import pymupdf" >/dev/null 2>&1; then
  echo "Installing PDF reader (pymupdf)…"
  "$PY" -m pip install --quiet "pymupdf>=1.24"
fi

exec "$PY" -m consign.server "$@"
