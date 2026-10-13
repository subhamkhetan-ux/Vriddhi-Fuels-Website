#!/bin/bash
# Runs inside the runner user's login session (tank-stock-session.service).
#
# AnyDesk only starts for a process of the logged-in user's session, which a
# GitHub job is not. So the tank-stock job leaves a request in the queue
# (python -m tank_stock.run --capture does this) and the capture runs here,
# in the session, with the job's checkout and the job's secrets. Same user,
# same rights as the job itself. Installed by infra/anydesk/setup.sh.
Q=${TANK_STOCK_QUEUE:-/opt/agents/tank-stock-queue}
PY=${TANK_STOCK_PYTHON:-/opt/agents/venv/bin/python}
install -d -m 700 "$Q"
while sleep 2; do
  for req in "$Q"/*.req; do
    [ -f "$req" ] || continue
    job="${req%.req}"
    workdir=$(cat "$req")
    rm -f "$req"
    if [ -d "$workdir" ]; then
      (cd "$workdir" && exec "$PY" -m tank_stock.run --in-session "$job") >"$job.log" 2>&1
      rc=$?
    else
      echo "The job's checkout is gone." >"$job.log"
      rc=1
    fi
    echo "$rc" >"$job.rc.tmp" && mv "$job.rc.tmp" "$job.rc"
  done
done
