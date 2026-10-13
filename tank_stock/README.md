# Tank stock from the IOCL automation PC (`tank_stock/`)

The IOCL PC at the station (Lubuntu) runs the automation's tank stock screen
and AnyDesk with unattended access. Nothing else may be installed on it. So
the **India server** runs the AnyDesk *client*: it connects with the
unattended-access password, waits for the remote screen to draw, and reads
it. It works like you opening AnyDesk on your phone. The client draws on a
private virtual display, and the password reaches AnyDesk on stdin (its
documented `--with-password` mode).

## What it does

- **Phone page** (over your own Tailscale network, like the XtraPower one):
  - pick the tanks (any of 1-4);
  - **Capture** shows a zoomed picture of just those tanks' cards and their
    figures with the decant app's check badge;
  - **Upload** (per tank, or all shown) saves the stock to the decant app;
  - **Capture & upload** does both.
- **Monitor**: every 15 minutes by default it captures the watched tanks and,
  with auto-upload on, saves them to the decant app. The interval (5-1440
  minutes), the tanks and auto-upload are set on the page. When something goes
  wrong it tells the XtraPower Telegram bot once, and again when it's fine.
- **GitHub job** "Tank stock (AnyDesk -> decant)": `capture` sends the whole
  screen to the XtraPower bot; `save-login` gives the monitor the AnyDesk
  login from the repo's secrets.

If the PC isn't on Tank Status, the agent opens it the way a person would:
**Monitoring** in FuelTrans' blue menu bar, then **Tank Status** (`navigate.py`).

## Saving to the decant app

The decant app keeps each tank's latest stock as one row of its Supabase table
`dec_tank_state` (T1-T4). `decant.py` writes the same reading the app's own
"From a screenshot" button does (`readingFrom` in `decant/js/core.js`), after
the same two checks (`settleReading` in `decant/js/automation.js`):

- **sum**: volume + ullage = capacity, to a litre;
- **chart**: the dip chart's litres at the product height = the volume, to
  max(15 L, 0.2 %).

Both pass: "Checked". The sum alone (no height to check): "Fixed & checked".
Anything else (a failed check, the two reads of the card disagreeing, or the
screen showing another product than the app has for that tank) is **not
saved** and the page says why. As in the app, an older reading never replaces
a newer one. Tanks, the date order and the dip chart come from the app's
Settings (`dec_config`), else its defaults.

Each card is read twice with Tesseract, enlarged (`cards.py`): as it is, which
gives the figures cleanly, and thresholded, which also gives the grey labels
and the "Last Updated" time. The figures of both reads must agree.

## Setup (once)

1. In GitHub, **Settings → Secrets and variables → Actions → Secrets**:
   - `ANYDESK_IDS`: **both** of the IOCL PC's AnyDesk numbers, comma separated,
     for example `123 456 789, 987 654 321`;
   - `ANYDESK_PASSWORD`: its unattended-access password.
2. On the server: `cd ~/Vriddhi-Fuels-Website && git pull && bash infra/anydesk/setup.sh`
   (again after every change here: it updates the monitor's copy of the code
   in `/opt/agents/tank-stock/app`). It:
   - installs AnyDesk, a virtual display, screenshot tools;
   - logs the runner user in at the console (tty7 of seat0, made the active
     one) with `tank-stock-session.service`, and runs the monitor
     (`python -m tank_stock.service`) inside that session. AnyDesk's client
     crashes at start ("The logged in user differs from the (non-root) user
     this process runs as") unless it runs inside the session of the user at
     the machine's active console, and on a server nobody is;
   - publishes the page at `https://<server's Tailscale name>:8443/`, for
     your Tailscale login only. Tailscale itself is set up by
     `infra/xtrapower/phone-setup.sh`.

   The server's own AnyDesk gets no unattended password, so no one can
   connect into it.
3. `bash infra/anydesk/use-xtrapower-bot.sh` on the server, so reports go to
   the XtraPower bot.
4. **Actions → Tank stock (AnyDesk -> decant) → Run workflow**, mode
   **save-login**. This copies the AnyDesk login to the monitor
   (`/opt/agents/tank-stock/login.json`, owner-only). Do it again if the
   password changes.

The GitHub job can't start AnyDesk itself (it's not in the console session),
so it leaves its request in `/opt/agents/tank-stock-queue` and the monitor
runs it in the session with the job's checkout and secrets (same user, same
rights). One capture runs at a time.

## The PC's two AnyDesk IDs

The PC's AnyDesk switches between two IDs every few days, and only one is
online (the green dot in the AnyDesk app). AnyDesk can't be asked whether a
remote ID is online, so the agent tries them. An offline ID never opens a
session window, so after about 35 seconds the agent moves on to the other. The
ID that worked last is tried first, so the extra wait only happens on the day
the PC switches.

## Caveats

- **AnyDesk licence:** free AnyDesk is for personal use. The monitor connects
  every 15 minutes (96 times a day), which may trigger AnyDesk's "commercial
  use detected" limits. A longer interval makes that less likely; a paid
  licence lifts them.
- **The PC's screen:** each connection shows on the PC like any AnyDesk
  session, and if it isn't on Tank Status the agent clicks Monitoring → Tank
  Status, which moves whoever is using it off their page.
- This repo's job logs are public, so pictures, figures, IDs and window titles
  never go there; they go to the page and the XtraPower bot.
