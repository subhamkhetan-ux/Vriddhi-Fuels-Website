"""Launch one Chrome window per account, ready for a manual login.

Each account gets its own Chrome process with:
  * ``--remote-debugging-port=<cdp_port>`` so the monitor can attach, and
  * ``--user-data-dir=<profiles>/<label>`` so several accounts can be logged in
    at once without their cookies colliding (a single Chrome profile can only
    hold one XtraPower session).

You then log in by hand in each window and leave it on the Balance Info screen.
Only Chrome/Chromium is launched — the portal does not work in Safari.

Usage:
    python -m xtrapower.launch --config xtrapower/config.json
    python -m xtrapower.launch --config xtrapower/config.json --only 1005218882
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys

PORTAL_URL = "https://beta.iocxtrapower.com"

# Common Chrome / Chromium locations per OS, plus anything on PATH.
_CANDIDATES = {
    "darwin": [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    "win32": [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ],
    "linux": [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ],
}


def find_chrome() -> str | None:
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    for path in _CANDIDATES.get(sys.platform, []):
        if path and os.path.exists(path):
            return path
    return None


def launch_account(chrome: str, acct: dict, profiles_dir: str) -> None:
    label = acct.get("label") or acct.get("customer_id")
    port = int(acct["cdp_port"])
    profile = os.path.join(profiles_dir, str(acct.get("customer_id") or label).replace(" ", "_"))
    os.makedirs(profile, exist_ok=True)
    args = [
        chrome,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        PORTAL_URL,
    ]
    # Detach so closing this script doesn't close the browsers.
    kwargs: dict = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x00000008  # DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(args, **kwargs)
    print(f"  ▸ {label:20s}  port {port}  profile {profile}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Launch Chrome windows for XtraPower login")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(__file__), "config.json"))
    ap.add_argument("--only", default=None, help="launch just this customer_id")
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)

    chrome = find_chrome()
    if not chrome:
        sys.exit("Could not find Chrome. Install Google Chrome, or edit _CANDIDATES in launch.py.")

    profiles_dir = os.path.join(os.path.dirname(os.path.abspath(args.config)), "profiles")
    accounts = [a for a in cfg.get("accounts", []) if a.get("watch", True)]
    if args.only:
        accounts = [a for a in accounts if str(a.get("customer_id")) == args.only]
    if not accounts:
        sys.exit("No matching accounts in config.")

    print(f"Launching {len(accounts)} Chrome window(s) with {chrome}:")
    for acct in accounts:
        launch_account(chrome, acct, profiles_dir)

    print(
        "\nNow, in EACH window:\n"
        "  1. Log in to your XtraPower account.\n"
        "  2. Go to Financials → Balance Info and run one Search so the table is showing.\n"
        "  3. Leave the window open on that screen.\n\n"
        "Then start the monitor:\n"
        f"  python -m xtrapower.monitor --config {args.config} --announce\n"
    )


if __name__ == "__main__":
    main()
