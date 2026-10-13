#!/usr/bin/env bash
# One-time setup of the India self-hosted GitHub Actions runner (Oracle Cloud
# Always Free, Ubuntu 22.04/24.04, Ampere A1 arm64 or x86-64).
#
#   git clone https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website.git
#   cd Vriddhi-Fuels-Website && bash infra/india-runner/setup.sh
#
# Run as the default `ubuntu` user (needs sudo). The runner itself runs as a
# separate `runner` user WITHOUT sudo. Re-running the script is safe.
# See infra/india-runner/README.md.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website}"
RUNNER_NAME="${RUNNER_NAME:-oracle-india}"
RUNNER_LABELS="india"
RUNNER_USER="runner"
RUNNER_DIR="/opt/actions-runner"
AGENTS_DIR="/opt/agents"
PORTAL="https://utkarsh.indianoil.co.in/ioconline/iocExStart.jsp"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as the ubuntu user, not root (the script uses sudo where needed)."
case "$(uname -m)" in
  aarch64) ARCH=arm64 ;;
  x86_64)  ARCH=x64 ;;
  *) die "Unsupported CPU architecture $(uname -m)." ;;
esac
. /etc/os-release
case "${ID}-${VERSION_ID}" in
  ubuntu-22.04|ubuntu-24.04) ;;
  *) die "Use an Ubuntu 22.04 or 24.04 image (found ${PRETTY_NAME})." ;;
esac

say "1/6 Checking that this server can reach IOCL e-Mitra"
code="$(curl -sS -m 30 -o /dev/null -w '%{http_code}' "$PORTAL" || true)"
if [ -z "$code" ] || [ "$code" = "000" ]; then
  [ "${SKIP_PORTAL_CHECK:-}" = "1" ] || die "e-Mitra did not answer from this server (no connection).
The portal blocks this network, so the agent cannot work here. Nothing was installed.
(Set SKIP_PORTAL_CHECK=1 to install anyway for other agents.)"
  echo "Portal unreachable; continuing because SKIP_PORTAL_CHECK=1."
else
  echo "e-Mitra answered with HTTP $code. Good."
fi

# The 1 GB E2.1.Micro cannot hold Chromium and apt in memory; give small
# servers a 2 GB swap file so they work (slowly) until an A1 is available.
mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
if [ "$mem_kb" -lt 3000000 ] && [ -z "$(swapon --noheadings)" ]; then
  say "Adding a 2 GB swap file (this server has under 3 GB of memory)"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

say "2/6 Installing system packages (Python, Tesseract OCR)"
sudo apt-get update -q
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
  ca-certificates curl git tar python3 python3-venv python3-pip tesseract-ocr

say "3/6 Creating the unprivileged '$RUNNER_USER' user"
if ! id "$RUNNER_USER" >/dev/null 2>&1; then
  sudo useradd --create-home --shell /bin/bash "$RUNNER_USER"
fi
sudo install -d -o "$RUNNER_USER" -g "$RUNNER_USER" "$AGENTS_DIR" "$RUNNER_DIR"

say "4/6 Python environment, Playwright Chromium and its system libraries"
sudo -u "$RUNNER_USER" -H python3 -m venv "$AGENTS_DIR/venv"
sudo -u "$RUNNER_USER" -H "$AGENTS_DIR/venv/bin/python" -m pip install -q --upgrade pip
# Home folders are private on Ubuntu 22.04+, so hand the runner user a copy.
reqs="$(mktemp)"; install -m 644 "$ROOT/iocl_portal/requirements.txt" "$reqs"
sudo -u "$RUNNER_USER" -H "$AGENTS_DIR/venv/bin/python" -m pip install -q -r "$reqs"
rm -f "$reqs"
# System libraries need root; the browser download goes to the runner's cache.
sudo "$AGENTS_DIR/venv/bin/python" -m playwright install-deps chromium
sudo -u "$RUNNER_USER" -H "$AGENTS_DIR/venv/bin/python" -m playwright install chromium

say "5/6 Downloading the GitHub Actions runner (linux-$ARCH)"
if [ ! -x "$RUNNER_DIR/config.sh" ]; then
  release="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)"
  read -r version sha < <(printf '%s' "$release" | ARCH="$ARCH" python3 -c '
import json, os, re, sys
d = json.load(sys.stdin)
arch = os.environ["ARCH"]
m = re.search(r"BEGIN SHA linux-" + arch + r" -->\s*([0-9a-f]{64})", d.get("body", ""))
print(d["tag_name"].lstrip("v"), m.group(1) if m else "")')
  [ -n "$sha" ] || die "Could not read the runner checksum. Use the commands from GitHub > Settings > Actions > Runners > New self-hosted runner instead."
  tarball="actions-runner-linux-$ARCH-$version.tar.gz"
  curl -fsSL -o "/tmp/$tarball" "https://github.com/actions/runner/releases/download/v$version/$tarball"
  echo "$sha  /tmp/$tarball" | sha256sum -c - || die "Runner download failed its checksum."
  sudo -u "$RUNNER_USER" tar -xzf "/tmp/$tarball" -C "$RUNNER_DIR"
  rm -f "/tmp/$tarball"
  sudo "$RUNNER_DIR/bin/installdependencies.sh"
else
  echo "Runner already downloaded."
fi

say "6/6 Registering the runner with GitHub"
if [ ! -f "$RUNNER_DIR/.runner" ]; then
  if [ -z "${RUNNER_TOKEN:-}" ]; then
    echo "On GitHub open: Settings > Actions > Runners > New self-hosted runner (Linux)."
    echo "Copy only the token after --token in the 'Configure' box (valid for 1 hour)."
    read -rsp "Paste the registration token (input hidden): " RUNNER_TOKEN; echo
  fi
  # Forgive a pasted "--token" prefix, quotes, spaces or terminal paste markers.
  RUNNER_TOKEN="$(printf '%s' "$RUNNER_TOKEN" | sed -e 's/\x1b\[20[01]~//g' -e 's/--token//' | tr -d "[:space:]'\"")"
  case "$RUNNER_TOKEN" in
    *[!A-Za-z0-9]*|"") die "That doesn't look like a registration token (expected only letters and digits).
Copy just the code after --token and re-run:  RUNNER_TOKEN='CODE' bash infra/india-runner/setup.sh" ;;
  esac
  echo "Using token ${RUNNER_TOKEN:0:2}…${RUNNER_TOKEN: -2} (${#RUNNER_TOKEN} characters)."
  if ! sudo -u "$RUNNER_USER" -H bash -c 'cd "$1" && ./config.sh --unattended --replace \
      --url "$2" --token "$3" --name "$4" --labels "$5" --work _work' \
    _ "$RUNNER_DIR" "$REPO_URL" "$RUNNER_TOKEN" "$RUNNER_NAME" "$RUNNER_LABELS"; then
    die "GitHub rejected the registration (a 404 means the token is expired, already used or incomplete).
Refresh the GitHub 'New self-hosted runner' page for a new token and re-run:
  RUNNER_TOKEN='CODE' bash infra/india-runner/setup.sh"
  fi
  unset RUNNER_TOKEN
  (cd "$RUNNER_DIR" && sudo ./svc.sh install "$RUNNER_USER" && sudo ./svc.sh start)
else
  echo "Runner already registered; making sure the service is running."
  (cd "$RUNNER_DIR" && sudo ./svc.sh start || true)
fi

say "Done. In GitHub > Settings > Actions > Runners, '$RUNNER_NAME' should show Idle."
echo "Next: run the 'IOCL e-Mitra PAD balance -> Payments' workflow in 'network', then 'probe' mode."
