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

One started in the decant app can be carried on here: "Carry on one from the
decant app" → Take over on the page, or "Let the tank stock server finish it"
on a phone (looked for every half minute). Its stock before and chambers stay
the app's; each tank picks up at its stage (``Decantation.take_over``). If it
can't be followed safely it stays in the app as it was, and the phone is told
why. "Take it back on this phone" in the app hands it back.

When the stock says something the plan didn't (a tank stopped short, got
more than planned, or never started) it asks on the page and on Telegram,
and waits for the answer. A phone can still do anything in the decant app
meanwhile: the agent takes the app's copy over when it is newer. If the PC's
connection drops, it connects again; if the service restarts, it carries on
from ``decantation.json``. "Hand over" leaves the decantation to the app.

Fail-safes: a tank's card whose "Last Updated" time stops moving has frozen
figures (probe, ATG or FuelTrans down) that look like a settled tank, so a
run won't start on one and nothing is taken from one while it runs (the stock
after waits until it updates). Each stock before / after keeps its tank's
zoomed card here (the page shows it) and in the decant app (for the result
picture), sent again until the app takes it.

Once it has ended (finished, cancelled, handed over) and nothing is left to
save, it leaves the page by itself after CLEAR_AFTER_S; a line about it stays
(``last``).
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
CLEAR_AFTER_S = 15 * 60    # a finished (cancelled, handed over) decantation leaves the page this long after
CLOCK_JUMP_S = 60           # the wall clock moved this much more (or less) than real time between two reads
QUICK_S = 10               # seconds the live reads wait on the decant app at most, per call
CLOUD_REST_S = 30          # after the decant app couldn't be reached: the live reads don't wait on it again this soon
REQUEST_FRESH_S = 15 * 60  # a phone's "let the tank stock server finish it" older than this: not taken up


class AutoError(ValueError):
    """Safe to show on the page."""


class AutoDecant:
    def __init__(self, station):
        self.st = station
        self.lock = threading.RLock()
        data, self._load_note = _load(station.home / AUTO_FILE)
        self.run = dz.Decantation.from_json(data["run"]) if data.get("run") else None
        self.info = data.get("info") or {}
        self.last = data.get("last")          # the decantation before, in a line: {title, phase, at, result}
        self.screens = {}                     # tank id -> the screen at its settling peak
        self.lows = {}                        # tank id -> the screen at its lowest stock while waiting
        self.abort = threading.Event()
        self.reconnecting = None              # the thread connecting again, while it runs
        self._view = None                     # the page's last view
        # tank id -> {"fp", "at", "stale"}: when its card's clock last moved (kept over a restart: a card
        # frozen before it is still frozen after it, until its clock is seen to move)
        self.probes = data.get("probes") or {}
        self._live_seen = None                # the live session the probes were last checked on
        self._again = False                   # AnyDesk dropped again while connecting again
        self._tick = None                     # (wall, monotonic) at the last read: did the clock jump?

    # ---- state -----------------------------------------------------------
    @property
    def phase(self) -> str:
        return self.info.get("phase") or ""

    def active(self) -> bool:
        return self.phase in ACTIVE

    def _persist(self) -> None:
        from .service import _write_json
        with self.lock:                          # (the reconnect thread writes too)
            # (the copy before it kept: a write cut short by a power cut never loses a running decantation)
            _write_json(self.st.home / AUTO_FILE, {"info": self.info, "run": self.run.to_json() if self.run else None,
                                                   "probes": self.probes, "last": self.last}, keep_copy=True)

    def _set(self, phase: str, **info) -> None:
        self.info.update(phase=phase, at=_now(), **info)
        if phase not in ACTIVE:
            self.screens, self.lows = {}, {}     # (the screens kept for a stock before / after)
            self.info["ended_ts"] = time.time()
        self._persist()

    def _clear(self) -> None:
        """Off the page (under the lock), leaving a line about it."""
        if self.info.get("phase"):
            self.last = {"title": self._title(), "phase": self.phase, "at": self.info.get("at"),
                         "result": self.info.get("result") or []}
        self.run, self.info = None, {}
        self._persist()

    def _expire(self, now: float) -> None:
        """An ended decantation with nothing left to save leaves the page
        CLEAR_AFTER_S after it ended."""
        ended = self.info.get("ended_ts")
        if (ended and not self.active() and not self.info.get("unsaved")
                and now - ended >= CLEAR_AFTER_S):
            self._clear()

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
        return {"invoices": out, "tanks": tanks, "settleMinutes": s["settleMinutes"], "open": self._open_ones(sessions, s)}

    @staticmethod
    def _open_ones(sessions, s) -> list:
        """Decantations going on in the decant app that this can carry on (Take over)."""
        names = {t["id"]: t["no"] for t in s["tanks"]}
        out = []
        for x in sessions:
            d = x.get("data") or {}
            a = d.get("auto") or {}
            if x.get("status") not in ("draft", "decanting", "settling") or not d.get("tanks"):
                continue
            if x.get("status") == "draft" and d.get("step") != "decant":
                continue                          # (still being planned in the app)
            out.append({"id": x["id"], "invoice_no": x.get("invoice_no"), "tt_no": x.get("tt_no"),
                        "status": x.get("status"), "updated_at": x.get("updated_at"),
                        "byAgent": bool(a) and not a.get("released"),
                        "tanks": [{"no": t.get("tankNo") or names.get(t["tank"]), "stage": dz.tank_stage(x, t),
                                   "litres": t.get("litres"), "chambers": t.get("chambers"),
                                   "before": (t.get("before") or {}).get("volume")} for t in d["tanks"]]})
        return out

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
            if self.info.get("unsaved") and self.run and not self._save_final(time.time()):
                raise AutoError("The last decantation's end hasn't reached the decant app yet (it can't be "
                                "reached): try again once it answers.")
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
                if self.abort.is_set():          # (Cancel pressed while the app was asked)
                    raise AutoError("Cancelled.")
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

    # ---- carrying on one started in the decant app -------------------------------
    def take_over(self, session_id: str, requested: bool = False) -> dict:
        """A decantation started in the decant app (its stock before and
        chambers kept), followed from here on: the page's Take over, or a
        phone's "Let the tank stock server finish it"."""
        with self.lock:
            if self.active():
                raise AutoError("A decantation is already running here: finish, hand over or cancel it first.")
            self.st.login()
            if self.info.get("unsaved") and self.run and not self._save_final(time.time()):
                raise AutoError("The last decantation's end hasn't reached the decant app yet (it can't be "
                                "reached): try again once it answers.")
            try:
                s = self.st.decant.get_session(session_id)
            except self.st.decant.DecantError as exc:
                raise AutoError(str(exc)) from None
            if not s:
                raise AutoError("That decantation isn't in the decant app any more.")
            if s.get("status") not in ("draft", "decanting", "settling") or not (s.get("data") or {}).get("tanks"):
                raise AutoError("That decantation can't be carried on: it is finished, cancelled or not planned yet.")
            self.run, self.screens, self.probes, self.lows = None, {}, {}, {}
            self.abort.clear()
            self.info = {"invoice_no": s.get("invoice_no"), "tt_no": s.get("tt_no"), "plan": {}, "started": _now(),
                         "error": "", "log": [], "proof_id": str(int(time.time() * 1000)), "proofs": {},
                         "takeover": session_id, "requested": requested}
            self._prune_proofs()
            self._set("starting", step="connecting to the PC")
        threading.Thread(target=self._taking_over, args=(session_id,), daemon=True, name="auto-takeover").start()
        return self.view()

    def _taking_over(self, session_id: str) -> None:
        try:
            live = self._ensure_live()
            cfg = self._cloud()[0]
            s = self.st.decant.get_session(session_id)
            if not s:
                raise AutoError("It was deleted in the decant app meanwhile.")
            rows = (s.get("data") or {}).get("tanks") or []
            open_ = [t for t in rows if dz.tank_stage(s, t) != "read"]
            nos = sorted({t.get("tankNo") or self._no(t["tank"]) for t in open_})
            self._step("checking each tank's card is updating on the PC")
            self._probes_alive(live, nos)
            # a tank set up with no stock before yet: read now, in full (with its picture)
            need = sorted({t.get("tankNo") or self._no(t["tank"]) for t in open_
                           if (t.get("before") or {}).get("volume") is None})
            befores = {}
            if need:
                self._step("reading the stock before")
                befores = self._full_before(live, need)
            for attempt in range(2):
                self._step("taking it over in the decant app")
                volumes = self._live_volumes(live)
                with self.lock:
                    if self.abort.is_set():
                        raise AutoError("Cancelled.")
                    s = s if attempt == 0 else self.st.decant.get_session(session_id)
                    if not s:
                        raise AutoError("It was deleted in the decant app meanwhile.")
                    base = s.get("updated_at")
                    run = dz.Decantation.take_over(copy.deepcopy(s), cfg["app"], volumes, now=time.time(), befores=befores)
                    # only over the version just read: a phone's change landing meanwhile is read again
                    if not self.st.decant.save_session(run.s, base=base):
                        continue
                    self.run = run
                    self.info["saved_at"] = run.s["updated_at"]
                    self.info["fed"] = {}
                    self.info["runningSince"] = time.time()
                    self._set("running", step="")
                    break
            else:
                raise AutoError("It kept changing in the decant app while being taken over: try again.")
            self._tell("🤖 Took over a decantation from the decant app: " + self._title() + ". "
                       + self.run.state["log"][-1]["text"])
        except Exception as exc:  # noqa: BLE001 - say what stopped it
            if not isinstance(exc, (AutoError, ValueError, RuntimeError)):
                traceback.print_exc()
            msg = str(exc) if isinstance(exc, (AutoError, ValueError, RuntimeError)) else f"{type(exc).__name__}: {exc}"
            with self.lock:
                self._set("cancelled" if self.abort.is_set() else "failed", error=msg, step="")
            if not self.abort.is_set():
                self._tell(f"⚠️ The tank stock server couldn't take over {self._title()}: {msg} "
                           "It carries on in the decant app as before.")
                if self.info.get("requested"):
                    self._answer_request(session_id, msg)
            self._stop_live_if_ours()

    def _live_volumes(self, live) -> dict:
        """{tank id: litres} from the live figures that read well."""
        cfg = live.get("cfg") or {}
        out = {}
        for no, f in (live.get("figures") or {}).items():
            vol = (f.get("reading") or {}).get("volume")
            if vol is None or f.get("confidence") == "low":
                continue
            tank = self.st.decant.tank_for(int(no), cfg) if cfg else None
            out[tank["id"] if tank else self._id(int(no))] = vol
        return out

    def _answer_request(self, session_id: str, error: str) -> None:
        """Tell the phone that asked why it wasn't taken over (shown there)."""
        try:
            s = self.st.decant.get_session(session_id, timeout=QUICK_S)
            req = (s or {}).get("data", {}).get("autoRequest")
            if not isinstance(req, dict):
                return
            req.update(error=error[:300], answeredAt=_now())
            self.st.decant.save_session(s, base=s.get("updated_at"), timeout=QUICK_S)
        except Exception:  # noqa: BLE001 - the page and Telegram said it anyway
            traceback.print_exc()

    def check_requests(self) -> None:
        """Every half minute: has a phone asked for a decantation to be
        finished here? Taken up if nothing runs here; else the phone is told why not."""
        try:
            reqs = self.st.decant.handover_requests()
        except Exception:  # noqa: BLE001 - asked again next time
            return
        now = time.time()
        for r in reqs:
            req = r["request"]
            at = dz._ts(req.get("at")) or 0
            if req.get("error") or req.get("answeredAt") or now - at > REQUEST_FRESH_S:
                continue                              # (answered already, or too old to act on)
            if self.active():
                if self.info.get("takeover") != r["id"]:
                    self._answer_request(r["id"], "the tank stock server is running another decantation "
                                                  f"({self._title()}): finish or hand that over first")
                continue
            try:
                self.take_over(r["id"], requested=True)
            except AutoError as exc:
                self._answer_request(r["id"], str(exc))
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                self._answer_request(r["id"], f"{type(exc).__name__}")
            return                                    # (one at a time)

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
            # (from FuelTrans' live data there's no screen: its pictures are taken when needed)
            if live.get("state") == "live" and live.get("reads", 0) > reads and (live.get("last_png") or live.get("feed")):
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
        p = self.probes.get(tank_id)
        if not tick or not tick.get("fp"):
            return bool(p and p.get("stale"))    # (its clock not read yet: as it was)
        if p and p.get("held"):
            # frozen before a restart or a new AnyDesk session (whose picture of
            # the clock may differ a little): frozen until the clock moves here
            if p.get("fp") is None:
                p["fp"] = tick["fp"]
            if p["fp"] == tick["fp"]:
                return True
            p = None
        if not p or p["fp"] != tick["fp"]:
            self.probes[tank_id] = {"fp": tick["fp"], "at": now, "stale": False}
            return False
        p["stale"] = now - p["at"] >= PROBE_STALE_S
        return p["stale"]

    def _clock_check(self, now: float) -> None:
        """The VM's clock set right after the Mac slept: the run's timers start again."""
        mono = time.monotonic()
        last, self._tick = self._tick, (now, mono)
        if not last:
            return
        jump = (now - last[0]) - (mono - last[1])
        if abs(jump) < CLOCK_JUMP_S:
            return
        self.run.clock_jumped(jump, now)
        for p in self.probes.values():
            if p.get("at"):
                p["at"] += jump
        for k in list((self.info.get("fed") or {})):
            self.info["fed"][k] += jump
        if self.info.get("runningSince"):
            self.info["runningSince"] += jump
        self._tell(f"⚠️ {self._title()}: the server's clock was off by {abs(jump) / 60:,.0f} min and was set right; "
                   "settling and waiting times start again from now (nothing is taken early).")

    def _rearm_probes(self) -> None:
        """A new live session (or a restart): a card that was frozen stays so
        until its clock is seen to move on this one."""
        for p in self.probes.values():
            if p.get("stale") or p.get("held"):
                p.update(fp=None, held=True, stale=True)

    def _full_before(self, live, tanks) -> dict:
        """Each planned tank's stock before, read in full and saved to the app."""
        got, problems = {}, {}
        for attempt in range(BEFORE_TRIES):
            png = self.st.live_png(live)
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
            self._clock_check(now)
            if live is not self._live_seen:
                self._live_seen = live
                self._rearm_probes()
            if self.run.s["status"] == "done":
                if not self._cloud_resting(now):
                    self._finished(now)          # saving it failed last time
                return
            if now - self.info.get("synced", 0) >= SYNC_EVERY and not self._cloud_resting(now):
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
            self._end("cancelled", now)

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
        png = self.st.live_png(live) if live else b""
        res = self.st.full_read(png, [no], "automatic decantation: stock before (chambers added)").get(no) if png else None
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
                "readingAt": dz.iso(at), "timeRead": False, "source": "photo", "via": "server",
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
            why = self.info.get("cloud_error") or "it couldn't be reached"
            self.info["error"] = f"Finished, but not in the decant app yet ({why}): it is saved as soon as it can be."
            if "refused (4" in why and not self.info.get("refusal_told"):
                # not the network: the app says no, and will go on saying it - someone has to look
                self.info["refusal_told"] = True
                self._tell(f"⚠️ {self._title()}: finished, but the decant app refuses to save it ({why}). "
                           "It keeps trying; check the decant app's cloud project.")

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
        if not force and self._cloud_resting(now):
            return
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
        try:
            self._sheet()
        except Exception:  # noqa: BLE001 - a nice-to-have: never in the way of ending the run
            traceback.print_exc()

    def _sheet(self) -> None:
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
            remote = self.st.decant.get_session(self.run.s["id"], timeout=QUICK_S)
        except self.st.decant.DecantError as exc:
            self.info.update(cloud_error=str(exc), cloud_at=now)
            return True
        self.info.pop("cloud_error", None)
        if remote is None:
            # gone twice in a row (not one odd answer) before it counts as deleted
            self.info["missing"] = self.info.get("missing", 0) + 1
            if self.info.get("saved_at") and self.info["missing"] >= 2:
                self.run.log("The decantation was deleted in the decant app.", now, "done")
                self._set("released", error="It was deleted in the decant app.")
                self._stop_live_if_ours()
                return False
            return True
        self.info.pop("missing", None)
        if self._changed(remote):
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
            if not ended and self.run.active() and not self.run.s["data"].get("tanks"):
                # a phone took every tank out (or went back to planning it): it's the app's now
                self.run.log("No tank is left in it in the decant app, so it is left to the app.", now, "done")
            elif ended or not self.run.active():
                pass
            else:
                self._adopted(now)
                return True
            self._set(ended or "released")
            self._tell(f"🤖 {self._title()}: {self.run.state['log'][-1]['text']}")
            self._stop_live_if_ours()
            return False
        elif self.info.get("dirty"):
            self._save(now)
        return True

    def _changed(self, remote: dict) -> bool:
        """Has someone else saved it since the agent did? By the time of the
        agent's own last save (not "newer than": a phone's clock may be behind)."""
        r = dz._ts(remote.get("updated_at")) or 0
        mine = (dz._ts(self.info.get("saved_at")) or 0, dz._ts(self.run.s.get("updated_at")) or 0,
                dz._ts(self.run.s.get("_sent_at")) or 0)          # (sent, its answer lost: still ours)
        return all(abs(r - m) > 0.0005 for m in mine)

    def _cloud_resting(self, now: float) -> bool:
        """The decant app couldn't be reached a moment ago: the live reads don't wait on it again yet."""
        return bool(self.info.get("cloud_error")) and now - self.info.get("cloud_at", 0) < CLOUD_REST_S

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
        if not force and self._cloud_resting(now):
            self.info["dirty"] = True                # (saved once it answers)
            return False
        try:
            remote = self.st.decant.get_session(self.run.s["id"], timeout=QUICK_S)
            if not force and remote and self._changed(remote):
                self.info["synced"] = 0              # take it over on the next read
                self.info["dirty"] = True
                return False
            # only over the version just looked at: a phone's save landing in between wins
            if not self.st.decant.save_session(self.run.s, base=None if force or not remote else remote["updated_at"],
                                               timeout=QUICK_S):
                self.info["synced"] = 0
                self.info["dirty"] = True
                return False
        except self.st.decant.DecantError as exc:
            self.info.update(dirty=True, cloud_error=str(exc), cloud_at=now)
            return False
        self.info.update(saved_at=self.run.s["updated_at"], dirty=False)
        self.info.pop("cloud_error", None)
        return True

    def _end(self, phase: str, now: float) -> None:
        """Handed over / cancelled: in the decant app first. If it can't be
        reached, it is sent as soon as it can be - else the app would show it
        still run by the agent, with nobody running it."""
        saved = self._save_final(now)
        self._set(phase, unsaved=not saved,
                  error="" if saved else "The decant app couldn't be reached: this is sent to it as soon as it answers.")
        if not saved:
            self._save_later()
        self._stop_live_if_ours()

    def _save_final(self, now: float) -> bool:
        """The ended run into the app. A phone's change made meanwhile is taken
        over first, and the end applied to it."""
        try:
            remote = self.st.decant.get_session(self.run.s["id"])
        except self.st.decant.DecantError as exc:
            self.info.update(cloud_error=str(exc), cloud_at=now)
            return False
        if remote is not None and self._changed(remote):
            if remote.get("status") in ("done", "cancelled") or (remote["data"].get("auto") or {}).get("released"):
                return True                          # it ended in the app meanwhile
            cancelling = self.run.s.get("status") == "cancelled"
            self.run.adopt(remote, now)
            self.info["saved_at"] = remote.get("updated_at")
            try:
                self.run.cancel(now) if cancelling else self.run.release(now)
            except ValueError:
                self.run.release(now)                # (a tank started meanwhile: it can only be handed over)
        return self._save(now, force=True)

    def flush_final(self, now: float | None = None) -> bool:
        """An ended run the decant app couldn't take: try again. -> True once
        nothing is left to send."""
        with self.lock:
            if not self.info.get("unsaved") or not self.run or self.active():
                return True
            if not self._save_final(now or time.time()):
                return False
            self.info.update(unsaved=False, error="")
            self._persist()
        self._tell(f"🤖 {self._title()}: the end of the decantation is now saved in the decant app.")
        return True

    def _save_later(self) -> None:
        def again():
            while True:
                time.sleep(PROOF_RETRY_S)
                try:
                    if self.flush_final():
                        return
                except Exception:  # noqa: BLE001 - keeps trying (a full disk, a reply cut short)
                    traceback.print_exc()
        threading.Thread(target=again, daemon=True, name="auto-save-later").start()

    # ---- the page's buttons ----------------------------------------------------
    def act(self, action: str, body: dict) -> dict:
        with self.lock:
            if action == "clear":
                if self.active():
                    raise AutoError("It's still running.")
                self._clear()
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
            # a phone's change first: the button acts on the decantation as it is now
            # (else saving it would be refused, and the answer lost when theirs is taken over)
            self.info["synced"] = now
            if not self._sync(now):
                raise AutoError(f"It ended in the decant app meanwhile: {self.run.state['log'][-1]['text']}")
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
                self._end("released" if action == "release" else "cancelled", now)
                return self.view()
            else:
                raise AutoError("Unknown action.")
            work["save"] = True
            self._do(work, self.st.live, now)
            self._persist()
            return self.view()

    # ---- live monitoring ending, the service restarting -------------------------
    def on_live_end(self, reason: str, by_you: bool) -> None:
        """The PC's connection ended the session (or it failed) while running: connect again."""
        if self.phase != "running" or by_you:
            return
        self.info["lost"] = {"at": _now(), "reason": reason}
        self._persist()
        self._reconnect()

    def _reconnect(self, now: bool = False) -> None:
        with self.lock:
            if self.reconnecting and self.reconnecting.is_alive():
                self._again = True               # (it dropped again as that one connected: it goes on)
                return
            self._again = False
            self.reconnecting = threading.Thread(target=self._reconnect_loop, args=(now,), daemon=True,
                                                 name="auto-reconnect")
            self.reconnecting.start()

    def _reconnect_loop(self, at_once: bool) -> None:
        while True:
            self._reconnect_tries(at_once)
            with self.lock:
                if self._again and self.phase == "running" and not self.st.live:
                    self._again, at_once = False, True
                    continue
                self.reconnecting = None
                return

    def _reconnect_tries(self, at_once: bool) -> None:
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
                with self.lock:
                    if self.phase != "running":      # (handed over or cancelled meanwhile)
                        return
                    self._set("paused", error="The PC couldn't be reached for "
                                              f"{RECONNECT_FOR // 3600} hours: press Connect again, or hand it over.")
                self._tell(f"⚠️ {self._title()}: the PC can't be reached; the decantation is paused.")
                return

    def resume(self) -> None:
        """The service has (re)started."""
        self._rearm_probes()
        if self._load_note:
            self._tell(f"⚠️ Tank stock: {self._load_note}.")
        if self.phase in ("released", "cancelled") and self.info.get("unsaved") and self.run:
            self._save_later()
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
            self._expire(time.time())
            if not self.info:
                self._view = None
            else:
                info = {k: v for k, v in self.info.items() if k not in ("fed", "synced", "runningSince", "cloud_at", "ended_ts")}
                if self.info.get("ended_ts") and not self.active() and not self.info.get("unsaved"):
                    info["clears_in_s"] = max(0, round(CLEAR_AFTER_S - (time.time() - self.info["ended_ts"])))
                self._view = copy.deepcopy({**info, "run": self.run.view(time.time()) if self.run else None})
            return self._view
        finally:
            self.lock.release()


def _now() -> str:
    from .service import now_iso
    return now_iso()


def _load(path):
    from .service import _read_json_safe
    return _read_json_safe(path, {})
