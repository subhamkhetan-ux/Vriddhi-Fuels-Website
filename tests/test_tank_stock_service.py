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
    """The decant project: dec_tank_state, dec_shots and the dec-shots bucket."""

    def __init__(self, rows=None):
        self.rows, self.writes = dict(rows or {}), []
        self.shots, self.files = [], {}

    def http(self, method, path, data, headers, timeout=30):
        if path.startswith("rest/v1/"):
            return self(method, path[len("rest/v1/"):], json.loads(data) if data else None,
                        headers.get("Prefer", ""))
        assert path.startswith("storage/v1/object/dec-shots")
        if method == "POST":
            self.files[path.split("dec-shots/", 1)[1]] = (data, headers["Content-Type"])
        else:
            for p in json.loads(data)["prefixes"]:
                self.files.pop(p, None)

    def __call__(self, method, path, body=None, prefer="", timeout=30):
        if path.startswith("dec_config"):
            return []
        if path.startswith("dec_shots"):
            if method == "POST":
                self.shots.extend(body)
                return None
            day = path.split("day=lt.")[1].split("&")[0]
            old = [r for r in self.shots if r["day"] < day]
            if method == "DELETE":
                self.shots = [r for r in self.shots if r["day"] >= day]
            return [{"id": r["id"], "path": r["path"]} for r in old]
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
    monkeypatch.setattr(decant, "_http", db.http)
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
    monkeypatch.setattr(decant, "_http", db.http)
    monkeypatch.setattr(service.cards_mod, "picture", lambda png, boxes, tanks, **kw: b"\x89PNG-cards")
    monkeypatch.setattr(service.cards_mod, "to_jpeg", lambda png: b"\xff\xd8" + png)
    monkeypatch.setattr(service.cards_mod, "read_all",
                        lambda png: ({3: (959, 343, 1284, 677)}, {3: dict(CARD3)}))
    monkeypatch.setattr(service, "CHECK_EVERY", 0.01)
    # live reads: the screen "changes" when screen["fp"] does; each quick read is counted
    screen = {"fp": "a", "card": dict(CARD3), "reads": 0}
    monkeypatch.setattr(service.cards_mod, "Pixels", lambda png: type("P", (), {"ok": True})())
    monkeypatch.setattr(service.cards_mod, "fingerprint", lambda px, box: screen["fp"])

    def read_figures(png, box):
        screen["reads"] += 1
        return dict(screen["card"])
    monkeypatch.setattr(service.cards_mod, "read_figures", read_figures)
    FakeSession.opened, FakeSession.fail = [], False
    (tmp_path / "login.json").write_text(json.dumps({"ids": ["123456789"], "password": "pw"}))
    alerts, photos = [], []
    st = service.Station(home=tmp_path, session_cls=FakeSession, notify=alerts.append,
                         notify_photo=lambda png, caption: photos.append((png, caption)) or True)
    st.db, st.alerts, st.photos, st.screen = db, alerts, photos, screen
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
    assert station.settings == service.DEFAULTS                 # 10 s, all tanks, figures to decant
    assert station.save_settings({"interval_s": "30", "tanks": [3, 1]})["tanks"] == [1, 3]
    for bad in ({"interval_s": 4}, {"interval_s": 3601}, {"tanks": []}, {"tanks": [5]}, {"interval_s": "x"}):
        with pytest.raises(ValueError):
            station.save_settings(bad)
    assert station.settings["interval_s"] == 30
    assert station.save_settings({"interval_s": 5})["interval_s"] == 5           # as often as every 5 s


def test_capture_connects_reads_and_disconnects_without_uploading(station):
    last = station.capture([3])
    assert last["tanks"]["3"]["confidence"] == "high" and station.db.writes == []
    assert len(FakeSession.opened) == 1 and FakeSession.opened[0].closed
    assert station.upload_last([3])[3]["ok"] and station.db.writes[0]["tank_id"] == "T3"
    assert station.last["uploads"]["3"]["ok"] and "mark" not in station.last["uploads"]["3"]
    # the zoomed card goes with it, for the app's result pictures on any phone
    (shot,) = station.db.shots
    assert shot["source"] == "agent" and shot["readings"] == {
        "T3": {"readingAt": "2026-10-13T18:01:54+05:30", "volume": 19552.05}}
    assert station.db.files[shot["path"]] == (b"\xff\xd8\x89PNG-cards", "image/jpeg")
    assert shot["path"].startswith(shot["day"] + "/") and station.last["proof"]["ok"]


def test_earlier_days_proof_pictures_are_dropped(station):
    station.db.shots.append({"id": "old", "day": "2000-01-01", "path": "2000-01-01/old.jpg", "readings": {}})
    station.db.files["2000-01-01/old.jpg"] = (b"x", "image/jpeg")
    station.capture([3], upload=True)
    assert "old" not in [s["id"] for s in station.db.shots]
    assert "2000-01-01/old.jpg" not in station.db.files and len(station.db.files) == 1


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
    station.start_live({"tanks": [3]})
    assert wait_for(lambda: station.live and station.live["reads"] == 1)
    assert station.db.writes[-1]["tank_id"] == "T3"            # the figures, as they come
    assert station.db.shots == [] and station.db.files == {}   # no pictures while live
    assert station.live["figures"]["3"]["reading"] == {"volume": 19552.05}
    sent = station.db.writes[-1]["reading"]                     # the volume alone to decant
    assert sent["volume"] == 19552.05 and sent["ullage"] == 447.95
    assert all(sent[k] is None for k in ("height", "dip", "temp", "density", "densityTc", "water"))
    session = FakeSession.opened[0]
    session.is_alive = False                                    # AnyDesk closes it
    assert wait_for(lambda: station.live is None) and session.closed
    assert len(FakeSession.opened) == 1
    assert station.live_last["reason"] == "AnyDesk ended the session"
    png, caption = station.photos[-1]
    assert png == b"\x89PNG-ended" and "ended after" in caption and "(1 read)" in caption
    # the last screen read is now a capture, with its pictures to save or upload
    assert station.last["why"] == "live" and station.last["tanks"]["3"]["confidence"] == "high"


def decant_dip_at(litres):
    """The dip (cm) where the app's chart reaches these litres."""
    chart = decant.dip_chart()
    i = next(i for i, v in enumerate(chart["litres"]) if v >= litres)
    return chart["startCm"] + i * chart["stepCm"]


def test_an_unchanged_card_is_not_read_again_and_a_change_is_shown(station):
    station.start_live({"tanks": [3], "auto_upload": False})
    assert wait_for(lambda: station.live and station.live["reads"] == 1)
    live = station.live
    for _ in range(3):
        station._live_read(live)                                # the screen didn't change
    assert station.screen["reads"] == 1 and live["reads"] == 4
    height_cm = decant_dip_at(19000.0)
    station.screen.update(fp="b", card={**CARD3, "volume": 19000.0, "ullage": 1000.0, "height": round(height_cm * 10, 2),
                                        "time": ("10", "13", "2026", "18", "05", "00")})
    station._live_read(live)
    assert station.screen["reads"] == 2 and live["figures"]["3"]["reading"]["volume"] == 19000.0
    assert station.db.writes == []                              # figures to decant were off
    station.stop_live()
    assert wait_for(lambda: station.live is None)
    assert "log" not in station.live_last and not (station.home / "live-log.csv").exists()   # no change log kept


def test_a_live_read_that_fails_the_checks_is_shown_not_sent_and_read_again(station):
    station.screen["card"] = {**CARD3, "volume": 19000.0}       # volume + ullage don't add up
    station.start_live({"tanks": [3]})
    assert wait_for(lambda: station.live and station.live["figures"].get("3"))
    live = station.live
    assert live["figures"]["3"]["confidence"] == "low" and station.db.writes == []
    station._live_read(live)
    assert station.screen["reads"] >= 2                         # not taken as read
    station.stop_live()
    assert wait_for(lambda: station.live is None)


def test_stop_ends_live_monitoring_quietly_with_the_last_pictures(station):
    station.start_live({"tanks": [3]})
    assert wait_for(lambda: station.live and station.live["reads"] == 1)
    station.stop_live()
    assert wait_for(lambda: station.live is None)
    assert station.live_last["reason"] == "stopped by you" and station.photos == []
    assert station.last["why"] == "live" and "3" in station.last["tanks"]
    assert station.picture([3])                                  # the Save image button
    with pytest.raises(RuntimeError):
        station.start_live() if station.live else (station.start_live(), station.start_live())
    station.stop_live()
    assert wait_for(lambda: station.live is None)


def test_live_monitoring_that_cannot_connect_says_so(station):
    FakeSession.fail = True
    station.start_live({"tanks": [3]})
    assert wait_for(lambda: station.live is None)
    assert "opened a session" in station.live_last["reason"] and "opened a session" in station.alerts[-1]


def test_reads_never_take_more_than_half_the_time(station, monkeypatch):
    station.start_live({"tanks": [3], "interval_s": 10})
    assert wait_for(lambda: station.live and station.live.get("next_read"))
    live = station.live
    assert live["read_s"] < 10
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
        assert state["login_saved"] and state["settings"]["interval_s"] == 10
        page = urllib.request.urlopen(f"{base}/").read()
        assert srv.csrf.encode() in page and b"__CSRF__" not in page

        def post(path, body, token):
            req = urllib.request.Request(f"{base}{path}", data=json.dumps(body).encode(), method="POST",
                                         headers={"Content-Type": "application/json", "X-TS-CSRF": token})
            try:
                return urllib.request.urlopen(req).status
            except urllib.error.HTTPError as exc:
                return exc.code
        assert post("/api/settings", {"interval_s": 20}, "wrong") == 403
        assert post("/api/settings", {"interval_s": 20}, srv.csrf) == 200
        assert post("/api/settings", {"interval_s": 0}, srv.csrf) == 400
        assert post("/api/live/stop", {}, srv.csrf) == 200
        req = urllib.request.Request(f"{base}/api/state", headers={"Host": "elsewhere.example"})
        with pytest.raises(urllib.error.HTTPError) as err:
            urllib.request.urlopen(req)
        assert err.value.code == 403
    finally:
        srv.shutdown()
        srv.server_close()


def test_each_anydesk_session_is_kept_with_how_long_it_lasted(station):
    station.start_live({"tanks": [3]})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    FakeSession.opened[0].is_alive = False                      # AnyDesk ends it
    assert wait_for(lambda: station.live is None)
    station.start_live({"tanks": [3]})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    station.stop_live()
    assert wait_for(lambda: station.live is None)
    s = station.view()["sessions"]
    assert [r["by"] for r in s["recent"]] == ["you", "anydesk"]           # newest first
    assert all(r["lasted_s"] is not None and r["connected"] for r in s["recent"])
    assert s["anydesk"]["count"] == 1                                     # only AnyDesk's own endings count
    assert "The AnyDesk session lasted" in station.photos[-1][1]


def test_with_reconnect_on_it_connects_again_when_anydesk_ends_the_session(station, monkeypatch):
    monkeypatch.setattr(service, "RECONNECT_AFTER", 0.05)
    station.start_live({"tanks": [3], "reconnect": True})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    first = station.live
    FakeSession.opened[0].is_alive = False
    assert wait_for(lambda: station.live is not None and station.live is not first and station.live.get("state") == "live")
    assert len(FakeSession.opened) == 2 and "Connecting again" in station.photos[-1][1]
    assert station.settings["reconnect"] is True and station.live["by_auto"] is False
    station.stop_live()                                                    # you stop it: it stays stopped
    assert wait_for(lambda: station.live is None)
    import time as _t
    _t.sleep(0.3)
    assert station.live is None


def test_reconnecting_stops_after_many_short_sessions_in_a_row(station, monkeypatch):
    monkeypatch.setattr(service, "RECONNECT_RUN", 2)
    station.save_settings({"reconnect": True})
    started = []
    monkeypatch.setattr(service.threading, "Timer", lambda secs, fn: type("T", (), {"start": lambda self: started.append(fn)})())
    short = {"by": "anydesk", "lasted_s": 30}
    assert station._reconnect_later(short) and station._reconnect_later(short)
    assert not station._reconnect_later(short)                            # the third: it gives up and says so
    assert "stopped connecting again" in station.alerts[-1] and len(started) == 2
    assert station._reconnect_later({"by": "anydesk", "lasted_s": 3600})   # a long one starts the count again
    assert not station._reconnect_later({"by": "you", "lasted_s": 3600})   # never after you stopped it


def test_no_tank_cards_shows_the_whole_screen_and_tells_the_bot_once(station, monkeypatch):
    monkeypatch.setattr(service.cards_mod, "read_all", lambda png: ({}, {}))
    station.capture([1, 2])
    assert station.last["tanks"] == {}
    assert station.photos and "no tank cards" in station.photos[-1][1]
    assert station.picture([], full=True) == b"\x89PNG"                    # the whole screen, as taken
    station.capture([1])
    assert len(station.photos) == 1                                        # not again within 10 min


def test_a_session_anydesk_dropped_but_kept_open_ends_live_monitoring(station, monkeypatch):
    station.start_live({"tanks": [3]})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    FakeSession.ended = lambda self, png: "client offline"                 # the window shows AnyDesk's message
    monkeypatch.setattr(service.cards_mod, "fingerprint", lambda px, box: "changed")
    monkeypatch.setattr(service.cards_mod, "read_figures", lambda png, box: {"no": 3})   # no card readable
    try:
        station._live_read(station.live)                                    # (the next read, now)
        assert wait_for(lambda: station.live is None, timeout=10)
    finally:
        del FakeSession.ended
    assert station.live_last["reason"] == "AnyDesk ended the session (it shows “client offline”)"
    assert station.view()["sessions"]["recent"][0]["by"] == "anydesk"
