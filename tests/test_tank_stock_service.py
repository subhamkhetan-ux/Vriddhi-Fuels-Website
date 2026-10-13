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


class FakeSession:
    """Stands in for capture.Session: connects, shows Tank Status, can end."""
    opened, fail = [], False

    def __init__(self, ids, password, **kw):
        self.position, self.is_alive, self.closed = None, True, False

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()

    def open(self):
        if FakeSession.fail:
            raise service.CaptureError("None of the 2 AnyDesk IDs opened a session")
        FakeSession.opened.append(self)
        self.position = 1
        return 1

    def shot(self):
        return b"\x89PNG", "already on Tank Status"

    def screen(self):
        return b"\x89PNG-ended"

    def alive(self):
        return self.is_alive

    def close(self):
        self.closed = True


@pytest.fixture
def station(tmp_path, monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(decant, "_rest", db)
    monkeypatch.setattr(service.cards_mod, "read_all",
                        lambda png: ({3: (959, 343, 1284, 677)}, {3: dict(CARD3)}))
    monkeypatch.setattr(service, "CHECK_EVERY", 0.01)
    FakeSession.opened, FakeSession.fail = [], False
    (tmp_path / "login.json").write_text(json.dumps({"ids": ["123456789"], "password": "pw"}))
    alerts, photos = [], []
    st = service.Station(home=tmp_path, session_cls=FakeSession, notify=alerts.append,
                         notify_photo=lambda png, caption: photos.append((png, caption)) or True)
    st.db, st.alerts, st.photos = db, alerts, photos
    return st


def wait_for(cond, timeout=5):
    import time
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


def test_settings_are_checked(station):
    assert station.settings == service.DEFAULTS                 # 15 min, all tanks, upload on
    assert station.save_settings({"interval_min": "30", "tanks": [3, 1]})["tanks"] == [1, 3]
    for bad in ({"interval_min": 0}, {"interval_min": 241}, {"tanks": []}, {"tanks": [5]}, {"interval_min": "x"}):
        with pytest.raises(ValueError):
            station.save_settings(bad)
    assert station.settings["interval_min"] == 30


def test_capture_connects_reads_and_disconnects_without_uploading(station):
    last = station.capture([3])
    assert last["tanks"]["3"]["confidence"] == "high" and station.db.writes == []
    assert len(FakeSession.opened) == 1 and FakeSession.opened[0].closed
    assert station.upload_last([3])[3]["ok"] and station.db.writes[0]["tank_id"] == "T3"
    assert station.last["uploads"]["3"]["ok"]


def test_send_for_decantation_uploads_and_ends_live_monitoring(station):
    station.start_live({"tanks": [3], "auto_upload": False})
    assert wait_for(lambda: station.live and station.live["reads"] == 1)
    session = FakeSession.opened[0]
    station.capture([3], decantation=True)
    assert station.db.writes[-1]["tank_id"] == "T3"
    assert len(FakeSession.opened) == 1                         # read from the open session
    assert wait_for(lambda: station.live is None) and session.closed
    assert station.live_last["reason"] == "sent for decantation"
    assert station.alerts == [] and station.photos == []        # you ended it: no message


def test_live_monitoring_keeps_one_session_until_anydesk_ends_it(station):
    station.start_live({"tanks": [3], "interval_min": 1})
    assert wait_for(lambda: station.live and station.live["reads"] == 1)
    assert station.db.writes[-1]["tank_id"] == "T3"            # auto-upload on
    session = FakeSession.opened[0]
    session.is_alive = False                                    # AnyDesk closes it
    assert wait_for(lambda: station.live is None) and session.closed
    assert len(FakeSession.opened) == 1
    assert station.live_last["reason"] == "AnyDesk ended the session"
    png, caption = station.photos[-1]
    assert png == b"\x89PNG-ended" and "ended after" in caption and "(1 read)" in caption


def test_stop_ends_live_monitoring_quietly(station):
    station.start_live({"tanks": [3]})
    assert wait_for(lambda: station.live and station.live["reads"] == 1)
    station.stop_live()
    assert wait_for(lambda: station.live is None)
    assert station.live_last["reason"] == "stopped by you" and station.photos == []
    with pytest.raises(RuntimeError):
        station.start_live() if station.live else (station.start_live(), station.start_live())
    station.stop_live()
    assert wait_for(lambda: station.live is None)


def test_live_monitoring_that_cannot_connect_says_so(station):
    FakeSession.fail = True
    station.start_live({"tanks": [3]})
    assert wait_for(lambda: station.live is None)
    assert "opened a session" in station.live_last["reason"] and "opened a session" in station.alerts[-1]


def test_a_watched_tank_missing_from_the_live_screen_is_reported_once(station):
    station.start_live({"tanks": [1, 3], "interval_min": 1})
    assert wait_for(lambda: station.live and station.live["reads"] == 1)
    station._live_read(station.live)                            # the next scheduled read
    assert station.live["reads"] == 2
    assert len([a for a in station.alerts if "Tank 1" in a]) == 1
    station.stop_live()
    assert wait_for(lambda: station.live is None)


def test_without_the_login_a_capture_says_how_to_add_it(station):
    (station.home / "login.json").unlink()
    with pytest.raises(service.CaptureError, match="save-login"):
        station.capture([1])


def test_a_github_job_during_live_monitoring_is_answered_from_the_session(station, tmp_path, monkeypatch):
    queue = tmp_path / "queue"
    monkeypatch.setattr(service, "QUEUE", queue)
    station.start_live({"tanks": [3]})
    assert wait_for(lambda: station.live and station.live["reads"] == 1)
    stop = threading.Event()
    threading.Thread(target=station.queue_loop, args=(stop,), daemon=True).start()
    assert wait_for(lambda: queue.is_dir())
    (queue / "job.env").write_text("{}")
    (queue / "job.req").write_text(str(tmp_path))
    assert wait_for(lambda: (queue / "job.rc").exists(), timeout=10)
    stop.set()
    assert (queue / "job.rc").read_text().strip() == "0" and not (queue / "job.env").exists()
    assert "from the open live session" in (queue / "job.log").read_text()
    assert len(FakeSession.opened) == 1
    station.stop_live()
    assert wait_for(lambda: station.live is None)


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
        assert post("/api/settings", {"interval_min": 0}, srv.csrf) == 400
        assert post("/api/live/stop", {}, srv.csrf) == 200
        req = urllib.request.Request(f"{base}/api/state", headers={"Host": "elsewhere.example"})
        with pytest.raises(urllib.error.HTTPError) as err:
            urllib.request.urlopen(req)
        assert err.value.code == 403
    finally:
        srv.shutdown()
        srv.server_close()
