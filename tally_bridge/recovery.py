"""Start a stopped Tally process only before work; never kill an open accounting session."""
from pathlib import Path
import re
import time

from .tally import TallyProblem
from .transport import ConnectionProblem


class TallyStarting(TallyProblem):
    pass


def startup_settings(path, number):
    exe = Path(path).expanduser()
    if not exe.is_absolute() or exe.name.lower() not in ("tally.exe", "tallyprime.exe") or not exe.is_file() or str(exe).startswith("\\\\"):
        raise RuntimeError("Select the installed local Tally.exe (or TallyPrime.exe).")
    number = str(number).strip()
    if not re.fullmatch(r"[0-9]{1,9}", number) or int(number) <= 0:
        raise RuntimeError("Enter the numeric company folder number shown in Tally's company selection (for example 10000).")
    return {"enabled": True, "exe": str(exe.resolve()), "number": number}


class Recovery:
    def __init__(self, tally, config, store, processes, launch, clock=time.time):
        self.tally, self.config, self.store = tally, config, store
        self.processes, self.launch, self.clock = processes, launch, clock

    def ensure(self):
        try:
            result = self.tally.verify()
        except ConnectionProblem:
            pass
        else:
            if self.store.get("tally_launch_failures", 0):
                self.store.set("tally_launch_failures", 0)
            restarted = self.store.get("tally_recovery_pending", False)
            if restarted:
                self.store.set("tally_recovery_pending", False)
            return restarted
        if not self.config.get("enabled"):
            raise ConnectionProblem("Tally is unavailable")
        try:
            settings = startup_settings(self.config.get("exe", ""), self.config.get("number", ""))
        except RuntimeError as e:
            raise TallyProblem(str(e)) from None
        # A live process may be busy, loading, awaiting a prompt or using another port.
        # None of these is permission to kill it or open a competing Tally instance.
        try:
            running = self.processes()
        except (OSError, RuntimeError):
            raise TallyProblem("Windows could not inspect running Tally processes. No new instance was started; review the bridge's Windows account.") from None
        if running:
            raise TallyStarting("Tally is running; waiting for its XML server. If a company/login prompt is shown, open the paired company once. No extra Tally instance was started.")
        now = self.clock()
        failures = self.store.get("tally_launch_failures", 0)
        last = self.store.get("tally_last_launch", 0)
        cooldown = min(900, 30 * 2 ** min(failures, 5))
        if last and now - last < cooldown:
            raise TallyStarting("Waiting before another Tally start attempt; queued work is retained.")
        # Persist the throttle BEFORE launching, including across worker restarts.
        self.store.set("tally_recovery_pending", True)
        self.store.set("tally_last_launch", now)
        self.store.set("tally_launch_failures", min(failures + 1, 6))
        try:
            self.launch(settings)
        except OSError:
            raise TallyProblem("Windows could not start Tally. Check the selected installation and Windows Security; do not disable Defender. Queued work is retained.") from None
        raise TallyStarting("Starting Tally minimized with the paired company's startup number. Sync resumes after company identity is verified.")
