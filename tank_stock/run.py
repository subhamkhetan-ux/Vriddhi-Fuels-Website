"""python -m tank_stock.run --capture

Stage 1: AnyDesk screenshot of the IOCL automation PC, sent privately to
Telegram. (Stage 2 will hand it to the decant app's Stock reader.)

AnyDesk only starts inside the logged-in user's session, which a GitHub job
is not part of. So when the server has the session's capture queue
(infra/anydesk/setup.sh), the job leaves a request there and relays the
result; tank-stock-session.sh runs ``--in-session`` with it.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import time
import uuid

from . import telegram
from .capture import CaptureError, capture, diagnosis, parse_ids

IST = timezone(timedelta(hours=5, minutes=30))
QUEUE = Path(os.environ.get("TANK_STOCK_QUEUE", "/opt/agents/tank-stock-queue"))
# What the capture in the session needs from the job's environment.
PASS_ENV = ("ANYDESK_IDS", "ANYDESK_ID", "ANYDESK_PASSWORD", "TANK_TELEGRAM_TOKEN", "TANK_TELEGRAM_CHAT")
SESSION_WAIT = 400   # seconds; the job's timeout is 8 minutes


def via_session(wait: int = SESSION_WAIT) -> int:
    """Leave the capture to the login session and relay its output."""
    job = QUEUE / uuid.uuid4().hex
    env = {k: os.environ[k] for k in PASS_ENV if os.environ.get(k)}
    fd = os.open(f"{job}.env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(env, f)
    Path(f"{job}.tmp").write_text(os.getcwd(), encoding="utf-8")
    os.replace(f"{job}.tmp", f"{job}.req")
    print("Capturing inside the runner's login session...", flush=True)
    rc_file, deadline = Path(f"{job}.rc"), time.monotonic() + wait
    while not rc_file.exists() and time.monotonic() < deadline:
        time.sleep(2)
    try:
        if not rc_file.exists():
            print("The login session never picked up the capture. On the server check: "
                  "systemctl status tank-stock-session", file=sys.stderr)
            return 1
        print(Path(f"{job}.log").read_text(encoding="utf-8", errors="replace"), end="")
        return int(rc_file.read_text().strip() or 1)
    finally:
        for ext in (".req", ".env", ".log", ".rc"):
            Path(f"{job}{ext}").unlink(missing_ok=True)


def in_session(job: str) -> int:
    """Run by tank-stock-session.sh, inside the session, for one request."""
    env_file = Path(f"{job}.env")
    env = json.loads(env_file.read_text(encoding="utf-8"))
    env_file.unlink()
    os.environ.update(env)
    return capture_and_report()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Tank stock from the IOCL automation PC via AnyDesk")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--capture", action="store_true", help="connect, screenshot, send it to Telegram")
    mode.add_argument("--in-session", metavar="REQUEST", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    if args.in_session:
        return in_session(args.in_session)
    if QUEUE.is_dir():
        return via_session()
    print("No login-session queue on this server (re-run infra/anydesk/setup.sh); "
          "capturing directly.", flush=True)
    return capture_and_report()


def capture_and_report() -> int:
    when = datetime.now(IST).strftime("%d %b %Y %I:%M %p IST")
    try:
        ids = parse_ids(os.environ.get("ANYDESK_IDS") or os.environ.get("ANYDESK_ID", ""))
        png, seen, used, page = capture(ids, os.environ.get("ANYDESK_PASSWORD", ""))
    except CaptureError as exc:
        print(f"Tank stock capture stopped: {exc}", file=sys.stderr)
        if exc.trace:
            for line in diagnosis(exc.trace):
                print(f"  {line}")
        sent = telegram.send_text(f"⚠️ Tank stock capture failed ({when}): {exc}")
        # Private only: what each attempt's virtual screen showed.
        delivered = 0
        for a in exc.attempts:
            titles = "; ".join(f"{t or '(untitled)'} {w}x{h}" for _, t, w, h in a["windows"]) or "none"
            code = a.get("exit")
            note = (f"Attempt with ID #{a['position']} ({a['id']}): windows {titles}; connect command "
                    f"{'still running' if code is None else f'exited with {code}'}.\n"
                    f"AnyDesk output: {a['output'].strip()[-600:] or '(none)'}")
            if a["png"]:
                delivered += telegram.send_photo(a["png"], note)
            else:
                delivered += telegram.send_text(note + "\n(no screenshot)")
        if exc.trace:
            sent_trace = telegram.send_file(exc.trace.encode(), "anydesk-trace.txt", "text/plain",
                                            "AnyDesk's own logs from this run")
        print(f"Telegram: failure notice {'sent' if sent else 'NOT sent'}; "
              f"{delivered} of {len(exc.attempts)} attempt report(s) delivered"
              + (f"; AnyDesk trace {'sent' if sent_trace else 'NOT sent'}." if exc.trace else "."))
        return 1
    # Window titles can carry the PC's ID or name: Telegram only, not the log.
    titles = "; ".join(f"{t or '(untitled)'} {w}x{h}" for _, t, w, h in seen) or "none"
    sent = telegram.send_photo(png, f"Tank stock screen via AnyDesk ID #{used} ({ids[used - 1]}), {when}: "
                                    f"{page}.\nWindows: {titles}")
    print(f"Captured the screen via ID #{used} of {len(ids)} ({len(png) // 1024} KB, {len(seen)} windows; "
          f"{page}); {'sent to Telegram' if sent else 'Telegram delivery failed'}.")
    return 0 if sent else 1


if __name__ == "__main__":
    raise SystemExit(main())
