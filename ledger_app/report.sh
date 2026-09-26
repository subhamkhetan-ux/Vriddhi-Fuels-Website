#!/usr/bin/env bash
# Write the Master Ledger structure report (every sheet, formula and macro) and,
# with --push, send it to a PRIVATE GitHub repo so it can be read from there.
#
#   bash ledger_app/report.sh                    # find Master Ledger.xlsm, write ledger_app/out/
#   bash ledger_app/report.sh --push             # ...then send the report to your private repo
#   bash ledger_app/report.sh "/path/to/Master Ledger.xlsm" --push
#
# Safety:
#   * The workbook is only read, never changed.
#   * Nothing is ever committed to this repo: it is public and it serves the
#     live apps. The report is written to ledger_app/out/, which git ignores.
#   * --push works in a temporary folder and sends the report to a separate
#     private repo, <your account>/vriddhi-ledger-private by default
#     (LEDGER_REPORT_REPO=owner/name to change it). It refuses if that repo is
#     public, and never touches your branches or files here.
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
PY="${PYTHON:-python3}"
OUT="${LEDGER_REPORT_OUT:-$ROOT/ledger_app/out}"

PUSH=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --push) PUSH=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

# openpyxl reads the sheets; oletools reads the VBA source out of the .xlsm.
for mod in openpyxl oletools; do
  if ! "$PY" -c "import ${mod}" >/dev/null 2>&1; then
    echo "Installing ${mod} ..."
    # Plain, then per-user, then past macOS/Homebrew's "externally-managed" guard.
    "$PY" -m pip install --quiet "${mod}" \
      || "$PY" -m pip install --user --quiet "${mod}" \
      || "$PY" -m pip install --user --break-system-packages --quiet "${mod}"
  fi
  if ! "$PY" -c "import ${mod}" >/dev/null 2>&1; then
    echo "ERROR: couldn't install the Python package '${mod}'."
    echo "       Fix it once with:   ${PY} -m pip install --user ${mod}"
    exit 1
  fi
done

RUN="$(mktemp -d)"
trap 'rm -rf "$RUN"' EXIT

# ${ARGS[@]+...} keeps macOS's bash 3.2 happy when no path was given.
"$PY" -m ledger_app.inspect_workbook --out "$OUT" --manifest "$RUN/files" ${ARGS[@]+"${ARGS[@]}"} || exit 1

if [ "$PUSH" != 1 ]; then
  echo "Done. To send it to your private repo:  bash ledger_app/report.sh --push"
  exit 0
fi

# Where to send it: a private repo on the same GitHub account as this one.
ORIGIN="$(git config --get remote.origin.url 2>/dev/null || true)"
OWNER="$(printf '%s' "$ORIGIN" | sed -E 's#^(git@github\.com:|https://([^@/]+@)?github\.com/)##; s#/.*##')"
if [ -z "${LEDGER_REPORT_REPO:-}" ] && [ -z "$OWNER" ]; then
  echo "⚠️  Couldn't work out your GitHub account. Run with LEDGER_REPORT_REPO=owner/name."
  exit 1
fi
REPO="${LEDGER_REPORT_REPO:-${OWNER}/vriddhi-ledger-private}"
URL="${LEDGER_REPORT_URL:-}"
if [ -z "$URL" ]; then
  case "$ORIGIN" in
    git@github.com:*) URL="git@github.com:${REPO}.git" ;;
    *)                URL="https://github.com/${REPO}.git" ;;
  esac
fi

# Never publish: a repo anyone can see answers GitHub's public API with 200.
case "$URL" in
  *github.com*)
    code="$(curl -s -o /dev/null -w '%{http_code}' "https://api.github.com/repos/${REPO}" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then
      echo "⛔ ${REPO} is PUBLIC, so anyone could read the report. Nothing was sent."
      echo "   Make it private on GitHub (Settings → Danger Zone → Change visibility), or pick"
      echo "   another repo:  LEDGER_REPORT_REPO=owner/name bash ledger_app/report.sh --push"
      exit 1
    fi
    if [ "$code" != "404" ]; then
      echo "⚠️  Couldn't confirm ${REPO} is private (GitHub answered '${code:-nothing}'). Nothing was sent; try again."
      exit 1
    fi ;;
esac

if ! git clone --quiet --depth 1 "$URL" "$RUN/private" 2>"$RUN/clone.err"; then
  echo "⚠️  Couldn't open ${REPO}. Create it on GitHub as a Private repository"
  echo "   (https://github.com/new, name: ${REPO#*/}), then run this again."
  tail -n 2 "$RUN/clone.err" | sed 's/^/   /'
  exit 1
fi
while IFS= read -r f; do
  cp "$f" "$RUN/private/"
done < "$RUN/files"
cd "$RUN/private" || exit 1
git add -A
if git diff --cached --quiet; then
  echo "The report hasn't changed since the last push. Nothing to send."
  exit 0
fi
git -c user.name="Master Ledger report" -c user.email="ledger-report@users.noreply.github.com" \
  commit --quiet -m "Master Ledger structure report" || exit 1
if git push --quiet origin HEAD:main 2>"$RUN/push.err"; then
  echo "✅ Report sent to the private repo ${REPO}. Nothing in this repo was changed."
else
  echo "⚠️  Couldn't push to ${REPO}:"
  tail -n 3 "$RUN/push.err" | sed 's/^/   /'
  exit 1
fi
