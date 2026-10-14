#!/usr/bin/env bash
# Ubuntu's automatic updates (apt-daily, unattended-upgrades) run by default
# around 06:00-07:00 UTC = 11:30-12:30 IST, in the middle of the working day,
# and take about 250 MB while they run: on a 1 GB server that pushes the
# XtraPower Chromium and the AnyDesk session into swap. Move them to the night
# in India, after the IOCL opening-balance runs (00:33-01:38 IST):
# the package lists at 02:30 IST, the upgrades at 03:00 IST.
# Safe to re-run; called by infra/india-runner/setup.sh and infra/anydesk/setup.sh.
set -euo pipefail

drop_in() {   # timer, UTC time
  local dir="/etc/systemd/system/$1.timer.d"
  sudo mkdir -p "$dir"
  printf '[Timer]\nOnCalendar=\nOnCalendar=*-*-* %s UTC\nRandomizedDelaySec=10m\n' "$2" \
    | sudo tee "$dir/night-in-india.conf" >/dev/null
}
drop_in apt-daily 21:00            # 02:30 IST
drop_in apt-daily-upgrade 21:30    # 03:00 IST
sudo systemctl daemon-reload
sudo systemctl restart apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
echo "Ubuntu's automatic updates now run at night (02:30-03:10 IST)."
