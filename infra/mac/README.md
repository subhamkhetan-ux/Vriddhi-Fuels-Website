# Tank stock on your Mac (Oracle keeps e-Mitra and XtraPower)

The tank stock agent connects to the IOCL PC with AnyDesk, reads the tank cards
and sends them to the decant app. Here it moves from the 1 GB Oracle server to
your Mac at home. The Oracle server keeps the e-Mitra PAD job and the XtraPower
monitor, and gets back the memory AnyDesk was using. The Vriddhi Fuels app on
your phone keeps its address; only its **Tank stock** tab now shows the Mac's
page.

**Why a virtual machine.** The automation is built on Linux tools: a virtual
screen, simulated clicks, and AnyDesk's Linux command line. In a small Ubuntu
virtual machine (VM) on the Mac, the same code runs unchanged, and nothing
appears on your Mac's own screen. You can keep using the Mac normally while it
works.

**What the Mac must do.**
- Stay switched on, awake and online during the hours you need tank stock.
- If the Mac is off, the Tank stock tab says so. Nothing else stops: e-Mitra
  and XtraPower carry on on Oracle.
- You can switch back to the Oracle server with one command (part E).

## A. Prepare the Mac (once)

1. **System Settings → Energy**:
   - *Prevent automatic sleeping when the display is off*: **on**
   - *Wake for network access*: **on**
   - *Start up automatically after a power failure*: **on**
2. **System Settings → Users & Groups → Automatically log in as**: your user.
   This lets the VM come back by itself after a power cut. With FileVault on,
   this option isn't offered; then just log in once after a power cut.
3. Install **UTM**, a free virtual machine app: <https://mac.getutm.app> →
   Download, then drag it to Applications.
4. Download **Ubuntu Server 24.04 for ARM** (an `.iso` file):
   <https://ubuntu.com/download/server/arm>.

## B. Create the virtual machine

1. UTM → **Create a New Virtual Machine** → **Virtualize** → **Linux**.
2. Settings:
   - **Boot ISO image**: the Ubuntu file you downloaded.
   - **Memory** 4096 MB, **CPU cores** 2.
   - **Storage** 20 GB.
   - **Name** `Tank stock`.
3. Start it and install Ubuntu with the defaults:
   - Your name and a username, for example `vf`.
   - Server name `mac-tank`.
   - Tick **Install OpenSSH server**.
   - Choose no extra snaps.
4. When it finishes, eject the ISO (the CD icon in UTM's toolbar → Clear), then
   restart the VM. The VM window shows its IP address after login. Typing
   commands is easier from the Mac's **Terminal**: `ssh vf@THAT_IP`.

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
- **The XtraPower bot token and chat id**: on the Oracle server, run
  `sudo cat /opt/agents/tank-telegram.json` and copy the two values.

If it stops at *"AnyDesk did not install cleanly on this aarch64 server"*, send
me the lines above that message. AnyDesk's ARM build is the one thing this
setup can't check in advance. The fallback is running AnyDesk's x86 build
under Apple's Rosetta. Nothing has changed on Oracle by then.

When it's done, it prints the VM's own page, for example
`https://mac-tank.<your-tailnet>.ts.net:8443/`. Open it on your phone and press
**Capture only**. Use one page at a time (the Mac's or Oracle's), since both
connect to the same IOCL PC.

## D. Point the Vriddhi Fuels app at the Mac

On the **Oracle server** (Cloud Shell → `ssh -i ~/.ssh/oracle_india ubuntu@PUBLIC_IP`),
with the address part C printed:

```sh
cd ~/Vriddhi-Fuels-Website && git pull
bash infra/mac/use-mac-tank-stock.sh https://mac-tank.<your-tailnet>.ts.net:8443
```

It checks that the Mac answers. Then it switches the app's Tank stock tab to
the Mac, and stops the Oracle server's own tank stock page and AnyDesk.

From then on, `bash infra/anydesk/setup.sh` on Oracle only updates the app's
page. To update the Mac's tank stock code, run this in the VM:

```sh
cd ~/Vriddhi-Fuels-Website && git pull && bash infra/mac/vm-setup.sh
```

## E. Start the VM with the Mac, and the way back

1. **System Settings → General → Login Items**: add **UTM**.
2. Then, in the Mac's Terminal (once), have the VM start a little after login:

```sh
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/in.vriddhi.tank-vm.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>in.vriddhi.tank-vm</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>sleep 30; /Applications/UTM.app/Contents/MacOS/utmctl start "Tank stock"</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
launchctl load ~/Library/LaunchAgents/in.vriddhi.tank-vm.plist
```

**Back to the Oracle server** at any time (for example, if the Mac will be off
for a while). On the Oracle server:

```sh
bash infra/mac/use-mac-tank-stock.sh --back
```

The GitHub **Tank stock** workflow belongs to the Oracle server. Once the Mac
does the work, use the app instead.
