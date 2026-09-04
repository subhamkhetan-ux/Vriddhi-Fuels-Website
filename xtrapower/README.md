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

## Quick start on a Mac (the easy path)

Open **Terminal** (⌘-Space, type "Terminal") and run these, one at a time. All
paths assume the repo is at `~/Vriddhi-Fuels-Website`.

```bash
cd ~/Vriddhi-Fuels-Website
./xtrapower/setup-mac.sh          # installs everything into a local .venv, makes your config
open -e xtrapower/config.json     # fill in your Telegram token + accounts, then save
./xtrapower/launch-mac.sh         # opens one Chrome window per account — log into each
./xtrapower/run-mac.sh            # starts monitoring (Ctrl-C to stop)
```

That's it. The four scripts handle Python, Playwright, and the virtual
environment for you — you never type `pip` or `python` directly.

- **`setup-mac.sh`** — run **once**. If it says Python isn't installed, run
  `xcode-select --install`, finish the popup, and run it again.
- **`config.json`** — reuse your existing Telegram bot **token** and **chat id**
  from the old setup if you have them. Put one block per account under
  `accounts`, each with a **unique `cdp_port`** (9222, 9223, 9224, …).
  `watch: false` pauses an account without deleting it.
- **`launch-mac.sh`** — opens the login windows. Log into each, go to
  **Financials → Balance Info**, run **Search** once so the table shows, and
  leave the window there.
- **`run-mac.sh`** — start monitoring. Add `--once` for a single test pass:
  `./xtrapower/run-mac.sh --once`.

Everything below is the same thing explained in full, plus the manual commands
if you'd rather not use the scripts.

## Daily use — turning it on and off

Think of it as two things that must both be up: **the Chrome windows** (your
logins) and **the monitor** (the watcher).

**To turn it ON for the day:**
```bash
./xtrapower/launch-mac.sh          # only if the login windows aren't already open
#   … log into each window, go to Balance Info, click Search once …
./xtrapower/monitor-mac.sh start   # start watching (runs in the background)
```
`start` keeps running even after you close Terminal, and keeps the Mac awake
while it runs. You'll get a ✅ on Telegram as each account is picked up, then a
🟢 on every credit.

**To check on it:**
```bash
./xtrapower/monitor-mac.sh status  # ON or OFF, plus recent activity
./xtrapower/monitor-mac.sh logs    # watch it live (Ctrl-C just leaves the viewer)
```

**To turn it OFF:**
```bash
./xtrapower/monitor-mac.sh stop
```
That fully stops it — no more checks or alerts until you `start` again. The
Chrome windows stay open (harmless); close them whenever you like.

Notes for the daily rhythm:
- The Chrome login windows need to stay open. If the Mac restarts or you quit
  Chrome, run `launch-mac.sh` again, then `monitor-mac.sh start`.
- `run-mac.sh` is the *foreground* alternative (runs in the Terminal window,
  stops on Ctrl-C) — handy for a quick `--once` test; `monitor-mac.sh start` is
  the set-and-forget one.

## Running unattended for hours (auto re-login)

The portal ends every session on a **fixed ~30–45 min timer**, no matter how
active you are — so clicking Search can't keep it alive. To run for 5–6 hours
(or all day) without babysitting, let the monitor **log itself back in** each
time the portal times out.

Turn it on by adding each account's login to `config.json`:
```jsonc
{ "label": "Shyam Metalics", "customer_id": "1005218882", "cdp_port": 9222,
  "watch": true,
  "username": "1005218882",         // the customer ID / login you type
  "password": "your-password" }
```
Now the flow is hands-off: open the windows once with `launch-mac.sh` (you don't
even need to log in — the monitor will), then `monitor-mac.sh start`. When the
session drops, it logs back in, returns to Balance Info, and carries on —
**silently**; you only hear about it (⚠️) if the auto-login *fails*, and 🟢
credits keep coming through across re-logins.

- **Only works because login is username + password** (no OTP, no captcha). If
  the portal ever adds either, auto-login stops and you'd log in by hand.
- **`nav_labels`** (optional, per account) is the menu path back to the balance
  table after a re-login — default `["Financials", "Balance Info"]`. If your
  build names them differently and you get a "couldn't reach Balance Info"
  alert, set the exact names here.
- **Passwords sit in `config.json` in plain text.** That file is git-ignored and
  never leaves the machine, so this is fine on your own private/locked Mac or
  device — but keep it off any shared or cloud-synced folder.
- **Without** `username`/`password`, nothing changes: the monitor waits quietly
  for you to log in by hand and you re-login yourself after each timeout.

## Manual setup (any OS)

1. **Install Python 3 and the driver** into a virtual environment (on macOS
   there's no bare `pip` — use `python3 -m pip`, or just use the scripts above):
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   python -m pip install -r xtrapower/requirements.txt
   ```
   You already have Chrome, and the monitor drives *your* Chrome, so you do not
   need `playwright install` — but if you ever want Playwright's own Chromium,
   run `python -m playwright install chromium`. Each new terminal, re-run
   `source .venv/bin/activate` before the `python -m xtrapower.*` commands.

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

   `config.json`, the saved Chrome `profiles/`, `.venv`, and `state.json` are
   git-ignored — they hold your token and logged-in sessions and must stay on
   this machine only.

## Every time you want to monitor (manual commands)

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
| `setup-mac.sh` | One-time Mac setup: makes `.venv`, installs Playwright, creates `config.json` |
| `launch-mac.sh` | Mac wrapper: activates `.venv` and opens the login windows |
| `monitor-mac.sh` | On/off switch: `start` / `stop` / `status` / `logs` (background, keeps Mac awake) |
| `run-mac.sh` | Mac wrapper: run the monitor in the foreground (good for `--once` tests) |
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
