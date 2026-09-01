#!/usr/bin/env bash
# One-time setup for the XtraPower monitor on macOS.
# Creates an isolated Python environment, installs Playwright, and makes your
# config file. Safe to re-run. Usage:  ./xtrapower/setup-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ Python 3 isn't installed yet."
  echo "  Run:  xcode-select --install"
  echo "  Finish the popup that appears, then run this script again."
  exit 1
fi
echo "✓ Found $(python3 --version)"

echo "→ Creating an isolated environment in .venv …"
python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate

echo "→ Installing Playwright (this can take a minute) …"
python -m pip install --upgrade pip >/dev/null
python -m pip install -r xtrapower/requirements.txt

if [ ! -f xtrapower/config.json ]; then
  cp xtrapower/config.example.json xtrapower/config.json
  echo "✓ Created xtrapower/config.json"
  CREATED_CONFIG=1
else
  echo "✓ xtrapower/config.json already exists — leaving it as is"
  CREATED_CONFIG=0
fi

echo
echo "─────────────────────────────────────────────"
echo "Setup done. Next steps:"
if [ "$CREATED_CONFIG" = "1" ]; then
  echo "  1. Put your Telegram token + accounts in the config:"
  echo "       open -e xtrapower/config.json"
fi
echo "  • Open the login windows:   ./xtrapower/launch-mac.sh"
echo "  • Start monitoring:         ./xtrapower/run-mac.sh"
echo "─────────────────────────────────────────────"
