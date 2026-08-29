"""The always-on daemon: drain log-requested payments into Master Paid.

launchd keeps this process alive (see ``com.vriddhi.paymentagent.plist``). Each
loop it:

  1. reads rows the /payments app pressed "Log to Excel" on (and hasn't logged),
  2. writes them into the Master Paid sheet of Master Ledger.xlsm via Excel,
  3. stamps each logged + exported in Supabase and posts a 'posted' event,
  4. emits a periodic 'heartbeat' so the app shows the agent online.

Offline / Excel-closed is a non-event: the queue keeps filling in the cloud, and
whatever accumulated flushes on the next healthy loop. Two idempotency guards
(the Mac-local seen-store and Supabase's ``logged_at``) make that flush safe — no
payment is ever written twice, even after the Mac is off for a week.

Run directly for a one-shot drain (handy for testing):

    MASTER_LEDGER_PATH=~/…/Master\\ Ledger.xlsm \\
    SUPABASE_URL=… SUPABASE_KEY=… python3 -m local_agent.mac_agent --once
"""

from __future__ import annotations

import argparse
import sys
import time

from . import poster
from .config import Config, from_env
from .excel_writer import ExcelUnavailable, ExcelWriter
from .seen_store import SeenStore
from .supabase_client import SupabaseClient


def _drain_once(cfg: Config, sb: SupabaseClient, writer: ExcelWriter, seen: SeenStore) -> int:
    """One read -> write -> mark pass. Returns rows posted (0 if none/holding).

    Opens Excel + the ledger only when there is something to write, and closes /
    quits them afterwards (see ExcelWriter.close_session), so the ledger and Excel
    don't have to be left open."""
    rows = sb.fetch_log_requested()
    if not rows:
        return 0
    if not poster.select_postable(rows, seen):
        return 0
    writer.open_session()  # launches Excel / opens the ledger as needed
    try:
        return poster.post_batch(rows, writer, seen, sb)
    finally:
        writer.close_session()  # save + close/quit what we opened


def run(cfg: Config, *, once: bool = False) -> int:
    if not cfg.configured:
        print(
            "Not configured — set MASTER_LEDGER_PATH, SUPABASE_URL and SUPABASE_KEY "
            "(see local_agent/README.md).",
            file=sys.stderr,
        )
        return 2

    sb = SupabaseClient(cfg)
    writer = ExcelWriter(cfg.ledger_path, cfg.sheet_name)
    seen = SeenStore(cfg.seen_path)

    if once:
        try:
            posted = _drain_once(cfg, sb, writer, seen)
            print(f"Posted {posted} entr{'y' if posted == 1 else 'ies'}.")
            return 0
        except ExcelUnavailable as ex:
            print(f"Excel unavailable: {ex}", file=sys.stderr)
            sb.event("error", detail=str(ex))
            return 1

    sb.event("heartbeat", detail="agent started")
    last_heartbeat = time.monotonic()
    print(f"Payment agent running — polling every {cfg.poll_seconds}s. Ctrl-C to stop.")

    while True:
        try:
            _drain_once(cfg, sb, writer, seen)
        except ExcelUnavailable as ex:
            # Excel closed / workbook locked — hold the batch and tell the app.
            sb.event("error", detail=str(ex))
        except Exception as ex:  # network blip reading the queue, etc.
            print(f"loop error (will retry): {ex}", file=sys.stderr)

        now = time.monotonic()
        if now - last_heartbeat >= cfg.heartbeat_seconds:
            sb.event("heartbeat")
            last_heartbeat = now

        time.sleep(cfg.poll_seconds)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Vriddhi payment logging agent (Mac)")
    ap.add_argument("--once", action="store_true", help="drain once and exit (no loop)")
    args = ap.parse_args(argv)
    return run(from_env(), once=args.once)


if __name__ == "__main__":
    raise SystemExit(main())
