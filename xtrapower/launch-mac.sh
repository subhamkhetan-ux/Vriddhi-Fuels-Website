#!/usr/bin/env bash
# Open one Chrome window per account so you can log in. Usage:
#   ./xtrapower/launch-mac.sh            # all watched accounts
#   ./xtrapower/launch-mac.sh --only 1005218882
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root
if [ ! -d .venv ]; then
  echo "✗ No .venv found — run ./xtrapower/setup-mac.sh first."
  exit 1
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python -m xtrapower.launch --config xtrapower/config.json "$@"
