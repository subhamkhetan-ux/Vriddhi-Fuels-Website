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
  # Plain, then per-user, then past macOS/Homebrew's "externally-managed" guard.
  "$PY" -m pip install --quiet "pymupdf>=1.24" \
    || "$PY" -m pip install --user --quiet "pymupdf>=1.24" \
    || "$PY" -m pip install --user --break-system-packages --quiet "pymupdf>=1.24" \
    || true
fi
if ! "$PY" -c "import pymupdf" >/dev/null 2>&1; then
  echo ""
  echo "ERROR: the Python package 'pymupdf' is not installed, and installing it failed."
  echo "       Without it the PAD and invoice PDFs cannot be read."
  echo "       Fix it once with:   ${PY} -m pip install --user pymupdf"
  echo "       (if that is refused: ${PY} -m pip install --user --break-system-packages pymupdf)"
  echo ""
  exit 1
fi

exec "$PY" -m iocl_tally.server "$@"
