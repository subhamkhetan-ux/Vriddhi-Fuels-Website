# Tank stock from the IOCL automation PC (`tank_stock/`)

The IOCL PC at the station (Lubuntu) runs the automation's tank stock screen
and AnyDesk with unattended access. Nothing else may be installed on it. So
the **India server** runs the AnyDesk *client*: it connects with the
unattended-access password, waits for the remote screen to draw, and takes a
screenshot. It works like you opening AnyDesk on your phone. The client
draws on a private virtual display, and the password reaches AnyDesk on stdin
(its documented `--with-password` mode).

**Stage 1 (now):** the screenshot goes **privately to Telegram** (the
payment agent's `TELEGRAM_TOKEN` / `TELEGRAM_CHAT`). This repo's job logs are
public, so pictures and window titles are never logged there.

**Stage 2 (next):** hand the screenshot to the decant app's **📷 Stock**
reader and press *Use these readings* only when every tank card passes the
app's checks.

## Setup (once)

1. On the server: `cd ~/Vriddhi-Fuels-Website && git pull && bash infra/anydesk/setup.sh`.
   This installs AnyDesk, a virtual display and screenshot tools. The server's
   own AnyDesk gets no unattended password, so no one can connect into it.
2. In GitHub, **Settings → Secrets and variables → Actions → Secrets**:
   `ANYDESK_ID` (the IOCL PC's AnyDesk number) and `ANYDESK_PASSWORD` (its
   unattended-access password).
3. **Actions → Tank stock (AnyDesk -> decant) → Run workflow**. The
   screenshot arrives on Telegram within a minute or two.

## Caveats

- **AnyDesk licence:** free AnyDesk is for personal use. Regular automated
  business connections may trigger AnyDesk's "commercial use detected" limits.
  A paid licence lifts them.
- **What the screen shows:** whatever the PC shows when the job connects. If
  someone leaves another window open, the screenshot shows that instead. Stage
  2 will only save readings that the decant app recognises as tank cards.
