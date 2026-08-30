#!/usr/bin/env bash
# Launch the Bank -> Tally web app on your Mac.
#   bank_tally/run_app.sh            # start + open browser
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
PY="${PYTHON:-python3}"
for m in openpyxl xlrd; do
  "$PY" -c "import $m" >/dev/null 2>&1 || { echo "Installing $m…"; "$PY" -m pip install --quiet "$m" || "$PY" -m pip install --user --quiet "$m"; }
done
exec "$PY" -m bank_tally.server "$@"
