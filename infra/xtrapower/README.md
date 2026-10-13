# XtraPower monitor on the India server

Runs the [XtraPower CCMS monitor](../../xtrapower/README.md) around the clock
on the Oracle Cloud server from [`infra/india-runner`](../india-runner/README.md),
so the Mac no longer has to stay on.

It is the same monitor code, set up the way the Mac runs it:

| On the Mac | On the server |
| --- | --- |
| Your screen | A virtual display (Xvfb) |
| Google Chrome, one window per account | Playwright's Chromium, one real (non-headless) window per account |
| `launch-mac.sh` + `monitor-mac.sh start` | The `xtrapower` systemd service, started at boot and restarted on failure |
| You log in, or auto re-login | Always auto-login: every account needs its `username` and `password` |
| `config.json` in the repo folder | `/opt/xtrapower/config.json` (owner-only) |

A Chromium window that dies is relaunched within a minute, and if the monitor
itself stops, the whole service restarts after 30 seconds. Telegram alerts and
`/status`, `/logs` and `/help` work exactly as before.

**Isolation from GitHub Actions.** The monitor runs as its own `xtrapower` user.
Workflow jobs run as `runner` and cannot read `/opt/xtrapower` (passwords, bot
token, sessions). A firewall rule lets only `xtrapower` connect to the Chromium
debug ports (9222–9299), so a job can't take over a logged-in session either.
Keep every account's `cdp_port` in that range.

## Set it up (once)

On the server (Cloud Shell → `ssh -i ~/.ssh/oracle_india ubuntu@PUBLIC_IP`):

```sh
cd ~/Vriddhi-Fuels-Website && git pull
bash infra/xtrapower/setup.sh
```

The script first checks that XtraPower answers from this server without its
firewall's *"The requested URL was rejected"* page, and stops before installing
anything if it doesn't. It then installs the virtual display, Chromium and the
monitor, and registers the service. The service doesn't start until the config
is filled in:

1. **Stop the Mac monitor first**: `./xtrapower/monitor-mac.sh stop` on the Mac.
   Two monitors would fight over the same Telegram bot (*409 Conflict*) and log
   the same accounts in from two places.
2. **Copy the config over.** On the Mac, run `cat xtrapower/config.json` in
   Terminal and copy the output. On the server:

   ```sh
   sudo -u xtrapower nano /opt/xtrapower/config.json
   ```

   Delete the example contents, paste yours, and make sure **every watched
   account has its `username` and `password`**; nobody is there to log in by
   hand. Save with **Ctrl+O, Enter**, exit with **Ctrl+X**.
3. **Start it:** `sudo systemctl start xtrapower`. Within a minute or two you get
   *▶️ XtraPower monitor started* on Telegram, then a ✅ as each account logs in.

## Manage it from your phone

The [account manager page](../../xtrapower/README.md#account-manager--edit-accounts-on-the-mac)
runs on the server too, with a **Monitor** card on top: **Start**, **Stop**,
**Restart** and **Show log**. Below it you can add, edit and delete accounts,
switch watching on or off, and change the Telegram settings. It installs to
your home screen like an app.

Your phone reaches it over [Tailscale](https://tailscale.com), a free private
network between your own devices. The page is never on the public internet:
only devices signed in to your Tailscale account can open it, and the page
also checks that the request comes from your login.

**Set up once** (on the server):

```sh
cd ~/Vriddhi-Fuels-Website && git pull && bash infra/xtrapower/phone-setup.sh
```

1. It updates the monitor, installs Tailscale, and prints a **login link**.
   Open it, sign in (Google, Microsoft, Apple or GitHub), and approve the server.
2. If it prints a link to **enable HTTPS / Serve**, open that too and click
   **Enable**. The script continues by itself.
3. It ends with the page address, `https://oracle-india.<your-tailnet>.ts.net/`.

**On your phone:** install the **Tailscale** app, sign in with the same
account, and open that address. Then add it to your home screen (iPhone:
**Share → Add to Home Screen**; Android: **⋮ → Install app**). Tailscale has to
be connected when you use the page; you can leave it on all the time.

**Recommended:** at [login.tailscale.com](https://login.tailscale.com) →
**Machines**, open the server's **⋯** menu and choose **Disable key expiry**.
Otherwise the server drops off your Tailscale network after 6 months.

What the buttons do:

| Button | Effect |
| --- | --- |
| Stop | Stops checks and alerts, closes the Chromium windows, and stays stopped after a reboot. |
| Start | Starts the monitor again and turns start-at-boot back on. |
| Restart | Restarts the monitor, for example if it seems stuck. |
| Watching switch | Takes effect on the next check, about 2 minutes. No restart needed. |
| Add account | Its window opens within a minute. Keep the 1 GB server to one watched account. |

The page runs as its own service (`xtrapower-manage`) so **Start** still works
while the monitor is stopped. It can run only those three `systemctl` commands
and read the monitor's log (`/etc/sudoers.d/xtrapower-manage`). GitHub Actions
jobs can't reach it.

## Daily use

There's nothing to do: it runs all the time and survives reboots. From your
phone, use the page above or `/status` on Telegram. On the server:

| Task | Command |
| --- | --- |
| Is it running? | `systemctl status xtrapower` |
| Live log | `journalctl -u xtrapower -f` (Ctrl+C to leave) |
| Stop / start / restart | `sudo systemctl stop xtrapower` (or `start`, `restart`) |
| Edit accounts or settings | `sudo -u xtrapower nano /opt/xtrapower/config.json` (applied on the next check, no restart) |
| Update the code after a merge | `cd ~/Vriddhi-Fuels-Website && git checkout -q main && git pull && bash infra/xtrapower/setup.sh` |
| Failure captures | `sudo ls /opt/xtrapower/app/xtrapower/debug/` |

Adding an account? Give it a new `cdp_port` between 9222 and 9299. Its window
opens within a minute.

## Memory

Each watched account keeps its own Chromium window open (roughly 250–400 MB).
On the 1 GB **E2.1.Micro** start with **one** watched account (`"watch": false`
on the others); the setup's swap file keeps it alive, but slowly. On an A1
(6 GB or more) all accounts fit alongside the IOCL runner.
