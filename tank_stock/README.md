# Tank stock from the IOCL automation PC (`tank_stock/`)

The IOCL PC at the station (Lubuntu) runs FuelTrans, the automation's tank
stock screen. Nothing may be installed on it, so the PC only keeps an SSH
tunnel open to the Oracle server ([infra/fueltrans](../infra/fueltrans/README.md)),
and the **Oracle server** opens FuelTrans itself in a headless browser
through it (`fueltrans.py`): it logs in as Dealer, opens Tank Status, waits
for every card's live figures and takes a screenshot, drawn as on the PC
(1920 x 1080, DejaVu Sans). Set up by `infra/fueltrans/tank-stock-setup.sh`.

**The figures are FuelTrans' own.** Its page gets each tank's figures over
its live connection (socket.io's `tankStatusPkt`) and draws them on the
card; the server's browser keeps those packets, and a screenshot's figures
are the ones whose "Last Updated" is the very time its card shows, so the
picture and the figures always agree and nothing is guessed from pixels. The
screenshot is still taken (the proof picture) and read once to find the
cards. A card the live data didn't bring is read off the screenshot with
Tesseract (`cards.py`), as before, and Telegram is told once (FuelTrans may
have changed its live data; the screen still works, only slower). Either
way the decant app's checks (volume + ullage = capacity, the dip chart) run
on every reading.

The earlier AnyDesk reader is kept as a fallback (see the end).

## What it does

Nothing connects on its own: everything starts from the **phone page** (over
your own Tailscale network). The page is the **Tank stock** tab of the
XtraPower app (`https://<server's Tailscale name>/`, under `/ts/`), and it
also has its own address on port 8443. Pick the tanks (any of
1-4), then:

- **Send for decantation**: connect, read those tanks, save them to the
  decant app, disconnect. If live monitoring is on, it ends too.
- **Capture only**: the same without saving. The page shows a zoomed picture
  of just those tanks' cards, their figures and the decant app's check badge;
  **Upload** (per tank, or all shown) saves them afterwards.
- **Live monitoring**: open Tank Status once and keep it open. Every
  10 seconds (5-3600, set on the page) the watched tanks' **product volume**
  is read again, without reconnecting and without pictures: the page shows
  each one as it comes, and with "Send the volume to the decant app as it
  changes" decant gets the volume alone (it works the ullage and dip out itself, as for typed
  litres). Each read covers a card from its Last Updated time to its ullage:
  the height and ullage are read only to check the volume (volume + ullage =
  capacity, and the dip chart at that height), so a misread digit never goes
  to decant. A card whose volume rows haven't changed on screen isn't read
  again, and reads never keep the server busy more than half the time (the
  page says how long a read takes); the OCR runs at low priority so the
  XtraPower monitor comes first. It runs until you press Stop. If the PC's
  connection drops (the station's internet, the PC restarting), it stops and
  connects again by itself: 15 s, 30 s, 1 min, ... then every 5 min, until
  FuelTrans answers; the XtraPower Telegram bot is told once when it stops
  and once when it's back. If FuelTrans' page stops updating (no card's "Last
  Updated" moving for 2½ min), Tank Status is opened again. When it ends, the
  last screen becomes an ordinary capture, with its pictures to save or
  upload.

- **Automatic decantation** (`auto.py`, `decantation.py`): one setup, then
  nothing to do in the decant app. Pick the truck's invoice (from the decant
  app's list: this and last month's, with chambers still in the truck) and a
  tank, or "Keep in truck", for each chamber. The page checks the plan as the
  app does (room, product, a tank already being decanted). Press **Start**:
  1. live monitoring connects (or the open session is used), reading **all**
     tanks every 10 s whatever its own setting, and sending the planned tanks'
     volume to the decant app, whose decanting screen drains the chambers by
     it;
  2. a full read of the planned tanks is their **stock before**, saved to the
     app with its proof picture, and the decantation is created in the app,
     its tanks waiting (an open draft for that truck is taken over);
  3. a tank is **decanting** once its stock rises 30 L, from the last reading
     before the rise;
  4. each pause of the flow (25 s or more: the pipe being moved) ends a run;
     the run's litres say which chamber it was (or two together), within
     max(50 L, 2 %). The tank's chambers are put in the order they came, which
     is the order the decant app shows the pipe going round;
  5. still for 90 s with all its chambers in (or the whole plan's litres), a
     tank is **done**: settling from when it stopped rising;
  6. steady (within 5 L, or 0.05 % of the stock) for the app's settle time, a
     full read is its **stock after** (with proof picture). It reads anyway
     after three settle times;
  7. every tank read: **finished and saved** with the app's own result and
     variation, the stock after saved as each tank's latest. Telegram (the
     XtraPower bot) gets the result, and live monitoring ends if it was
     started for this.

  When the stock says something the plan didn't, it asks on the page and on
  Telegram, and waits for your answer:
  - **stopped short** for 5 min: which chambers were emptied? (the closest
    ones ticked; the rest stay in the truck), or "Still decanting: wait";
  - **more than planned** for 3 min: which chambers went into it? (its own,
    another tank's not yet in, or ones kept in the truck): they move to it;
  - **not started** after 30 min with nothing else decanting: leave it out,
    or keep waiting.

  The stock rising again withdraws a question. Other cases are handled
  without asking:
  - a reading that couldn't happen (faster than a pipe fills, or a fall in a
    tank that isn't selling) counts only once a second reading agrees;
  - a tank that **sells before it starts** gets its stock before read again
    (the live figure just before the rise if that read fails);
  - one that **sells again while settling** gets its stock after from the
    screen before the fall;
  - a tank outside the plan rising 60 L is a warning (a chamber going into
    the wrong tank?);
  - a stock after that can't be read in full three times is the live figure
    (marked as such).

  Each tank also has a button:
  - waiting: "Leave out";
  - decanting: "Done now…";
  - settling: "Read the stock after now".

  For the whole decantation:
  - "Cancel" before any tank starts;
  - "Hand over to the decant app" at any time, to finish it there.

  A phone can still do anything in the app meanwhile: every 30 s (and before
  each save) the agent checks the app's copy, and a newer one from a phone
  is taken over: a tank marked done, a new reading, finished or cancelled
  there. If the PC's connection drops it connects again (15 s, 30 s, 1, 2,
  then every 5 min, for 3 hours, then it pauses with "Connect again"). If
  the service restarts, it carries on from `decantation.json`. Live
  monitoring's Stop is hidden while it runs.

- **Check or monitor the stock from the decant app** (`phone.py`): its
  **Monitor** tab has this page's controls, for the tanks ticked there:
  - **Send for decantation**: what Capture then "Send for decantation" does
    here: those tanks read (from the open live session, else a connection for
    this one read), their full figures saved and each zoomed card uploaded as
    the proof picture a result picture shows. Live monitoring, if on, stays
    on;
  - **Capture only**: the same read, nothing saved; **Upload these to
    decant** then saves it, as Upload does here (refused if the server has
    captured again since);
  - both reads also upload the zoomed cards as one picture for the tab to
    show (in `dec-shots` with no readings, so no result picture uses it;
    cleared the next day as the others);
  - **Live monitoring**: live monitoring (the open session, else one started
    for it) sends the ticked tanks' volume to the app as it changes, every
    5-3600 s (10 by default) whatever its own setting, until the phone stops
    it or 3 hours have passed. It doesn't end when nobody has the page open,
    and if the PC's connection drops it connects again (a minute apart; after
    5 tries in a row without a read it stops and tells the phone). A live
    session it started for the phone ends with it; your own live monitoring,
    and its saved settings, stay as they are.

  The phone leaves its requests in the app's shared settings
  (`dec_config.data.stockRequest` for a read or upload, `stockMonitor` for
  monitoring, apart so a read never stops the monitoring); the server looks
  every half minute, as for "Let the tank stock server finish it", and
  answers in the same place (figures, picture, each tank's result, or why
  not), writing only over the settings version it read.

The GitHub job "Tank stock" still works: `capture` sends the whole screen to
the XtraPower bot (from the open session when live monitoring is on).

## Pumps (the Vriddhi Fuels app's Pumps tab)

`pumps.py`, page `static/pumps.html`: the nozzles you tick, live from
FuelTrans' own live connection (`pumpStatusPkt`, about once a second, read
through the tunnel with plain HTTP long-polling, no browser). It only ever
listens; it never sends anything on that connection (FuelTrans' Pump Status
page can send pump controls there).

- **Off unless started.** Tick nozzles, press **Start monitoring**. It stops
  on **Stop**, when no nozzle is ticked, or 15 minutes after the Pumps page
  was last open. Off, the listener sleeps with no timer and makes no request
  at all, and a restart leaves it off.
- **Each watched nozzle:** FuelTrans' status (IDLE, CALLING, AUTHORISED,
  FUELING, SALE END, PUMP LOCK...), the sale's rupees and litres, how long
  it has been fuelling, its flow now and its usual flow (the median of its
  last 30 sales, counting only the seconds it flowed), and its last 5 sales.
- **Preset:** set on the dispenser's keypad, which FuelTrans never sees. Tap
  it on the nozzle (₹ or litres) for a progress bar and the time left; it
  clears when that sale ends.
- **Interlocks:** `lockval`'s bits and the NPND flag, by FuelTrans' own
  names (TEST, PRODUCT LOW, DELIVERY INPROGRESS i.e. decantation, PUMP LOCK,
  ... as its Pump Status page shows them); Telegram is told when one comes on
  or clears on a watched nozzle (a setting on the page).

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

A card read off the screen is read twice with Tesseract, enlarged (`cards.py`): as it is, which
gives the figures cleanly, and thresholded, which also gives the grey labels
and the "Last Updated" time. The figures of both reads must agree.

## Setup (once)

On the Oracle server, once the PC's tunnel works ([infra/fueltrans](../infra/fueltrans/README.md)):

```sh
cd ~/Vriddhi-Fuels-Website && git pull && bash infra/fueltrans/tank-stock-setup.sh
```

It asks once for the FuelTrans user (Dealer) and password, publishes the page
at `https://<server's Tailscale name>:8443/` (also the Vriddhi Fuels app's
**Tank stock** tab) and reads the tanks once to show it works. Run it again
after a change here to update the server's copy of the code.

## Fallback: the AnyDesk reader

AnyDesk was removed from the Oracle server once FuelTrans worked
(`infra/fueltrans/remove-anydesk.sh`). If the tunnel ever can't be used, the
AnyDesk reader (`capture.py`, `navigate.py`) can be put back: the PC still has
AnyDesk with unattended access. The server's AnyDesk *client* connects with
the unattended-access password, waits for the remote screen to draw on a
private virtual display, and reads it the same way; if the PC isn't on Tank
Status, it clicks Monitoring → Tank Status as a person would.

### Setup (once)

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

### How long AnyDesk keeps a session open

Every live session is kept in `/opt/agents/tank-stock/sessions.jsonl`: when it
connected, how long the AnyDesk session itself lasted, and who ended it (you,
the agent, AnyDesk, or a problem). The page's **AnyDesk sessions** box shows
the recent ones and, from those AnyDesk ended by itself, how long it typically
allows (shortest, longest). The XtraPower bot gets a picture of what AnyDesk
showed when it ended a session, with how long it lasted.

To measure it on purpose, run this on the server (ssh in from Oracle Cloud
Shell). It starts live monitoring and reports when AnyDesk ends it:

```sh
cd ~/Vriddhi-Fuels-Website && git pull
nohup bash infra/anydesk/session-test.sh > ~/anydesk-session-test.log 2>&1 &
tail -f ~/anydesk-session-test.log     # Ctrl+C stops watching, not the test
```

(`nohup … &` because Cloud Shell closes after about 20 minutes without typing,
and a session may last hours.)

**Connect again when AnyDesk ends the session** (live monitoring setting):

- **On:** live monitoring connects again 15 s after AnyDesk ends a session.
  It stops trying after 12 sessions in a row that each lasted under 10
  minutes, and says so.
- **Never:** it doesn't connect again after you press Stop.
- **Automatic decantation:** it always reconnects on its own.

### The PC's two AnyDesk IDs

The PC's AnyDesk switches between two IDs every few days, and only one is
online (the green dot in the AnyDesk app). AnyDesk can't be asked whether a
remote ID is online, so the agent tries them in turn:
- **An offline ID** may still open a session window, a tab showing "Client
  Offline - This desk is not available". The agent reads AnyDesk's screen (by
  OCR) before taking a session as connected. On such a message it presses
  Cancel, closes the tab and tries the other ID at once.
- **No window at all** within about 35 seconds also means the next ID.
- **Still connecting** ("Waiting for image") means it waits.
- **FuelTrans on screen** (its blue menu bar) always counts as connected,
  whatever words FuelTrans shows.
- **The ID that worked last** is tried first, so the extra wait only happens
  on the day the PC switches.
- **If neither connects**, the error says what AnyDesk showed for each ID.
- **During live monitoring**, AnyDesk showing such a message instead of the
  tank cards counts as AnyDesk ending the session, so reconnecting starts
  straight away.

### Caveats

- **AnyDesk licence:** free AnyDesk is for personal use, and limits how long a
  session may stay open; live monitoring simply runs until it does. Many
  sessions a day may trigger its "commercial use detected" limits; a paid
  licence lifts them.
- **The PC's screen:** a connection shows on the PC like any AnyDesk session,
  and if the screen isn't on Tank Status when a read is due, the agent clicks
  Monitoring → Tank Status, which moves whoever is using it off their page.
- This repo's job logs are public, so pictures, figures, IDs and window titles
  never go there; they go to the page and the XtraPower bot.
