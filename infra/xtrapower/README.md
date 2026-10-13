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

## Daily use

There's nothing to do: it runs all the time and survives reboots. From your
phone, `/status` on Telegram shows each account; on the server:

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
