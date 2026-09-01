#!/usr/bin/env bash
# Dump the login page's real fields/buttons so login selectors can be tuned.
# Run this while a window is showing the LOGIN screen. Usage:
#   ./xtrapower/inspect-mac.sh              # first watched account
#   ./xtrapower/inspect-mac.sh --port 9222
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root
if [ ! -d .venv ]; then
  echo "✗ No .venv found — run ./xtrapower/setup-mac.sh first."
  exit 1
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python -m xtrapower.inspect_login --config xtrapower/config.json "$@"
