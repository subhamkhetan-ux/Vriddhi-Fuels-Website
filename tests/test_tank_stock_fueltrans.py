"""FuelTransSession against a synthetic FuelTrans (never the station's): its
login page (user list from getSiteUsers, a password, LOGIN) and a Tank Status
page laid out like the real one, read by the same card reader as AnyDesk's
screenshots."""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import threading
import time

import pytest

pytest.importorskip("playwright.sync_api")

from tank_stock import cards as cards_mod  # noqa: E402
from tank_stock.capture import CaptureError  # noqa: E402
from tank_stock import fueltrans  # noqa: E402
from tank_stock.fueltrans import FuelTransSession  # noqa: E402

TANKS = [  # (no, product, volume, height, ullage, density, density tc, temp, time, fill %, colour): the PC's screen
    (1, "Motor Spirit", "8,787.48", "894.89", "11,212.52", "724.10", "738.00", "30.60", "37", 44, "#ea5a2a"),
    (2, "High Speed Diesel", "16,038.20", "1,458.86", "3,961.80", "1,035.70", "1,045.70", "30.50", "39", 80, "#0b1660"),
    (3, "High Speed Diesel", "17,182.31", "1,555.83", "2,817.69", "894.40", "904.80", "30.40", "40", 86, "#0b1660"),
    (4, "XtraGreen", "2,513.75", "364.73", "17,486.25", "530.20", "547.10", "30.80", "38", 13, "#6cb35a"),
]
# FuelTrans' tank picture: a capsule with a hatch, two feet, a dip scale and
# the fill level, with its percentage in a disc, and a padlock beside it.
TANK_SVG = """<svg width="170" height="90" viewBox="0 0 158 84"><defs><clipPath id="c{no}">
<rect x="7" y="9" width="126" height="56" rx="28"/></clipPath></defs>
<rect x="50" y="0" width="48" height="10" rx="5" fill="#111"/>
<rect x="7" y="9" width="126" height="56" rx="28" fill="#fff"/>
<rect x="0" y="{top}" width="140" height="70" fill="{colour}" clip-path="url(#c{no})"/>
<rect x="7" y="9" width="126" height="56" rx="28" fill="none" stroke="#111" stroke-width="5"/>
<line x1="34" y1="12" x2="34" y2="62" stroke="#111" stroke-width="2"/>
{ticks}<circle cx="70" cy="27" r="9" fill="{disc}"/>
<text x="70" y="29.5" font-size="6.5" fill="#fff" text-anchor="middle">{pct}%</text>
<rect x="38" y="67" width="22" height="7" fill="#111"/><rect x="80" y="67" width="22" height="7" fill="#111"/>
<g fill="#aaa"><rect x="145" y="28" width="11" height="9" rx="1.5"/>
<path d="M147.5 28v-3a3 3 0 0 1 6 0v3" fill="none" stroke="#aaa" stroke-width="2"/></g></svg>"""
CARD = """<div class="card"><div class="head">Tank {no} : {product}</div><div class="pic">{svg}</div>
<div class="upd">Last Updated @ 10/26/2026 12:46:{sec}</div>
<div class="row"><span>Tank Status</span><b class="ok">ONLINE</b></div>
<div class="row"><span>Tank Capacity</span><b>20,000.00 ltr</b></div>
<div class="row"><span>Product Volume</span><b>{volume} ltr</b></div>
<div class="row"><span>Product Height</span><b>{height} mm</b></div>
<div class="row"><span>Water Volume</span><b>0.00 ltr</b></div>
<div class="row"><span>Ullage Space</span><b>{ullage} ltr</b></div>
<div class="row"><span>Density</span><b>{density} kg/m^3</b></div>
<div class="row"><span>Density (tc)</span><b>{density_tc} kg/m^3</b></div>
<div class="row"><span>Temperature</span><b>{temp}</b></div></div>"""


def card_html(no, product, volume, height, ullage, density, density_tc, temp, sec, pct, colour):
    ticks = "".join(f'<line x1="34" y1="{y}" x2="40" y2="{y}" stroke="#111" stroke-width="1.5"/>'
                    for y in range(16, 62, 6))
    svg = TANK_SVG.format(no=no, top=65 - 56 * pct / 100, colour=colour, ticks=ticks, pct=pct,
                          disc=colour if pct < 50 else "#0b1660", )
    return CARD.format(no=no, product=product, svg=svg, sec=sec, volume=volume, height=height,
                       ullage=ullage, density=density, density_tc=density_tc, temp=temp)


# The station's layout (measured on the PC's own screenshot, which was shrunk
# to 0.71 of its 1920 x 1080 screen: hence zoom 1.4): DejaVu Sans, cards 308 x
# 322 px there with a light border, rounded corners and a soft shadow, rows
# 21 px apart, grey labels and bold figures.
APP = """<!DOCTYPE html><html><head><script src="/vendor.0123456789abcdef.js"></script><style>
html{zoom:1.4}
body{margin:0;font-family:Roboto,"Helvetica Neue",Arial,sans-serif;background:#fff;color:#333}
.fa{font-family:monospace}
.top{height:62px;display:flex;align-items:center;padding:0 16px;font-weight:bold;color:#e0301e;font-size:17px}
.bar{background:rgb(0,169,246);height:30px;display:flex;gap:90px;padding:0 50px;align-items:center;color:#fff;
 font-weight:bold;font-size:13px}
.bar span{cursor:pointer}#menu{position:absolute;top:92px;left:200px;background:#fff;border:1px solid #888;display:none}
#menu div{padding:6px 14px;cursor:pointer;font-size:13px}
.title{background:#082243;color:#fff;text-align:center;font-weight:bold;font-size:13px;height:20px;line-height:20px;
 margin:6px 8px 0}
.cards{display:flex;gap:19px;padding:9px 8px}
.card{width:308px;height:322px;border:1px solid #e1e1e1;border-radius:8px;box-sizing:border-box;padding:0 0 0 20px;
 box-shadow:0 2px 3px rgba(0,0,0,.28);background:#fff}
.head{font-weight:bold;font-size:12px;margin:3px 0 0 -7px;color:#222;height:17px}
.pic{height:90px;margin:5px 0 0 -3px}.upd{color:#9a9a9a;font-size:10px;margin-top:2px;height:17px}
.row{display:flex;height:21px;align-items:center;font-size:10px}
.row span{width:94px;color:#adadad}.row b{color:#333;font-size:10.3px}.ok{color:#a3cf36!important}
.off{color:#aaa!important}
#login{padding:200px 760px}select,input,button{display:block;width:380px;margin:10px 0;font-size:16px;padding:6px}
</style></head><body><div id="app"></div><script>
const tanks = TANKS_JSON, placeholders = PLACEHOLDERS_JSON, inMemory = IN_MEMORY;
let authed = false;
const isAuthed = () => inMemory ? authed : sessionStorage.getItem("auth") === "1";
function login() {
  app.innerHTML = '<div id="login"><select id="user"><option value="" disabled selected>User Name</option></select>' +
    '<input type="password" id="pw" placeholder="Password"><button id="go">LOGIN</button></div>';
  setTimeout(() => fetch(base + "/getSiteUsers").then(r => r.json()).then(us => us.forEach(u => {
    const o = document.createElement("option"); o.value = u.id; o.textContent = u.name; user.appendChild(o);
  })), 300);
  go.onclick = () => {
    if (user.selectedOptions[0].textContent === "Dealer" && pw.value === "123456") {
      authed = true; sessionStorage.setItem("auth", "1"); history.pushState({}, "", "/home"); route();
    }
  };
}
function bar() {
  return '<div class="top">VRIDDHI FUELS : 338821</div>' +
    '<div class="bar"><span><i class="fa fa-home">H</i>Home</span><span id="mon">Monitoring</span><span>Operations</span><span>Reports</span></div>' +
    '<div id="menu"><div id="ts">Tank Status</div><div>Pump Status</div></div>';
}
function home() {
  app.innerHTML = bar() + '<h2 style="padding:30px">Welcome</h2>';
  mon.onclick = () => { menu.style.display = "block"; };
  ts.onclick = () => { history.pushState({}, "", "/tank-dashboard"); route(); };
}
function dashboard() {
  app.innerHTML = bar() + '<div class="title">Tank Status</div><div class="cards"></div>';
  // as FuelTrans: the cards come first as placeholders (OFFLINE, 00/00/0000,
  // 1,000,000.00 ltr), each tank's figures a while later over its live connection
  fetch(base + "/getSiteInfo").then(r => r.json()).then(() => {
    if (LIVE_DATA) {   // socket.io: a first reply over HTTP polling, then the websocket
      fetch("/socket.io/?EIO=3&transport=polling&t=1");
      new WebSocket(`ws://${location.host}/socket.io/?EIO=3&transport=websocket`);
    }
    document.querySelector(".cards").innerHTML = placeholders.join("");
    tanks.forEach((card, i) => NEVER.includes(i + 1) || setTimeout(() => {
      document.querySelectorAll(".card")[i].outerHTML = card;
    }, 1500 + 1500 * i));
  });
}
function route() {
  if (!isAuthed()) { history.replaceState({}, "", "/login"); return login(); }
  return location.pathname === "/tank-dashboard" ? dashboard() : home();
}
// as Angular: the app starts (and redirects to the login) a moment after the
// page loads, and asks its backend at config.json's baseUrl
let base = "";
setTimeout(() => fetch("/assets/data/config.json").then(r => r.json())
  .then(cfg => { base = cfg.baseUrl; route(); }), 700);
</script></body></html>"""


def packet(no, product, volume, height, ullage, density, density_tc, temp, sec, *_):
    """A card's figures as FuelTrans' live data brings them (float32 noise and all)."""
    f = lambda v: float(v.replace(",", "")) - 0.0000195   # noqa: E731
    return {"tankId": no, "lastUpdated": f"10/26/2026 12:46:{sec}", "tankUid": 40 + no, "tankStatus": 2,
            "productLevel": f(height), "prodcutVolume": f(volume), "waterLevel": 0, "waterVolume": 0,
            "temperature": f(temp), "tcVolume": 0, "ullage": f(ullage), "density": f(density),
            "tcDensity": f(density_tc), "lockval": 0}


def ws_frame(text: str) -> bytes:
    data = text.encode()
    head = bytes([0x81, len(data)]) if len(data) < 126 else bytes([0x81, 126]) + len(data).to_bytes(2, "big")
    return head + data


def serve(in_memory: bool, never=(), live_data=True):
    """The synthetic FuelTrans; ``never``: tanks whose figures never come (a
    probe that is down); ``live_data``: its page gets the figures over
    socket.io as well (tank 1 over HTTP polling, the others over a websocket)."""
    cards = [card_html(*t) for t in TANKS]
    waiting = [card_html(no, product, "1,000,000.00", "714.90", "171,892.48", "827.10", "827.10", "0.00", "00", 2,
                         colour).replace("10/26/2026 12:46:00", "00/00/0000 00:00:00")
               .replace('class="ok">ONLINE', 'class="off">OFFLINE')
               for no, product, *_, colour in TANKS]
    page = APP.replace("TANKS_JSON", json.dumps(cards)).replace("PLACEHOLDERS_JSON", json.dumps(waiting)).replace("IN_MEMORY", json.dumps(in_memory)).replace("NEVER", json.dumps(list(never))).replace("LIVE_DATA", json.dumps(live_data)).encode()
    pkts = {t[0]: "42" + json.dumps(["tankStatusPkt", packet(*t)]) for t in TANKS if t[0] not in never}

    files = []                                     # requests for its program file

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path.startswith("/socket.io/") and "transport=websocket" in self.path:
                return self.websocket()
            if self.path.startswith("/socket.io/"):
                one = [p for no, p in pkts.items() if no == 1]
                body, kind = "".join(f"{len(p)}:{p}" for p in ['0{"sid":"x"}', *one]).encode(), "text/plain"
            elif self.path == "/vendor.0123456789abcdef.js":
                files.append(self.path)
                body, kind = b"window.vendorLoaded = true;", "text/javascript"
            elif self.path == "/tankDetails":
                body, kind = json.dumps([{"id": 40 + t[0], "tank_no": t[0], "product_name": t[1], "capacity": 20000}
                                         for t in TANKS]).encode(), "application/json"
            elif self.path == "/getSiteInfo":
                body, kind = b'[{"site_id": "338821"}]', "application/json"
            elif self.path == "/getSiteUsers":
                body, kind = json.dumps([{"id": i, "name": n} for i, n in enumerate(
                    ["Admin", "IOCL", "Manager", "Attendant", "Dealer"], 1)]).encode(), "application/json"
            elif self.path == "/assets/data/config.json":
                body, kind = b'{"baseUrl": "http://localhost:3000"}', "application/json"
            else:
                body, kind = page, "text/html"
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.end_headers()
            self.wfile.write(body)

        def websocket(self):
            key = self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
            self.protocol_version = "HTTP/1.1"         # (a websocket needs it)
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", base64.b64encode(hashlib.sha1(key.encode()).digest()).decode())
            self.end_headers()
            try:
                self.wfile.write(ws_frame("40"))
                while True:                            # (every second, as the ATG's figures come)
                    for no, p in pkts.items():
                        if no != 1:
                            self.wfile.write(ws_frame(p))
                    self.wfile.flush()
                    time.sleep(1)
            except OSError:
                pass                                   # the page closed

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.files = files
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture
def chromium(monkeypatch):
    exe = os.environ.get("TANK_STOCK_CHROMIUM") or shutil.which("chromium")
    if exe:
        monkeypatch.setenv("TANK_STOCK_CHROMIUM", exe)
        return
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        if not Path(p.chromium.executable_path).is_file():
            pytest.skip("Install Playwright Chromium (or set TANK_STOCK_CHROMIUM) for the FuelTrans tests")


@pytest.mark.parametrize("in_memory", [False, True], ids=["login-kept", "login-per-load"])
def test_logs_in_and_reads_the_cards(chromium, in_memory):
    server = serve(in_memory)
    url = f"http://127.0.0.1:{server.server_port}"
    try:
        s = FuelTransSession(url, "Dealer", "123456", settle=1)
        try:
            png, did = s.shot()                                      # (no open() first: it opens)
            assert png.startswith(b"\x89PNG") and "logged in as Dealer" in did
            assert "no figures" not in did                           # waited for the placeholders to fill
            fonts = s._do(lambda: s._page.evaluate(
                "[getComputedStyle(document.querySelector('.row span')).fontFamily,"
                " getComputedStyle(document.querySelector('i.fa')).fontFamily]"))
            assert fonts[0].startswith('"DejaVu Sans"') and fonts[1] == "monospace", fonts   # the PC's font, icons kept
            assert ("Monitoring > Tank Status" in did) == in_memory   # the menu when a reload logs out
            assert s.alive()
            exact = s.last_figures                                   # FuelTrans' live data, as shown
            assert sorted(exact) == [1, 2, 3, 4], exact              # (tank 1's came over HTTP polling)
            for no, product, volume, height, ullage, density, density_tc, temp, sec, *_ in TANKS:
                assert exact[no] == {
                    "no": no, "time": ("10", "26", "2026", "12", "46", sec), "capacity": 20000.0,
                    "volume": float(volume.replace(",", "")), "height": float(height.replace(",", "")),
                    "water": 0.0, "ullage": float(ullage.replace(",", "")),
                    "density": float(density.replace(",", "")), "densityTc": float(density_tc.replace(",", "")),
                    "temp": float(temp), "disagree": [], "exact": True,
                    "product": {"Motor Spirit": "MS", "XtraGreen": "XG"}.get(product, "HSD")}, exact[no]
            png2, did2 = s.shot()                                    # from another thread: same page
            assert did2 == "already on Tank Status"
            assert s.screen().startswith(b"\x89PNG")
            if not (shutil.which("tesseract") and shutil.which("convert")):
                return
            boxes, read = cards_mod.read_all(png2)
            assert sorted(boxes) == [1, 2, 3, 4]
            for no, product, volume, height, ullage, *_ in TANKS:
                card = read[no]
                assert card["volume"] == float(volume.replace(",", "")), card
                assert card["height"] == float(height.replace(",", "")), card
                assert card["ullage"] == float(ullage.replace(",", "")), card
                assert card["capacity"] == 20000.0 and not card["disagree"], card
            assert read[1]["product"] == "MS" and read[2]["product"] == "HSD"
            px = cards_mod.Pixels(png2)
            card = cards_mod.read_figures(png2, boxes[3])            # what a live read reads
            assert card["volume"] == 17182.31 and card["ullage"] == 2817.69
            assert cards_mod.fingerprint(px, boxes[3])
        finally:
            s.close()
    finally:
        server.shutdown()
    assert not s.alive()


def test_wrong_password_and_tunnel_down(chromium, tmp_path, monkeypatch):
    monkeypatch.setenv("TANK_STOCK_HOME", str(tmp_path))
    server = serve(False)
    url = f"http://127.0.0.1:{server.server_port}"
    try:
        with pytest.raises(CaptureError, match=r"didn't accept the login.*\(page: /login\)"):
            FuelTransSession(url, "Dealer", "wrong", settle=1).open()
        assert (tmp_path / "fueltrans-problem.png").read_bytes().startswith(b"\x89PNG")   # what it showed
        with pytest.raises(CaptureError, match="no user .Owner."):
            FuelTransSession(url, "Owner", "123456", settle=1).open()
    finally:
        server.shutdown()
        server.server_close()
    with pytest.raises(CaptureError, match="tunnel is down"):
        FuelTransSession(url, "Dealer", "123456", settle=1).open()


def test_service_picks_fueltrans_from_the_login(tmp_path):
    from tank_stock import service
    st = service.Station(home=tmp_path, notify=lambda *a: True, notify_photo=lambda *a: True)
    (tmp_path / "login.json").write_text(json.dumps({"source": "fueltrans", "password": "123456"}))
    assert st.from_fueltrans() and st.view()["login_saved"] and st.view()["source"] == "fueltrans"
    s = st._session(*st.login())
    assert isinstance(s, FuelTransSession)
    assert (s.url, s.user, s.password) == ("http://127.0.0.1:13000", "Dealer", "123456")
    s.close()
    (tmp_path / "login.json").write_text(json.dumps({"source": "fueltrans", "url": "http://x:1/",
                                                     "user": "Manager", "password": "p"}))
    s = st._session(*st.login())
    assert (s.url, s.user, s.password) == ("http://x:1", "Manager", "p")
    s.close()
    (tmp_path / "login.json").write_text(json.dumps({"source": "fueltrans"}))
    with pytest.raises(CaptureError, match="tank-stock-setup.sh"):
        st.login()
    (tmp_path / "login.json").write_text(json.dumps({"ids": ["123456789"], "password": "x"}))
    assert not st.from_fueltrans() and isinstance(st._session(*st.login()), service.Session)


def test_a_tank_whose_figures_never_come(chromium, monkeypatch):
    monkeypatch.setattr(fueltrans, "DATA_WAIT", 8)
    server = serve(False, never=(3,))
    s = FuelTransSession(f"http://127.0.0.1:{server.server_port}", "Dealer", "123456", settle=0)
    try:
        png, did = s.shot()
        assert did.endswith("1 card still had no figures after 8 s"), did
        assert sorted(s.last_figures) == [1, 2, 4]
        if shutil.which("tesseract") and shutil.which("convert"):
            boxes, read = cards_mod.read_all(png)
            assert read[1]["volume"] == 8787.48 and read[4]["volume"] == 2513.75
            assert read[3]["volume"] == 1000000.0                    # the placeholder: the decant checks refuse it
    finally:
        s.close()
        server.shutdown()


@pytest.mark.parametrize("live_data", [True, False], ids=["live-data", "screen-only"])
def test_the_service_reads_saves_and_monitors_through_fueltrans(chromium, tmp_path, monkeypatch, live_data):
    """What the Vriddhi Fuels app's Tank stock tab and the decant app ask for,
    end to end: a capture saved to the decant app with its proof picture, then
    live monitoring sending the volumes as they come. With FuelTrans' live
    data the figures are its own, and the screen is read only to find the
    cards for their pictures; without it, they're read off the screen."""
    if not (shutil.which("tesseract") and shutil.which("convert")):
        pytest.skip("needs Tesseract and ImageMagick")
    from tank_stock import decant, service
    from tests.test_tank_stock_service import FakeDB
    db = FakeDB()
    monkeypatch.setattr(decant, "_rest", db)
    monkeypatch.setattr(decant, "_http", db.http)
    monkeypatch.setenv("TANK_STOCK_HOME", str(tmp_path))
    server = serve(False, live_data=live_data)
    reads = {"ocr": 0, "read_card": 0, "read_figures": 0}
    for name in reads:
        monkeypatch.setattr(cards_mod, name, (lambda name, fn: lambda *a: (
            reads.__setitem__(name, reads[name] + 1), fn(*a))[1])(name, getattr(cards_mod, name)))
    (tmp_path / "login.json").write_text(json.dumps({
        "source": "fueltrans", "url": f"http://127.0.0.1:{server.server_port}", "user": "Dealer", "password": "123456"}))
    st = service.Station(home=tmp_path, notify=lambda *a: True, notify_photo=lambda *a: True)
    try:
        last = st.capture([1, 2, 3, 4], upload=True, why="decant app")
        for no, product, volume, *_ in TANKS:
            tank = last["tanks"][str(no)]
            assert tank["confidence"] != "low" and tank["reading"]["volume"] == float(volume.replace(",", "")), tank
            assert last["uploads"][str(no)]["ok"], last["uploads"]
        assert sorted(w["tank_id"] for w in db.writes) == ["T1", "T2", "T3", "T4"]
        assert len(db.shots) == 4 and all(data.startswith(b"\xff\xd8") for data, _ in db.files.values())
        assert reads == ({"ocr": 1, "read_card": 0, "read_figures": 0} if live_data
                         else {"ocr": 1, "read_card": 4, "read_figures": 0}), reads

        st.start_live({"tanks": [1, 2, 3, 4], "auto_upload": True, "interval_s": 5})
        deadline = time.time() + 150
        while time.time() < deadline and not (st.live and st.live.get("reads", 0) >= 2):
            time.sleep(0.5)
        live = st.live
        assert live and live["reads"] >= 2 and not live.get("last_error"), live and live.get("last_error")
        assert {no: f["reading"]["volume"] for no, f in sorted(live["figures"].items())} == {
            str(no): float(volume.replace(",", "")) for no, _, volume, *_ in TANKS}
        assert live["session"].alive()
        assert live["exact"] is live_data
        if live_data:
            assert reads["read_figures"] == 0 and reads["read_card"] == 0, reads   # no reading of the screen
        else:
            assert reads["read_figures"] >= 4, reads
    finally:
        st.stop_live("test over")
        deadline = time.time() + 60
        while st.live and time.time() < deadline:
            time.sleep(0.2)
        server.shutdown()
    assert st.live is None


def test_a_stalled_page_is_opened_again(chromium, monkeypatch):
    """No card's "Last Updated" moving (FuelTrans' live connection stalled):
    the next screenshot opens Tank Status again."""
    monkeypatch.setattr(fueltrans, "STALE_RELOAD", 3)
    server = serve(False)
    loads = []
    handle = server.RequestHandlerClass.do_GET
    server.RequestHandlerClass.do_GET = lambda self: (loads.append(self.path) if self.path == "/tank-dashboard"
                                                      else None, handle(self))[1]
    s = FuelTransSession(f"http://127.0.0.1:{server.server_port}", "Dealer", "123456", settle=0)
    try:
        s.shot()
        opened = len(loads)                          # (before and after the login)
        s.screen()                                   # the clocks are noted
        assert len(loads) == opened
        time.sleep(3.5)                              # (the mock's clocks never move)
        assert s.screen().startswith(b"\x89PNG") and len(loads) == opened + 1
        s.screen()
        assert len(loads) == opened + 1              # just reloaded: its clocks are new
    finally:
        s.close()
        server.shutdown()


def test_a_blip_of_the_tunnel_isnt_a_lost_session(chromium, monkeypatch):
    """FuelTrans not answering for a moment (the station's internet) keeps
    the session; only LOST_AFTER seconds without an answer lose it, and the
    reason says how it failed."""
    monkeypatch.setattr(fueltrans, "LOST_AFTER", 2)
    server = serve(False)
    port = server.server_port
    s = FuelTransSession(f"http://127.0.0.1:{port}", "Dealer", "123456", settle=0)
    try:
        s.shot()
        assert s.alive()
        server.shutdown()
        server.server_close()                        # the tunnel's port closes: refused
        assert s.alive()                             # a blip: still the session
        time.sleep(1)
        assert s.alive()
        time.sleep(1.2)
        assert not s.alive()                         # 2 s without an answer: lost
        assert "no answer for 2 s: connection refused" in s.lost, s.lost
        again = serve(False)                         # (back: a new answer resets it)
        s.url = f"http://127.0.0.1:{again.server_port}"
        assert s.alive() and s._down_since is None
        again.shutdown()
    finally:
        s.close()


def test_fueltrans_program_files_cross_the_tunnel_once(chromium, tmp_path, monkeypatch):
    """FuelTrans' fingerprinted program files are kept on the server: the
    next page load (and the next session) doesn't fetch them over the PC's
    upload again."""
    monkeypatch.setenv("TANK_STOCK_HOME", str(tmp_path))
    server = serve(True)                                  # (logged out on each load: two loads a session)
    url = f"http://127.0.0.1:{server.server_port}"
    try:
        for _ in range(2):
            s = FuelTransSession(url, "Dealer", "123456", settle=0)
            try:
                png, did = s.shot()
                assert "logged in as Dealer" in did
                assert s._do(lambda: s._page.evaluate("window.vendorLoaded")) is True
            finally:
                s.close()
        assert server.files == ["/vendor.0123456789abcdef.js"]
        assert (tmp_path / "fueltrans-files" / "vendor.0123456789abcdef.js").read_bytes().startswith(b"window.")
    finally:
        server.shutdown()


class FakeResponse:
    def __init__(self, url, body):
        self.url, self.body = url, body

    def text(self):
        if self.body is None:
            raise RuntimeError("Response body is unavailable for redirect responses")
        return self.body


def test_exact_figures_are_the_ones_on_the_screen(monkeypatch):
    """A tank's live figures count only if their "Last Updated" is the one its
    card shows: the picture and the figures always agree. Unknown live data
    (FuelTrans changed) gives none: those cards are read off the screen."""
    s = FuelTransSession("http://127.0.0.1:9", "Dealer", "x")
    assert s._tank_details() == {} and s._tank_details() == {}   # (nothing there: not asked again at once)
    monkeypatch.setattr(s, "_tank_details", lambda: {1: {"capacity": 20000, "product_name": "Motor Spirit"}})
    one = packet(*TANKS[0])
    later = {**one, "lastUpdated": "10/26/2026 12:46:42", "prodcutVolume": 8700.0}
    for p in (one, later):
        s._on_frame("42" + json.dumps(["tankStatusPkt", p]))
    s._on_frame('42["pumpStatusPkt",{"PumpId":1}]')
    s._on_frame("3")                                           # (a pong)
    s._on_frame(b'42["tankStatusPkt",{"no":"tankId"}]')        # unknown: kept out
    assert s._figures(["Last Updated @ 10/26/2026 12:46:42"])[1]["volume"] == 8700.0
    shown = s._figures(["Last Updated @ 10/26/2026 12:46:37", "Last Updated @ 10/26/2026 12:46:39"])
    assert shown[1]["volume"] == 8787.48 and shown[1]["product"] == "MS"   # the older one: what's on screen
    assert s._figures(["Last Updated @ 10/26/2026 12:47:00"]) == {}           # neither is on screen
    assert s._figures([]) == {}
    for _ in range(fueltrans.KEPT_PACKETS):
        s._on_frame("42" + json.dumps(["tankStatusPkt", later]))
    assert s._figures(["Last Updated @ 10/26/2026 12:46:37"]) == {}           # long gone
    # over HTTP polling (before the websocket is up), one reply holding several packets
    two = "42" + json.dumps(["tankStatusPkt", packet(*TANKS[1])])
    s._on_response(FakeResponse("http://x/socket.io/?EIO=3&transport=polling&t=2", f'2:40{len(two)}:{two}'))
    s._on_response(FakeResponse("http://x/socket.io/?EIO=3&transport=polling&t=3", None))   # (gone: skipped)
    s._on_response(FakeResponse("http://x/getSiteInfo", "[]"))
    assert s._figures(["Last Updated @ 10/26/2026 12:46:39"])[2]["volume"] == 16038.2
    # FuelTrans' live data in another shape: no exact figures, the screen is read
    assert fueltrans.card_from_packet({**one, "prodcutVolume": None}, {}) is None
    assert fueltrans.card_from_packet({k: v for k, v in one.items() if k != "ullage"}, {}) is None
    assert fueltrans.card_from_packet({**one, "lastUpdated": "00/00/0000 00:00:00"}, {}) is None
    fixed = {k: v for k, v in one.items() if k != "prodcutVolume"} | {"productVolume": 5.0}   # (the typo fixed)
    assert fueltrans.card_from_packet(fixed, {})["volume"] == 5.0
    assert fueltrans.card_from_packet(one, {})["capacity"] is None              # (no tankDetails: the decant app's)
    s.close()


def test_the_service_pairs_each_screen_with_its_exact_figures(tmp_path, monkeypatch):
    """A screen's exact figures are used for the cards found on it (a tank
    whose card isn't on the screen has none); any other screen is read off
    as before. A FuelTrans card read fine off the screen that the live data
    didn't bring is said once a session."""
    from tank_stock import service
    told = []
    st = service.Station(home=tmp_path, notify=lambda text, *a: told.append(text) or True,
                         notify_photo=lambda *a: True)

    class Session:
        last_figures = {1: {"no": 1, "volume": 5.0, "exact": True}, 2: {"no": 2, "volume": 6.0, "exact": True}}

    png = b"\x89PNG the screen"
    assert st._got((png, "already on Tank Status"), Session()) == (png, "already on Tank Status")
    monkeypatch.setattr(cards_mod, "ocr", lambda png: [])
    monkeypatch.setattr(cards_mod, "card_boxes", lambda png, words: {1: (0, 0, 9, 9), 3: (10, 0, 19, 9)})
    monkeypatch.setattr(cards_mod, "read_card", lambda png, box: {"volume": 7.0})
    monkeypatch.setattr(cards_mod, "read_all", lambda png: ({}, {"read": "off the screen"}))
    boxes, read = st._read_screen(png)
    assert read == {1: {"no": 1, "volume": 5.0, "exact": True}, 3: {"volume": 7.0}}, read
    assert st._read_screen(b"\x89PNG another screen") == ({}, {"read": "off the screen"})

    live = {"session": Session(), "reads": 2, "figures": {"3": {"confidence": "high"}, "4": {"confidence": "low"}}}
    st._read_off_screen(live, 3)
    assert not told                                    # (not in a session's first reads)
    live["reads"] = 3
    for no in (3, 3, 4, 5):
        st._read_off_screen(live, no)
    assert len(told) == 1 and "Tank 3" in told[0], told   # once; not a card without figures
    st._read_off_screen({"session": object(), "reads": 9, "figures": {"6": {"confidence": "high"}}}, 6)
    assert len(told) == 1                               # (a screen-only session: nothing to say)
