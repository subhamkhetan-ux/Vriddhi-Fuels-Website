# Tank stock on your Mac (Oracle keeps e-Mitra and XtraPower)

The tank stock agent connects to the IOCL PC with AnyDesk, reads the tank cards
and sends them to the decant app. It runs on your Mac mini at home now, not on
the 1 GB Oracle server. The Oracle server keeps the e-Mitra PAD job and the
XtraPower monitor. The Vriddhi Fuels app on your phone keeps its address: its
**Tank stock** tab shows the Mac's page.

**Why a virtual machine.** The automation is built on Linux tools: a virtual
screen, simulated clicks, and AnyDesk's Linux command line. In a small Ubuntu
virtual machine (VM) in **Parallels Desktop**, the same code runs unchanged.
It runs without a window, so nothing appears on your Mac's screen and you can
keep using the Mac normally.

**What the Mac must do.**
- Stay switched on, awake and online during the hours you need tank stock.
- If the Mac is off, the Tank stock tab says so. Nothing else stops: e-Mitra
  and XtraPower carry on on Oracle.

## 0. Remove AnyDesk from the Oracle server (once)

On the Oracle server (Cloud Shell → `ssh -i ~/.ssh/oracle_india ubuntu@PUBLIC_IP`):

```sh
cd ~/Vriddhi-Fuels-Website && git pull && bash infra/anydesk/uninstall.sh
```

This removes:
- AnyDesk itself;
- the tank stock page and its console login session;
- the tank stock code and data, including the saved AnyDesk login and the copy
  of the bot token;
- the tools only the tank stock used (xdotool and ImageMagick).

The script shows how much memory it freed. The e-Mitra runner, the XtraPower
monitor and the app stay. Until part D, the app's Tank stock tab says *"Tank
stock is moving to the Mac"*. From then on, `bash infra/anydesk/setup.sh` on
Oracle only updates the app's page; it never installs AnyDesk again.

## A. Prepare the Mac (once)

1. **System Settings → Energy**:
   - *Prevent automatic sleeping when the display is off*: **on**
   - *Wake for network access*: **on**
   - *Start up automatically after a power failure*: **on**
2. **System Settings → Users & Groups → Automatically log in as**: your user.
   This lets the VM come back by itself after a power cut. With FileVault on,
   this option isn't offered; then just log in once after a power cut.
3. Download **Ubuntu Server 24.04 for ARM** (an `.iso` file, about 2.5 GB):
   <https://ubuntu.com/download/server/arm>.

   Use the **Server** image, not the Ubuntu option Parallels offers to download.
   That one is Ubuntu Desktop, whose own login screen gets in the way of the
   console session AnyDesk needs.

## B. Create the VM in Parallels Desktop

1. **File → New → Install Windows, Linux or macOS from an image file** →
   Continue. Choose the Ubuntu Server `.iso`, then Continue.
2. Name it `Tank stock`. Tick **Customize settings before installation**, then
   **Create**.
3. In the settings window that opens:
   - **Hardware → CPU & Memory**: 2 processors, 4096 MB.
   - **Hardware → Network**: *Shared Network* (the default).
   - **Options → Startup and Shutdown**:
     - *Start automatically*: **When Mac starts**. If your edition doesn't
       offer it, choose **When user logs in**.
     - *Startup View*: **Headless** (no window).
     - *On Mac shutdown*: **Shut down**.
     - Turn off any *Pause after inactivity* option.
4. Close the settings window and press **Continue** to start the install. Use
   the defaults, plus:
   - Your name and a username, for example `vf`.
   - Server name `mac-tank`.
   - Tick **Install OpenSSH server**.
   - Choose no extra snaps.
5. When it says *Reboot now*, press Enter. If it asks to remove the
   installation medium, use **Devices → CD/DVD → Disconnect**, then press
   Enter. Log in. The welcome text shows the VM's IP address, next to
   *IPv4 address for enp0s5*.

Typing commands is easier from the Mac's **Terminal**: `ssh vf@THAT_IP`.
Parallels Tools aren't needed on a server VM.

## C. Set up tank stock in the VM

```sh
git clone https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website.git
cd Vriddhi-Fuels-Website
bash infra/mac/vm-setup.sh
```

It asks for three things, once each:
- **Tailscale**: open the link it prints and sign in with the same account as
  your phone.
- **The AnyDesk numbers and password**: the values you keep in the GitHub
  secrets `ANYDESK_IDS` and `ANYDESK_PASSWORD`. The password input is hidden.
- **The XtraPower bot token and chat id**: they are in the XtraPower monitor's
  settings on the Oracle server. Show them with:

  ```sh
  sudo python3 -c "import json; t=json.load(open('/opt/xtrapower/config.json'))['telegram']; print(t['token']); print(t['chat_id'])"
  ```

If it stops at *"AnyDesk did not install cleanly on this aarch64 server"*, send
me the lines above that message. AnyDesk's ARM build is the one thing this
setup can't check in advance. The fallback is running AnyDesk's x86 build
under Apple's Rosetta, which Parallels supports.

When it's done, it prints the VM's own page, for example
`https://mac-tank.<your-tailnet>.ts.net:8443/`. Open it on your phone and press
**Capture only**.

## D. Point the Vriddhi Fuels app at the Mac

On the **Oracle server**, with the address part C printed:

```sh
cd ~/Vriddhi-Fuels-Website && git pull
bash infra/mac/use-mac-tank-stock.sh https://mac-tank.<your-tailnet>.ts.net:8443
```

It checks that the Mac answers, then switches the app's Tank stock tab to it.

To update the Mac's tank stock code later, run this in the VM:

```sh
cd ~/Vriddhi-Fuels-Website && git pull && bash infra/mac/vm-setup.sh
```

To change the saved AnyDesk login or bot later, run
`ASK_AGAIN=1 bash infra/mac/vm-setup.sh`.

## If the Mac will be away for a long time

Tank stock can go back on the Oracle server. It's slower there, and it uses
the memory the other tasks need:

```sh
bash infra/mac/use-mac-tank-stock.sh --back && bash infra/anydesk/setup.sh
```
