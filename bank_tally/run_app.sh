#!/usr/bin/env bash
# Launch the Bank -> Tally web app on your Mac.
#   bank_tally/run_app.sh            # start the app and open the browser
cd "$(dirname "$0")/.." || exit 1
PY="${PYTHON:-python3}"

for mod in openpyxl xlrd; do
  if ! "$PY" -c "import ${mod}" >/dev/null 2>&1; then
    echo "Installing ${mod} ..."
    "$PY" -m pip install --quiet "${mod}" >/dev/null 2>&1 \
      || "$PY" -m pip install --user --quiet "${mod}"
  fi
done

exec "$PY" -m bank_tally.server "$@"
