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

    def settings(self):
        self._up()
        return {"tanks": decant.DEFAULT_TANKS, "dateOrder": "MDY", "chart": CHART,
                "app": dz.settings_with({}, decant.DEFAULT_TANKS)}

    def invoices_and_sessions(self):
        self._up()
        return [dict(INVOICE)], [copy.deepcopy(s) for s in self.sessions.values()]

    def tank_states(self):
        self._up()
        return copy.deepcopy(self.stock)

    def get_session(self, sid):
        self._up()
        return copy.deepcopy(self.sessions.get(sid))

    def save_session(self, s):
        self._up()
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
    assert {"T1", "T2"} <= set(rig.cloud.shots[0])
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
    assert any("could not start" in m for m in rig.told)
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
    assert any("could not start" in m for m in rig.told)


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


def test_a_tank_that_sold_just_before_its_turn_gets_its_stock_before_in_full(rig, monkeypatch):
    # screens as taken: a kept screen shows the stock when it was taken
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
