"""Tank stock monitor, phone page API, card parsing and the decant upload (fakes only)."""
import json
import time
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
            if method == "DELETE" and "id=in.(" in path:
                ids = path.split("id=in.(")[1].rstrip(")").split(",")
                self.shots = [r for r in self.shots if r["id"] not in ids]
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
    assert again[3]["mark"] == {"readingAt": "2026-10-13T18:01:54+05:30", "volume": 19552.05}   # its picture still goes


def test_a_full_read_of_a_reading_live_monitoring_sent_fills_in_its_figures(monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(decant, "_rest", db)
    monkeypatch.setattr(decant, "_http", db.http)
    decant.upload({3: CARD3}, [3], CFG, only_volume=True)                   # live monitoring: the volume alone
    assert db.rows["T3"]["height"] is None
    again = decant.upload({3: CARD3}, [3], CFG, only_volume=True)          # live again: nothing to do
    assert again[3]["message"] == "already in the app" and len(db.writes) == 1
    full = decant.upload({3: CARD3}, [3], CFG)                              # a full read (stock before / after)
    assert full[3]["ok"] and full[3]["mark"]["volume"] == 19552.05
    assert db.rows["T3"]["height"] == CARD3["height"] and db.rows["T3"]["volume"] == 19552.05
    assert db.rows["T3"]["readingAt"] == full[3]["mark"]["readingAt"]      # the same reading, its picture matches


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
    yesterday = decant.ist_day(service.datetime.now(service.timezone.utc) - service.timedelta(days=1))
    station.db.shots.append({"id": "yday", "day": yesterday, "path": f"{yesterday}/yday.jpg", "readings": {}})
    station.db.files[f"{yesterday}/yday.jpg"] = (b"y", "image/jpeg")
    station.capture([3], upload=True)
    assert "old" not in [s["id"] for s in station.db.shots]
    assert "2000-01-01/old.jpg" not in station.db.files
    # yesterday's stay: a decantation that ran past midnight still has its stock before's
    assert "yday" in [s["id"] for s in station.db.shots] and len(station.db.files) == 2


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
    assert station.live["figures"]["3"]["reading"]["volume"] == 19552.05
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
    with pytest.raises(service.CaptureError, match="FuelTrans login isn't saved here yet: run infra/fueltrans/tank-stock-setup.sh"):
        station.capture([1])
    (station.home / "login.json").write_text(json.dumps({"ids": ["123456789"]}))     # AnyDesk's, half saved
    with pytest.raises(service.CaptureError, match="vm-setup.sh again with ASK_AGAIN=1"):
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
    assert "The session lasted" in station.photos[-1][1] and "server's screen showed" in station.photos[-1][1]


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


def test_tanks_missing_from_the_screen_are_told_to_the_bot_with_the_screen(station, monkeypatch):
    monkeypatch.setattr(service.cards_mod, "read_all",
                        lambda png: ({3: (0, 0, 9, 9)}, {3: {"product": "HSD", "volume": 1.0}}))
    station.capture([1, 3])
    assert "3" in station.last["tanks"] and "1" not in station.last["tanks"]
    assert station.photos and "Tank 1 not found" in station.photos[-1][1]


def test_live_monitoring_nobody_watches_and_that_sends_nothing_ends_by_itself(station, monkeypatch):
    monkeypatch.setattr(service, "UNWATCHED_STOP", 0)
    station.seen_at = 0                                                     # the page has been closed
    station.start_live({"tanks": [3], "auto_upload": True})                # sending to the decant app: kept
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    time.sleep(0.05)
    assert station.live and not station._unwatched(station.live)
    station.stop_live()
    assert wait_for(lambda: station.live is None)
    station.start_live({"tanks": [3], "auto_upload": False})               # nothing sent: it ends
    assert wait_for(lambda: station.live is None)
    assert FakeSession.opened[-1].closed
    assert station.live_last["reason"].startswith("nobody had the page open")
    assert station.view()["sessions"]["recent"][0]["by"] == "agent"


def test_the_page_in_front_of_someone_keeps_live_monitoring_on(station, monkeypatch):
    monkeypatch.setattr(service, "UNWATCHED_STOP", 60)
    station.seen_at = time.time()
    live = {"since": service.now_iso(), "auto_upload": False}
    assert not station._unwatched(live)
    station.seen_at = time.time() - 120
    live["since"] = (service.datetime.now(service.IST) - service.timedelta(seconds=120)).isoformat()
    assert station._unwatched(live)


def test_stock_for_a_decantation_gets_its_picture_although_live_monitoring_sent_it(station):
    station.start_live({"tanks": [3], "auto_upload": True})                  # live: sends the volume alone
    assert wait_for(lambda: station.live and station.live["reads"] >= 1 and station.db.writes)
    assert station.db.shots == [] and station.db.files == {}                 # live monitoring: no pictures
    station.capture([3], decantation=True)                                   # the stock for the decantation
    (shot,) = station.db.shots
    reading = station.db.rows["T3"]
    assert shot["readings"] == {"T3": {"readingAt": reading["readingAt"], "volume": reading["volume"]}}
    assert reading["height"] is not None                                     # its full figures too
    assert station.last["proof"]["ok"]
    assert wait_for(lambda: station.live is None)


def test_the_card_clock_print_follows_the_last_updated_row_not_the_volume():
    from types import SimpleNamespace
    w, h, box = 50, 100, (0, 0, 50, 100)
    def px(time_px=0, volume_px=0):
        raw = bytearray(w * h * 3)
        raw[(40 * w + 5) * 3] = time_px              # row 40: "Last Updated" (36%..50% of the card)
        raw[(60 * w + 5) * 3] = volume_px            # row 60: the volume rows
        return SimpleNamespace(width=w, height=h, raw=bytes(raw))
    base = cards.clock_print(px(), box)
    assert cards.clock_print(px(time_px=9), box) != base             # the time ticked
    assert cards.clock_print(px(volume_px=9), box) == base           # only the stock changed
    assert cards.fingerprint(px(time_px=9), box) == cards.fingerprint(px(), box)   # (and the other way round)


def test_the_live_view_says_which_cards_are_frozen(station, monkeypatch):
    monkeypatch.setattr(service.cards_mod, "clock_print", lambda px, box: "same")
    station.start_live({"tanks": [3], "auto_upload": False})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    station.live["ticks"][3]["t"] -= service.PROBE_STALE_S + 1
    view = station.live_view()
    assert view["probes"]["3"]["frozen"] is True and "ticks" not in view
    station.stop_live()
    assert wait_for(lambda: station.live is None)


def test_a_live_volume_the_decant_app_couldnt_take_is_sent_again_once_it_answers(station, monkeypatch):
    monkeypatch.setattr(service, "LIVE_UPLOAD_BACKOFF", 0)
    real, down = decant._rest, {"on": True}

    def rest(method, path, body=None, prefer="", timeout=30):
        if down["on"] and path.startswith("dec_tank_state"):
            raise decant.DecantError("The decant database could not be reached (TimeoutError).")
        return real(method, path, body, prefer, timeout)
    monkeypatch.setattr(decant, "_rest", rest)
    station.start_live({"tanks": [3], "auto_upload": True})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    live = station.live
    assert "sent again when it answers" in live["uploads"]["3"]["message"] and 3 in live["pending"]
    assert station.db.writes == []
    warned = [m for m in station.alerts if "could not be reached" in m]
    station._live_read(live)                                   # still down: the same card isn't read again ...
    assert [m for m in station.alerts if "could not be reached" in m] == warned   # ... nor told again
    down["on"] = False
    station._live_read(live)                                   # the same screen: nothing changed on it
    assert station.db.writes and station.db.writes[-1]["tank_id"] == "T3"        # but the volume went
    assert live["pending"] == {} and live["uploads"]["3"]["ok"]
    assert any("answers again" in m for m in station.alerts)
    station.stop_live()
    assert wait_for(lambda: station.live is None)


# ---- edge cases -------------------------------------------------------------

def test_a_reading_time_misread_into_the_future_counts_as_not_read():
    seen = "2026-10-13T12:40:00.000Z"                          # 18:10 IST: when the screen was taken
    card = {**CARD3, "seenAt": seen, "time": ("10", "13", "2026", "19", "01", "54")}   # 19:01 read for 18:01
    r = decant.make_reading(card, decant.tank_for(3, CFG), CFG)["reading"]
    assert r["timeRead"] is False and r["readingAt"] == seen    # else nothing could ever replace it
    ok = decant.make_reading({**CARD3, "seenAt": seen}, decant.tank_for(3, CFG), CFG)["reading"]
    assert ok["timeRead"] and ok["readingAt"] == "2026-10-13T18:01:54+05:30"


def test_a_card_without_its_time_is_stamped_when_the_screen_was_taken(station, monkeypatch):
    monkeypatch.setattr(service.cards_mod, "read_all",
                        lambda png: ({3: (959, 343, 1284, 677)}, {3: {**CARD3, "time": None}}))
    station.capture([3])
    seen = json.loads((station.home / "cards.json").read_text())["3"]["seenAt"]
    time.sleep(0.01)
    station.upload_last([3])                                    # sent later: still the capture's time
    assert station.db.writes[-1]["reading"]["readingAt"] == seen


def test_live_telegram_says_the_app_is_down_once_and_a_tanks_problem_once(station, monkeypatch):
    monkeypatch.setattr(service, "LIVE_UPLOAD_BACKOFF", 0)
    real, down = decant._rest, {"on": True}

    def rest(method, path, body=None, prefer="", timeout=30):
        if down["on"] and path.startswith("dec_tank_state"):
            raise decant.DecantError("The decant database could not be reached (TimeoutError).")
        return real(method, path, body, prefer, timeout)
    monkeypatch.setattr(decant, "_rest", rest)
    station.start_live({"tanks": [3], "auto_upload": True})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    live = station.live
    for fp in "bcd":                                            # new figures every read, still down
        station.screen["fp"] = fp
        station._live_read(live)
    assert len([m for m in station.alerts if "could not be reached" in m]) == 1
    down["on"] = False
    station.db.rows["T3"] = {"readingAt": "2027-01-01T00:00:00+05:30", "volume": 1}   # the app has a newer one
    for fp in "efg":
        station.screen["fp"] = fp
        station._live_read(live)
    assert len([m for m in station.alerts if "newer reading" in m]) == 1
    station.stop_live()
    assert wait_for(lambda: station.live is None)


def test_without_the_apps_settings_nothing_is_saved_under_a_guessed_tank(station, monkeypatch):
    def broken():
        raise decant.DecantError("The decant database could not be reached (URLError).")
    monkeypatch.setattr(decant, "settings", broken)
    last = station.capture([3], upload=True)
    assert station.db.writes == [] and "settings couldn't be read" in last["uploads"]["3"]["message"]
    assert station.upload_last([3])[3]["ok"] is False and station.db.writes == []


def test_the_apps_settings_last_read_are_used_while_it_cant_be_reached(station, monkeypatch):
    station.capture([3])                                        # read them once
    def broken():
        raise decant.DecantError("The decant database could not be reached (URLError).")
    monkeypatch.setattr(decant, "settings", broken)
    monkeypatch.setattr(decant, "_rest", station.db)
    assert station.upload_last([3])[3]["ok"]


def test_a_capture_during_live_monitoring_waits_its_turn_not_refused(station):
    station.start_live({"tanks": [3], "auto_upload": False})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    station.busy.acquire()                                       # a live read is going on
    try:
        srv = service.make_server(station, 0)
        srv.port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        req = urllib.request.Request(f"http://127.0.0.1:{srv.port}/api/capture", data=b'{"tanks":[3]}', method="POST",
                                     headers={"X-TS-CSRF": srv.csrf, "Host": f"127.0.0.1:{srv.port}"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            assert resp.status == 202
    finally:
        station.busy.release()
    assert wait_for(lambda: station.last.get("why") == "phone" and station.last.get("tanks"))
    assert len(FakeSession.opened) == 1                          # from the open session, not a second one
    srv.shutdown()
    station.stop_live()
    assert wait_for(lambda: station.live is None)


def test_a_capture_that_fails_says_why_on_the_page(station, monkeypatch):
    monkeypatch.setattr(service.cards_mod, "read_all", lambda png: (_ for _ in ()).throw(KeyError("x")))
    with pytest.raises(KeyError):
        station.capture([3])
    assert "KeyError" in station.last["error"]


def test_two_starts_at_once_open_one_live_session(station):
    errors = []

    def go():
        try:
            station.start_live({"tanks": [3]})
        except RuntimeError as exc:
            errors.append(str(exc))
    threads = [threading.Thread(target=go) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(errors) == 3
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    station.stop_live()
    assert wait_for(lambda: station.live is None) and len(FakeSession.opened) == 1


def test_an_agent_save_goes_only_over_the_version_it_looked_at(monkeypatch):
    calls = []

    def rest(method, path, body=None, prefer="", timeout=30):
        calls.append((method, path, prefer))
        return [] if "updated_at=eq." in path and "OLD" in path else [{"id": "S1"}]
    monkeypatch.setattr(decant, "_rest", rest)
    s = {"id": "S1", "status": "decanting", "data": {}, "updated_at": "x"}
    assert decant.save_session(dict(s), base="OLD") is None              # a phone saved since: theirs stays
    assert calls[-1][0] == "PATCH" and "return=representation" in calls[-1][2]
    saved = decant.save_session(dict(s), base="2026-10-21T08:00:00+00:00")
    assert saved and saved["updated_at"] != "x" and "updated_at=eq.2026-10-21T08%3A00%3A00%2B00%3A00" in calls[-1][1]
    assert decant.save_session(dict(s))["created_at"] and calls[-1][0] == "POST"            # a new one: as before


def test_an_unreachable_decant_app_says_why_and_a_read_is_tried_again(monkeypatch):
    import ssl
    import urllib.error
    monkeypatch.setattr(decant, "cloud", lambda: ("https://proj.supabase.co", "key"))
    monkeypatch.setattr(decant.time, "sleep", lambda s: None)
    calls = {"n": 0}

    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"[]"

    def flaky(req, timeout):
        calls["n"] += 1
        if calls["n"] < 3:
            raise urllib.error.URLError(OSError(-3, "Temporary failure in name resolution"))
        return Resp()
    monkeypatch.setattr(decant.urllib.request, "urlopen", flaky)
    assert decant._rest("GET", "dec_tank_state?select=tank_id") == [] and calls["n"] == 3   # two blips: fine

    def down(req, timeout):
        raise urllib.error.URLError(ssl.SSLCertVerificationError(
            "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: certificate is not yet valid"))
    monkeypatch.setattr(decant.urllib.request, "urlopen", down)
    with pytest.raises(decant.DecantError) as e:
        decant._rest("GET", "dec_tank_state")
    msg = str(e.value)
    assert "not yet valid" in msg and "clock" in msg and "timedatectl" in msg
    assert "proj.supabase.co" not in msg and "key" not in msg.replace("keyword", "")
    calls["n"] = 0
    monkeypatch.setattr(decant.urllib.request, "urlopen", flaky)
    with pytest.raises(decant.DecantError) as e:                     # a write: never sent twice
        decant._rest("POST", "dec_tank_state?on_conflict=tank_id", [{}])
    assert calls["n"] == 1 and "can't look its name up" in str(e.value)


def test_a_full_disk_at_the_end_of_live_monitoring_still_frees_the_pc(station, monkeypatch):
    station.start_live({"tanks": [3], "auto_upload": False})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    real = service._write_json

    def full(path, data, **kw):
        if path.name == "live.json":
            raise OSError(28, "No space left on device")
        return real(path, data, **kw)
    monkeypatch.setattr(service, "_write_json", full)
    station.stop_live()
    assert wait_for(lambda: station.live is None)       # not stuck "ending" for good
    monkeypatch.setattr(service, "_write_json", real)
    station.start_live({"tanks": [3], "auto_upload": False})   # and it can start again
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    station.stop_live()
    assert wait_for(lambda: station.live is None)


def test_a_state_file_is_written_whole_or_not_at_all(tmp_path, monkeypatch):
    path = tmp_path / "x.json"
    service._write_json(path, {"a": 1}, keep_copy=True)
    service._write_json(path, {"a": 2}, keep_copy=True)
    assert json.loads(path.read_text()) == {"a": 2} and json.loads((tmp_path / "x.json.bak").read_text()) == {"a": 1}

    def boom(*a, **k):
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(service.json, "dump", boom)
    with pytest.raises(OSError):
        service._write_json(path, {"a": 3})
    assert json.loads(path.read_text()) == {"a": 2}                 # the old one as it was
    assert not list(tmp_path.glob(".*.tmp"))                        # no leftover
    path.write_text("{bad")
    data, note = service._read_json_safe(path, {})
    assert data == {"a": 1} and "damaged" in note


def test_the_page_api_always_answers(station):
    srv = service.make_server(station, 0)
    srv.port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    import http.client
    c = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=5)
    c.request("POST", "/api/settings", body=b"", headers={"X-TS-CSRF": srv.csrf, "Host": f"127.0.0.1:{srv.port}",
                                                         "Content-Length": "-5"})
    assert c.getresponse().status == 400                        # not a read that waits for ever
    c.close()
    station.save_settings = lambda body: (_ for _ in ()).throw(OSError(28, "No space left on device"))
    req = urllib.request.Request(f"http://127.0.0.1:{srv.port}/api/settings", data=b"{}", method="POST",
                                 headers={"X-TS-CSRF": srv.csrf, "Host": f"127.0.0.1:{srv.port}"})
    try:
        urllib.request.urlopen(req, timeout=5)
        raise AssertionError("expected 500")
    except urllib.error.HTTPError as exc:
        assert exc.code == 500 and "disk is full" in json.loads(exc.read())["error"]
    srv.shutdown()


def test_the_decant_app_saying_no_is_told_apart_and_a_strange_answer_isnt_no_rows(monkeypatch):
    import io
    import urllib.error
    monkeypatch.setattr(decant, "cloud", lambda: ("https://proj.supabase.co", "key"))

    def refuse(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {},
                                     io.BytesIO(b'{"code":"PGRST204","message":"Could not find the column"}'))
    monkeypatch.setattr(decant.urllib.request, "urlopen", refuse)
    with pytest.raises(decant.DecantError) as e:
        decant._rest("GET", "dec_sessions?id=eq.x")
    assert "refused (400: Could not find the column)" in str(e.value)

    class Html:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"<html>Sign in to the Wi-Fi</html>"
    monkeypatch.setattr(decant.urllib.request, "urlopen", lambda req, timeout: Html())
    with pytest.raises(decant.DecantError):
        decant.get_session("S1")                                    # never "None: deleted"


def test_a_volume_the_app_turned_away_for_now_is_sent_again(station, monkeypatch):
    monkeypatch.setattr(service, "LIVE_UPLOAD_BACKOFF", 0)
    real, busy = decant._rest, {"on": True}

    def rest(method, path, body=None, prefer="", timeout=30):
        if busy["on"] and path.startswith("dec_tank_state") and method == "POST":
            raise decant.DecantError("The decant database refused (429).")
        return real(method, path, body, prefer, timeout)
    monkeypatch.setattr(decant, "_rest", rest)
    station.start_live({"tanks": [3], "auto_upload": True})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    live = station.live
    assert 3 in live["pending"]                                     # kept (a steady card isn't read again)
    busy["on"] = False
    station._live_read(live)
    assert live["pending"] == {} and station.db.writes[-1]["tank_id"] == "T3"
    station.stop_live()
    assert wait_for(lambda: station.live is None)


def test_times_with_any_number_of_fraction_digits_are_read():
    from tank_stock import decantation as dz
    assert dz._ts("2026-10-21T08:00:00.12+00:00") == dz._ts("2026-10-21T08:00:00.120000+00:00")
    assert dz._ts("2026-10-21T08:00:00Z") and dz._ts("nonsense") is None




# ---- the decant app's Monitor page (phone.py) -----------------------------------

class Config:
    """dec_config as stock_requests / answer_stock_request see it."""

    def __init__(self):
        self.data, self.lose = {"settings": {"tanks": decant.DEFAULT_TANKS}}, 0

    def ask(self, kind, tanks=("T3",), rid="r1", **more):
        from tank_stock import decantation as dz
        slot = "stockMonitor" if kind == "monitor" else "stockRequest"
        self.data[slot] = {"id": rid, "kind": kind, "tanks": list(tanks), "at": dz.iso(), "by": "phone", **more}

    @property
    def req(self):
        return self.data.get("stockRequest")

    @property
    def mon(self):
        return self.data.get("stockMonitor")

    def stock_requests(self, timeout=10):
        return {k: self.data.get(k) for k in decant.STOCK_SLOTS}

    def answer_stock_request(self, rid, answer, slot="stockRequest", timeout=10):
        if self.lose:
            self.lose -= 1
            return False                                 # a phone saved the settings meanwhile
        if (self.data.get(slot) or {}).get("id") == rid:
            self.data[slot].update(answer, answeredAt="now")
        return True


@pytest.fixture
def phone(station, monkeypatch):
    c = Config()
    monkeypatch.setattr(decant, "stock_requests", c.stock_requests)
    monkeypatch.setattr(decant, "answer_stock_request", c.answer_stock_request)
    return c


def test_send_for_decantation_reads_saves_and_uploads_the_pictures_once(station, phone):
    phone.ask("check")
    station.phone.check()
    assert len(FakeSession.opened) == 1 and FakeSession.opened[0].closed      # connected for it, then closed
    assert station.db.writes[-1]["tank_id"] == "T3"                          # its full figures saved
    proof, image = station.db.shots                                          # its card, for the result picture,
    assert proof["readings"]["T3"]["volume"] == 19552.05                     # and the picture the page shows
    assert image["readings"] == {} and image["path"] in station.db.files
    req = phone.req
    assert req["state"] == "done" and req["results"]["T3"]["ok"] and req["picture"] is True
    assert req["image"] == image["path"] and req["figures"]["T3"]["volume"] == 19552.05
    assert req["figures"]["T3"]["confidence"] == "high" and req["capturedAt"] == station.last["at"]
    station.phone.check()
    assert len(FakeSession.opened) == 1 and len(station.db.shots) == 2       # answered: never read again


def test_capture_only_saves_nothing_until_upload(station, phone):
    phone.ask("capture", tanks=["T3"])
    station.phone.check()
    assert station.db.writes == [] and phone.req["state"] == "done"
    (image,) = station.db.shots                                              # just the picture to show
    assert image["readings"] == {} and phone.req["image"] == image["path"]
    assert phone.req["figures"]["T3"]["volume"] == 19552.05 and "results" not in phone.req
    phone.ask("upload", tanks=["T3"], rid="r2", of=phone.req["capturedAt"])  # "Upload these to decant"
    station.phone.check()
    assert station.db.writes[-1]["tank_id"] == "T3" and len(station.db.shots) == 2
    assert phone.req["state"] == "done" and phone.req["results"]["T3"]["ok"] and phone.req["picture"] is True
    assert len(FakeSession.opened) == 1                                      # the upload reads nothing again


def test_an_upload_of_an_older_capture_is_refused(station, phone):
    phone.ask("capture")
    station.phone.check()
    phone.ask("upload", rid="r2", of="2000-01-01T00:00:00+05:30")
    station.phone.check()
    assert phone.req["state"] == "error" and "another capture" in phone.req["message"]
    assert station.db.writes == []


def test_a_read_from_the_open_live_session_leaves_it_on(station, phone):
    station.start_live({"tanks": [3], "auto_upload": False})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    phone.ask("check")
    station.phone.check()
    assert len(FakeSession.opened) == 1 and station.db.shots and phone.req["state"] == "done"
    assert station.live and station.live["state"] == "live"
    station.stop_live()
    assert wait_for(lambda: station.live is None)


def test_an_answer_a_phones_save_lost_is_written_again(station, phone):
    phone.ask("check")
    phone.lose = 1
    station.phone.check()
    assert "state" not in phone.req
    station.phone.check()
    assert phone.req["state"] == "done" and len(FakeSession.opened) == 1


def test_monitoring_the_picked_tanks_at_their_interval_until_stopped(station, phone, monkeypatch):
    monkeypatch.setattr(service, "UNWATCHED_STOP", 0)
    station.save_settings({"tanks": [1], "auto_upload": False, "interval_s": 60})
    station.seen_at = 0                                                      # the page is closed
    phone.ask("monitor", every=30)
    station.phone.check()
    assert wait_for(lambda: station.live and station.live["reads"] >= 1 and station.db.writes)
    live = station.live
    assert station.db.writes[-1]["tank_id"] == "T3"                          # its tank's volume, as it comes
    assert not live["by_auto"] and not station._unwatched(live)              # kept on for the phone
    assert station.live_view()["every_s"] == 30 and station.live_view()["sending"] == [3]
    assert station.settings["tanks"] == [1] and not station.settings["auto_upload"]   # your settings stay
    assert phone.mon["state"] == "monitoring" and phone.mon["until"] and phone.mon["every"] == 30
    phone.ask("capture", rid="r2")                                           # a capture meanwhile
    station.phone.check()
    assert phone.req["state"] == "done" and station.phone.watched() == {3}   # doesn't stop the monitoring
    phone.data["stockMonitor"] = None                                        # "Stop"
    station.phone.check()
    assert wait_for(lambda: station.live is None)
    assert station.live_last["reason"] == "the decant app's monitoring ended"


def test_monitoring_on_your_own_live_session_leaves_it_on(station, phone):
    station.start_live({"tanks": [3], "auto_upload": False})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    live = station.live
    phone.ask("monitor", every=1)
    station.phone.check()
    assert station.phone.watched() == {3} and len(FakeSession.opened) == 1    # the open session is used
    assert station.phone.watch["every"] == 5                                  # (5 s at the least, as the page)
    phone.ask("monitor", rid="r2")                                           # asked anew: the old one ends
    phone.data["stockMonitor"] = None
    station.phone.check()
    assert not station.phone.active() and station.live is live              # yours: still on
    station.stop_live()
    assert wait_for(lambda: station.live is None)


def test_monitoring_ends_after_its_time(station, phone, monkeypatch):
    from tank_stock import phone as phone_mod
    monkeypatch.setattr(phone_mod, "MONITOR_MAX_S", 0)
    phone.ask("monitor")
    station.phone.check()
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    station.phone.check()
    assert phone.mon["state"] == "ended" and "stopped after" in phone.mon["message"]
    assert wait_for(lambda: station.live is None)


def test_the_answer_goes_into_the_apps_settings_over_the_version_read(monkeypatch):
    calls = []
    row = {"data": {"settings": {"x": 1}, "stockRequest": {"id": "r1", "kind": "check"},
                    "stockMonitor": {"id": "m1", "kind": "monitor"}}, "updated_at": "2026-10-25T01:00:00+00:00"}

    def rest(method, path, body=None, prefer="", timeout=30):
        calls.append((method, path, body))
        if method == "GET" and "stockRequest:data" in path:
            return [{"stockRequest": row["data"]["stockRequest"], "stockMonitor": row["data"]["stockMonitor"]}]
        if method == "GET":
            return [json.loads(json.dumps(row))]
        assert "updated_at=eq.2026-10-25T01%3A00%3A00%2B00%3A00" in path         # only over the version read
        return [{"id": 1}]
    monkeypatch.setattr(decant, "_rest", rest)
    assert decant.stock_requests() == {"stockRequest": {"id": "r1", "kind": "check"},
                                       "stockMonitor": {"id": "m1", "kind": "monitor"}}
    assert decant.answer_stock_request("m1", {"state": "monitoring"}, slot="stockMonitor")
    sent = calls[-1][2]["data"]
    assert sent["settings"] == {"x": 1} and sent["stockMonitor"]["state"] == "monitoring" and sent["updatedAt"]
    assert "state" not in sent["stockRequest"]
    n = len(calls)
    assert decant.answer_stock_request("other", {"state": "done"}) and len(calls) == n + 1   # asked something else: no write


def test_fueltrans_live_monitoring_comes_back_by_itself(station, monkeypatch):
    """From FuelTrans (no AnyDesk sessions to ration): live monitoring that the
    PC's tunnel going down ended keeps trying, and Telegram hears once that it
    stopped and once that it's back."""
    (station.home / "login.json").write_text(json.dumps({"source": "fueltrans", "password": "pw"}))
    monkeypatch.setattr(FakeSession, "lost", "the IOCL PC's FuelTrans tunnel went down (PC off or offline)",
                        raising=False)
    monkeypatch.setattr(service, "RECONNECT_AFTER", 0.05)
    assert not station.settings["reconnect"]                    # (the AnyDesk setting doesn't matter)
    station.start_live({"tanks": [3], "auto_upload": False})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    first = FakeSession.opened[0]
    FakeSession.fail = True                                     # the tunnel stays down for a while
    first.is_alive = False
    assert wait_for(lambda: station._ft_tries >= 3)             # 0.05 s, 0.1 s, 0.2 s ...
    assert len(station.alerts) == 1 and "keeps trying" in station.alerts[0] and "tunnel went down" in station.alerts[0]
    FakeSession.fail = False                                    # back
    assert wait_for(lambda: station.live and station.live.get("state") == "live" and station.live["reads"] >= 1)
    assert station._ft_tries == 0 and len(station.alerts) == 2 and "is back" in station.alerts[1]
    station.stop_live()
    assert wait_for(lambda: station.live is None)
    assert len(station.alerts) == 2                             # you stopped it: no retry, no message


def test_anydesk_live_monitoring_still_follows_the_reconnect_setting(station, monkeypatch):
    monkeypatch.setattr(service, "RECONNECT_AFTER", 0.05)
    station.start_live({"tanks": [3], "auto_upload": False})
    assert wait_for(lambda: station.live and station.live["reads"] >= 1)
    FakeSession.opened[0].is_alive = False
    assert wait_for(lambda: station.live is None)
    time.sleep(0.3)
    assert station.live is None and len(FakeSession.opened) == 1 and station._ft_tries == 0


def test_a_tanks_flow_while_live(tmp_path, monkeypatch):
    """The page's decanting speed: each watched tank's flow now (L/min, from
    its last 2 minutes of live stock)."""
    now = 1_800_000_000.0
    # decanting at 450 L/min, read every 5 s, with a reading jumping 20 L now and then
    pts = [(now - 120 + i * 5, 5000 + 450 / 60 * i * 5 + (20 if i % 7 == 3 else 0)) for i in range(25)]
    assert abs(service.flow_lpm(pts, now) - 450) < 15
    assert service.flow_lpm(pts[-3:], now) is None                       # (not 30 s of it yet)
    assert service.flow_lpm([(now - 600, 1), (now - 590, 2), (now - 580, 3)], now) is None   # (too old)
    selling = [(now - 60 + i * 10, 9000 - i * 4) for i in range(7)]
    assert service.flow_lpm(selling, now) == -24.0                       # sales out: 24 L/min

    st = service.Station(home=tmp_path, notify=lambda *a: True, notify_photo=lambda *a: True)
    clock = [now - 600]
    monkeypatch.setattr(service.time, "time", lambda: clock[0])
    st.live = {"state": "live", "tanks": [2], "auto_upload": False, "interval_s": 5,
               "figures": {"2": {"reading": {"volume": 5000.0}}}}
    for i in range(121):
        clock[0] = now - 600 + i * 5
        st.live["figures"]["2"]["reading"]["volume"] = 5000.0 + 450 / 60 * i * 5
        st._keep_trend(st.live, [2, 3])                                  # (Tank 3: no figures yet)
    view = st.live_view()
    assert "hist" not in view and abs(view["flow"]["2"] - 450) < 1 and "3" not in view["flow"]
    assert now - st.live["hist"][2][0][0] <= service.TREND_KEEP_S       # (only what the flow needs is kept)


class FakeFeed(FakeSession):
    """FuelTrans' live data (feed.py): Tank 3's exact figures, moving a
    little each time, with no screen."""
    n = 0

    def figures(self):
        FakeFeed.n += 1
        v = round(CARD3["volume"] + FakeFeed.n % 9 * 0.25, 2)
        return {3: {**CARD3, "volume": v, "ullage": round(20000 - v, 2), "exact": True}}

    def screen(self):
        raise AssertionError("no screen is taken while live from FuelTrans' live data")

    def shot(self):
        raise AssertionError("no screen is taken while live from FuelTrans' live data")


def test_from_fueltrans_live_data_the_page_is_fast_and_the_app_gets_it_at_its_interval(station, monkeypatch):
    """Each live read from FuelTrans' live data comes every FEED_EVERY: the
    page's figures as fast as that; the decant app gets the latest of them
    every interval (a "beat"), as from the screen."""
    monkeypatch.setattr(service, "FEED_EVERY", 0.02)
    monkeypatch.setattr(station, "_every", lambda live: 1.5)
    monkeypatch.setattr(service.cards_mod, "read_figures", lambda png, box: pytest.fail("the screen was read"))
    station.session_cls = FakeFeed
    station.start_live({"tanks": [3], "auto_upload": True, "interval_s": 5})
    assert wait_for(lambda: station.live and station.live.get("reads", 0) >= 20, 10)
    live = station.live
    assert live["feed"] and live["exact"] and not live.get("last_error")
    shown = live["figures"]["3"]["reading"]["volume"]
    assert wait_for(lambda: live["figures"]["3"]["reading"]["volume"] != shown)      # (the page: every read)
    assert wait_for(lambda: len(station.db.writes) >= 2, 5), live["uploads"]
    reads, writes = live["reads"], len(station.db.writes)
    assert reads >= 10 * writes, (reads, writes)                                    # (the app: every 1.5 s)
    assert live["uploads"]["3"]["ok"], live["uploads"]
    assert not live.get("last_png")                                                 # (no screen while live)
    station.stop_live()
    assert wait_for(lambda: station.live is None)
    assert station.last == {} or "the last screen" not in str(station.last.get("page"))
