# India runner (Oracle Cloud Always Free)

GitHub's own runners are in the US/EU, and the IOCL e-Mitra host drops their
connections (TCP 443 and 80 time out, while other IndianOil sites answer). This
folder sets up a free Oracle Cloud server in India as a **self-hosted GitHub
Actions runner**. Workflows still live in this repo and are started by GitHub
on their schedules; only the job runs on the Indian server.

Any workflow can use it with:

```yaml
runs-on: [self-hosted, india]
```

It runs one job at a time; others wait in the queue. Python agents can use
`/opt/agents/venv/bin/python` (Playwright Chromium and Tesseract preinstalled).

Everything below is done in a web browser, including from a phone. No
personal computer is needed.

## 1. Create the Oracle Cloud account

1. Open <https://www.oracle.com/cloud/free/> and choose **Start for free**.
2. Country **India**; verify your email.
3. **Home Region: India West (Mumbai)** or **India South (Hyderabad)**. This
   is permanent, and Always Free servers can only be created in it.
4. Add the address and mobile number, then verify a card. Oracle places a small
   temporary hold. Credit cards with online/international use enabled work most
   reliably; many debit and RuPay cards are rejected.
5. Wait for the "account is ready" email (minutes to a few hours).

**Keep the server from being reclaimed.** Oracle may stop Always Free servers
that look idle (under 20% CPU, network and memory for 7 days), and a runner is
idle most of the time. Upgrading to **Pay As You Go** (Billing → *Upgrade and
manage payment*) exempts the server from that rule and stays free as long as you
only use Always Free resources. After upgrading, add a budget alert (Billing →
*Budgets*, for example ₹100/month) so any accidental paid usage emails you.

## 2. Create an SSH key in Cloud Shell

In the Oracle console, click the **Cloud Shell** icon (`>_`, top right). In the
terminal that opens:

```sh
ssh-keygen -t rsa -b 4096 -N "" -f ~/.ssh/oracle_india
cat ~/.ssh/oracle_india.pub
```

Copy the whole line that starts with `ssh-rsa` (it wraps over several lines).
Cloud Shell runs in FIPS mode, which rejects ED25519 keys.

## 3. Create the server

Menu → **Compute → Instances → Create instance**:

| Setting | Value |
| --- | --- |
| Name | `oracle-india` |
| Image | **Canonical Ubuntu 24.04** |
| Shape | **Ampere → VM.Standard.A1.Flex**, **2 OCPUs, 12 GB** (shows *Always Free-eligible*) |
| Networking | Create a new virtual cloud network and public subnet; **Assign a public IPv4 address: Yes** |
| SSH keys | **Paste public keys**, then paste the line from step 2 |
| Boot volume | Default (about 47 GB; 200 GB total is free) |

Click **Create** and copy the **Public IP address** once the instance shows
*Running*. No inbound ports are needed besides the default SSH; the runner only
makes outbound connections to GitHub.

*"Out of capacity for shape VM.Standard.A1.Flex"* means Oracle's free ARM pool
is full (Hyderabad and Mumbai each have a single availability domain). Retry
later, or try 1 OCPU / 6 GB. Pay As You Go accounts usually get capacity more
easily. Meanwhile the AMD **VM.Standard.E2.1.Micro** (1 GB, also Always Free) is
usually available: pick it, re-select Ubuntu 24.04, and the setup script adds a
2 GB swap file so the browser fits. It is slower, but it is enough to verify
e-Mitra access and run the agent until an A1 can be created.

## 4. Run the setup script on the server

Back in Cloud Shell (replace `PUBLIC_IP`):

```sh
ssh -i ~/.ssh/oracle_india ubuntu@PUBLIC_IP
```

On the server:

```sh
git clone https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website.git
cd Vriddhi-Fuels-Website
bash infra/india-runner/setup.sh
```

The script first checks that e-Mitra answers from this server, and stops without
installing anything if it doesn't. It then installs Python, Tesseract, Playwright
Chromium and the GitHub runner. The runner runs as a separate `runner` user with
no sudo, and starts automatically on boot.

When it asks for a **registration token**: on GitHub open the repo's
**Settings → Actions → Runners → New self-hosted runner**, pick **Linux**, and
copy only the value after `--token` from the *Configure* box. It is valid for
one hour; the input is hidden.

When it finishes, **Settings → Actions → Runners** shows `oracle-india` as
**Idle**.

## 5. Lock down the public repo (required)

This repo is public. A stranger's pull request must never be able to run code on
your server. In **Settings → Actions → General → Approval for running fork pull
request workflows from contributors**, choose **Require approval for all external
contributors**, and never approve workflow runs on pull requests you don't fully
trust. Only use `runs-on: [self-hosted, india]` in scheduled or manually started
workflows, never in `pull_request` workflows.

## 6. Turn on the IOCL agent

Follow **Live setup** in [`iocl_portal/README.md`](../../iocl_portal/README.md):
add the e-Mitra secrets, then run the workflow in `network`, `probe` and `dry-run`
modes before enabling the schedule.

## Maintenance

- The runner updates itself. Ubuntu installs security updates automatically.
- Status and logs: `sudo systemctl status 'actions.runner.*'` and
  `journalctl -u 'actions.runner.*' -n 100` on the server.
- To remove it: in `/opt/actions-runner`, run `sudo ./svc.sh stop`,
  `sudo ./svc.sh uninstall`, then `sudo -u runner ./config.sh remove --token TOKEN`
  (token from the same GitHub Runners page), and terminate the instance in
  Oracle.
