# FuelTrans on your phone, through the Oracle server

The IOCL automation PC shows FuelTrans (Bahwan CyberTek's Station Manager) in
Chromium at `localhost:3000`. This makes the same page open on your phone or
laptop, live, with no AnyDesk session and no time limit:

```
IOCL PC  ──ssh tunnel (out only)──▶  Oracle server  ──Tailscale──▶  your phone
localhost:3000                       localhost:13000                https://<server>:10000/
```

- **On the IOCL PC nothing is installed.** It uses the `ssh` Ubuntu already
  has, plus one systemd service that starts it at boot and reconnects within
  15 s whenever the station's internet comes back. The PC only connects
  *out*, the way AnyDesk does.
- **On the server**, the PC's key can do one thing: open port 13000 on the
  server's own localhost. It gets no shell, and it can't open other ports or
  reach the server's other services.
- **Tailscale** shows the page to your own signed-in devices only. Nothing is
  opened to the internet. It's the same Tailscale network as the Vriddhi Fuels
  app.
- **The page's data requests.** FuelTrans' page asks for its data (the user
  list, tank status and so on) at the address in `assets/data/config.json`,
  which is `http://localhost:3000`. On your phone that would be the phone, so
  Tailscale gives your devices a copy of that file with the page's own
  address. The PC keeps its own file.

It's all free: Oracle Always Free, Tailscale's free plan and OpenSSH, with no
session limits.

## 1. On the IOCL PC

Open the terminal (**Ctrl+Alt+T**). The easiest way is to open this page in
Chromium on the PC and copy each command with the copy button (paste in the
terminal with **Ctrl+Shift+V**):

```sh
wget -qO ft.sh https://raw.githubusercontent.com/subhamkhetan-ux/Vriddhi-Fuels-Website/main/infra/fueltrans/pc-setup.sh
```

```sh
bash ft.sh SERVER_PUBLIC_IP
```

`SERVER_PUBLIC_IP` is the Oracle server's public IP (Oracle console →
Instances). Type the login password when it asks for sudo.

At the end it prints a line starting `ssh-ed25519`. Select it, copy it
(**Ctrl+Shift+C**) and send it to yourself, for example on WhatsApp Web or
Gmail in Chromium. It's a public key, so it's safe to send.

## 2. On the Oracle server

In Cloud Shell, run `ssh -i ~/.ssh/oracle_india ubuntu@PUBLIC_IP`, then:

```sh
cd ~/Vriddhi-Fuels-Website && git pull
bash infra/fueltrans/server-setup.sh 'ssh-ed25519 AAAA...the line from the PC...'
```

Keep the single quotes. It ends with *"FuelTrans answers through the tunnel"*
and prints the address. To update the server part later, run it again
without the key: the allowed key is kept.

## 3. On your phone

With the Tailscale app on and signed in, open:

```
https://<server's Tailscale name>:10000/tank-dashboard
```

Add it to your home screen.

## 4. Tank stock for the decant app, from this server (instead of AnyDesk)

The server can read the tank cards itself, through the tunnel: a hidden
Chromium logs in to FuelTrans (user Dealer) and opens Tank Status, like the
AnyDesk reader did with the PC's screen. Everything after that is the same
as before (`tank_stock/`): the figures and their checks, the zoomed cards as
the proof picture, live monitoring, the decant app's "Check stock now" and
automatic decantation. There's no AnyDesk session to drop and no time limit,
and the screenshots are sharp.

On the server, after step 2 works:

```sh
cd ~/Vriddhi-Fuels-Website && git pull
bash infra/fueltrans/tank-stock-setup.sh
```

It asks once for the FuelTrans user (Enter for Dealer) and password, then
reads the tanks once to show it works. It also turns off this server's
AnyDesk tank stock service and points the Vriddhi Fuels app's **Tank stock**
tab back to this server (from the Mac).

If the Mac's VM does tank stock now, stop it there afterwards, or both
answer the decant app:

```sh
sudo systemctl disable --now tank-stock-session
```

To update it after a change: run the same two lines again. To change the
password: `ASK_AGAIN=1 bash infra/fueltrans/tank-stock-setup.sh`.

## If something's wrong

| What you see | Do this |
| --- | --- |
| PC: *"Can't reach … on port 22"* | The IP is wrong, or the station's network blocks SSH. Send a photo. |
| Server: *"Not connected yet"* | On the PC, run `systemctl status fueltrans-tunnel`. *Permission denied* means the key wasn't copied whole: run step 2 again with it. |
| Login page has no user names, or tanks stay empty | The page isn't getting the corrected `config.json`. On the server, run `bash infra/fueltrans/server-setup.sh` again (no key needed), then reload with **Ctrl+Shift+R**. |
| *"Invalid Host header"* | FuelTrans checks the address it's opened with. This needs a small fix on the server only. |
| Tank stock: *"FuelTrans didn't accept the login"* | Save the password again: `ASK_AGAIN=1 bash infra/fueltrans/tank-stock-setup.sh`. |
| Tank stock: *"its FuelTrans tunnel is down"* | The PC is off or offline, or its tunnel stopped. On the PC: `systemctl status fueltrans-tunnel`. |

The PC's tunnel status at any time: `systemctl status fueltrans-tunnel`.

## Removing it

- PC: `sudo systemctl disable --now fueltrans-tunnel`
- Server: `bash infra/fueltrans/server-setup.sh --remove`
- Tank stock back to AnyDesk: `sudo systemctl disable --now tank-stock`, then
  `bash infra/anydesk/setup.sh` (or the Mac: `infra/mac/README.md`).

**Who can open it:** anyone signed in to your Tailscale network, including
FuelTrans's Operations menu. Keep that network to your own devices.
