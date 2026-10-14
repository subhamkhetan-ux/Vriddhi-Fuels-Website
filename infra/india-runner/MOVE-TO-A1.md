# Moving to an Ampere A1 server (with the current one kept on)

> **Tank stock no longer runs on the Oracle server.** It moves to the Mac
> ([infra/mac/README.md](../mac/README.md)). On an A1, skip steps B5–B7 and the
> tank stock parts of part C.

The current server is the 1 GB **E2.1.Micro**. Chromium, AnyDesk and the
tank stock reader share that memory, so things start slowly and spill into
swap. An **Ampere A1** with 2 OCPUs and 12 GB is also Always Free. This guide
sets one up **next to** the current server, tries it, and moves over only once
everything works there. Until the last part, the current server keeps doing
all the work.

**Staying free:**
- All your A1 servers together may use up to 4 OCPUs and 24 GB.
- All boot volumes together may use up to 200 GB. The two servers use about
  47 GB each.
- Only pick shapes that show **Always Free-eligible**.

## A. Create the A1 server

Oracle console → **Compute → Instances → Create instance**:

| Setting | Value |
| --- | --- |
| Name | `oracle-a1` |
| Image | **Canonical Ubuntu 24.04** (the ARM build is picked for you) |
| Shape | **Ampere → VM.Standard.A1.Flex**, **2 OCPUs, 12 GB** (*Always Free-eligible*) |
| Networking | The **existing** virtual cloud network and public subnet (the ones `oracle-india` uses); **Assign a public IPv4 address: Yes** |
| SSH keys | **Paste public keys**: the same key as before (`cat ~/.ssh/oracle_india.pub` in Cloud Shell) |
| Boot volume | Default |

*"Out of capacity for shape VM.Standard.A1.Flex"* means Oracle's free ARM
servers are all taken right now. Try again later: early morning or late night
IST often works. You can also try 1 OCPU / 6 GB, which is still plenty. Nothing
is charged for trying.

When it shows *Running*, copy its **Public IP address**. In Cloud Shell, log in:

```sh
ssh -i ~/.ssh/oracle_india ubuntu@NEW_IP
```

## B. Set it up next to the current server

Nothing below moves any work yet. On the new server:

```sh
git clone https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website.git
cd Vriddhi-Fuels-Website
```

1. **GitHub runner, under its own name and label.** The name must not be
   `oracle-india`, or it would replace the current server's runner:

   ```sh
   RUNNER_NAME=oracle-a1 RUNNER_LABELS=india-a1 bash infra/india-runner/setup.sh
   ```

   For the registration token: GitHub → **Settings → Actions → Runners → New
   self-hosted runner** → Linux. Copy the code after `--token`.

   The scheduled jobs keep going to the current server, which has the label
   `india`. The new one only gets the jobs you send it.

2. **Check e-Mitra from it.** Actions → **IOCL PAD balance** → **Run workflow**,
   with mode `network` and server `india-a1`. The log should show an Indian
   location.

3. **XtraPower monitor, installed but not started:**

   ```sh
   bash infra/xtrapower/setup.sh
   ```

   It ends with *"the monitor is NOT started yet: config.json still has
   placeholders"*. That's intended: two monitors on the same portal account
   would keep logging each other out. It starts in part C.

4. **Tailscale and the app's page:**

   ```sh
   bash infra/xtrapower/phone-setup.sh
   ```

   Open the login link it prints, with the same Tailscale account as before.
   The new server gets its own address, `https://oracle-a1.<your-tailnet>.ts.net/`.

5. **Tank stock (AnyDesk):**

   ```sh
   bash infra/anydesk/setup.sh
   ```

   This step also checks that AnyDesk installs on this ARM server. If it stops
   with *"AnyDesk did not install cleanly on this aarch64 server"*, send me the
   lines above that message. The current server carries on unchanged.

6. **Give it the AnyDesk login:** Actions → **Tank stock** → **Run workflow**,
   with mode `save-login` and server `india-a1`.

7. **Try it.** Open the new address → **Tank stock** → **Capture only**. Use
   one server's page at a time, because both connect to the same IOCL PC.

## C. Move over

Do this once part B works.

1. **XtraPower.** In Cloud Shell, copy the accounts and the last balances
   across. They pass straight from one server to the other and nothing is
   saved on the way. Then stop the old monitor and start the new one:

   ```sh
   OLD=ubuntu@OLD_IP NEW=ubuntu@NEW_IP K=~/.ssh/oracle_india
   for f in config.json state.json; do
     ssh -i $K $OLD "sudo cat /opt/xtrapower/$f" | ssh -i $K $NEW "sudo -u xtrapower tee /opt/xtrapower/$f >/dev/null"
   done
   ssh -i $K $OLD "sudo systemctl disable --now xtrapower"
   ssh -i $K $NEW "sudo systemctl restart xtrapower"
   ```

   You get *"▶️ XtraPower monitor started"*, then a ✅ for each account.

2. **The scheduled jobs.** GitHub → **Settings → Actions → Runners**:
   - On `oracle-a1`, add the label `india`.
   - On `oracle-india`, remove the label `india`.

3. **Keep the phone link.** On <https://login.tailscale.com/admin/machines>:
   - Rename `oracle-india` to `oracle-india-old`.
   - Rename `oracle-a1` to `oracle-india`.

   Then on the new server, run `bash infra/anydesk/setup.sh` once more. Your
   saved link opens the new server.

4. **The old server.** Stop its tank stock page:

   ```sh
   sudo systemctl disable --now tank-stock-session
   ```

   Keep the server for a week in case anything was missed. Then, in Oracle:
   **Instance → More actions → Terminate**, and tick *permanently delete the
   attached boot volume*.

To go back at any point before step 4, undo the steps of part C in reverse
order. The old server still has everything.
