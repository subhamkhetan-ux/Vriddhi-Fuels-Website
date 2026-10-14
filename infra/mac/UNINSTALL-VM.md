# Removing the Tank Stock VM from the Mac (no leftovers)

This removes the Ubuntu Server virtual machine **Tank Stock** that runs tank
stock in Parallels Desktop (set up by [README.md](README.md)), together with
everything it left on the Mac, on the Oracle server and in Tailscale.
Parallels itself stays installed.

Work through the steps in order. Step 1 comes first so that the phone app
never points at a machine that no longer exists.

| Where | What gets removed |
| --- | --- |
| Oracle server | The app's link to the Mac's tank stock page |
| Tailscale | The `mac-tank` device |
| Inside the VM | Nothing needs doing: its saved AnyDesk login and bot token are deleted with the VM |
| Parallels | The VM, its virtual disk and its snapshots |
| Mac | The Ubuntu ISO, the SSH fingerprint, any start-up item, the settings changed for the VM |

## 1. Unhook the phone app (on the Oracle server)

In Cloud Shell → `ssh -i ~/.ssh/oracle_india ubuntu@PUBLIC_IP`, pick **one**
of these:

- **Tank stock moves back to the Oracle server:**

  ```sh
  cd ~/Vriddhi-Fuels-Website && git pull
  bash infra/mac/use-mac-tank-stock.sh --back && bash infra/anydesk/setup.sh
  ```

- **Tank stock is turned off.** The app's Tank stock tab then says *"Tank
  stock is moving to the Mac"*:

  ```sh
  printf '[Service]\nEnvironment=XTRAPOWER_TANK_STOCK=off\n' \
    | sudo tee /etc/systemd/system/xtrapower-manage.service.d/tank-stock-on-mac.conf >/dev/null
  sudo systemctl daemon-reload && sudo systemctl restart xtrapower-manage
  ```

The e-Mitra jobs and the XtraPower monitor on Oracle aren't affected either way.

## 2. Take the VM off Tailscale

While the VM is still running, in the Mac's Terminal (`ssh vf@10.211.55.4`, or
in the VM's window):

```sh
sudo tailscale logout
```

Then open <https://login.tailscale.com/admin/machines>, find **mac-tank**,
click **⋯ → Remove**, and confirm. If the VM was already gone, the Remove step
alone is enough. The device stays listed until you remove it here.

## 3. Shut the VM down

Choose one:
- In the Mac's Terminal: `prlctl stop "Tank Stock"`
- In Parallels: **Control Center** → right-click **Tank Stock** → **Shut Down**

Wait until it shows as stopped. `prlctl list -a` shows its status as
`stopped`.

## 4. Delete the VM in Parallels

1. **Control Center** → right-click **Tank Stock** → **Remove "Tank Stock"…**
2. Choose **Move to Trash**, not *Keep Files*. Keep Files would leave the
   whole virtual disk, up to 64 GB, on the Mac.
3. Empty the Trash: Finder → **Empty Trash**.

From the Terminal the same thing is `prlctl delete "Tank Stock"`. It deletes
the VM's files directly, without going through the Trash.

The VM's snapshots, if you ever took any, are inside the VM's package, so they
go with it.

## 5. Clean up the Mac

In the Mac's Terminal:

```sh
# The Ubuntu installer image (about 2.5–3 GB), if it is still there
rm -f ~/Downloads/ubuntu-24.04*-live-server-arm64.iso

# The VM's SSH fingerprint, so a future VM at the same address isn't refused
ssh-keygen -R 10.211.55.4

# A start-up item from the earlier UTM version of the guide, if one was made
launchctl unload ~/Library/LaunchAgents/in.vriddhi.tank-vm.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/in.vriddhi.tank-vm.plist
```

If the VM's address wasn't `10.211.55.4`, use the address it had in
`ssh-keygen -R`.

## 6. Settings changed for the VM (optional)

These were set so the VM could run all day. Turn them back if you don't need
them for anything else:

- **System Settings → Energy**:
  - *Prevent automatic sleeping when the display is off*
  - *Wake for network access*
  - *Start up automatically after a power failure*
- **System Settings → Users & Groups → Automatically log in as**: **Off**.

## 7. Check nothing is left

```sh
prlctl list -a                                   # Tank Stock is not listed
ls ~/Parallels 2>/dev/null                       # no "Tank Stock.pvm"
mdfind -name "Tank Stock.pvm"                    # finds nothing (it may have been saved elsewhere)
ls ~/Library/LaunchAgents | grep -i -E "tank|vriddhi"   # prints nothing
ls ~/Downloads | grep -i ubuntu                  # prints nothing
```

Also confirm that the Tailscale admin page no longer lists **mac-tank**, and
that the Vriddhi Fuels app's **Tank stock** tab shows either the Oracle
server's page or the *"moving to the Mac"* note.

## Nothing to remove elsewhere

- **The IOCL PC**: AnyDesk there only knows its own unattended-access
  password. Nothing was added on the PC for the VM. If you ever added the VM's
  AnyDesk number to an allow list (AnyDesk → Settings → Security → Access
  control list), remove it there.
- **GitHub**: no runner or secret belongs to the VM. `ANYDESK_IDS` and
  `ANYDESK_PASSWORD` stay; they are the IOCL PC's own details.
- **The decant app**: readings the VM sent stay as stock records. They are your
  data, not leftovers.
- **Telegram**: the XtraPower bot stays. The VM only held a copy of its token.
