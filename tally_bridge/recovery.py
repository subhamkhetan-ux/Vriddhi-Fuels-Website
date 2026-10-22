"""Start a stopped Tally process only before work; never kill an open accounting session."""
from pathlib import Path
import re
import time

from .tally import TallyProblem
from .transport import ConnectionProblem


class TallyStarting(TallyProblem):
    pass


# A hidden Tally that has not answered by then may be showing a login, licence or company
# prompt nobody can see: it is shown. Windows it opens while loading are hidden until then.
REVEAL_AFTER = 120
WATCH_FOR = 300


def startup_settings(path, number, hidden=False):
    exe = Path(path).expanduser()
    if not exe.is_absolute() or exe.name.lower() not in ("tally.exe", "tallyprime.exe") or not exe.is_file() or str(exe).startswith("\\\\"):
        raise RuntimeError("Select the installed local Tally.exe (or TallyPrime.exe).")
    number = str(number).strip()
    if not re.fullmatch(r"[0-9]{1,9}", number) or int(number) <= 0:
        raise RuntimeError("Enter the numeric company folder number shown in Tally's company selection (for example 10000).")
    return {"enabled": True, "exe": str(exe.resolve()), "number": number, "hidden": bool(hidden)}


class Recovery:
    def __init__(self, tally, config, store, processes, launch, clock=time.time, show=None):
        self.tally, self.config, self.store = tally, config, store
        self.processes, self.launch, self.clock = processes, launch, clock
        self.show = show  # show(visible, pids): hide or reveal Tally's windows

    def keep_hidden(self, running_pids=None):
        """While a Tally the bridge started in the background is loading, hide any window it
        opens; if it has not answered in time, show it so its prompt can be dealt with."""
        pid = self.store.get("tally_hidden_pid")
        if not pid or not self.show:
            return None
        if running_pids is not None and pid not in running_pids:
            self.store.set("tally_hidden_pid", None)
            return None
        age = self.clock() - self.store.get("tally_last_launch", 0)
        try:
            if running_pids is not None and age >= REVEAL_AFTER:
                self.store.set("tally_hidden_pid", None)
                self.show(True, [pid])
                return "shown"
            if age < WATCH_FOR:
                self.show(False, [pid])
            else:
                self.store.set("tally_hidden_pid", None)
        except (OSError, RuntimeError):
            pass
        return None

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
            self.keep_hidden()  # Tally may show its window once the company has loaded
            return restarted
        if not self.config.get("enabled"):
            raise ConnectionProblem("Tally is unavailable")
        try:
            settings = startup_settings(self.config.get("exe", ""), self.config.get("number", ""), self.config.get("hidden", False))
        except RuntimeError as e:
            raise TallyProblem(str(e)) from None
        # A live process may be busy, loading, awaiting a prompt or using another port.
        # None of these is permission to kill it or open a competing Tally instance.
        try:
            running = self.processes()
        except (OSError, RuntimeError):
            raise TallyProblem("Windows could not inspect running Tally processes. No new instance was started; review the bridge's Windows account.") from None
        if running:
            if self.keep_hidden({p.get("pid") for p in running}) == "shown":
                raise TallyStarting("Tally has not answered for two minutes, so it is now shown on screen: a login, "
                                    "licence or company prompt may need attention. Sync resumes once it answers.")
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
            pid = self.launch(settings)
            self.store.set("tally_hidden_pid", pid if settings["hidden"] and isinstance(pid, int) else None)
        except OSError:
            raise TallyProblem("Windows could not start Tally. Check the selected installation and Windows Security; do not disable Defender. Queued work is retained.") from None
        raise TallyStarting("Starting Tally " + ("in the background" if settings["hidden"] else "minimized")
                            + " with the paired company's startup number. Sync resumes after company identity is verified.")
