"""Always-on Mac half of the Gmail -> Master Paid agent.

Where the cloud agent (``agent/``) parses bank credit alerts and the ``/payments``
app lets you resolve names and press **Log to Excel**, this package is the piece
that actually writes those pressed entries into ``Master Ledger.xlsm``.

It is deliberately split so the decision logic is testable without Excel:

- ``poster``          pure functions: queue row -> Master-Paid entry, and the
                      per-row post loop (idempotency, event emission). No I/O.
- ``excel_writer``    xlwings adapter that drives the real Excel app so macros,
                      spill formulas and other sheets survive. Mac-only; imported
                      lazily so the pure code and its tests need no Excel.
- ``supabase_client`` urllib REST client: read log-requested rows, stamp them
                      logged, and post activity events for the app's feed.
- ``seen_store``      a Mac-local (never committed) guard file of entry_ids
                      already written, so a crash can't double-post.
- ``mac_agent``       the launchd-run daemon loop that wires the four together.
- ``config``          env-driven settings (ledger path, Supabase keys, cadence).
"""
