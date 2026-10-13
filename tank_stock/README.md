# Tank stock from the IOCL automation PC (`tank_stock/`)

The IOCL PC at the station (Lubuntu) runs the automation's tank stock screen
and AnyDesk with unattended access. Nothing else may be installed on it. So
the **India server** runs the AnyDesk *client*: it connects with the
unattended-access password, waits for the remote screen to draw, and takes a
screenshot. It works like you opening AnyDesk on your phone. The client
draws on a private virtual display, and the password reaches AnyDesk on stdin
(its documented `--with-password` mode).

**Stage 1 (now):** the screenshot goes **privately to Telegram**: to
`TANK_TELEGRAM_TOKEN` / `TANK_TELEGRAM_CHAT` when both secrets are set (for
example the XtraPower monitor's bot token and chat id), otherwise to the
payment agent's `TELEGRAM_TOKEN` / `TELEGRAM_CHAT`. The job log names the bot
and chat it delivered to, masked (`@Vr…ot`, `private chat 'Su…am'`), or
Telegram's reason for refusing. This repo's job logs are public, so pictures
and window titles are never logged there.

**Stage 2 (next):** hand the screenshot to the decant app's **📷 Stock**
reader and press *Use these readings* only when every tank card passes the
app's checks.

## Setup (once)

1. On the server: `cd ~/Vriddhi-Fuels-Website && git pull && bash infra/anydesk/setup.sh`.
   This installs AnyDesk, a virtual display and screenshot tools. The server's
   own AnyDesk gets no unattended password, so no one can connect into it.
2. In GitHub, **Settings → Secrets and variables → Actions → Secrets**:
   - `ANYDESK_IDS`: **both** of the IOCL PC's AnyDesk numbers, comma separated,
     for example `123 456 789, 987 654 321`;
   - `ANYDESK_PASSWORD`: its unattended-access password.
3. **Actions → Tank stock (AnyDesk -> decant) → Run workflow**. The
   screenshot arrives on Telegram within a minute or two.

## The PC's two AnyDesk IDs

The PC's AnyDesk switches between two IDs every few days, and only one is
online (the green dot in the AnyDesk app). AnyDesk can't be asked whether a
remote ID is online, so the job tries them. An offline ID never opens a
session window, only a small "not available" message, so after about 35
seconds the job moves on to the other. The ID that worked last is tried first
(remembered on the server), so the extra wait only happens on the day the PC
switches. Telegram says which ID was used; the public log says only "#1" or
"#2".

## Caveats

- **AnyDesk licence:** free AnyDesk is for personal use. Regular automated
  business connections may trigger AnyDesk's "commercial use detected" limits.
  A paid licence lifts them.
- **What the screen shows:** whatever the PC shows when the job connects. If
  someone leaves another window open, the screenshot shows that instead. Stage
  2 will only save readings that the decant app recognises as tank cards.
