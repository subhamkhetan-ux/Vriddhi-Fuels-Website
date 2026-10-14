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
import shlex
import shutil
import socket
import subprocess
import sys
import time

from .configfile import ConfigError, load as load_config

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
    # A server install (infra/xtrapower) points this at Playwright's Chromium.
    override = os.environ.get("XTRAPOWER_CHROME")
    if override:
        return override if os.path.exists(override) else None
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    for path in _CANDIDATES.get(sys.platform, []):
        if path and os.path.exists(path):
            return path
    return None


def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def clear_stale_lock(profile: str, kill_hung: bool = False) -> bool:
    """Remove a Chromium profile lock left by a Chromium that was killed
    (the server restarted, the service was stopped hard). Chromium refuses a
    locked profile when the lock's process id now belongs to another program
    ("The profile appears to be in use by another Chromium process"), and the
    new window closes at once. ``kill_hung``: a Chromium that really holds
    the profile but whose debug port is closed (it hung) is stopped first.
    -> True if a lock was removed."""
    lock = os.path.join(profile, "SingletonLock")
    try:
        target = os.readlink(lock)                     # "<host>-<pid>"
    except OSError:
        return False
    host, _, pid = target.rpartition("-")
    try:
        pid_no = int(pid)
    except ValueError:
        pid_no = 0
    if pid_no and host == socket.gethostname() and _alive(pid_no):
        try:
            with open(f"/proc/{pid_no}/cmdline", "rb") as f:
                ours = profile.encode() in f.read()
        except OSError:
            return False                               # (no /proc: leave it to Chromium)
        if ours:
            if not kill_hung:
                return False                           # really in use: a Chromium on this profile
            _stop(pid_no)
    for name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        try:
            os.unlink(os.path.join(profile, name))
        except OSError:
            pass
    return True


def _stop(pid: int) -> None:
    """Stop a hung Chromium (its whole process group: it was started in a
    session of its own)."""
    import signal
    for sig, grace in ((signal.SIGTERM, 5), (signal.SIGKILL, 2)):
        try:
            os.killpg(os.getpgid(pid), sig)
        except OSError:
            return
        end = time.time() + grace
        while time.time() < end and _alive(pid):
            time.sleep(0.2)
        if not _alive(pid):
            return


def _why(log_path: str) -> str:
    """The line of Chromium's output that says why it stopped, if any."""
    try:
        with open(log_path, errors="replace") as f:
            lines = [l.strip() for l in f.read().splitlines()[-200:] if l.strip()]
    except OSError:
        return ""
    for key in ("Missing X server", "cannot open display", "profile appears to be in use", "FATAL",
                "No space left", "Cannot allocate memory", "ERROR"):
        hit = next((l for l in reversed(lines) if key.lower() in l.lower()), None)
        if hit:
            return hit[-300:]
    return lines[-1][-300:] if lines else ""


def launch_account(chrome: str, acct: dict, profiles_dir: str, wait: float = 0) -> dict:
    """Start the account's Chrome window. With ``wait``, wait that many
    seconds for its debug port to open. -> {"ok", "message"}."""
    label = acct.get("label") or acct.get("customer_id")
    port = int(acct["cdp_port"])
    profile = os.path.join(profiles_dir, str(acct.get("customer_id") or label).replace(" ", "_"))
    os.makedirs(profile, exist_ok=True)
    if wait and port_open(port):
        print(f"  ▸ {label:20s}  port {port}  already open")
        return {"ok": True, "message": "already running"}
    notes = []
    if sys.platform.startswith("linux") and clear_stale_lock(profile, kill_hung=bool(wait)):
        notes.append("cleared a stale or hung window's profile lock")
    args = [
        chrome,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        # Extra flags for headless servers, e.g. "--no-sandbox --password-store=basic".
        *shlex.split(os.environ.get("XTRAPOWER_CHROME_FLAGS", "")),
        PORTAL_URL,
    ]
    # Detach so closing this script doesn't close the browsers.
    kwargs: dict = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x00000008  # DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    log_path = profile.rstrip("/") + ".log"
    out = None
    if wait:
        out = open(log_path, "w")                      # (this window's own output, to say why it stopped)
        kwargs["stdout"] = kwargs["stderr"] = out
    try:
        proc = subprocess.Popen(args, **kwargs)
    finally:
        if out:
            out.close()
    print(f"  ▸ {label:20s}  port {port}  profile {profile}" + (f"  ({', '.join(notes)})" if notes else ""))
    if not wait:
        return {"ok": True, "message": "started"}
    deadline = time.time() + wait
    while time.time() < deadline:
        if port_open(port):
            return {"ok": True, "message": "open" + (f" ({', '.join(notes)})" if notes else "")}
        if proc.poll() is not None:
            break
        time.sleep(0.5)
    if proc.poll() is None:
        message = f"Chromium is running but its port {port} didn't open within {int(wait)} s"
    else:
        message = f"Chromium closed at once (exit code {proc.returncode})"
    why = _why(log_path)
    return {"ok": False, "message": message + (f": {why}" if why else "")}


def write_status(path: str, results: dict) -> None:
    """What the last launch of each account's window did, for the monitor."""
    try:
        with open(path) as f:
            status = json.load(f)
    except (OSError, ValueError):
        status = {}
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    for cid, r in results.items():
        status[cid] = {**r, "at": stamp}
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(status, f)
    os.replace(tmp, path)


def main() -> None:
    ap = argparse.ArgumentParser(description="Launch Chrome windows for XtraPower login")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(__file__), "config.json"))
    ap.add_argument("--only", default=None, help="launch just this customer_id")
    ap.add_argument("--wait", type=float, default=0,
                    help="wait this many seconds for each window's debug port; exit 1 if one didn't open")
    args = ap.parse_args()

    try:
        cfg = load_config(args.config)
    except ConfigError as exc:
        sys.exit(f"\n{exc}\n")

    chrome = find_chrome()
    if not chrome:
        sys.exit("Could not find Chrome. Install Google Chrome, or edit _CANDIDATES in launch.py.")

    home = os.path.dirname(os.path.abspath(args.config))
    profiles_dir = os.path.join(home, "profiles")
    accounts = [a for a in cfg.get("accounts", []) if a.get("watch", True)]
    if args.only:
        accounts = [a for a in accounts if str(a.get("customer_id")) == args.only]
    if not accounts:
        sys.exit("No matching accounts in config.")

    print(f"Launching {len(accounts)} Chrome window(s) with {chrome}:")
    results = {}
    for acct in accounts:
        results[str(acct.get("customer_id") or acct.get("label"))] = launch_account(
            chrome, acct, profiles_dir, wait=args.wait)
    if args.wait:
        write_status(os.path.join(home, "launch-status.json"), results)
        failed = {cid: r["message"] for cid, r in results.items() if not r["ok"]}
        for cid, message in failed.items():
            print(f"Chromium for {cid} did not open: {message}")
        sys.exit(1 if failed else 0)

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
