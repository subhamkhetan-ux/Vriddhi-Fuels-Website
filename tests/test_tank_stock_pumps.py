"""The Pumps tab (tank_stock/pumps.py) against a synthetic FuelTrans live
connection: sales followed and learnt from, a tapped preset's time left,
interlocks, and monitoring that is off (no requests at all) unless started."""
import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from tank_stock import pumps as pm
from tank_stock import service

LAYOUT = [
    {"du_no": 1, "make": "Gilbarco", "pump_no": 1, "nozzle_no": 1, "global_nozzle_no": 1, "tank_no1": 3,
     "grade_price": 100.74, "grade_code": "HS"},
    {"du_no": 2, "make": "Gilbarco", "pump_no": 5, "nozzle_no": 1, "global_nozzle_no": 5, "tank_no1": 1,
     "grade_price": 109.01, "grade_code": "MS"},
    {"du_no": 2, "make": "Gilbarco", "pump_no": 8, "nozzle_no": 1, "global_nozzle_no": 8, "tank_no1": 2,
     "grade_price": 100.74, "grade_code": "HS"},
]


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t


def pkt(pump, status, litres=0.0, price=100.74, lockval=0, npnd=0):
    return {"PumpId": pump, "pumpUid": pump, "status": status, "nozzleId": 1, "trxnVolume": litres,
            "trxnAmount": round(litres * price, 2), "lockval": lockval, "npndstatus": npnd, "pumptype": 1}


def frame(*events):
    """An engine.io v3 polling payload of socket.io events."""
    out = ""
    for name, data in events:
        p = "42" + json.dumps([name, data])
        out += f"{len(p)}:{p}"
    return out


@pytest.fixture
def mon(tmp_path):
    clock, told = Clock(), []
    p = pm.Pumps(tmp_path, lambda: "http://ft", notify=told.append,
                 fetch=lambda url, data=None, timeout=0: json.dumps(LAYOUT), clock=clock)
    p.load_layout("http://ft")
    p.clock_, p.told_ = clock, told
    return p


def sale(mon, pump, litres, lpm, price=100.74, pause=None):
    """A sale: calling, fuelling ``litres`` at ``lpm`` (one packet a second), sale end, idle."""
    c = mon.clock_
    mon.update(pump, pkt(pump, 3, 0, price))
    c.t += 2
    secs = litres / lpm * 60
    flowed = elapsed = 0
    while flowed < secs:
        paused = bool(pause) and pause[0] <= elapsed < pause[1]
        mon.update(pump, pkt(pump, 6 if paused else 5, round(min(litres, lpm / 60 * flowed), 3), price))
        flowed += 0 if paused else 1
        elapsed += 1
        c.t += 1
    mon.update(pump, pkt(pump, 5, litres, price))
    c.t += 1
    mon.update(pump, pkt(pump, 7, litres, price))
    c.t += 3
    mon.update(pump, pkt(pump, 2, litres, price))


def test_engine_io_payloads_and_interlock_bits():
    opened = '0{"sid":"x","upgrades":["websocket"],"pingInterval":25000}'
    payload = f"{len(opened)}:{opened}2:40" + frame(("pumpStatusPkt", pkt(5, 5, 1.0)))
    got = list(pm.packets(payload))
    assert got[0].startswith("0{") and got[1] == "40" and got[2].startswith('42["pumpStatusPkt"')
    assert list(pm.packets('9:42["a",1]garbage')) == ['42["a",1]']                     # (stops at junk)
    assert pm.interlocks(0, 0) == []
    assert pm.interlocks(5, 0) == ["interlock bit 0", "PRESET INTERLOCK"]
    assert pm.interlocks(0, 1) == ["NPND INTERLOCK"]
    assert pm.interlocks("2", "1") == ["TEST INTERLOCK", "NPND INTERLOCK"]
    assert pm.interlocks(8, 1) == ["NPND INTERLOCK"]                 # (bit 3 and the flag: once)
    assert pm.interlocks((1 << 6) | (1 << 8), 0) == ["PRODUCT LOW INTERLOCK", "DELIVERY INPROGRESS INTERLOCK"]
    assert pm.interlocks(1 << 20, 0) == ["TANK LEAKAGE INTERLOCK"]
    assert pm.interlocks(1 << 19, 0) == ["interlock bit 19"]          # (FuelTrans has no name for it)


def test_a_sale_is_followed_and_teaches_the_nozzles_usual_flow(mon):
    mon.set_watch([8, 5])
    sale(mon, 8, 50.0, 34.0)                                    # fast HSD nozzle
    sale(mon, 5, 4.6, 7.0, price=109.01)                        # slow MS nozzle (a bike)
    v = mon.view()
    cards = {c["pump"]: c for c in v["watching"]}
    assert cards[8]["status"] == "IDLE" and cards[8]["litres"] == 50.0
    assert abs(cards[8]["usual_lpm"] - 34) < 1.5 and abs(cards[5]["usual_lpm"] - 7) < 0.5
    (s8,) = cards[8]["sales"]
    assert s8["litres"] == 50.0 and abs(s8["lpm"] - 34) < 1.5 and 85 < s8["secs"] < 95
    assert [p["pump"] for p in v["pumps"]] == [1, 5, 8] and v["pumps"][1]["product"] == "MS"
    assert v["pumps"][1]["watched"] and not v["pumps"][0]["watched"]
    # learnt and kept across a restart of the service
    again = pm.Pumps(mon.home, lambda: "http://ft", clock=mon.clock_)
    assert again.watch == [5, 8] and abs(pm._median(again.speeds[8]) - 34) < 1.5


def test_a_pause_on_the_trigger_is_the_same_sale_and_a_tiny_sale_teaches_nothing(mon):
    mon.set_watch([8])
    sale(mon, 8, 30.0, 30.0, pause=(20, 35))                    # suspended for 15 s mid-sale
    assert len(mon.sales[8]) == 1 and mon.sales[8][0]["litres"] == 30.0
    assert abs(mon.speeds[8][0] - 30) < 1.5                     # the flow while it flowed
    sale(mon, 8, 0.5, 30.0)                                     # a test squirt: kept, not learnt from
    assert len(mon.sales[8]) == 2 and len(mon.speeds[8]) == 1


def test_a_tapped_preset_counts_down_and_clears_when_the_sale_ends(mon):
    mon.set_watch([8])
    sale(mon, 8, 40.0, 30.0)                                    # learns ~30 L/min
    mon.set_preset(8, "amount", 1007.4)                         # ₹1007.40 = 10 L at ₹100.74
    card = mon.view()["watching"][0]
    assert card["target_litres"] == 10.0 and abs(card["left_s"] - 20) <= 2 and card["progress"] is None
    c = mon.clock_
    mon.update(8, pkt(8, 5, 0.0))
    for i in range(1, 9):                                       # 8 s at 30 L/min: 4 L in
        c.t += 1
        mon.update(8, pkt(8, 5, round(0.5 * i, 2)))
    card = mon.view()["watching"][0]
    assert card["status"] == "FUELING" and card["litres"] == 4.0 and card["progress"] == 0.4
    assert abs(card["lpm"] - 30) < 1 and abs(card["left_s"] - 12) <= 1 and card["fueling_s"] == 8
    c.t += 1
    mon.update(8, pkt(8, 7, 4.0))
    assert mon.view()["watching"][0]["preset"] is None
    assert mon.sales[8][0]["preset"]["value"] == 1007.4         # (it stays with the sale it was for)
    mon.set_preset(8, "litres", 20)
    assert mon.view()["watching"][0]["target_litres"] == 20
    for bad in (("litres", -1), ("litres", 50000), ("kg", 5), ("amount", "x")):
        with pytest.raises(ValueError):
            mon.set_preset(8, *bad)
    mon.set_preset(8, None, None)
    assert mon.presets == {}


def test_interlocks_on_a_watched_nozzle_go_to_telegram_once_each_way(mon):
    mon.set_watch([5])
    mon.update(5, pkt(5, 2))
    mon.update(5, pkt(5, 9, lockval=5))                         # PUMP LOCK with two interlocks
    mon.update(5, pkt(5, 9, lockval=5))                         # (the same: said once)
    mon.update(8, pkt(8, 9, lockval=1))                         # not watched: nothing said
    card = mon.view()["watching"][0]
    assert card["status"] == "PUMP LOCK" and card["locks"] == ["interlock bit 0", "PRESET INTERLOCK"]
    mon.update(5, pkt(5, 2, lockval=0, npnd=1))
    mon.update(5, pkt(5, 2))
    assert mon.told_ == ["🔒 Pump 5 (MS, DU 2): interlock bit 0, PRESET INTERLOCK.",
                         "🔒 Pump 5 (MS, DU 2): NPND INTERLOCK.",
                         "🔓 Pump 5 (MS, DU 2): interlock cleared (NPND INTERLOCK)."]
    mon.set_alerts(False)
    mon.update(5, pkt(5, 9, lockval=2))
    assert len(mon.told_) == 3


class FakeFuelTrans:
    """FuelTrans' live connection, polled: counts every request."""

    def __init__(self):
        self.calls, self.queue, self.lock = [], [], threading.Lock()

    def __call__(self, url, data=None, timeout=0):
        with self.lock:
            self.calls.append((url, data))
        if url.endswith("/getDuPumpNozzleDetails"):
            return json.dumps(LAYOUT)
        if "sid=" not in url:
            opened = '0{"sid":"abc","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":5000}'
            return f"{len(opened)}:{opened}2:40"
        if data is not None:
            return "ok"
        time.sleep(0.02)                                       # (a long poll)
        with self.lock:
            out, self.queue = self.queue, []
        return frame(*out)


def test_monitoring_is_off_unless_started_and_idle_again_after(tmp_path, monkeypatch):
    ft = FakeFuelTrans()
    clock = Clock()
    p = pm.Pumps(tmp_path, lambda: "http://ft", fetch=ft, clock=clock)
    stop = threading.Event()
    th = threading.Thread(target=p.run, args=(stop,), daemon=True)
    th.start()
    time.sleep(0.3)
    assert ft.calls == [] and not p.view()["on"]                # off: not one request
    with pytest.raises(ValueError, match="Tick the nozzles"):
        p.start()
    p.set_watch([8])
    time.sleep(0.2)
    assert ft.calls == []                                       # ticked but not started: still nothing
    p.start()
    ft.queue = [("pumpStatusPkt", pkt(8, 5, 12.5)), ("DeviceStatus", {"deviceType": 4}), ("sendPumpControl", {})]
    deadline = time.time() + 5
    while time.time() < deadline and not p.live.get(8):
        time.sleep(0.02)
    assert p.live[8]["volume"] == 12.5 and p.view()["feed"]["connected"]
    assert all(d in (None, b"1:2") for _, d in ft.calls)        # it only ever listens (and pings)
    p.stop()
    time.sleep(0.2)
    n = len(ft.calls)
    time.sleep(0.4)
    assert len(ft.calls) == n and not p.view()["on"]            # stopped: idle again
    assert p.view()["stopped"]["why"] == "stopped by you"
    # nobody looking: it stops by itself
    monkeypatch.setattr(pm, "UNSEEN_STOP", 60)
    p.start()
    assert wait_for(lambda: len(ft.calls) > n)
    clock.t += 61
    assert wait_for(lambda: not p.on)
    assert "wasn't open for 1 min" in p.view()["stopped"]["why"]
    n = len(ft.calls)
    time.sleep(0.3)
    assert len(ft.calls) == n
    # un-ticking every nozzle stops it too
    p.start()
    p.set_watch([])
    assert not p.on and p.view()["stopped"]["why"] == "no nozzle ticked"
    stop.set()
    p.wake.set()


def test_without_the_fueltrans_tunnel_it_says_so(tmp_path):
    p = pm.Pumps(tmp_path, lambda: "", fetch=FakeFuelTrans())
    with pytest.raises(ValueError, match="tunnel"):
        p.start()
    assert not p.view()["available"]


def wait_for(cond, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def test_the_pumps_page_and_api(tmp_path):
    (tmp_path / "login.json").write_text(json.dumps({"source": "fueltrans", "password": "x", "url": "http://127.0.0.1:9"}))
    st = service.Station(home=tmp_path, notify=lambda *a: True, notify_photo=lambda *a: True)
    st.pumps.fetch = ft = FakeFuelTrans()
    srv = service.make_server(st, 0)
    srv.port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.port}"

    def post(path, body):
        req = urllib.request.Request(f"{base}{path}", data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "X-TS-CSRF": srv.csrf})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())
    try:
        page = urllib.request.urlopen(f"{base}/pumps").read()
        assert srv.csrf.encode() in page and b"__CSRF__" not in page and b'src="pumps.js"' in page
        assert b"use strict" in urllib.request.urlopen(f"{base}/pumps.js").read()
        v = json.loads(urllib.request.urlopen(f"{base}/api/pumps").read())
        assert v["pumps"] == [] and ft.calls == []              # (not open in front of anyone: nothing read)
        v = json.loads(urllib.request.urlopen(f"{base}/api/pumps?seen=1").read())
        assert v["available"] and not v["on"] and [p["pump"] for p in v["pumps"]] == [1, 5, 8]   # to tick, before Start
        assert [u for u, _ in ft.calls] == ["http://127.0.0.1:9/getDuPumpNozzleDetails"]
        json.loads(urllib.request.urlopen(f"{base}/api/pumps?seen=1").read())
        assert len(ft.calls) == 1                                # read once (for an hour)
        assert post("/api/pumps/watch", {"pumps": [5, 99]})[0] == 400
        code, v = post("/api/pumps/watch", {"pumps": [5]})
        assert code == 200 and [c["pump"] for c in v["watching"]] == [5]
        assert post("/api/pumps/preset", {"pump": 5, "kind": "amount", "value": 500})[1]["watching"][0]["preset"]["value"] == 500
        code, v = post("/api/pumps/start", {})
        assert code == 200 and v["on"] and v["stops_in_s"] > 0
        code, v = post("/api/pumps/stop", {})
        assert code == 200 and not v["on"]
        assert post("/api/pumps/alerts", {"on": False})[1]["alerts"] is False
    finally:
        srv.shutdown()
        st.pumps.stop()


def test_a_long_sale_is_learnt_from_whole(mon):
    mon.set_watch([1])
    sale(mon, 1, 300.0, 30.0, pause=(200, 230))                 # 10 min of flow and a pause
    (s,) = mon.sales[1]
    assert s["litres"] == 300.0 and abs(mon.speeds[1][0] - 30) < 0.6


def test_the_pump_list_is_read_when_the_page_opens_and_again_after_a_failure(tmp_path):
    clock, answers = Clock(), []

    def fetch(url, data=None, timeout=0):
        answers.append(url)
        if len(answers) == 1:
            raise urllib.error.URLError(ConnectionRefusedError("Connection refused"))
        return json.dumps(LAYOUT)
    p = pm.Pumps(tmp_path, lambda: "http://ft/", fetch=fetch, clock=clock)
    p.need_layout()
    v = p.view()
    assert v["pumps"] == [] and "tunnel is down" in v["layout_error"]
    p.need_layout()
    assert len(answers) == 1                                     # not again at once
    clock.t += pm.LAYOUT_RETRY
    p.need_layout()
    v = p.view()
    assert [n["pump"] for n in v["pumps"]] == [1, 5, 8] and v["layout_error"] == ""
    assert answers == ["http://ft/getDuPumpNozzleDetails"] * 2
    clock.t += pm.LAYOUT_EVERY
    p.on = True
    p.need_layout()                                              # (monitoring: the listener keeps it)
    assert len(answers) == 2
    p.on = False
    p.need_layout()
    assert len(answers) == 3                                     # an hour on: read again
    assert pm.Pumps(tmp_path, lambda: "", fetch=fetch).need_layout() is None and len(answers) == 3
