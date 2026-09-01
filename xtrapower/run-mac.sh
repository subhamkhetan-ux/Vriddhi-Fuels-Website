#!/usr/bin/env bash
# Start the monitor. It waits quietly for each account until you've logged it
# in, then sends a ✅ and watches for credits. Ctrl-C to stop. Usage:
#   ./xtrapower/run-mac.sh          # monitor continuously
#   ./xtrapower/run-mac.sh --once   # one test pass, then exit
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root
if [ ! -d .venv ]; then
  echo "✗ No .venv found — run ./xtrapower/setup-mac.sh first."
  exit 1
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python -m xtrapower.monitor --config xtrapower/config.json --announce "$@"
