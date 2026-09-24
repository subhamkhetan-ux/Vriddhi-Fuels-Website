#!/usr/bin/env bash
# Launch the Bank -> Tally web app on your Mac.
#   bank_tally/run_app.sh            # start the app and open the browser
cd "$(dirname "$0")/.." || exit 1
PY="${PYTHON:-python3}"

# openpyxl reads .xlsx (ICICI); xlrd reads the legacy binary .xls that HDFC
# statements download as. Both are required.
for mod in openpyxl xlrd; do
  if ! "$PY" -c "import ${mod}" >/dev/null 2>&1; then
    echo "Installing ${mod} ..."
    # Plain, then per-user, then past macOS/Homebrew's "externally-managed" guard.
    "$PY" -m pip install --quiet "${mod}" \
      || "$PY" -m pip install --user --quiet "${mod}" \
      || "$PY" -m pip install --user --break-system-packages --quiet "${mod}"
  fi
  if ! "$PY" -c "import ${mod}" >/dev/null 2>&1; then
    echo ""
    echo "ERROR: the Python package '${mod}' is not installed, and installing it failed."
    echo "       Without it some statements cannot be read."
    echo "       Fix it once with:   ${PY} -m pip install --user ${mod}"
    echo "       (if that is refused: ${PY} -m pip install --user --break-system-packages ${mod})"
    echo ""
    exit 1
  fi
done

exec "$PY" -m bank_tally.server "$@"
