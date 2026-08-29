# Mac payment logging agent (`local_agent/`)

The always-on piece that lives on your Mac and writes the payments you approve
**straight into the Master Paid sheet** of `Master Ledger.xlsm` — closing the one
manual step the cloud agent couldn't reach (a cloud runner can't touch your Mac's
Excel). You stay in control: nothing is written until **you** tap **Log to Excel**
in the [`/payments`](../payments/) app.

## The mental model

```
Gmail → GitHub Actions → Supabase pay_credit_queue → /payments app
                                                        │  (you tap "Log to Excel")
                                                        ▼  log_requested = true
                              ┌───────────  THIS AGENT (Mac, always on)  ──────────┐
                              │  poll → write into Master Paid (real Excel) → stamp │
                              │  logged_at + exported → post an activity event      │
                              └─────────────────────────────────────────────────────┘
                                                        │
                       /payments "Activity" feed  ◄─────┘  pay_agent_events (realtime)
```

- **Pull, not push.** The agent only ever writes rows you pressed **Log** on
  (`log_requested = true` and not yet `logged_at`). Review rows and un-pushed
  matched rows are never touched.
- **It drives real Excel** (via xlwings), so macros, spill formulas, other sheets
  and formatting are all preserved. It writes each entry into the **next blank
  row** of the Master Paid table (the first row whose Date cell is empty), keeping
  that row's own formatting — it never overrides existing entries. When the
  pre-made blank rows run out it adds one more (extending the table so the new row
  keeps its formatting).
- **The queue is the offline buffer.** If your Mac is asleep, offline, or Excel is
  closed, pressed entries just wait in Supabase. When the agent is healthy again it
  drains everything in one pass.

## No double-posting, ever — three stacked guards

1. **Server filter** — the agent only fetches rows with `log_requested = true`
   **and** `logged_at is null`.
2. **Mac-local seen-store** — every written `entry_id` is recorded to
   `~/.vriddhi-payment-agent/posted_entry_ids.json` *before* the Supabase mark, so
   a crash in the gap can't re-post on the next loop.
3. **Order of operations** — append to Excel → record locally → stamp `logged_at`
   in Supabase → emit the event. A failed Excel write records nothing and is simply
   retried; a row is only ever marked done after it's really in the sheet.

Because of this, a Mac that was off for a week just flushes safely on reconnect.

## What you see on your phone

The app's **Activity** section shows a live feed and an **online/offline** pill:

- 🟢 `Mac agent online · just now` — driven by a heartbeat every ~2 minutes.
- ✅ `Logged ₹1,20,000 · A.K.V. Logistics · HDFC NEFT` — each row written.
- ⚠️ `couldn't write to Excel — check it's open` — Excel closed / workbook locked;
  the agent holds the batch and retries, nothing is lost.

Pushed entries sit under **Queued to log** (with a **cancel** you can tap until the
agent picks them up); once written they drop into **Exported** marked **logged ✓**.

## One-time setup

1. **Schema** — in Supabase → SQL Editor, re-run
   [`supabase/payments-schema.sql`](../supabase/payments-schema.sql) (safe to
   re-run). This update adds the `log_requested` / `logged_at` columns and the
   `pay_agent_events` feed table.

2. **Python + xlwings** on the Mac:

   ```bash
   cd /path/to/Vriddhi-Fuels-Website
   pip3 install -r requirements.txt      # includes xlwings
   ```

   Make sure Microsoft Excel is installed and you've opened it once (xlwings drives
   the desktop Excel app; the web/iPad Excel won't work).

3. **Configure + install the launchd agent.** Edit the four ALL-CAPS placeholders
   in [`com.vriddhi.paymentagent.plist`](./com.vriddhi.paymentagent.plist) — the
   repo path, your `MASTER_LEDGER_PATH`, and the same `SUPABASE_URL` / `SUPABASE_KEY`
   the `/payments` app uses — then:

   ```bash
   cp local_agent/com.vriddhi.paymentagent.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.vriddhi.paymentagent.plist
   ```

   It now starts at login and restarts on crash. Logs stream to
   `~/Library/Logs/vriddhi-payment-agent.log` (and `.err.log`).

   Stop or reload it any time:

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.vriddhi.paymentagent.plist
   ```

## Try it before installing the daemon

A one-shot drain (writes whatever you've already pressed **Log** on, then exits):

```bash
MASTER_LEDGER_PATH="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Master Ledger.xlsm" \
SUPABASE_URL="https://YOUR-PROJECT.supabase.co" SUPABASE_KEY="YOUR_KEY" \
python3 -m local_agent.mac_agent --once
```

## Configuration (env vars, all set in the plist)

| Var | Required | Default | What |
|---|---|---|---|
| `MASTER_LEDGER_PATH` | ✅ | — | Full path to `Master Ledger.xlsm` (spaces OK) |
| `SUPABASE_URL` | ✅ | — | Same project as the `/payments` app |
| `SUPABASE_KEY` | ✅ | — | anon or service_role key |
| `MASTER_PAID_SHEET` | | `Master Paid` | Sheet name to append into |
| `AGENT_POLL_SECONDS` | | `20` | How often to check for pushed entries |
| `AGENT_HEARTBEAT_SECONDS` | | `120` | How often to report "online" |
| `AGENT_SEEN_PATH` | | `~/.vriddhi-payment-agent/posted_entry_ids.json` | Local guard file |

## Layout

| File | What |
|---|---|
| `mac_agent.py` | The launchd-run daemon loop (`python -m local_agent.mac_agent`) |
| `poster.py` | Pure logic: queue row → Master-Paid entry, the post loop (no I/O — fully unit-tested) |
| `excel_writer.py` | xlwings adapter that drives the real Excel app (Mac-only, lazily imported) |
| `supabase_client.py` | urllib REST: read log-requests, stamp logged, post events |
| `seen_store.py` | Mac-local `entry_id` guard file (never committed) |
| `config.py` | Env-driven settings |
| `com.vriddhi.paymentagent.plist` | launchd LaunchAgent template |

## Tests

```bash
python -m pytest tests/test_local_agent.py -q
```

Excel can't run in CI, so the Excel append is behind an interface and tested with a
fake writer. The tests cover the serial↔date mapping, the postable gate, the post
loop's ordering / idempotency / error handling, and the seen-store.

## Relationship to `materialize.py`

`materialize.py` (the terminal "download an `.xlsx` and paste it in" flow) still
works as a fallback, and the app's **`.xlsx`** button still downloads a batch. The
agent is the hands-off path: press **Log to Excel** and the rows appear in Master
Paid on their own. Don't run both against the same rows at once — the agent's
`logged_at` guard and the download's `exported` flag each drop a row off the list,
so a row is only ever handled by whichever you use.
