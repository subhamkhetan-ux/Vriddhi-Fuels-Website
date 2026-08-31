# XtraPower CCMS monitor (`xtrapower/`)

Watches the **CCMS** balance on the IndianOil XtraPower fleet-card portal and
pings you on **Telegram the moment it goes up** (a credit) — for several
accounts at once.

This is the rebuilt monitor for the **updated** portal. The old approach (a
headless browser logging in with saved credentials) no longer works: the site
changed, and — as the project report already found — the F5 firewall blocks
datacenter IPs, and login from GitHub / any cloud runner does not work.

So this version does the one thing that reliably works: **you** log in by hand
in a normal Chrome window and leave it on the Balance Info screen; the monitor
**attaches to that window** and just clicks **Search** every 2 minutes. No
credentials ever touch this code.

```
YOU (once)                          THIS MONITOR (every 2 min, per account)
 ─────────                           ───────────────────────────────────────
 launch.py opens a Chrome window     attach over CDP  →  click "Search"
 per account (own debug port)   ┐                         │
 you log in + open Balance Info ┴──►  Chrome (logged in) ◄─┘  read CCMS cell
                                                             │
                                        compare to last value
                                             │changed?           │error?
                                             ▼                    ▼
                                     Telegram: "credited"   Telegram: logout /
                                     100000 → 250000        timeout / site change
```

## Why this shape

- **The portal only works in Chrome** (not Safari), and it blocks cloud IPs, so
  monitoring has to run on your own machine in your own Chrome. That's exactly
  what attaching over the Chrome DevTools Protocol (CDP) does.
- **You log in, not the script.** IOCL login from GitHub doesn't work and
  automating the login was fragile. Leaving login to you sidesteps captcha,
  OTP, session, and firewall-login problems in one move.
- **Multiple accounts = multiple Chrome windows.** One Chrome profile can only
  hold one XtraPower session, so each account gets its **own** Chrome window
  (own `--user-data-dir`, own debug port). All are watched together.

## One-time setup

1. **Install Python 3 and the driver:**
   ```bash
   pip install -r xtrapower/requirements.txt
   ```
   You already have Chrome, and the monitor drives *your* Chrome, so you do not
   need `playwright install` — but if you ever want Playwright's own Chromium,
   run `python -m playwright install chromium`.

2. **Make a Telegram bot** (if you don't have one from the old setup): message
   [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **token**. Send
   your new bot any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy your **chat id**.

3. **Create your config:**
   ```bash
   cp xtrapower/config.example.json xtrapower/config.json
   ```
   Edit `xtrapower/config.json`:
   - put your bot **token** and **chat_id** under `telegram`;
   - one block per account under `accounts`, each with a **unique `cdp_port`**
     (9222, 9223, 9224, …). `watch: false` pauses an account without deleting it.

   `config.json`, the saved Chrome `profiles/`, and `state.json` are
   git-ignored — they hold your token and logged-in sessions and must stay on
   this machine only.

## Every time you want to monitor

1. **Open the Chrome windows:**
   ```bash
   python -m xtrapower.launch --config xtrapower/config.json
   ```
   This opens one Chrome window per watched account (each on the portal).

2. **Start the monitor** (you can do this before or after logging in):
   ```bash
   python -m xtrapower.monitor --config xtrapower/config.json --announce
   ```
   Leave it running (a terminal, or `nohup … &`). Stop it with Ctrl-C.

3. **Hand over each account, at your own pace.** In each window: log in →
   **Financials → Balance Info** → run **Search** once so the table is on
   screen → leave the window there. The monitor **waits quietly** for each
   account until you've done this, then sends a **✅ "now watching"** as it
   takes that account over. So you can log in one account, get the ✅, log in
   the next, and so on — no false "logged out" alerts while you're still
   logging in. (Because each window keeps its own profile, next time you'll
   often already be logged in.)

**Test it without waiting:** `python -m xtrapower.monitor --config xtrapower/config.json --once`
runs a single pass and exits — good for confirming it can see each window and
read the CCMS cell.

## What you'll be notified about

| Situation | Telegram message |
|---|---|
| Account handed over (you logged in) | ✅ `<account>` — now watching. Current CCMS `<value>` |
| A credit landed while the monitor was off | ✅ now watching — CCMS **credited since last check** `old → new` |
| CCMS went **up** (a credit) | 🟢 `<account>` CCMS **credited** — `old → new` |
| CCMS went down (a debit) | *(no alert — increase-only)* |
| Not logged in yet / still logging in | *(no alert — waiting quietly for hand-over)* |
| Logged out / session timed out **after hand-over** | ⚠️ "looks logged out / session expired — log back in" (then waits quietly until you do) |
| Chrome window closed / port unreachable | ⚠️ "can't reach Chrome on debug port N — re-run launch.py" |
| **Search** button gone (site changed) | ⚠️ "couldn't find the Search button" |
| CCMS cell unreadable (table changed) | ⚠️ "couldn't read a CCMS value" |
| F5 firewall blocking this network | ⚠️ "the site firewall is rejecting this connection" |

Balance alerts are **increase-only**: you're pinged when CCMS goes up (a
credit), and debits or an unchanged balance stay quiet (the stored value still
refreshes, so the next credit is measured from the current balance).

**Hand-over is quiet, then confirmed.** Each account starts every run "awaiting
log-in" and stays silent — no error alerts — until you've logged it in and it's
on the Balance Info screen. The first clean read sends the ✅ "now watching"
confirmation; only *after* that do problems on that account (logout, closed
window, missing Search button, unreadable table) become ⚠️ alerts. A problem
then quietly returns it to "awaiting log-in" until you log back in, when it
re-confirms — so a session timeout won't spam you every 2 minutes. Because this
is per-run, you can relaunch Chrome and re-hand-over each session cleanly.
Repeated errors are additionally rate-limited (at most every 30 min).

## Configuration reference (`config.json`)

```jsonc
{
  "poll_seconds": 120,                 // how often to click Search (seconds)
  "telegram": { "token": "…", "chat_id": "…" },
  "accounts": [
    { "label": "Shyam Metalics",       // shown in alerts
      "customer_id": "1005218882",     // identifies the account in state/alerts
      "cdp_port": 9222,                // unique Chrome debug port for this account
      "watch": true }                  // false = paused
  ]
}
```

`poll_seconds` defaults to 120 (2 minutes). Going much lower is impolite to the
server and risks drawing a firewall block — 2 minutes is already brisk.

## Files

| File | Purpose |
|---|---|
| `launch.py` | Opens one Chrome window per account with a debug port + saved profile |
| `monitor.py` | The 2-minute loop: attach → click Search → read CCMS → compare → alert |
| `browser.py` | CDP attach, Search-button click, and CCMS table scrape (Playwright) |
| `parse.py` | Pure logic: amount parsing, CCMS extraction, change/logout/WAF detection |
| `state.py` | Last-known balances + error de-dup, saved atomically to `state.json` |
| `notify.py` | Best-effort Telegram push |
| `config.example.json` | Copy to `config.json` and fill in |

Tests: `tests/test_xtrapower.py` (`python -m pytest tests/test_xtrapower.py`).

## Limits and the durable fix

- **One machine, awake and online.** If this PC sleeps or the window closes,
  checks stop until you restart them. The monitor tells you when it loses a
  window rather than going quiet.
- **Sessions still expire.** When the portal logs you out you get an alert;
  just log back in on that window and leave it on Balance Info.
- **Site changes can break the scrape.** The Search-click and CCMS read use
  several fallback strategies, but a big redesign may still need a selector
  tweak — you'll get a "couldn't find Search / read CCMS" alert, not silence.
- **The firewall could tighten.** It accepts your home/office connection today;
  that isn't guaranteed forever.

As the report has said throughout, the truly durable answer is **official CCMS
credit alerts or API access from IndianOil** — instant, sanctioned, and immune
to every failure above. This monitor is a solid stopgap until that exists.
