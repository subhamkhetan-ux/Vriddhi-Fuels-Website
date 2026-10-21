"""Automatic decantation, run by the tank stock service (service.py).

From the page you pick a truck's invoice and which chamber goes into which
tank, and press Start. Then, without anyone touching the decant app:

1. live monitoring connects (or the open session is used) and reads every
   tank every ~10 s;
2. a full read of the planned tanks gives each one's **stock before**, saved
   to the decant app with its proof picture, and the decantation is created
   in the app (``dec_sessions``), its tanks waiting;
3. ``decantation.Decantation`` follows the stock: decanting started, each
   chamber in, done, settling, steady; a full read then gives the **stock
   after**, and once every tank has one the decantation is **finished and
   saved** with the app's result.

When the stock says something the plan didn't (a tank stopped short, got
more than planned, or never started) it asks on the page and on Telegram,
and waits for the answer. A phone can still do anything in the decant app
meanwhile: the agent takes the app's copy over when it is newer. If AnyDesk
ends the session, it connects again; if the service restarts, it carries on
from ``decantation.json``. "Hand over" leaves the decantation to the app.

Fail-safes: a tank's card whose "Last Updated" time stops moving has frozen
figures (probe, ATG or FuelTrans down) that look like a settled tank, so a
run won't start on one and nothing is taken from one while it runs (the stock
after waits until it updates). Each stock before / after keeps its tank's
zoomed card here (the page shows it) and in the decant app (for the result
picture), sent again until the app takes it.
"""
from __future__ import annotations

import copy
import threading
import time
import traceback

from . import decantation as dz

AUTO_FILE = "decantation.json"
ACTIVE = ("starting", "running", "paused")
INTERVAL_S = 10            # live reads while it runs, whatever the live setting
FIRST_READ_WAIT = 240      # seconds for live monitoring to give its first read
BEFORE_TRIES = 3           # full reads for the stock before
SYNC_EVERY = 30            # seconds: has a phone changed the decantation?
RECONNECT = (15, 30, 60, 120, 300)   # seconds between tries to connect again
RECONNECT_FOR = 3 * 3600   # then it pauses ("Connect again" on the page)
STALE_S = 120              # a planned tank without a reading this long: say so
TELEGRAM_LEVELS = ("ask", "warn", "done")
PROBE_STALE_S = 180        # a planned tank whose card's clock hasn't moved this long: its figures are frozen
PROBE_START_WAIT = 75      # seconds for each planned tank's clock to move before the stock before
PROOF_DIR = "auto-proof"   # each run's stock before / after pictures, per tank
PROOF_RUNS_KEPT = 10       # runs whose pictures stay on the server
PROOF_RETRY_S = 60         # a picture the decant app didn't take: try again this often


class AutoError(ValueError):
    """Safe to show on the page."""


class AutoDecant:
    def __init__(self, station):
        self.st = station
        self.lock = threading.RLock()
        data = _load(station.home / AUTO_FILE)
        self.run = dz.Decantation.from_json(data["run"]) if data.get("run") else None
        self.info = data.get("info") or {}
        self.screens = {}                     # tank id -> the screen at its settling peak
        self.lows = {}                        # tank id -> the screen at its lowest stock while waiting
        self.abort = threading.Event()
        self.reconnecting = None              # the thread connecting again, while it runs
        self._view = None                     # the page's last view
        self.probes = {}                      # tank id -> {"fp", "at"}: when its card's clock last moved

    # ---- state -----------------------------------------------------------
    @property
    def phase(self) -> str:
        return self.info.get("phase") or ""

    def active(self) -> bool:
        return self.phase in ACTIVE

    def _persist(self) -> None:
        from .service import _write_json
        with self.lock:                          # (the reconnect thread writes too)
            _write_json(self.st.home / AUTO_FILE, {"info": self.info, "run": self.run.to_json() if self.run else None})

    def _set(self, phase: str, **info) -> None:
        self.info.update(phase=phase, at=_now(), **info)
        if phase not in ACTIVE:
            self.screens, self.lows = {}, {}     # (the screens kept for a stock before / after)
        self._persist()

    def watched(self) -> set:
        """Every tank while it runs: one outside the plan rising is a warning."""
        from .service import TANKS
        return set(TANKS) if self.active() else set()

    def to_upload(self) -> set:
        """The planned tanks' volume goes to the decant app as it changes (its
        decanting screen drains the chambers by it)."""
        if not self.active() or not self.run:
            return set()
        return {t.get("tankNo") or self.run.tank_no(t["tank"]) for t in self.run.s["data"]["tanks"]}

    def interval(self, interval_s: int) -> int:
        return min(interval_s, INTERVAL_S) if self.active() else interval_s

    # ---- the page: what can be decanted ------------------------------------
    def options(self) -> dict:
        """This and last month's invoices with chambers still in the truck,
        each with a first plan, and the tanks with their latest stock."""
        cfg, invoices, sessions, stock = self._cloud()
        s = cfg["app"]
        busy = dz.busy_tanks(sessions)
        out = []
        for inv in invoices:
            layout = dz.layout_for(inv, s)
            status = dz.invoice_status(inv, sessions, layout)
            if status not in ("new", "partial"):
                continue
            used = dz.used_chambers(sessions, inv["invoice_no"])
            left = [c for c in layout["chambers"] if c["product"] in dz.PRODUCTS and c["litres"] > 0 and c["no"] not in used]
            if not left:
                continue
            free = [t for t in s["tanks"] if t["id"] not in busy]
            out.append({"invoice_no": inv["invoice_no"], "tt_no": inv.get("tt_no"), "date": inv.get("invoice_date"),
                        "time": inv.get("invoice_time"), "status": status,
                        "chambers": [{"no": c["no"], "product": c["product"], "litres": c["litres"]} for c in left],
                        "plan": {p["no"]: p["tank"] for p in dz.suggest_plan(left, free, stock)}})
        tanks = [{"id": t["id"], "no": t["no"], "product": t["product"], "capacity": t["capacity"],
                  "fillTo": t["fillTo"], "busy": t["id"] in busy,
                  "volume": (stock.get(t["id"]) or {}).get("volume"),
                  "readingAt": (stock.get(t["id"]) or {}).get("readingAt")} for t in s["tanks"]]
        return {"invoices": out, "tanks": tanks, "settleMinutes": s["settleMinutes"]}

    def check(self, invoice_no: str, plan: dict) -> dict:
        cfg, invoices, sessions, stock = self._cloud()
        rows, _ = self._plan_rows(invoice_no, plan, cfg, invoices, sessions)
        return dz.check_plan(rows, cfg["app"]["tanks"], stock, dz.busy_tanks(sessions), cfg["app"])

    def _cloud(self):
        try:
            cfg = self.st.decant.settings()
            invoices, sessions = self.st.decant.invoices_and_sessions()
            stock = self.st.decant.tank_states()
        except self.st.decant.DecantError as exc:
            raise AutoError(str(exc)) from None
        return cfg, invoices, sessions, stock

    @staticmethod
    def _plan_rows(invoice_no, plan, cfg, invoices, sessions):
        inv = next((i for i in invoices if i["invoice_no"] == invoice_no), None)
        if not inv:
            raise AutoError("That invoice isn't in the decant app (add its PDF there first).")
        layout = dz.layout_for(inv, cfg["app"])
        used = dz.used_chambers(sessions, invoice_no)
        plan = {int(k): v for k, v in (plan or {}).items()}
        clash = sorted(no for no, t in plan.items() if t and no in used)
        if clash:
            raise AutoError(f"Chamber {', '.join(map(str, clash))} is already decanted or being decanted.")
        rows = [{"no": c["no"], "product": c["product"], "litres": c["litres"], "tank": plan.get(c["no"]) or None}
                for c in layout["chambers"] if c["product"] in dz.PRODUCTS and c["litres"] > 0 and c["no"] not in used]
        return rows, inv

    # ---- starting --------------------------------------------------------
    def start(self, invoice_no: str, plan: dict) -> dict:
        with self.lock:
            if self.active():
                raise AutoError("A decantation is already running here: finish, hand over or cancel it first.")
            self.st.login()                    # the AnyDesk login is saved (else a clear error)
            cfg, invoices, sessions, stock = self._cloud()
            rows, inv = self._plan_rows(invoice_no, plan, cfg, invoices, sessions)
            # the plan as it stands now (the stock before is read again at the start)
            chk = dz.check_plan(rows, cfg["app"]["tanks"], stock, dz.busy_tanks(sessions), cfg["app"])
            blocking = [b for b in chk["blocking"] if not b.startswith("Add Tank")]
            if blocking:
                raise AutoError(blocking[0])
            self.run, self.screens, self.probes, self.lows = None, {}, {}, {}
            self.abort.clear()
            self.info = {"invoice_no": invoice_no, "tt_no": inv.get("tt_no"), "plan": {str(k): v for k, v in plan.items()},
                         "started": _now(), "error": "", "log": [], "proof_id": str(int(time.time() * 1000)),
                         "proofs": {}}
            self._prune_proofs()
            self._set("starting", step="connecting to the PC")
        threading.Thread(target=self._starting, args=(invoice_no, rows), daemon=True, name="auto-start").start()
        return self.view()

    def _starting(self, invoice_no, rows) -> None:
        try:
            live = self._ensure_live()
            tanks = sorted({self._no(r["tank"]) for r in rows if r.get("tank")})
            self._step("checking each tank's card is updating on the PC")
            self._probes_alive(live, tanks)
            self._step("reading the stock before")
            before = self._full_before(live, tanks)
            if self.abort.is_set():
                raise AutoError("Cancelled.")
            self._step("creating the decantation in the decant app")
            cfg, invoices, sessions, _ = self._cloud()
            rows2, inv = self._plan_rows(invoice_no, {r["no"]: r["tank"] for r in rows}, cfg, invoices, sessions)
            draft = next((s for s in sessions if s["invoice_no"] == invoice_no and s["status"] == "draft"), None)
            layout = dz.layout_for(inv, cfg["app"])
            session = dz.new_session(inv, layout, sessions)
            if draft:                            # the app's open draft for this truck: take it over
                session.update(id=draft["id"], created_at=draft.get("created_at"))
            with self.lock:
                run = dz.Decantation.plan(session, rows2, before, cfg["app"],
                                          dz.busy_tanks(sessions, except_id=session["id"]), now=time.time())
                self.st.decant.save_session(run.s)
                self.run = run
                self.info["saved_at"] = run.s["updated_at"]
                self.info["fed"] = {}
                self.info["runningSince"] = time.time()
                self._set("running", step="")
            self._tell("🤖 Automatic decantation started: " + self._title() + ". " + run.state["log"][-1]["text"])
        except Exception as exc:  # noqa: BLE001 - say what stopped it
            if not isinstance(exc, (AutoError, ValueError, RuntimeError)):
                traceback.print_exc()
            msg = str(exc) if isinstance(exc, (AutoError, ValueError, RuntimeError)) else f"{type(exc).__name__}: {exc}"
            with self.lock:
                self._set("cancelled" if self.abort.is_set() else "failed", error=msg, step="")
            if not self.abort.is_set():
                self._tell(f"⚠️ The automatic decantation could not start ({self._title()}): {msg}")
            self._stop_live_if_ours()

    def _step(self, text: str) -> None:
        with self.lock:
            self.info["step"] = text
            self._persist()

    def _ensure_live(self) -> dict:
        """The open live session, or a new one; and its first read done."""
        live = self.st.live
        if not live:
            self.st.start_live(auto=True)
            self.info["live_by_auto"] = True
            live = self.st.live
        else:
            self.info.setdefault("live_by_auto", bool(live.get("by_auto")))
        reads, until = live.get("reads", 0), time.monotonic() + FIRST_READ_WAIT
        live["wake"].set()                       # read now, not at the next interval
        while time.monotonic() < until:
            if self.abort.is_set():
                raise AutoError("Cancelled.")
            if self.st.live is not live:
                raise AutoError(f"Live monitoring ended: {(self.st.live_last or {}).get('reason') or 'it stopped'}.")
            if live.get("state") == "live" and live.get("reads", 0) > reads and live.get("last_png"):
                return live
            if live.get("failed", 0) >= 3:
                raise AutoError(f"The PC's tank screen couldn't be read ({live.get('last_error') or 'unknown'}).")
            time.sleep(0.5)
        raise AutoError(f"The PC's tank screen wasn't read within {FIRST_READ_WAIT // 60} minutes "
                        f"({live.get('last_error') or 'still connecting'}).")

    def _probes_alive(self, live, tanks) -> None:
        """Each planned tank's card is live on the PC: its "Last Updated" time
        moves. A frozen card (the probe, the ATG or FuelTrans' link down) would
        give a stock before - and later a stock after - that isn't real."""
        first = {no: ((live.get("ticks") or {}).get(no) or {}).get("fp") for no in tanks}
        if not any(first.values()):
            return                               # (no clock seen on the cards: nothing to tell)
        until = time.monotonic() + PROBE_START_WAIT
        while True:
            ticks = live.get("ticks") or {}
            still = [no for no in tanks if first.get(no) and (ticks.get(no) or {}).get("fp") == first[no]]
            if not still:
                return
            if self.abort.is_set():
                raise AutoError("Cancelled.")
            if self.st.live is not live:
                raise AutoError(f"Live monitoring ended: {(self.st.live_last or {}).get('reason') or 'it stopped'}.")
            if time.monotonic() >= until:
                names = " and ".join(f"Tank {n}" for n in still)
                raise AutoError(f"{names}: the card on the PC isn't updating (its \u201cLast Updated\u201d time hasn't "
                                f"moved for over {PROBE_START_WAIT} s), so its figures may be frozen: the probe, the ATG "
                                "or FuelTrans may be offline. Not started, so no stock is taken from frozen figures.")
            time.sleep(0.5)

    def _frozen(self, tank_id: str, tick: dict | None, now: float) -> bool:
        """Has this tank's card clock stopped for PROBE_STALE_S (by this run's clock)?"""
        if not tick or not tick.get("fp"):
            return False
        p = self.probes.get(tank_id)
        if not p or p["fp"] != tick["fp"]:
            self.probes[tank_id] = {"fp": tick["fp"], "at": now}
            return False
        return now - p["at"] >= PROBE_STALE_S

    def _full_before(self, live, tanks) -> dict:
        """Each planned tank's stock before, read in full and saved to the app."""
        got, problems = {}, {}
        for attempt in range(BEFORE_TRIES):
            png = live.get("last_png")
            want = [n for n in tanks if self._id(n) not in got]
            for no, r in self.st.full_read(png, want, "automatic decantation: stock before").items():
                if r["reading"]:
                    got[self._id(no)] = r["reading"]
                    self._keep_proof(self._id(no), "before", r)
                else:
                    problems[no] = r["problem"]
            if len(got) == len(tanks):
                return got
            if attempt < BEFORE_TRIES - 1:
                reads = live.get("reads", 0)
                live["wake"].set()
                until = time.monotonic() + 30
                while live.get("reads", 0) == reads and time.monotonic() < until and self.st.live is live:
                    time.sleep(0.5)
        bad = "; ".join(f"Tank {n}: {problems.get(n) or 'not read'}" for n in tanks if self._id(n) not in got)
        raise AutoError(f"The stock before couldn't be read ({bad}).")

    def _id(self, no) -> str:
        tanks = self.run.settings["tanks"] if self.run else (self.st.live or {}).get("cfg", {}).get("tanks") or \
            self.st.decant.DEFAULT_TANKS
        return next((t["id"] for t in tanks if t.get("no") == no), f"T{no}")

    def _no(self, tank_id) -> int:
        tanks = self.run.settings["tanks"] if self.run else (self.st.live or {}).get("cfg", {}).get("tanks") or \
            self.st.decant.DEFAULT_TANKS
        return next((t["no"] for t in tanks if t.get("id") == tank_id), int(str(tank_id).lstrip("T") or 0))

    # ---- each live read ----------------------------------------------------
    def on_read(self, live) -> None:
        """After every live read: feed the run and do what it says."""
        with self.lock:
            if self.phase != "running" or not self.run or live.get("failed"):
                return
            now = time.time()
            if self.run.s["status"] == "done":
                self._finished(now)              # saving it failed last time
                return
            if now - self.info.get("synced", 0) >= SYNC_EVERY:
                self.info["synced"] = now
                if not self._sync(now):
                    return
            cfg = live.get("cfg") or {}
            volumes, frozen = {}, []
            fed = self.info.setdefault("fed", {})
            ticks = live.get("ticks") or {}
            open_ = {t["tank"] for t in self.run.s["data"]["tanks"] if t["stage"] != "read"}
            for no, f in (live.get("figures") or {}).items():
                vol = (f.get("reading") or {}).get("volume")
                if vol is None or f.get("confidence") == "low":
                    continue
                tank = self.st.decant.tank_for(int(no), cfg) if cfg else None
                tank_id = tank["id"] if tank else self._id(int(no))
                fed[tank_id] = now
                if tank_id in open_ and self._frozen(tank_id, ticks.get(int(no)), now):
                    frozen.append(int(no))             # frozen figures look steady: never feed them
                    continue
                volumes[tank_id] = vol
            work = self.run.feed(volumes, now)
            self._do(work, live, now)
            self._stale(now)
            self._frozen_note(frozen, now)
            self._retry_proofs(now)
            self._persist()

    def _do(self, work: dict, live, now: float) -> None:
        """What the run asked for: full reads, saving, finishing, messages."""
        for tank in work["peak"]:
            if live and live.get("last_png"):
                self.screens[tank] = live["last_png"]
        for tank in work.get("low", []):
            if live and live.get("last_png"):
                self.lows[tank] = live["last_png"]
        for b in work["before"]:
            from_low = b.get("from") == "low"
            png = self.lows.get(b["tank"]) if from_low else (live or {}).get("last_png")
            if not png:
                continue
            r = self.st.full_read(png, [self._no(b["tank"])],
                                  "automatic decantation: stock before" + (" (just before decanting)" if from_low else " (it sold)"))
            res = next(iter(r.values()), {})
            if res.get("reading"):
                more = self.run.set_before(b["tank"], res["reading"], now, from_low=from_low)
                if more["save"]:
                    self._keep_proof(b["tank"], "before", res)
                self._merge(work, more)
        for a in work["after"]:
            self._after(a, live, work, now)
        if work["save"]:
            self._save(now)
        for ev in work["events"]:
            if ev["level"] in TELEGRAM_LEVELS:
                self._tell(f"🤖 {self._title()}: {ev['text']}")
        if (work["finish"] or self.run.ready_to_finish()) and self.run.s["status"] not in ("done", "cancelled"):
            self._finish(now)
        elif self.run.s["status"] == "cancelled":
            self._set("cancelled")
            self._stop_live_if_ours()

    @staticmethod
    def _merge(work: dict, more: dict) -> None:
        work["save"] = work["save"] or more["save"]
        work["finish"] = work["finish"] or more["finish"]
        work["events"] += more["events"]
        work["after"] += [a for a in more["after"] if a not in work["after"]]

    def _after(self, a: dict, live, work: dict, now: float) -> None:
        tank = a["tank"]
        no = self._no(tank)
        note = "not steady after the longest settle time" if a.get("unsteady") else ""
        if a.get("from") == "peak":
            png = self.screens.get(tank)
            fallback = self._live_reading(tank, a["volume"], a["at"])
            note = "from before sales started again"
        else:
            png = live.get("last_png") if live else None
            f = ((live or {}).get("figures") or {}).get(str(no)) or {}
            vol = (f.get("reading") or {}).get("volume")
            fallback = self._live_reading(tank, vol, now) if vol is not None else None
        reading = None
        if png:
            r = self.st.full_read(png, [no], "automatic decantation: stock after").get(no) or {}
            reading = r.get("reading")
            if reading:
                self._keep_proof(tank, "after", r)
        if not reading:
            # the stock after from the live figures: no picture to prove it
            self.info.setdefault("proofs", {}).setdefault(tank, {})["after"] = {
                "picture": False, "cloud": False, "at": _now(),
                "volume": (fallback or {}).get("volume"), "note": "from the live figures (the card couldn't be read in full)"}
        self._merge(work, self.run.read_after(tank, reading, fallback=fallback, note=note, now=now))

    def _add(self, tank_id: str, chambers: list, now: float) -> dict:
        """Held chambers into a tank while this decantation runs (the page's
        "Add to this decantation"). A tank new to it gets its stock before: in
        full now, or - if it is already rising - from the screen just before."""
        live = self.st.live or {}
        no = self._no(tank_id)
        try:
            _, _, sessions, _ = self._cloud()
        except AutoError:
            sessions = []                            # (checked again by the app's own plan)
        if tank_id in dz.busy_tanks(sessions, except_id=self.run.s["id"]):
            raise AutoError(f"Tank {no} is taken by another decantation.")
        tank = next((t for t in self.run.settings["tanks"] if t["id"] == tank_id), None)
        held = {c["no"]: c for c in self.run.held()}
        adding = sum(held[int(n)]["litres"] for n in chambers if int(n) in held)
        row = self.run.row(tank_id)
        f = ((live.get("figures") or {}).get(str(no)) or {}).get("reading") or {}
        start = (row["before"]["volume"] + row["litres"]) if row else f.get("volume")
        if tank and start is not None and start + adding > dz.fill_limit(tank) + 0.5:
            raise AutoError(f"Tank {no} can't take it: {start:,.0f} L + {adding:,.0f} L would go over its "
                            f"{dz.fill_limit(tank):,.0f} L limit.")
        if row:
            return self.run.add(tank_id, chambers, None, now)
        o = self.run.state["others"].get(tank_id) or {}
        if o.get("low") is not None and f.get("volume") is not None and f["volume"] - o["low"] >= dz.START_RISE_L:
            # already rising: the stock before is the one just before it rose
            before = self.run.low_reading(tank_id, o["low"], o.get("lowAt"), now)
            return self.run.add(tank_id, chambers, before, now, from_low=True)
        res = self.st.full_read(live.get("last_png"), [no], "automatic decantation: stock before (chambers added)") \
            .get(no) if live.get("last_png") else None
        if not res or not res.get("reading"):
            raise AutoError(f"Tank {no}'s stock before couldn't be read ({(res or {}).get('problem') or 'no screen yet'}): "
                            "try again in a moment.")
        work = self.run.add(tank_id, chambers, res["reading"], now)
        self._keep_proof(tank_id, "before", res)
        return work

    def _live_reading(self, tank_id, volume, at) -> dict | None:
        """A reading from a live figure, as live monitoring sends it."""
        if volume is None:
            return None
        cap = next((t["capacity"] for t in self.run.settings["tanks"] if t["id"] == tank_id), 20000)
        return {"volume": round(volume, 2), "ullage": round(cap - volume, 2), "capacity": cap, "height": None,
                "dip": None, "water": None, "density": None, "densityTc": None, "temp": None, "status": None,
                "readingAt": dz.iso(at), "timeRead": False, "source": "photo", "via": "anydesk",
                "confidence": "medium", "savedAt": dz.iso(at)}

    def _finish(self, now: float) -> None:
        self.info["result"] = self.run.finish(now)
        for t in self.run.s["data"]["tanks"]:
            try:
                self.st.decant.save_tank_reading(t["tank"], t["after"])   # (the app's newer one stays)
            except self.st.decant.DecantError:
                pass
        self._finished(now)

    def _finished(self, now: float) -> None:
        if self._save(now, force=True):
            self.info["error"] = ""
            self._retry_proofs(now, force=True)
            self._set("finished")
            self._tell(f"✅ Decantation finished and saved in the decant app: {self._title()}.\n"
                       + "\n".join(self.info.get("result") or []))
            self._send_sheet()
            self._stop_live_if_ours()
        else:
            self.info["error"] = "Finished, but the decant app couldn't be reached: it is saved as soon as it can be."

    def _stale(self, now: float) -> None:
        late = []
        for t in self.run.s["data"]["tanks"]:
            if t["stage"] == "read":
                continue
            at = (self.info.get("fed") or {}).get(t["tank"]) or self.info.get("runningSince") or now
            if now - at >= STALE_S:
                late.append(f"Tank {t.get('tankNo')}")
        text = f"{' and '.join(late)}: no good reading for {STALE_S // 60}+ min" if late else ""
        if text and text != self.info.get("stale"):
            self._tell(f"⚠️ {self._title()}: {text} (the card isn't readable).")
        self.info["stale"] = text

    def _frozen_note(self, frozen: list, now: float) -> None:
        text = ""
        if frozen:
            names = " and ".join(f"Tank {n}" for n in sorted(frozen))
            text = (f"{names}: the card on the PC hasn't updated for {PROBE_STALE_S // 60}+ min (probe, ATG or "
                    "FuelTrans offline?). Its figures are frozen, so nothing is taken from them: the stock after waits "
                    "until the card updates again.")
        if text and text != self.info.get("frozen"):
            self.run.log(text, now, "warn")
            self._tell(f"⚠️ {self._title()}: {text}")
        elif not text and self.info.get("frozen"):
            self.run.log("The tank cards on the PC are updating again.", now, "info")
            self._tell(f"🤖 {self._title()}: the tank cards on the PC are updating again.")
        self.info["frozen"] = text

    # ---- the stock before / after pictures --------------------------------------
    def _proof_path(self, tank_id: str, which: str):
        pid = "".join(ch for ch in str(self.info.get("proof_id") or "") if ch.isdigit())
        tid = "".join(ch for ch in str(tank_id) if ch.isalnum())
        if not pid or not tid or which not in ("before", "after"):
            return None
        return self.st.home / PROOF_DIR / pid / f"{tid}-{which}.jpg"

    def _keep_proof(self, tank_id: str, which: str, res: dict) -> None:
        """This tank's zoomed card for its stock before / after: kept here for
        the page, and in the decant app for the result picture (tried again
        until it takes it)."""
        reading, jpeg = res.get("reading") or {}, res.get("jpeg") or b""
        path = self._proof_path(tank_id, which)
        if path and jpeg:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(jpeg)
            except OSError:
                traceback.print_exc()
                jpeg = b""
        self.info.setdefault("proofs", {}).setdefault(tank_id, {})[which] = {
            "picture": bool(jpeg), "cloud": bool(res.get("cloud")), "at": _now(), "tried": time.time(),
            "volume": reading.get("volume"), "readingAt": reading.get("readingAt"), "height": reading.get("height"),
            "density": reading.get("density"), "temp": reading.get("temp")}

    def _retry_proofs(self, now: float, force: bool = False) -> None:
        for tank_id, both in (self.info.get("proofs") or {}).items():
            for which, p in both.items():
                if p.get("cloud") or not p.get("picture") or p.get("volume") is None or not p.get("readingAt"):
                    continue
                if not force and now - (p.get("tried") or 0) < PROOF_RETRY_S:
                    continue
                p["tried"] = now
                path = self._proof_path(tank_id, which)
                try:
                    self.st.decant.save_proof(path.read_bytes(), {tank_id: {"readingAt": p["readingAt"],
                                                                            "volume": p["volume"]}})
                    p["cloud"] = True
                except (OSError, AttributeError, self.st.decant.DecantError):
                    pass

    def proof_picture(self, tank_id: str, which: str) -> bytes:
        """For the page: the run's picture of a tank's stock before / after."""
        if not ((self.info.get("proofs") or {}).get(tank_id) or {}).get(which, {}).get("picture"):
            return b""
        path = self._proof_path(tank_id, which)
        try:
            return path.read_bytes() if path else b""
        except OSError:
            return b""

    def _send_sheet(self) -> None:
        """The stock before and after of every tank, one picture, to the bot (privately)."""
        from .cards import _join
        rows = []
        for t in (self.run.s["data"]["tanks"] if self.run else []):
            files = [str(p) for w in ("before", "after") if (p := self._proof_path(t["tank"], w)) and p.exists()]
            if files:
                row = _join(files, across=True)
                if row:
                    rows.append(row)
        sheet = _join(rows, across=False, data=True) if len(rows) > 1 else (rows[0] if rows else b"")
        if not sheet:
            return
        try:
            self.st.notify_photo(sheet, f"Stock before | after: {self._title()}")
        except Exception:  # noqa: BLE001 - a nice-to-have
            traceback.print_exc()

    def _prune_proofs(self) -> None:
        import shutil
        root = self.st.home / PROOF_DIR
        try:
            runs = sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name)
        except OSError:
            return
        for old in runs[:-PROOF_RUNS_KEPT]:
            shutil.rmtree(old, ignore_errors=True)

    # ---- the decant app's copy ----------------------------------------------
    def _sync(self, now: float) -> bool:
        """Take a phone's change over. -> False if the run has ended in the app."""
        try:
            remote = self.st.decant.get_session(self.run.s["id"])
        except self.st.decant.DecantError as exc:
            self.info["cloud_error"] = str(exc)
            return True
        self.info.pop("cloud_error", None)
        if remote is None:
            if self.info.get("saved_at"):
                self.run.log("The decantation was deleted in the decant app.", now, "done")
                self._set("released", error="It was deleted in the decant app.")
                self._stop_live_if_ours()
                return False
            return True
        if (dz._ts(remote.get("updated_at")) or 0) > (dz._ts(self.info.get("saved_at")) or 0) + 0.0005:
            if remote.get("status") == "draft" and self.run.s.get("status") != "draft":
                # A phone sent back its old draft of this truck (from before this
                # run took it over): a decantation never goes back to a draft
                # once a tank has started, so the run stays as it is.
                self.run.log("A phone sent back its old draft of this truck; the decantation here carries on.",
                             now, "warn")
                self._save(now, force=True)
                return True
            self.run.adopt(remote, now)
            self.info["saved_at"] = remote["updated_at"]
            ended = {"done": "finished", "cancelled": "cancelled"}.get(remote.get("status"))
            if ended or not self.run.active():
                self._set(ended or "released")
                self._tell(f"🤖 {self._title()}: {self.run.state['log'][-1]['text']}")
                self._stop_live_if_ours()
                return False
            self._adopted(now)
        elif self.info.get("dirty"):
            self._save(now)
        return True

    def _adopted(self, now: float) -> None:
        """After a phone's change: a tank it added gets its stock before read
        in full from the screen before it rose (and corrected, if the app's
        was taken after the rise began), saved back to the app."""
        reqs = self.run.state.pop("fullBefore", [])
        corrected = self.run.state.pop("corrected", [])
        if not reqs and not corrected:
            return
        work = dz._work()
        work["before"] = [{"tank": r["tank"], "from": "low", "volume": r["volume"]} for r in reqs]
        work["save"] = bool(corrected)
        for text in corrected:
            self._tell(f"🤖 {self._title()}: {text}")
        self._do(work, self.st.live, now)

    def _save(self, now: float, force: bool = False) -> bool:
        """Save the session, unless a phone changed it meanwhile (then theirs
        is taken over and the run goes on from it)."""
        try:
            remote = self.st.decant.get_session(self.run.s["id"])
            if not force and remote and (dz._ts(remote.get("updated_at")) or 0) > \
                    (dz._ts(self.info.get("saved_at")) or 0) + 0.0005:
                self.info["synced"] = 0              # take it over on the next read
                self.info["dirty"] = True
                return False
            self.st.decant.save_session(self.run.s)
        except self.st.decant.DecantError as exc:
            self.info.update(dirty=True, cloud_error=str(exc))
            return False
        self.info.update(saved_at=self.run.s["updated_at"], dirty=False)
        self.info.pop("cloud_error", None)
        return True

    # ---- the page's buttons ----------------------------------------------------
    def act(self, action: str, body: dict) -> dict:
        with self.lock:
            if action == "clear":
                if self.active():
                    raise AutoError("It's still running.")
                self.run, self.info = None, {}
                self._persist()
                return self.view()
            if action == "cancel" and self.phase == "starting":
                self.abort.set()
                return self.view()
            if action == "reconnect":
                if self.phase not in ("running", "paused"):
                    raise AutoError("Nothing is waiting for the PC.")
                self._set("running")
                self._reconnect(now=True)
                return self.view()
            if not self.run or self.phase not in ("running", "paused"):
                raise AutoError("No decantation is running.")
            now = time.time()
            tank = body.get("tank")
            if action == "answer":
                ans = body.get("chambers")
                work = self.run.answer(tank, "drop" if ans == "drop" else
                                       (None if ans is None else [int(n) for n in ans]), now)
            elif action == "done":
                work = self.run.done_now(tank, [int(n) for n in body.get("chambers") or []], now)
            elif action == "drop":
                work = self.run.drop(tank, now)
            elif action == "after":
                work = self.run.after_now(tank)
            elif action == "add":
                work = self._add(tank, body.get("chambers") or [], now)
            elif action in ("release", "cancel"):
                if action == "release":
                    self.run.release(now)
                else:
                    self.run.cancel(now)
                self._save(now, force=True)
                self._set("released" if action == "release" else "cancelled")
                self._stop_live_if_ours()
                return self.view()
            else:
                raise AutoError("Unknown action.")
            work["save"] = True
            self._do(work, self.st.live, now)
            self._persist()
            return self.view()

    # ---- live monitoring ending, the service restarting -------------------------
    def on_live_end(self, reason: str, by_you: bool) -> None:
        """AnyDesk ended the session (or it failed) while running: connect again."""
        if self.phase != "running" or by_you:
            return
        self.info["lost"] = {"at": _now(), "reason": reason}
        self._persist()
        self._reconnect()

    def _reconnect(self, now: bool = False) -> None:
        if self.reconnecting and self.reconnecting.is_alive():
            return
        self.reconnecting = threading.Thread(target=self._reconnect_loop, args=(now,), daemon=True, name="auto-reconnect")
        self.reconnecting.start()

    def _reconnect_loop(self, at_once: bool) -> None:
        began, tries = time.monotonic(), 0
        while self.phase == "running":
            if self.st.live:
                return
            wait = 0 if at_once and tries == 0 else RECONNECT[min(tries, len(RECONNECT) - 1)]
            time.sleep(wait)
            if self.phase != "running" or self.st.live:
                return
            tries += 1
            self.info["reconnect"] = {"tries": tries, "since": self.info.get("lost", {}).get("at") or _now()}
            try:
                self.st.start_live(auto=True)
                self.info["live_by_auto"] = True
                live = self.st.live
                until = time.monotonic() + FIRST_READ_WAIT
                while time.monotonic() < until and self.st.live is live and live.get("state") != "live":
                    time.sleep(1)
                if self.st.live is live and live.get("state") == "live":
                    self.info.pop("reconnect", None)
                    self.info.pop("lost", None)
                    self._persist()
                    if tries > 1:
                        self._tell(f"🤖 {self._title()}: connected to the PC again.")
                    return
            except Exception:  # noqa: BLE001 - try again
                traceback.print_exc()
            if time.monotonic() - began >= RECONNECT_FOR:
                self._set("paused", error="The PC couldn't be reached for "
                                          f"{RECONNECT_FOR // 3600} hours: press Connect again, or hand it over.")
                self._tell(f"⚠️ {self._title()}: the PC can't be reached; the decantation is paused.")
                return

    def resume(self) -> None:
        """The service has (re)started."""
        if self.phase == "starting":
            self._set("failed", error="The service restarted while it was starting: start it again.")
        elif self.phase == "running":
            self.info["fed"] = {}
            self.info["runningSince"] = time.time()
            if self.run:
                try:
                    self.run.recheck_added()
                    self._adopted(time.time())
                except Exception:  # noqa: BLE001 - carrying on matters more
                    traceback.print_exc()
            self._persist()
            self._tell(f"🤖 {self._title()}: the tank stock service restarted; carrying on.")
            self._reconnect(now=True)

    def _stop_live_if_ours(self) -> None:
        if self.info.get("live_by_auto") and self.st.live:
            self.st.stop_live("the automatic decantation ended", force=True)

    # ---- for the page ------------------------------------------------------------
    def _title(self) -> str:
        return " · ".join(x for x in (self.info.get("tt_no"), self.info.get("invoice_no") and
                                      f"invoice {self.info['invoice_no']}") if x) or "decantation"

    def _tell(self, text: str) -> None:
        try:
            self.st.notify(text)
        except Exception:  # noqa: BLE001 - Telegram is a nice-to-have here
            traceback.print_exc()

    def view(self) -> dict | None:
        """For the page. Under the lock (a live read changes the run), but a
        full read can hold it for seconds: then the last view."""
        if not self.lock.acquire(timeout=1):
            return self._view
        try:
            if not self.info:
                self._view = None
            else:
                info = {k: v for k, v in self.info.items() if k not in ("fed", "synced", "runningSince")}
                self._view = copy.deepcopy({**info, "run": self.run.view(time.time()) if self.run else None})
            return self._view
        finally:
            self.lock.release()


def _now() -> str:
    from .service import now_iso
    return now_iso()


def _load(path):
    from .service import _read_json
    return _read_json(path, {})
