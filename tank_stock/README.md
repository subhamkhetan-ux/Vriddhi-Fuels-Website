# Tank stock from the IOCL automation PC (`tank_stock/`)

The IOCL PC at the station (Lubuntu) runs the automation's tank stock screen
and AnyDesk with unattended access. Nothing else may be installed on it. So
the **India server** runs the AnyDesk *client*: it connects with the
unattended-access password, waits for the remote screen to draw, and reads
it. It works like you opening AnyDesk on your phone. The client draws on a
private virtual display, and the password reaches AnyDesk on stdin (its
documented `--with-password` mode).

## What it does

Nothing connects on its own: everything starts from the **phone page** (over
your own Tailscale network, like the XtraPower one). Pick the tanks (any of
1-4), then:

- **Send for decantation**: connect, read those tanks, save them to the
  decant app, disconnect. If live monitoring is on, it ends too.
- **Capture only**: the same without saving. The page shows a zoomed picture
  of just those tanks' cards, their figures and the decant app's check badge;
  **Upload** (per tank, or all shown) saves them afterwards.
- **Live monitoring**: connect once and keep that AnyDesk session open. Every
  N minutes (1-240, default 15) the screen is read again, without
  reconnecting, and with "Update the decant app each time" the watched tanks
  are saved. It runs until AnyDesk ends the session (the free licence's time
  limit, or the PC going offline) or you press Stop. When AnyDesk ends it, the
  XtraPower Telegram bot gets a picture of what AnyDesk showed and how long it
  lasted. Problems while live (a tank not saved, a tank not on the screen) are
  sent once each.

The GitHub job "Tank stock (AnyDesk -> decant)" still works: `capture` sends
the whole screen to the XtraPower bot (from the open session when live
monitoring is on); `save-login` gives the page the AnyDesk login from the
repo's secrets.

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

With the readings it saves a **proof picture**: the zoomed cards of those
tanks, as a JPEG in the app's private storage bucket `dec-shots` with a
`dec_shots` row naming the readings (as the app's phones do, `decant/js/
shots.js`). A result picture made on any phone that day shows it under the
figures. Earlier days' are deleted (once a day, by the agent or the first
phone that opens the app).

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
     one) with `tank-stock-session.service`, and runs the page and live
     monitor (`python -m tank_stock.service`) inside that session. AnyDesk's client
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
   **save-login**. This copies the AnyDesk login to the page
   (`/opt/agents/tank-stock/login.json`, owner-only). Do it again if the
   password changes.

The GitHub job can't start AnyDesk itself (it's not in the console session),
so it leaves its request in `/opt/agents/tank-stock-queue` and the service
runs it in the session with the job's checkout and secrets (same user, same
rights), or answers it from the open live session. One use of the PC runs at
a time.

## The PC's two AnyDesk IDs

The PC's AnyDesk switches between two IDs every few days, and only one is
online (the green dot in the AnyDesk app). AnyDesk can't be asked whether a
remote ID is online, so the agent tries them. An offline ID never opens a
session window, so after about 35 seconds the agent moves on to the other. The
ID that worked last is tried first, so the extra wait only happens on the day
the PC switches.

## Caveats

- **AnyDesk licence:** free AnyDesk is for personal use, and limits how long a
  session may stay open; live monitoring simply runs until it does. Many
  sessions a day may trigger its "commercial use detected" limits; a paid
  licence lifts them.
- **The PC's screen:** a connection shows on the PC like any AnyDesk session,
  and if the screen isn't on Tank Status when a read is due, the agent clicks
  Monitoring → Tank Status, which moves whoever is using it off their page.
- This repo's job logs are public, so pictures, figures, IDs and window titles
  never go there; they go to the page and the XtraPower bot.
