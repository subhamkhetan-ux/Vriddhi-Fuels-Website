"""The automatic decantation in the service (tank_stock/auto.py), end to end
with stand-ins: an AnyDesk session showing four tank cards whose stock a
made-up truck changes, the decant app's cloud, and a clock driven by the test.
Each step is one live read, as the live monitor's loop does it."""
import copy
import json
import threading
import time as real_time
from types import SimpleNamespace

import pytest

from tank_stock import auto, decant, service
from tank_stock import decantation as dz

T0 = 1_791_000_000.0
INVOICE = {
    "invoice_no": "7011294526", "invoice_date": "13/10/2026", "invoice_time": "14:15", "tt_no": "OD23U8210",
    "lines": [
        {"product": "EBMS [PDRP]", "column_key": "MS | EBMS", "qty_kl": 5, "compartments": [1], "density15": 748.2, "value": 524764},
        {"product": "HSD-BSVI [PDRP]", "column_key": "HSD", "qty_kl": 17, "compartments": [2, 3, 4, 5], "density15": 829.3, "value": 1668487},
    ],
    "chambers": [{"no": 1, "qty_kl": 5}, {"no": 2, "qty_kl": 5}, {"no": 3, "qty_kl": 4}, {"no": 4, "qty_kl": 4}, {"no": 5, "qty_kl": 4}],
    "created_at": "2026-10-13T08:50:00+00:00",
}
PRODUCT = {1: "MS", 2: "HSD", 3: "HSD", 4: "XG"}
CHART = decant.dip_chart()


class Clock:
    def __init__(self):
        self.t = T0

    def __call__(self):
        return self.t


class World:
    """Each tank's stock: its start, runs of flow [(tank no, start s, litres, secs)], sales."""

    def __init__(self, clock):
        self.clock = clock
        self.base = {1: 7682.0, 2: 10755.0, 3: 11495.0, 4: 2560.0}
        self.flows, self.sales = [], []

    def volume(self, no):
        secs = self.clock() - T0
        v = self.base[no]
        for t, at, litres, dur in self.flows:
            if t == no:
                v += litres * min(1.0, max(0.0, (secs - at) / dur))
        v -= sum(l for t, at, l in self.sales if t == no and secs >= at)
        return round(v, 2)

    def card(self, no):
        v = self.volume(no)
        lo, hi = 0.0, 300.0                       # the height at which the dip chart has these litres
        for _ in range(60):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if (decant.litres_at_dip(CHART, mid) or 0) < v else (lo, mid)
        ist = real_time.gmtime(self.clock() + 19800)
        return {"no": no, "product": PRODUCT[no], "capacity": 20000.0, "volume": v, "ullage": round(20000 - v, 2),
                "height": round(lo * 10, 2), "water": 0.0, "density": 830.0, "densityTc": 835.0, "temp": 30.0,
                "time": (f"{ist.tm_mon:02d}", f"{ist.tm_mday:02d}", str(ist.tm_year), f"{ist.tm_hour:02d}",
                         f"{ist.tm_min:02d}", f"{ist.tm_sec:02d}"), "disagree": []}


class Cloud:
    """The decant app's tables, as decant.py would see them."""
    DecantError = decant.DecantError
    DEFAULT_TANKS = decant.DEFAULT_TANKS
    tank_for = staticmethod(decant.tank_for)
    make_reading = staticmethod(decant.make_reading)
    dip_chart = staticmethod(decant.dip_chart)
    volume_only = staticmethod(decant.volume_only)

    def __init__(self, clock):
        self.clock = clock
        self.sessions, self.stock, self.shots, self.down = {}, {}, [], False

    def _up(self):
        if self.down:
            raise decant.DecantError("The decant database could not be reached (URLError).")

    def settings(self, timeout=30):
        self._up()
        return {"tanks": decant.DEFAULT_TANKS, "dateOrder": "MDY", "chart": CHART,
                "app": dz.settings_with({}, decant.DEFAULT_TANKS)}

    def invoices_and_sessions(self):
        self._up()
        return [dict(INVOICE)], [copy.deepcopy(s) for s in self.sessions.values()]

    def tank_states(self):
        self._up()
        return copy.deepcopy(self.stock)

    def get_session(self, sid, timeout=30):
        self._up()
        return copy.deepcopy(self.sessions.get(sid))

    def save_session(self, s, base=None, timeout=30):
        self._up()
        cur = self.sessions.get(s["id"])
        if base and (not cur or abs((dz._ts(cur["updated_at"]) or 0) - (dz._ts(base) or 0)) > 0.0005):
            return None                                  # someone saved it since
        s["updated_at"] = dz.iso(self.clock())
        s["created_at"] = s.get("created_at") or s["updated_at"]
        self.sessions[s["id"]] = copy.deepcopy(s)
        return s

    def save_tank_reading(self, tank_id, reading):
        self._up()
        self.stock[tank_id] = dict(reading)
        return True

    def upload(self, cards, tanks, cfg=None, now=None, only_volume=False, timeout=30):
        self._up()
        cfg = cfg or self.settings()
        out = {}
        for no in sorted(tanks):
            card, tank = cards.get(no), decant.tank_for(no, cfg)
            built = decant.make_reading(card, tank, cfg)
            if built["confidence"] == "low":
                out[no] = {"ok": False, "tank_id": tank["id"], "message": "not saved: " + "; ".join(built["problems"])}
                continue
            r = {**(decant.volume_only(built["reading"]) if only_volume else built["reading"]), "savedAt": dz.iso(self.clock())}
            self.stock[tank["id"]] = r
            out[no] = {"ok": True, "tank_id": tank["id"], "reading": r, "message": "saved",
                       "mark": {"readingAt": r["readingAt"], "volume": r["volume"]}}
        return out

    def save_proof(self, jpeg, marks):
        self.shots.append(marks)

    def drop_old_proofs(self):
        pass

    def ist_day(self):
        return "2026-10-13"


class Session:
    opened = []

    def __init__(self, ids, password, **kw):
        self.position, self.is_alive, self.closed = 1, True, False
        Session.opened.append(self)

    def open(self):
        return 1

    def shot(self):
        return b"\x89PNG", "already on Tank Status"

    def screen(self):
        return b"\x89PNG"

    def alive(self):
        return self.is_alive

    def close(self):
        self.closed = True


@pytest.fixture
def rig(tmp_path, monkeypatch):
    clock = Clock()
    world, cloud = World(clock), Cloud(clock)
    monkeypatch.setattr(auto, "time", SimpleNamespace(time=clock, monotonic=real_time.monotonic, sleep=real_time.sleep))
    monkeypatch.setattr(auto, "RECONNECT", (0.01,))
    boxes = {no: (no * 100, 0, no * 100 + 90, 90) for no in (1, 2, 3, 4)}
    monkeypatch.setattr(service.cards_mod, "read_all", lambda png: (dict(boxes), {no: world.card(no) for no in boxes}))
    monkeypatch.setattr(service.cards_mod, "Pixels", lambda png: SimpleNamespace(ok=True))
    monkeypatch.setattr(service.cards_mod, "fingerprint", lambda px, box: str(world.volume(box[0] // 100)))
    monkeypatch.setattr(service.cards_mod, "read_figures", lambda png, box: world.card(box[0] // 100))
    monkeypatch.setattr(service.cards_mod, "picture", lambda png, boxes, tanks, **kw: b"\x89PNG-cards")
    monkeypatch.setattr(service.cards_mod, "to_jpeg", lambda png: b"\xff\xd8" + png)

    def start_live(self, new_settings=None, auto=False):
        """The live session, without its own loop: the test does each read."""
        if self.live:
            raise RuntimeError("Live monitoring is already running.")
        s = self.settings
        self.live = {"state": "live", "since": service.now_iso(), "tanks": s["tanks"], "by_auto": auto,
                     "interval_s": s["interval_s"], "auto_upload": s["auto_upload"], "reads": 0, "failed": 0,
                     "figures": {}, "uploads": {}, "stop": threading.Event(), "wake": threading.Event(),
                     "session": Session([], "")}
        return self.live_view()
    monkeypatch.setattr(service.Station, "start_live", start_live)
    (tmp_path / "login.json").write_text(json.dumps({"ids": ["123456789"], "password": "pw"}))
    (tmp_path / "settings.json").write_text(json.dumps({"interval_s": 600, "tanks": [3], "auto_upload": False}))
    told = []
    st = service.Station(home=tmp_path, session_cls=Session, decant_mod=cloud, notify=told.append,
                         notify_photo=lambda png, caption: told.append(caption) or True)
    Session.opened = []
    return SimpleNamespace(st=st, clock=clock, world=world, cloud=cloud, told=told, home=tmp_path)


def read(rig):
    """One live read and what the automation does with it."""
    live = rig.st.live
    rig.st._live_read(live)
    rig.st.auto.on_read(live)


def wait_for(cond, timeout=5):
    end = real_time.time() + timeout
    while real_time.time() < end:
        if cond():
            return True
        real_time.sleep(0.01)
    return False


def start(rig, plan):
    a = rig.st.auto
    a.start(INVOICE["invoice_no"], plan)
    assert wait_for(lambda: rig.st.live is not None)
    read(rig)                                         # its first read (the live loop would do it)
    # the live loop goes on reading while it starts (a card's clock must be seen moving)
    end = real_time.time() + 5
    while a.phase == "starting" and real_time.time() < end:
        real_time.sleep(0.02)
        if a.phase == "starting" and rig.st.live:
            read(rig)
    assert a.phase != "starting", a.info
    assert a.phase == "running", a.info
    return a


def drive(rig, until, step=10, on=None):
    secs = rig.clock.t - T0
    while secs <= until and rig.st.auto.phase == "running":
        rig.clock.t = T0 + secs
        if rig.st.live:
            read(rig)
        if on:
            on(secs)
        secs += step
    return secs


def cloud_session(rig):
    return rig.cloud.sessions[rig.st.auto.run.s["id"]]


def test_the_page_offers_the_trucks_chambers_with_a_first_plan(rig):
    rig.cloud.stock = {t: {"volume": v, "readingAt": dz.iso(T0)} for t, v in (("T1", 7682.0), ("T2", 10755.0), ("T3", 11495.0), ("T4", 2560.0))}
    o = rig.st.auto.options()
    inv = o["invoices"][0]
    assert inv["tt_no"] == "OD23U8210" and [c["no"] for c in inv["chambers"]] == [1, 2, 3, 4, 5]
    assert inv["plan"][1] == "T1" and all(inv["plan"][n] in ("T2", "T3") for n in (2, 3, 4, 5))
    chk = rig.st.auto.check(INVOICE["invoice_no"], {"1": "T1", "2": "T2", "3": "T2"})
    assert chk["blocking"] == [] and {r["tank"]: r["litres"] for r in chk["perTank"]} == {"T1": 5000, "T2": 9000}
    bad = rig.st.auto.check(INVOICE["invoice_no"], {"1": "T2"})
    assert "can't go into Tank 2" in bad["blocking"][0]


def test_one_button_decants_reads_and_finishes_in_the_decant_app(rig):
    a = start(rig, {"1": "T1", "2": "T2", "3": "T2"})
    s = cloud_session(rig)
    assert s["status"] == "draft" and s["data"]["step"] == "decant"
    assert [t["stage"] for t in s["data"]["tanks"]] == ["waiting", "waiting"]
    # the stock before: full reads saved to the app, with their proof picture
    assert rig.cloud.stock["T2"]["volume"] == 10755.0 and rig.cloud.stock["T2"]["height"]
    assert [set(m) for m in rig.cloud.shots[:2]] == [{"T1"}, {"T2"}]      # one picture per tank (its card)
    assert wait_for(lambda: any("Automatic decantation started" in m for m in rig.told))
    # every tank is watched (not just the live setting's Tank 3), every 10 s
    assert set(rig.st.live["figures"]) == {"1", "2", "3", "4"} and a.interval(600) == 10
    rig.world.flows = [(1, 60, 4990, 495), (2, 100, 4985, 495), (2, 640, 3992, 420)]
    drive(rig, 4000)
    assert a.phase == "finished", a.info
    s = cloud_session(rig)
    assert s["status"] == "done" and s["completed_at"]
    t1, t2 = (next(t for t in s["data"]["tanks"] if t["tank"] == x) for x in ("T1", "T2"))
    assert t2["chambers"] == [2, 3] and t2["result"]["band"] == "ok" and t2["result"]["variation"] == -23.0
    assert t1["result"]["variation"] == -10.0 and t2["after"]["height"]       # a full read, with its proof
    assert len(rig.cloud.shots) >= 3
    # the planned tanks' volume went to the app as it rose (its chambers drain by it)
    assert rig.cloud.stock["T2"]["volume"] == 19732.0
    assert any("Decantation finished and saved" in m and "Tank 2" in m for m in rig.told)
    assert rig.st.live["stop"].is_set()                  # it connected for this: it lets go
    with pytest.raises(auto.AutoError):
        a.act("answer", {"tank": "T2", "chambers": [2]})
    a.act("clear", {})
    assert a.view() is None


def test_a_question_is_asked_on_telegram_and_answered_from_the_page(rig):
    a = start(rig, {"2": "T2", "3": "T2"})
    rig.world.flows = [(2, 50, 4990, 495)]                                   # C3 never comes
    drive(rig, 1000)
    q = a.view()["run"]["questions"][0]
    assert q["kind"] == "short" and q["suggest"] == [2]
    assert any("Which chambers were emptied" in m for m in rig.told)
    assert cloud_session(rig)["data"]["auto"]["questions"][0]["kind"] == "short"   # the app can show it too
    a.act("answer", {"tank": "T2", "chambers": [2]})
    drive(rig, 3000)
    s = cloud_session(rig)
    assert a.phase == "finished" and s["status"] == "done"
    assert next(p for p in s["data"]["plan"] if p["no"] == 3)["tank"] is None


def test_a_phone_finishing_it_in_the_decant_app_ends_the_run(rig):
    a = start(rig, {"2": "T2"})
    rig.world.flows = [(2, 50, 4990, 495)]
    drive(rig, 300)
    s = rig.cloud.sessions[a.run.s["id"]]
    s.update(status="cancelled", updated_at=dz.iso(rig.clock() + 1))
    drive(rig, 400)
    assert a.phase == "cancelled" and "Cancelled in the decant app" in a.run.state["log"][-1]["text"]


def test_a_phones_old_draft_sent_back_mid_run_doesnt_undo_it(rig):
    # The phone had a draft of this truck, the run took it over (same id), and
    # the phone, offline meanwhile, sends its old draft back once a tank is decanting.
    a = start(rig, {"2": "T2", "3": "T2"})
    rig.world.flows = [(2, 50, 4990, 495), (2, 640, 3992, 420)]
    drive(rig, 300)
    assert cloud_session(rig)["status"] == "decanting"
    sid = a.run.s["id"]
    old = copy.deepcopy(rig.cloud.sessions[sid])
    old["status"] = "draft"
    old["data"].update(step="truck", plan=[], tanks=[])
    old["updated_at"] = dz.iso(rig.clock() + 1)
    rig.cloud.sessions[sid] = old
    drive(rig, 3000)
    s = cloud_session(rig)
    assert a.phase == "finished" and s["status"] == "done", a.info
    assert [t["tank"] for t in s["data"]["tanks"]] == ["T2"] and s["data"]["tanks"][0]["result"]
    assert any("sent back its old draft" in e["text"] for e in a.run.state["log"])


def test_when_anydesk_ends_the_session_it_connects_again_and_carries_on(rig):
    a = start(rig, {"2": "T2"})
    rig.world.flows = [(2, 50, 4990, 495)]
    drive(rig, 200)
    live = rig.st.live
    live["session"].is_alive = False
    rig.st._live_end(live, "AnyDesk ended the session", b"")
    assert wait_for(lambda: rig.st.live is not None and rig.st.live is not live)
    assert len(Session.opened) == 2
    drive(rig, 2500)
    assert a.phase == "finished" and cloud_session(rig)["status"] == "done"


def test_after_a_restart_it_carries_on_from_where_it_was(rig):
    a = start(rig, {"2": "T2"})
    rig.world.flows = [(2, 50, 4990, 495)]
    drive(rig, 300)
    rig.st.live = None                                   # the service stopped
    again = service.Station(home=rig.home, session_cls=Session, decant_mod=rig.cloud, notify=rig.told.append,
                            notify_photo=lambda png, caption: True)
    assert again.auto.phase == "running" and again.auto.run.row("T2")["stage"] == "decanting"
    again.auto.resume()
    assert wait_for(lambda: again.live is not None)
    assert any("restarted; carrying on" in m for m in rig.told)
    rig.st = again
    drive(rig, 2500)
    assert again.auto.phase == "finished" and cloud_session(rig)["status"] == "done"


def test_live_monitoring_cant_be_stopped_under_it_and_hand_over_leaves_it_to_the_app(rig):
    a = start(rig, {"2": "T2"})
    with pytest.raises(RuntimeError, match="automatic decantation"):
        rig.st.stop_live()
    with pytest.raises(auto.AutoError):
        a.start(INVOICE["invoice_no"], {"4": "T3"})       # one at a time
    a.act("release", {})
    assert a.phase == "released" and cloud_session(rig)["data"]["auto"]["released"]
    assert cloud_session(rig)["status"] == "draft"        # still the app's to finish
    assert rig.st.live["stop"].is_set()


def test_the_decant_app_out_of_reach_is_saved_once_it_is_back(rig):
    a = start(rig, {"2": "T2"})
    rig.world.flows = [(2, 50, 4990, 495)]
    rig.cloud.down = True
    drive(rig, 300)
    assert a.info["dirty"] and "could not be reached" in a.info["cloud_error"]
    assert cloud_session(rig)["status"] == "draft"
    rig.cloud.down = False
    drive(rig, 2500)
    assert a.phase == "finished" and cloud_session(rig)["status"] == "done"


def test_a_start_that_cant_read_the_stock_before_says_why(rig, monkeypatch):
    real = rig.world.card
    monkeypatch.setattr(rig.world, "card", lambda no: {**real(no), "volume": 1.0})   # fails the checks
    rig.st.auto.start(INVOICE["invoice_no"], {"2": "T2"})
    assert wait_for(lambda: rig.st.live is not None)
    read(rig)
    for _ in range(3):
        if wait_for(lambda: rig.st.auto.phase != "starting", timeout=1):
            break
        read(rig)
    a = rig.st.auto
    assert a.phase == "failed" and "tank screen couldn't be read" in a.info["error"]
    assert wait_for(lambda: any("could not start" in m for m in rig.told))   # (told just after)
    assert rig.cloud.sessions == {}


def test_a_tank_failing_its_checks_at_the_start_is_named(rig, monkeypatch):
    real = rig.world.card
    monkeypatch.setattr(rig.world, "card", lambda no: {**real(no), "volume": 1.0} if no == 2 else real(no))
    rig.st.auto.start(INVOICE["invoice_no"], {"2": "T2"})
    assert wait_for(lambda: rig.st.live is not None)
    read(rig)
    for _ in range(4):
        if wait_for(lambda: rig.st.auto.phase != "starting", timeout=1):
            break
        read(rig)
    a = rig.st.auto
    assert a.phase == "failed" and "stock before couldn't be read (Tank 2: volume + ullage" in a.info["error"]
    assert rig.cloud.sessions == {}


# ---- frozen tank cards: the probe, the ATG or FuelTrans' link down ----------

def _clocks(rig, monkeypatch, frozen):
    """Each card's "Last Updated" clock ticks with the test's clock, except
    the tanks in ``frozen`` (a set the test changes)."""
    ticks = {"n": 0}

    def clock_print(px, box):
        no = box[0] // 100
        ticks["n"] += 1
        return f"{no}-frozen" if no in frozen else f"{no}-{rig.clock.t}-{ticks['n']}"
    monkeypatch.setattr(service.cards_mod, "clock_print", clock_print)


def test_a_tank_whose_card_isnt_updating_is_not_started(rig, monkeypatch):
    monkeypatch.setattr(auto, "PROBE_START_WAIT", 0.3)
    _clocks(rig, monkeypatch, {2})
    a = rig.st.auto
    a.start(INVOICE["invoice_no"], {"2": "T2"})
    assert wait_for(lambda: rig.st.live is not None)
    read(rig)
    stop = threading.Event()

    def reads():                                   # the live loop goes on reading meanwhile
        while not stop.is_set() and rig.st.live:
            read(rig)
            real_time.sleep(0.02)
    threading.Thread(target=reads, daemon=True).start()
    try:
        assert wait_for(lambda: a.phase != "starting"), a.info
    finally:
        stop.set()
    assert a.phase == "failed" and "Tank 2: the card on the PC isn't updating" in a.info["error"]
    assert "no stock is taken from frozen figures" in a.info["error"]
    assert rig.cloud.sessions == {} and rig.cloud.shots == []          # nothing recorded from frozen figures
    assert wait_for(lambda: any("could not start" in m for m in rig.told))   # (told just after)


def test_cards_that_update_start_as_usual(rig, monkeypatch):
    _clocks(rig, monkeypatch, set())
    a = rig.st.auto
    a.start(INVOICE["invoice_no"], {"2": "T2"})
    assert wait_for(lambda: rig.st.live is not None)
    stop = threading.Event()

    def reads():
        while not stop.is_set() and rig.st.live:
            read(rig)
            real_time.sleep(0.02)
    threading.Thread(target=reads, daemon=True).start()
    try:
        assert wait_for(lambda: a.phase != "starting"), a.info
    finally:
        stop.set()
    assert a.phase == "running", a.info


def test_a_card_that_freezes_while_settling_never_gives_the_stock_after(rig, monkeypatch):
    frozen = set()
    _clocks(rig, monkeypatch, frozen)
    a = start(rig, {"2": "T2"})
    rig.world.flows = [(2, 50, 4990, 495)]
    drive(rig, 600)                                       # in, now settling
    frozen.add(2)                                         # the probe goes offline: the figures stop
    drive(rig, 4000)
    assert a.phase == "running" and a.run.row("T2")["stage"] != "read"     # no stock after from frozen figures
    assert any("hasn't updated" in m and "Tank 2" in m for m in rig.told)
    assert "frozen" in a.view()["frozen"]
    frozen.discard(2)                                     # back online
    drive(rig, 7000)
    assert a.phase == "finished", a.info
    assert any("updating again" in m for m in rig.told)


# ---- the stock before / after pictures --------------------------------------

def test_each_tank_keeps_its_before_and_after_picture_for_the_page_and_the_app(rig):
    a = start(rig, {"2": "T2"})
    p = a.view()["proofs"]["T2"]["before"]
    assert p["picture"] and p["cloud"] and p["volume"] == 10755.0 and p["height"]
    assert a.proof_picture("T2", "before").startswith(b"\xff\xd8")             # the zoomed card, for the page
    assert a.proof_picture("T2", "after") == b"" and a.proof_picture("T9", "before") == b""
    assert a.proof_picture("../T2", "before") == b"" and a.proof_picture("T2", "x") == b""
    rig.world.flows = [(2, 50, 4990, 495)]
    drive(rig, 4000)
    assert a.phase == "finished", a.info
    after = a.view()["proofs"]["T2"]["after"]
    assert after["picture"] and after["cloud"] and after["volume"] == rig.cloud.stock["T2"]["volume"]
    # the decant app has a picture for exactly the stock before and the stock after it saved
    marks = [m["T2"] for m in rig.cloud.shots if "T2" in m]
    s = cloud_session(rig)
    t2 = next(t for t in s["data"]["tanks"] if t["tank"] == "T2")
    for which in ("before", "after"):
        assert {"readingAt": t2[which]["readingAt"], "volume": t2[which]["volume"]} in marks


def test_a_picture_the_decant_app_didnt_take_is_sent_again(rig, monkeypatch):
    fails = {"n": 2}
    real = rig.cloud.save_proof

    def flaky(jpeg, marks):
        if fails["n"] > 0:
            fails["n"] -= 1
            raise decant.DecantError("The decant database could not be reached (URLError).")
        real(jpeg, marks)
    monkeypatch.setattr(rig.cloud, "save_proof", flaky)
    a = start(rig, {"2": "T2"})
    p = a.view()["proofs"]["T2"]["before"]
    assert p["picture"] and not p["cloud"]                                 # kept here, not in the app yet
    drive(rig, 200)                                                         # a minute or two later
    assert a.view()["proofs"]["T2"]["before"]["cloud"]
    assert any(m.get("T2", {}).get("volume") == 10755.0 for m in rig.cloud.shots)


def test_the_proof_api_serves_only_the_runs_pictures(rig):
    import urllib.request
    import urllib.error
    a = start(rig, {"2": "T2"})
    srv = service.make_server(rig.st, 0)
    srv.port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        with urllib.request.urlopen(f"{base}/api/auto/proof?tank=T2&which=before", timeout=5) as r:
            assert r.headers["Content-Type"] == "image/jpeg" and r.read().startswith(b"\xff\xd8")
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(f"{base}/api/auto/proof?tank=T2&which=after", timeout=5)
        assert e.value.code == 404
    finally:
        srv.shutdown()
        srv.server_close()


# ---- one tank after another --------------------------------------------------

def test_tanks_decanted_one_after_another_finish_together_once_all_are_read(rig):
    a = start(rig, {"1": "T1", "2": "T2"})
    rig.world.flows = [(1, 60, 4990, 495), (2, 3000, 4985, 495)]        # Tank 2's turn comes much later
    drive(rig, 2900)
    t1, t2 = a.run.row("T1"), a.run.row("T2")
    assert t1["stage"] == "read" and t1["after"]["volume"] == 12672.0   # its stock after, as soon as it settled
    assert t2["stage"] == "waiting" and a.view()["run"]["questions"] == []   # waiting its turn: not asked about
    assert cloud_session(rig)["status"] != "done" and a.phase == "running"   # not finished yet
    assert a.view()["proofs"]["T1"]["after"]["picture"]
    drive(rig, 6000)
    assert a.phase == "finished", a.info
    s = cloud_session(rig)
    assert s["status"] == "done" and all(t["after"] for t in s["data"]["tanks"])
    assert sum("Decantation finished and saved" in m for m in rig.told) == 1


def test_a_tank_that_waits_too_long_after_the_others_is_asked_about(rig):
    a = start(rig, {"1": "T1", "2": "T2"})
    rig.world.flows = [(1, 60, 4990, 495)]                               # Tank 2's chamber never comes
    drive(rig, 1700)
    assert a.run.row("T1")["stage"] == "read" and a.view()["run"]["questions"] == []
    drive(rig, 1700 + 1800 + 60)                                         # 30 min with nothing going on
    q = a.view()["run"]["questions"]
    assert q and q[0]["tank"] == "T2" and q[0]["kind"] == "notstarted"


def _screens_as_taken(rig, monkeypatch):
    """A kept screen shows the stock when it was taken (not the latest)."""
    w = rig.world
    monkeypatch.setattr(Session, "screen", lambda self: b"\x89PNG@" + str(rig.clock.t).encode())

    def at(png):
        try:
            return float(png.split(b"@", 1)[1])
        except (IndexError, ValueError):
            return rig.clock.t

    def card_at(png, no):
        now = rig.clock.t
        rig.clock.t = at(png)
        try:
            return w.card(no)
        finally:
            rig.clock.t = now
    boxes = {no: (no * 100, 0, no * 100 + 90, 90) for no in (1, 2, 3, 4)}
    monkeypatch.setattr(service.cards_mod, "read_all", lambda png: (dict(boxes), {no: card_at(png, no) for no in boxes}))
    monkeypatch.setattr(service.cards_mod, "read_figures", lambda png, box: card_at(png, box[0] // 100))
    return w


def test_a_tank_that_sold_just_before_its_turn_gets_its_stock_before_in_full(rig, monkeypatch):
    w = _screens_as_taken(rig, monkeypatch)
    a = start(rig, {"2": "T2"})
    w.sales = [(2, 300, 40), (2, 330, 60)]                    # two sales half a minute apart ...
    w.flows = [(2, 345, 4990, 495)]                           # ... and the truck right after
    drive(rig, 2600)
    assert a.phase == "finished", a.info
    t2 = next(t for t in cloud_session(rig)["data"]["tanks"] if t["tank"] == "T2")
    assert t2["before"]["volume"] == 10755.0 - 100              # after both sales
    assert t2["before"]["height"] is not None                    # read in full, not the live figure
    assert any("read in full from the screen just before decanting" in e["text"] for e in a.run.state["log"])
    p = a.view()["proofs"]["T2"]["before"]
    assert p["picture"] and p["volume"] == t2["before"]["volume"]
    assert {"readingAt": t2["before"]["readingAt"], "volume": t2["before"]["volume"]} in \
        [m["T2"] for m in rig.cloud.shots if "T2" in m]           # its picture is in the app for the result


# ---- chambers kept in the truck, decanted while it runs -----------------------

def test_a_held_chamber_added_to_a_new_tank_is_followed_and_finished_with_the_rest(rig):
    a = start(rig, {"2": "T2", "3": "T2"})                      # C1, C4, C5 kept in the truck
    held = [c["no"] for c in a.view()["run"]["held"]]
    assert held == [1, 4, 5] and {t["id"] for t in a.view()["run"]["tankOptions"]} >= {"T1", "T3"}
    rig.world.flows = [(2, 50, 4990, 495), (2, 600, 3992, 420)]
    drive(rig, 120)
    a.act("add", {"tank": "T3", "chambers": [4]})                # C4 into Tank 3, now
    t3 = a.run.row("T3")
    assert t3["stage"] == "waiting" and t3["chambers"] == [4] and t3["before"]["volume"] == 11495.0
    assert t3["before"]["height"] is not None                    # read in full, with its picture
    assert a.view()["proofs"]["T3"]["before"]["picture"]
    assert [c["no"] for c in a.view()["run"]["held"]] == [1, 5]
    rig.world.flows.append((3, 200, 3990, 400))
    drive(rig, 5000)
    assert a.phase == "finished", a.info
    s = cloud_session(rig)
    rows = {t["tank"]: t for t in s["data"]["tanks"]}
    assert set(rows) == {"T2", "T3"} and rows["T3"]["after"] and rows["T3"]["result"]["band"] == "ok"
    assert next(p for p in s["data"]["plan"] if p["no"] == 4)["tank"] == "T3"
    assert next(p for p in s["data"]["plan"] if p["no"] == 5)["tank"] is None      # still in the truck


def test_a_held_chamber_added_to_a_settling_tank_waits_for_it(rig):
    a = start(rig, {"2": "T2"})
    rig.world.flows = [(2, 50, 4990, 495)]
    drive(rig, 700)
    assert a.run.row("T2")["stage"] == "settling"
    a.act("add", {"tank": "T2", "chambers": [3]})                # one more chamber into it
    t2 = a.run.row("T2")
    assert t2["stage"] == "decanting" and t2["chambers"] == [2, 3] and t2["litres"] == 9000
    rig.world.flows.append((2, 900, 3992, 420))
    drive(rig, 4000)
    assert a.phase == "finished", a.info
    t2 = next(t for t in cloud_session(rig)["data"]["tanks"] if t["tank"] == "T2")
    assert t2["chambers"] == [2, 3] and t2["result"]["band"] == "ok"


def test_a_tank_rising_with_a_held_chamber_is_asked_about_and_added(rig, monkeypatch):
    _screens_as_taken(rig, monkeypatch)
    a = start(rig, {"2": "T2"})
    rig.world.flows = [(2, 50, 4990, 495), (3, 300, 3990, 400)]  # C4 goes into Tank 3 without telling
    drive(rig, 400)
    q = next(q for q in a.view()["run"]["questions"] if q["tank"] == "T3")
    assert q["kind"] == "held" and "still in the truck" in q["text"] and 4 in [o["no"] for o in q["options"]]
    assert any("going into Tank 3" in m for m in rig.told)
    drive(rig, 2000)                                             # Tank 2 is read meanwhile ...
    assert a.run.row("T2")["stage"] == "read" and a.phase == "running"   # ... but nothing finishes while asked
    a.act("answer", {"tank": "T3", "chambers": [4]})
    t3 = a.run.row("T3")
    assert t3["before"]["volume"] == 11495.0 and t3["before"]["height"] is not None   # the screen before it rose
    drive(rig, 5000)
    assert a.phase == "finished", a.info
    rows = {t["tank"]: t for t in cloud_session(rig)["data"]["tanks"]}
    assert rows["T3"]["chambers"] == [4] and rows["T3"]["after"]


def test_no_to_the_held_question_warns_and_finishes_without_it(rig):
    a = start(rig, {"2": "T2"})
    rig.world.flows = [(2, 50, 4990, 495), (3, 300, 300, 60)]    # something else into Tank 3
    drive(rig, 400)
    a.act("answer", {"tank": "T3", "chambers": "drop"})
    assert a.run.row("T3") is None and any("not with this truck" in e["text"] for e in a.run.state["log"])
    drive(rig, 3000)
    assert a.phase == "finished"


def test_adding_held_chambers_says_what_cant_be_done(rig):
    a = start(rig, {"2": "T2"})
    for body, says in (({"tank": "T3", "chambers": [1]}, "can't go into Tank 3"),         # MS into HSD
                       ({"tank": "T3", "chambers": [2]}, "isn't in the truck any more"),  # already planned
                       ({"tank": "T3", "chambers": []}, "Tick the chambers")):
        with pytest.raises(ValueError, match=says):
            a.act("add", body)



def test_a_held_chamber_cant_go_into_a_tank_already_read(rig):
    a = start(rig, {"1": "T1", "2": "T2"})
    rig.world.flows = [(2, 50, 4990, 495), (1, 4000, 4990, 495)]   # Tank 1's turn comes later
    drive(rig, 2000)
    assert a.run.row("T2")["stage"] == "read" and a.phase == "running"
    with pytest.raises(ValueError, match="stock after is already taken"):
        a.act("add", {"tank": "T2", "chambers": [3]})
    with pytest.raises(ValueError, match="can.t take it"):            # 11,495 L + 12,000 L > 20,500 L
        a.act("add", {"tank": "T3", "chambers": [3, 4, 5]})


def test_the_rest_of_the_truck_can_be_decanted_after_it_finished(rig):
    a = start(rig, {"2": "T2"})
    rig.world.flows = [(2, 50, 4990, 495)]
    drive(rig, 3000)
    assert a.phase == "finished"
    first = a.run.s["id"]
    inv = next(i for i in a.options()["invoices"] if i["invoice_no"] == INVOICE["invoice_no"])
    assert inv["status"] == "partial" and [c["no"] for c in inv["chambers"]] == [1, 3, 4, 5]
    a.act("clear", {})
    b = start(rig, {"3": "T3"})
    assert b.run.s["id"] != first and 2 in b.run.s["data"]["done"]


def test_a_tank_the_decant_app_adds_mid_run_gets_its_true_stock_before_with_its_picture(rig, monkeypatch):
    w = _screens_as_taken(rig, monkeypatch)
    a = start(rig, {"2": "T2"})
    w.flows = [(2, 50, 4990, 495), (3, 300, 3990, 400)]          # C4 into Tank 3, started from the decant app
    drive(rig, 340)
    risen = w.volume(3)
    assert risen - 11495.0 > 100                                  # it was already rising ...
    s = rig.cloud.sessions[a.run.s["id"]]
    s["data"]["tanks"].append({"tank": "T3", "tankNo": 3, "product": "HSD", "litres": 4000, "chambers": [4],
                               "before": {"volume": risen, "readingAt": dz.iso(rig.clock()), "source": "litres"},
                               "after": None, "stage": "decanting", "startedAt": dz.iso(rig.clock())})
    next(p for p in s["data"]["plan"] if p["no"] == 4)["tank"] = "T3"
    s["updated_at"] = dz.iso(rig.clock() + 1)                     # ... when the phone took its stock before
    drive(rig, 5000)
    assert a.phase == "finished", a.info
    t3 = next(t for t in cloud_session(rig)["data"]["tanks"] if t["tank"] == "T3")
    assert t3["before"]["volume"] == 11495.0 and t3["before"]["height"] is not None   # the stock before it rose, in full
    assert t3["result"]["band"] == "ok" and t3["result"]["variation"] == -10.0
    assert any("isn't the stock just before it started rising" in m for m in rig.told)
    assert a.view()["proofs"]["T3"]["before"]["picture"]
    assert {"readingAt": t3["before"]["readingAt"], "volume": 11495.0} in [m["T3"] for m in rig.cloud.shots if "T3" in m]


def test_a_tank_the_decant_app_adds_before_it_rises_keeps_its_stock_and_gets_a_picture(rig, monkeypatch):
    w = _screens_as_taken(rig, monkeypatch)
    a = start(rig, {"2": "T2"})
    w.flows = [(2, 50, 4990, 495)]
    drive(rig, 200)
    s = rig.cloud.sessions[a.run.s["id"]]
    s["data"]["tanks"].append({"tank": "T3", "tankNo": 3, "product": "HSD", "litres": 4000, "chambers": [4],
                               "before": {"volume": 11495.0, "readingAt": dz.iso(rig.clock()), "source": "litres"},
                               "after": None, "stage": "waiting", "startedAt": None})
    next(p for p in s["data"]["plan"] if p["no"] == 4)["tank"] = "T3"
    s["updated_at"] = dz.iso(rig.clock() + 1)
    w.flows.append((3, 400, 3990, 400))
    drive(rig, 5000)
    assert a.phase == "finished", a.info
    t3 = next(t for t in cloud_session(rig)["data"]["tanks"] if t["tank"] == "T3")
    assert t3["before"]["volume"] == 11495.0 and t3["before"]["height"] is not None     # same stock, now with its figures
    assert not any("isn't the stock just before it started rising" in m for m in rig.told)
    assert a.view()["proofs"]["T3"]["before"]["picture"]



def test_a_tank_a_phone_added_before_this_update_is_checked_when_the_service_restarts(rig, monkeypatch):
    w = rig.world
    a = start(rig, {"2": "T2"})
    w.flows = [(2, 50, 4990, 495), (3, 300, 3990, 400)]
    drive(rig, 340)
    risen = w.volume(3)
    # taken over by the old code: Tank 3 in the run, its too-high stock before kept
    remote = copy.deepcopy(rig.cloud.sessions[a.run.s["id"]])
    remote["data"]["tanks"].append({"tank": "T3", "tankNo": 3, "product": "HSD", "litres": 4000, "chambers": [4],
                                    "before": {"volume": risen, "readingAt": dz.iso(rig.clock()), "source": "litres"},
                                    "after": None, "stage": "decanting", "startedAt": dz.iso(rig.clock())})
    real = dz.Decantation._adopt_new
    dz.Decantation._adopt_new = lambda self, t, st, now: None
    try:
        a.run.adopt(remote, rig.clock())
    finally:
        dz.Decantation._adopt_new = real
    assert a.run.row("T3")["before"]["volume"] == risen
    a.resume()                                                    # the service restarts with this update
    assert a.run.row("T3")["before"]["volume"] == 11495.0
    assert any("isn't the stock just before it started rising" in m for m in rig.told)


# ---- edge cases: restarts, outages, phones -----------------------------------

def test_a_card_frozen_before_a_restart_stays_frozen_after_it(rig, monkeypatch):
    frozen = set()
    _clocks(rig, monkeypatch, frozen)
    a = start(rig, {"2": "T2"})
    rig.world.flows = [(2, 50, 4990, 495)]
    drive(rig, 700)
    assert a.run.row("T2")["stage"] == "settling"
    frozen.add(2)                                   # the probe goes offline: the card shows what it last had
    v_frozen, real = rig.world.volume(2), rig.world.volume
    monkeypatch.setattr(rig.world, "volume", lambda no: v_frozen if no == 2 else real(no))
    rig.world.sales = [(2, 1000, 300)]              # (and the real stock sells meanwhile)
    drive(rig, 1400)
    rig.st.live = None                              # the service restarts
    again = service.Station(home=rig.home, session_cls=Session, decant_mod=rig.cloud, notify=rig.told.append,
                            notify_photo=lambda png, caption: True)
    again.auto.resume()
    assert wait_for(lambda: again.live is not None)
    rig.st = again
    drive(rig, 1800)
    r = again.auto.run.row("T2")
    assert r["stage"] == "settling" and r["after"] is None     # nothing taken from the frozen figures
    assert not any("updating again" in m for m in rig.told)
    frozen.discard(2)                               # the card updates again: it carries on
    monkeypatch.setattr(rig.world, "volume", real)
    drive(rig, 1900)
    assert again.auto.info.get("frozen") == ""


def test_a_phone_sending_back_its_empty_draft_hands_the_run_over(rig):
    a = start(rig, {"2": "T2"})
    sid = a.run.s["id"]
    old = copy.deepcopy(rig.cloud.sessions[sid])
    old["data"].update(step="truck", plan=[], tanks=[])
    old["data"].pop("auto", None)
    old["updated_at"] = dz.iso(rig.clock() + 1)
    rig.cloud.sessions[sid] = old
    drive(rig, 600)
    assert a.phase == "released"                    # not running on forever with no tank
    assert rig.st.live is None or rig.st.live["stop"].is_set()


def test_a_phone_dropping_the_only_tank_hands_it_over(rig):
    a = start(rig, {"2": "T2"})
    sid = a.run.s["id"]
    s = copy.deepcopy(rig.cloud.sessions[sid])
    for p in s["data"]["plan"]:
        p["tank"] = None
    s["data"]["tanks"], s["data"]["step"] = [], "plan"
    s["updated_at"] = dz.iso(rig.clock() + 1)
    rig.cloud.sessions[sid] = s
    drive(rig, 600)
    assert a.phase == "released"


def test_hand_over_while_the_app_is_down_reaches_it_once_it_answers(rig):
    a = start(rig, {"2": "T2"})
    rig.world.flows = [(2, 50, 4990, 495)]
    rig.cloud.down = True
    drive(rig, 1200)
    assert a.run.row("T2")["stage"] in ("settling", "read")
    a.act("release", {})
    assert a.phase == "released" and a.info["unsaved"]
    assert cloud_session(rig)["data"]["tanks"][0]["stage"] == "waiting"     # (not there yet)
    assert a.flush_final() is False                 # still down
    rig.cloud.down = False
    assert a.flush_final() is True
    s = cloud_session(rig)
    assert s["data"]["auto"]["released"] and s["data"]["tanks"][0]["stage"] in ("settling", "read")
    assert not a.info["unsaved"]


def test_a_change_from_a_phone_whose_clock_is_behind_is_still_taken(rig):
    a = start(rig, {"2": "T2", "3": "T2"})
    rig.world.flows = [(2, 50, 4990, 495)]
    drive(rig, 300)
    sid = a.run.s["id"]
    s = copy.deepcopy(rig.cloud.sessions[sid])
    t = s["data"]["tanks"][0]
    t["chambers"], t["litres"] = [2], 5000          # C3 taken out of Tank 2...
    next(p for p in s["data"]["plan"] if p["no"] == 3)["tank"] = None
    s["updated_at"] = dz.iso(dz._ts(a.info["saved_at"]) - 120)   # ...by a phone 2 min behind
    rig.cloud.sessions[sid] = s
    drive(rig, 900)
    assert a.run.row("T2")["chambers"] == [2]
    assert cloud_session(rig)["data"]["tanks"][0]["chambers"] == [2]


def test_a_button_acts_on_the_phones_latest_copy(rig):
    a = start(rig, {"2": "T2", "3": "T3"})
    sid = a.run.s["id"]
    s = copy.deepcopy(rig.cloud.sessions[sid])
    s["data"]["notes"] = "from a phone"
    s["updated_at"] = dz.iso(rig.clock() + 1)
    rig.cloud.sessions[sid] = s
    a.act("drop", {"tank": "T3"})                   # pressed before the next sync
    c = cloud_session(rig)
    assert c["data"]["notes"] == "from a phone" and [t["tank"] for t in c["data"]["tanks"]] == ["T2"]


def test_chambers_added_to_a_tank_a_phone_settled_are_followed():
    from tests import test_tank_stock_decantation as td
    run = td.start({2: "T2"})
    truck = td.Truck([("T2", 50, 4990, 495), ("T2", 1200, 3990, 420)])
    run.feed({"T2": truck.volume("T2", 0)}, T0)
    remote = json.loads(json.dumps(run.s))
    t = remote["data"]["tanks"][0]
    t.update(stage="settling", startedAt=dz.iso(T0 + 60), doneAt=None)      # the agent never saw it rise
    remote["status"] = "settling"
    run.adopt(remote, T0 + 700)
    assert run.row("T2")["doneAt"]                 # its settle time runs
    secs = 700
    while secs < 1100:
        run.feed({"T2": truck.volume("T2", secs)}, T0 + secs)
        secs += 10
    run.add("T2", [3], None, T0 + secs)             # "Add to this decantation": C3 into Tank 2
    while secs < 2500:                              # (no crash on every read)
        run.feed({"T2": truck.volume("T2", secs)}, T0 + secs)
        secs += 10
    assert 3 in run.state["tanks"]["T2"]["arrived"] or run.row("T2")["stage"] in ("settling", "read")


def test_the_clock_set_right_after_the_mac_slept_takes_nothing_early(rig):
    a = start(rig, {"2": "T2"})
    rig.world.flows = [(2, 50, 4990, 495)]
    drive(rig, 700)
    assert a.run.row("T2")["stage"] == "settling" and a.run.row("T2")["after"] is None
    rig.clock.t += 2 * 3600                         # the VM woke up 2 h behind and was set right
    read(rig)
    assert a.run.row("T2")["stage"] == "settling" and a.run.row("T2")["after"] is None   # not "unsteady, read now"
    assert any("clock" in m for m in rig.told)
    drive(rig, 700 + 2 * 3600 + 3600)               # it settles again in full, then the stock after
    assert a.run.row("T2")["after"] is not None


def test_a_decantation_file_cut_short_comes_back_from_its_copy(rig):
    a = start(rig, {"2": "T2"})
    sid = a.run.s["id"]
    read(rig)                                       # written twice: the copy is there
    (rig.home / auto.AUTO_FILE).write_text('{"info": {"phase": "runn')   # a power cut mid-write
    again = service.Station(home=rig.home, session_cls=Session, decant_mod=rig.cloud, notify=rig.told.append,
                            notify_photo=lambda png, caption: True)
    assert again.auto.phase == "running" and again.auto.run.s["id"] == sid
    again.auto.resume()
    assert any("damaged" in m for m in rig.told)
    assert list(rig.home.glob(auto.AUTO_FILE + ".corrupt-*"))        # the bad one kept aside
    rig.st.live = None


def test_one_odd_empty_answer_doesnt_count_as_deleted(rig, monkeypatch):
    a = start(rig, {"2": "T2"})
    real = rig.cloud.get_session
    answers = iter([None])
    monkeypatch.setattr(rig.cloud, "get_session", lambda sid, timeout=30: next(answers, "real") == "real" and real(sid) or None)
    a.info["synced"] = 0
    read(rig)
    assert a.phase == "running"                     # once: not "deleted in the decant app"


# ---- a decantation started in the decant app, carried on here -----------------

def app_session(rig, tanks, status="decanting"):
    """A decantation a phone set up in the decant app: {tank id: (chambers, stage, started s, done s)}."""
    cfg = rig.cloud.settings()
    layout = dz.layout_for(INVOICE, cfg["app"])
    s = dz.new_session(dict(INVOICE), layout, [])
    d = s["data"]
    d["step"] = "decant"
    litres = {c["no"]: c["litres"] for c in layout["chambers"]}
    d["plan"] = [{"no": c["no"], "product": c["product"], "litres": c["litres"], "tank": None} for c in layout["chambers"]]
    d["tanks"] = []
    for tank_id, (chambers, stage, started, done) in tanks.items():
        no = int(tank_id[1:])
        before = {"volume": rig.world.base.get(no, 5000.0), "readingAt": dz.iso(T0), "timeRead": True, "source": "photo",
                  "capacity": 20000}
        for p in d["plan"]:
            if p["no"] in chambers:
                p["tank"] = tank_id
        d["before"][tank_id] = before
        d["tanks"].append({"tank": tank_id, "tankNo": no, "product": PRODUCT.get(no, "HSD"), "litres": sum(litres[c] for c in chambers),
                           "chambers": chambers, "before": before, "after": None, "pricePerL": None, "stage": stage,
                           "startedAt": dz.iso(T0 + started) if started is not None else None,
                           "doneAt": dz.iso(T0 + done) if done is not None else None})
    s["status"] = status
    s["updated_at"] = dz.iso(rig.clock())
    rig.cloud.sessions[s["id"]] = copy.deepcopy(s)
    return s["id"]


def take_over(rig, sid, requested=False):
    a = rig.st.auto
    if requested:
        a.check_requests()
    else:
        a.take_over(sid)
    assert wait_for(lambda: rig.st.live is not None)
    read(rig)
    end = real_time.time() + 5
    while a.phase == "starting" and real_time.time() < end:
        real_time.sleep(0.02)
        if a.phase == "starting" and rig.st.live:
            read(rig)
    return a


def test_a_decantation_started_in_the_app_is_carried_on_and_finished_here(rig):
    rig.world.flows = [(2, 50, 4990, 495)]
    rig.clock.t = T0 + 200                          # C2 is going into Tank 2 (started on a phone)
    sid = app_session(rig, {"T2": ([2], "decanting", 50, None)})
    a = take_over(rig, sid)
    assert a.phase == "running", a.info
    s = cloud_session(rig)
    assert s["data"]["auto"]["takenOver"] and not s["data"]["auto"]["released"]
    t2 = s["data"]["tanks"][0]
    assert t2["stage"] == "decanting" and t2["before"]["volume"] == 10755.0    # the app's stock before, kept
    assert any("Took over a decantation" in m for m in rig.told)
    drive(rig, 3000)
    assert a.phase == "finished", a.info
    s = cloud_session(rig)
    t2 = s["data"]["tanks"][0]
    assert s["status"] == "done" and t2["result"]["variation"] == -10.0 and t2["after"]["height"]


def test_a_tank_marked_started_in_the_app_but_not_rising_waits_for_its_rise(rig):
    sid = app_session(rig, {"T2": ([2], "decanting", 0, None)})               # tapped Start, pipe not on yet
    rig.clock.t = T0 + 30
    a = take_over(rig, sid)
    assert a.run.row("T2")["stage"] == "waiting" and a.run.row("T2")["startedAt"] is None
    rig.world.flows = [(2, 100, 4990, 495)]
    drive(rig, 3000)
    t2 = cloud_session(rig)["data"]["tanks"][0]
    assert a.phase == "finished" and t2["result"]["variation"] == -10.0
    assert dz._ts(t2["startedAt"]) >= T0 + 100                                 # its real start


def test_a_settling_tank_taken_over_settles_in_full_before_its_stock_after(rig):
    rig.world.flows = [(2, 0, 4990, 495)]
    rig.clock.t = T0 + 560
    sid = app_session(rig, {"T2": ([2], "settling", 0, 500)}, status="settling")
    a = take_over(rig, sid)
    settle = a.run.settings["settleMinutes"] * 60
    drive(rig, 560 + settle - 60)
    assert a.run.row("T2")["after"] is None                                     # not before a full settle here
    drive(rig, 560 + settle * 3 + 300)
    assert a.phase == "finished" and cloud_session(rig)["data"]["tanks"][0]["result"]["variation"] == -10.0


def test_a_phone_asking_the_server_to_finish_it_is_taken_up(rig):
    rig.world.flows = [(2, 50, 4990, 495)]
    rig.clock.t = T0 + 200
    sid = app_session(rig, {"T2": ([2], "decanting", 50, None)})
    rig.cloud.sessions[sid]["data"]["autoRequest"] = {"at": dz.iso(rig.clock()), "by": "phone"}
    rig.cloud.handover_requests = lambda timeout=10: [
        {"id": x["id"], "updated_at": x["updated_at"], "request": x["data"]["autoRequest"]}
        for x in rig.cloud.sessions.values() if isinstance(x["data"].get("autoRequest"), dict)]
    a = take_over(rig, sid, requested=True)
    assert a.phase == "running" and a.info["takeover"] == sid
    assert "autoRequest" not in cloud_session(rig)["data"]                     # answered: it runs it now
    # a second phone's request meanwhile is told why not
    sid2 = app_session(rig, {"T3": ([4], "decanting", 50, None)})
    rig.cloud.sessions[sid2]["data"]["autoRequest"] = {"at": dz.iso(rig.clock()), "by": "phone"}
    a.check_requests()
    assert "running another decantation" in rig.cloud.sessions[sid2]["data"]["autoRequest"]["error"]


def test_a_takeover_that_cant_follow_a_tank_leaves_it_in_the_app_and_says_why(rig):
    sid = app_session(rig, {"T9": ([2], "decanting", 0, None)})                # a tank not in the settings
    rig.cloud.sessions[sid]["data"]["autoRequest"] = {"at": dz.iso(rig.clock()), "by": "phone"}
    rig.cloud.handover_requests = lambda timeout=10: [
        {"id": x["id"], "updated_at": x["updated_at"], "request": x["data"]["autoRequest"]}
        for x in rig.cloud.sessions.values() if isinstance(x["data"].get("autoRequest"), dict)]
    a = take_over(rig, sid, requested=True)
    assert a.phase == "failed" and "no longer in the decant app's settings" in a.info["error"]
    s = rig.cloud.sessions[sid]
    assert not s["data"].get("auto") and s["status"] == "decanting"            # carried on in the app, as it was
    assert wait_for(lambda: "no longer in the decant app's settings"
                    in rig.cloud.sessions[sid]["data"]["autoRequest"].get("error", ""))
    a.check_requests()                                                           # answered: never tried again
    assert a.phase == "failed"


def test_a_phone_taking_it_back_ends_the_run_here(rig):
    rig.world.flows = [(2, 50, 4990, 495)]
    rig.clock.t = T0 + 200
    sid = app_session(rig, {"T2": ([2], "decanting", 50, None)})
    a = take_over(rig, sid)
    s = copy.deepcopy(rig.cloud.sessions[sid])
    s["data"]["auto"]["released"] = True                                          # "Take it back on this phone"
    s["updated_at"] = dz.iso(rig.clock() + 1)
    rig.cloud.sessions[sid] = s
    a.info["synced"] = 0
    drive(rig, 400)
    assert a.phase == "released"


def test_the_page_lists_the_app_decantations_it_can_carry_on(rig):
    sid = app_session(rig, {"T2": ([2], "decanting", 0, None)})
    opts = rig.st.auto.options()
    ones = [o for o in opts["open"] if o["id"] == sid]
    assert ones and ones[0]["tanks"][0]["stage"] == "decanting" and not ones[0]["byAgent"]


def test_a_phone_saving_during_the_takeover_keeps_its_change(rig, monkeypatch):
    rig.world.flows = [(2, 50, 4990, 495)]
    rig.clock.t = T0 + 200
    sid = app_session(rig, {"T2": ([2], "decanting", 50, None)})
    real, first = rig.cloud.save_session, {"n": 0}

    def save(s, base=None, timeout=30):
        if base and first["n"] == 0:                  # a phone saves just before the takeover lands
            first["n"] = 1
            row = rig.cloud.sessions[sid]
            row["data"]["notes"] = "typed on the phone"
            row["updated_at"] = dz.iso(rig.clock() + 1)
        return real(s, base=base, timeout=timeout)
    monkeypatch.setattr(rig.cloud, "save_session", save)
    a = take_over(rig, sid)
    assert a.phase == "running", a.info
    s = rig.cloud.sessions[sid]
    assert s["data"]["notes"] == "typed on the phone" and s["data"]["auto"]["takenOver"]
