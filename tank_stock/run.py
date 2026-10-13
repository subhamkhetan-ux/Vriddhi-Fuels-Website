"""python -m tank_stock.run --capture

Stage 1: AnyDesk screenshot of the IOCL automation PC, sent privately to
Telegram. (Stage 2 will hand it to the decant app's Stock reader.)
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import os
import sys

from . import telegram
from .capture import CaptureError, capture, parse_ids

IST = timezone(timedelta(hours=5, minutes=30))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Tank stock from the IOCL automation PC via AnyDesk")
    ap.add_argument("--capture", action="store_true", required=True,
                    help="connect, screenshot, send it to Telegram")
    ap.parse_args(argv)
    when = datetime.now(IST).strftime("%d %b %Y %I:%M %p IST")
    try:
        ids = parse_ids(os.environ.get("ANYDESK_IDS") or os.environ.get("ANYDESK_ID", ""))
        png, seen, used = capture(ids, os.environ.get("ANYDESK_PASSWORD", ""))
    except CaptureError as exc:
        print(f"Tank stock capture stopped: {exc}", file=sys.stderr)
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
    sent = telegram.send_photo(png, f"Tank stock screen via AnyDesk ID #{used} ({ids[used - 1]}), {when}.\n"
                                    f"Windows: {titles}")
    print(f"Captured the screen via ID #{used} of {len(ids)} ({len(png) // 1024} KB, {len(seen)} windows); "
          f"{'sent to Telegram' if sent else 'Telegram delivery failed'}.")
    return 0 if sent else 1


if __name__ == "__main__":
    raise SystemExit(main())
