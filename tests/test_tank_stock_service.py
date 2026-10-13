"""Tank stock monitor, phone page API, card parsing and the decant upload (fakes only)."""
import json
import threading
import urllib.request

import pytest

from tank_stock import cards, decant, service

PLAIN = """Tank 3 : High Speed Diesel
C
20,000.00 itr
19,552.05 itr
1,780.37 mm
J 0.00 Itr
447.95 itr
894.30 kg/m*3
906.00 kg/m*3
32.40
"""
LABELLED = """Tank 3 : High Speed Diesel
Last Updated @ 10/13/2026 18:01:54
Tank Status
Tank Capacity 20,000.00 itr
Product Volume 19,552.05 ltr
Product Height 1,780.37 mm
Water Volume 0.00 itr
Ullage Space 447.95 tor
Density 894.30 kg/m*3
Density (tc) 906.00 kg/m*3
Temperature 32.40 7
"""
CARD3 = {"no": 3, "product": "HSD", "time": ("10", "13", "2026", "18", "01", "54"), "capacity": 20000.0,
         "volume": 19552.05, "height": 1780.37, "water": 0.0, "ullage": 447.95, "density": 894.3,
         "densityTc": 906.0, "temp": 32.4, "disagree": []}
CFG = {"tanks": decant.DEFAULT_TANKS, "dateOrder": "MDY", "chart": decant.dip_chart()}


def test_both_reads_of_a_card_give_the_same_figures():
    a, b = cards.parse_values(PLAIN), cards.parse_labelled(LABELLED)
    assert a == {k: CARD3[k] for k in cards.FIELDS}
    assert b["no"] == 3 and b["product"] == "HSD" and b["time"] == CARD3["time"]
    assert {k: b[k] for k in cards.FIELDS} == a                 # "32.40 7" is 32.40


def test_a_checked_card_becomes_the_apps_reading():
    built = decant.make_reading(CARD3, decant.tank_for(3, CFG), CFG)
    r = built["reading"]
    assert built["confidence"] == "high" and built["problems"] == []
    assert r["volume"] == 19552.05 and r["ullage"] == 447.95 and r["dip"] == 178.04
    assert r["readingAt"] == "2026-10-13T18:01:54+05:30" and r["timeRead"] is True
    assert r["checks"]["sum"]["ok"] and r["checks"]["chart"]["ok"] and r["source"] == "photo"


@pytest.mark.parametrize(("change", "problem"), [
    ({"volume": 19562.05}, "volume + ullage"),
    ({"height": 1500.0}, "dip chart"),
    ({"disagree": ["volume"]}, "two reads differ"),
    ({"product": "MS"}, "the app has HSD"),
])
def test_a_card_that_fails_a_check_is_not_saved(change, problem):
    built = decant.make_reading({**CARD3, **change}, decant.tank_for(3, CFG), CFG)
    assert built["confidence"] == "low" and any(problem in p for p in built["problems"])


class FakeDB:
    def __init__(self, rows=None):
        self.rows, self.writes = dict(rows or {}), []

    def __call__(self, method, path, body=None, prefer="", timeout=30):
        if path.startswith("dec_config"):
            return []
        if method == "GET":
            tid = path.split("eq.")[1].split("&")[0]
            return [{"reading": self.rows[tid]}] if tid in self.rows else []
        assert "on_conflict=tank_id" in path and "merge-duplicates" in prefer
        for row in body:
            self.writes.append(row)
            self.rows[row["tank_id"]] = row["reading"]


def test_upload_saves_checked_tanks_and_never_replaces_a_newer_reading(monkeypatch):
    db = FakeDB({"T1": {"readingAt": "2026-10-13T19:00:00+05:30", "volume": 1}})
    monkeypatch.setattr(decant, "_rest", db)
    card1 = {**CARD3, "no": 1, "product": "MS"}
    bad = {**CARD3, "no": 2, "volume": 1.0}
    out = decant.upload({1: card1, 2: bad, 3: CARD3}, [1, 2, 3, 4], CFG)
    assert out[1]["message"] == "the app already has a newer reading"
    assert out[2]["ok"] is False and "not saved" in out[2]["message"]
    assert out[3]["ok"] and "19,552.05 L (Checked)" in out[3]["message"]
    assert out[4]["message"] == "not on the screenshot"
    assert [w["tank_id"] for w in db.writes] == ["T3"]
    assert db.writes[0]["reading"]["savedAt"] == db.writes[0]["updated_at"]
    again = decant.upload({3: CARD3}, [3], CFG)
    assert again[3]["message"] == "already in the app" and len(db.writes) == 1


@pytest.fixture
def station(tmp_path, monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(decant, "_rest", db)
    monkeypatch.setattr(service.cards_mod, "read_all",
                        lambda png: ({3: (959, 343, 1284, 677)}, {3: dict(CARD3)}))
    (tmp_path / "login.json").write_text(json.dumps({"ids": ["123456789"], "password": "pw"}))
    alerts = []
    shots = {"fail": False}

    def fake_capture(ids, password):
        if shots["fail"]:
            raise service.CaptureError("None of the 2 AnyDesk IDs opened a session")
        return b"\x89PNG", [], 1, "already on Tank Status"
    st = service.Station(home=tmp_path, capture_fn=fake_capture, notify=alerts.append)
    st.db, st.alerts, st.shots = db, alerts, shots
    return st


def test_settings_are_checked(station):
    assert station.settings == service.DEFAULTS                 # 15 min, all tanks, upload on
    assert station.save_settings({"interval_min": "30", "tanks": [3, 1]})["tanks"] == [1, 3]
    for bad in ({"interval_min": 2}, {"tanks": []}, {"tanks": [5]}, {"interval_min": "x"}):
        with pytest.raises(ValueError):
            station.save_settings(bad)
    assert station.settings["interval_min"] == 30


def test_a_capture_reads_the_cards_and_uploads_when_asked(station):
    last = station.run([3], upload=False, why="phone")
    assert last["tanks"]["3"]["confidence"] == "high" and station.db.writes == []
    assert station.upload_last([3])[3]["ok"] and station.db.writes[0]["tank_id"] == "T3"
    assert station.last["uploads"]["3"]["ok"]


def test_the_monitor_alerts_once_and_says_when_it_is_fine_again(station):
    station.save_settings({"tanks": [3]})
    station.shots["fail"] = True
    station.monitor_once()
    station.monitor_once()
    assert len(station.alerts) == 1 and "opened a session" in station.alerts[0]
    station.shots["fail"] = False
    station.monitor_once()
    assert station.alerts[-1].startswith("✅") and station.db.writes[-1]["tank_id"] == "T3"
    assert station.monitor_state["last_error"] == ""


def test_the_monitor_waits_for_a_capture_from_the_page(station):
    station.busy.acquire()
    try:
        station.monitor_once()
    finally:
        station.busy.release()
    assert station.alerts == [] and 0 < station.next_due() - __import__("time").time() <= 61


def test_without_the_login_a_capture_says_how_to_add_it(station):
    (station.home / "login.json").unlink()
    with pytest.raises(service.CaptureError, match="save-login"):
        station.run([1], False, "phone")


def test_a_watched_tank_missing_from_the_screen_is_reported(station):
    station.monitor_once()                                      # watches all four; only Tank 3 shows
    assert "Tank 1: not on the screenshot" in station.alerts[0] and station.db.writes[-1]["tank_id"] == "T3"


def test_the_page_api_needs_its_token_and_this_machine(station):
    srv = service.make_server(station, 0)
    port = srv.server_address[1]
    srv.port = port
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    try:
        state = json.loads(urllib.request.urlopen(f"{base}/api/state").read())
        assert state["login_saved"] and state["settings"]["interval_min"] == 15
        page = urllib.request.urlopen(f"{base}/").read()
        assert srv.csrf.encode() in page and b"__CSRF__" not in page

        def post(path, body, token):
            req = urllib.request.Request(f"{base}{path}", data=json.dumps(body).encode(), method="POST",
                                         headers={"Content-Type": "application/json", "X-TS-CSRF": token})
            try:
                return urllib.request.urlopen(req).status
            except urllib.error.HTTPError as exc:
                return exc.code
        assert post("/api/settings", {"interval_min": 20}, "wrong") == 403
        assert post("/api/settings", {"interval_min": 20}, srv.csrf) == 200
        assert post("/api/settings", {"interval_min": 1}, srv.csrf) == 400
        req = urllib.request.Request(f"{base}/api/state", headers={"Host": "elsewhere.example"})
        with pytest.raises(urllib.error.HTTPError) as err:
            urllib.request.urlopen(req)
        assert err.value.code == 403
    finally:
        srv.shutdown()
        srv.server_close()
