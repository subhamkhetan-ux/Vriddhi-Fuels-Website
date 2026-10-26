"""FuelTransSession against a synthetic FuelTrans (never the station's): its
login page (user list from getSiteUsers, a password, LOGIN) and a Tank Status
page laid out like the real one, read by the same card reader as AnyDesk's
screenshots."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import threading

import pytest

pytest.importorskip("playwright.sync_api")

from tank_stock import cards as cards_mod  # noqa: E402
from tank_stock.capture import CaptureError  # noqa: E402
from tank_stock.fueltrans import FuelTransSession  # noqa: E402

TANKS = [  # (no, product, volume, height, ullage) as on the station's screen
    (1, "Motor Spirit", "8,840.93", "899.01", "11,159.07"),
    (2, "High Speed Diesel", "19,634.50", "1,789.18", "365.50"),
    (3, "High Speed Diesel", "19,897.46", "1,812.30", "102.54"),
    (4, "XtraGreen", "2,513.55", "364.71", "17,486.45"),
]
CARD = """<div class="card"><div class="head">Tank {no} : {product}</div><div class="pic"></div>
<div class="upd">Last Updated @ 10/26/2026 11:21:1{no}</div>
<div class="row"><span>Tank Status</span><b class="ok">ONLINE</b></div>
<div class="row"><span>Tank Capacity</span><b>20,000.00 ltr</b></div>
<div class="row"><span>Product Volume</span><b>{volume} ltr</b></div>
<div class="row"><span>Product Height</span><b>{height} mm</b></div>
<div class="row"><span>Water Volume</span><b>0.00 ltr</b></div>
<div class="row"><span>Ullage Space</span><b>{ullage} ltr</b></div>
<div class="row"><span>Density</span><b>724.40 kg/m^3</b></div>
<div class="row"><span>Density (tc)</span><b>738.30 kg/m^3</b></div>
<div class="row"><span>Temperature</span><b>30.50</b></div></div>"""
APP = """<!DOCTYPE html><html><head><style>
body{margin:0;font-family:"DejaVu Sans",Arial,sans-serif;background:#fff}
.bar{background:rgb(0,169,246);height:34px;display:flex;gap:60px;padding:0 40px;align-items:center;color:#fff;font-weight:bold}
.bar span{cursor:pointer}#menu{position:absolute;top:34px;left:200px;background:#fff;border:1px solid #888;display:none}
#menu div{padding:6px 14px;cursor:pointer}.cards{display:flex;gap:30px;padding:24px 30px}
.card{width:440px;height:462px;border:1px solid rgb(223,223,223);border-radius:6px;box-sizing:border-box;padding:0 18px}
.head{font-weight:bold;font-size:17px;margin-top:10px;color:#222}.pic{height:110px;margin:8px 40px;border-radius:50px;background:#24307a}
.upd{color:#888;font-size:14px;margin-top:18px}.row{display:flex;height:30px;align-items:center;font-size:15px}
.row span{width:160px;color:#999}.row b{color:#222}.ok{color:#6c0!important}
#login{padding:200px 760px}select,input,button{display:block;width:380px;margin:10px 0;font-size:16px;padding:6px}
</style></head><body><div id="app"></div><script>
const tanks = TANKS_JSON, inMemory = IN_MEMORY;
let authed = false;
const isAuthed = () => inMemory ? authed : sessionStorage.getItem("auth") === "1";
function login() {
  app.innerHTML = '<div id="login"><select id="user"><option value="" disabled selected>User Name</option></select>' +
    '<input type="password" id="pw" placeholder="Password"><button id="go">LOGIN</button></div>';
  setTimeout(() => fetch("/getSiteUsers").then(r => r.json()).then(us => us.forEach(u => {
    const o = document.createElement("option"); o.value = u.id; o.textContent = u.name; user.appendChild(o);
  })), 300);
  go.onclick = () => {
    if (user.selectedOptions[0].textContent === "Dealer" && pw.value === "123456") {
      authed = true; sessionStorage.setItem("auth", "1"); history.pushState({}, "", "/home"); route();
    }
  };
}
function bar() {
  return '<div class="bar"><span>Home</span><span id="mon">Monitoring</span><span>Operations</span></div>' +
    '<div id="menu"><div id="ts">Tank Status</div><div>Pump Status</div></div>';
}
function home() {
  app.innerHTML = bar() + '<h2 style="padding:30px">Welcome</h2>';
  mon.onclick = () => { menu.style.display = "block"; };
  ts.onclick = () => { history.pushState({}, "", "/tank-dashboard"); route(); };
}
function dashboard() {
  app.innerHTML = bar() + '<div class="cards"></div>';
  setTimeout(() => { document.querySelector(".cards").innerHTML = tanks.join(""); }, 500);
}
function route() {
  if (!isAuthed()) { history.replaceState({}, "", "/login"); return login(); }
  return location.pathname === "/tank-dashboard" ? dashboard() : home();
}
route();
</script></body></html>"""


def serve(in_memory: bool):
    cards = [CARD.format(no=n, product=p, volume=v, height=h, ullage=u) for n, p, v, h, u in TANKS]
    page = APP.replace("TANKS_JSON", json.dumps(cards)).replace("IN_MEMORY", json.dumps(in_memory)).encode()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path == "/getSiteUsers":
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

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
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
            assert ("Monitoring > Tank Status" in did) == in_memory   # the menu when a reload logs out
            assert s.alive()
            png2, did2 = s.shot()                                    # from another thread: same page
            assert did2 == "already on Tank Status"
            assert s.screen().startswith(b"\x89PNG")
            if not (shutil.which("tesseract") and shutil.which("convert")):
                return
            boxes, read = cards_mod.read_all(png2)
            assert sorted(boxes) == [1, 2, 3, 4]
            for no, product, volume, height, ullage in TANKS:
                card = read[no]
                assert card["volume"] == float(volume.replace(",", "")), card
                assert card["height"] == float(height.replace(",", "")), card
                assert card["ullage"] == float(ullage.replace(",", "")), card
                assert card["capacity"] == 20000.0 and not card["disagree"], card
            assert read[1]["product"] == "MS" and read[2]["product"] == "HSD"
            px = cards_mod.Pixels(png2)
            card = cards_mod.read_figures(png2, boxes[3])            # what a live read reads
            assert card["volume"] == 19897.46 and card["ullage"] == 102.54
            assert cards_mod.fingerprint(px, boxes[3])
        finally:
            s.close()
    finally:
        server.shutdown()
    assert not s.alive()


def test_wrong_password_and_tunnel_down(chromium):
    server = serve(False)
    url = f"http://127.0.0.1:{server.server_port}"
    try:
        with pytest.raises(CaptureError, match="didn't accept the login"):
            FuelTransSession(url, "Dealer", "wrong", settle=1).open()
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
