"""One Tally on this PC, whatever the employees click.

Employees open Tally from its desktop icon. If a Tally is already running (often the one
the bridge keeps in the background), that click starts a second copy: two windows on the
same books, and on a single-user licence possibly an Educational-mode copy. The guard sees
the new copy within a second, brings the Tally that is already open to the front (company
loaded), and asks the new copy to close the way its ✕ would, before it has opened a company.
Nothing is ever force-closed: a copy that will not close is reported instead.
"""
import time

SETTLE = 20  # seconds a new copy has to close before it is reported instead


class TallyGuard:
    def __init__(self, store, processes, show, close, log, clock=time.time):
        self.store, self.processes, self.show, self.close, self.log, self.clock = store, processes, show, close, log, clock
        self.known = None    # Tally PIDs at the previous look
        self.closing = {}    # new copy PID -> when it was first asked to close

    def poll(self):
        running = {p["pid"]: p for p in self.processes()}
        now = self.clock()
        if self.known is None:  # first look after the bridge starts: nothing is "new"
            self.known = set(running)
            return
        # A Tally process started BY a Tally process is part of it, never a second copy.
        new = [pid for pid in running if pid not in self.known and running[pid].get("parent") not in running]
        older = [pid for pid in running if pid in self.known]
        if new and older:
            hidden = self.store.get("tally_hidden_pid")
            keep = [hidden] if hidden in older else older
            # Employees are using it now: the bridge never hides it again.
            self.store.set("tally_hidden_pid", None)
            self.show(True, keep)
            for pid in new:
                self.closing.setdefault(pid, now)
            self.log("Tally was opened again while it was already running: brought the open Tally forward "
                     "and asked the extra copy to close")
        for pid, since in list(self.closing.items()):
            if pid not in running:
                del self.closing[pid]
                self.log("The extra Tally copy closed; one Tally is open")
            elif now - since > SETTLE:
                del self.closing[pid]
                note = "Two copies of Tally are open on this PC. Close the newer one so everyone works in the same Tally."
                self.store.set("tally_notice", {"at": now, "text": note})
                self.log(note)
            else:
                self.close(pid)
        if not any(pid in running for pid in self.closing) and len(running) <= 1:
            notice = self.store.get("tally_notice")
            if notice:
                self.store.set("tally_notice", None)
        self.known = set(running)
