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


# The station's layout at its 1366 px wide screen (measured on the PC's own
# screenshot): DejaVu Sans, cards 308 x 322 px with a light border, rounded
# corners and a soft shadow, rows 21 px apart, grey labels and bold figures.
APP = """<!DOCTYPE html><html><head><style>
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


def serve(in_memory: bool, never=()):
    """The synthetic FuelTrans; ``never``: tanks whose figures never come (a probe that is down)."""
    cards = [card_html(*t) for t in TANKS]
    waiting = [card_html(no, product, "1,000,000.00", "714.90", "171,892.48", "827.10", "827.10", "0.00", "00", 2,
                         colour).replace("10/26/2026 12:46:00", "00/00/0000 00:00:00")
               .replace('class="ok">ONLINE', 'class="off">OFFLINE')
               for no, product, *_, colour in TANKS]
    page = APP.replace("TANKS_JSON", json.dumps(cards)).replace("PLACEHOLDERS_JSON", json.dumps(waiting)).replace("IN_MEMORY", json.dumps(in_memory)).replace("NEVER", json.dumps(list(never))).encode()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path == "/getSiteInfo":
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
            assert "no figures" not in did                           # waited for the placeholders to fill
            fonts = s._do(lambda: s._page.evaluate(
                "[getComputedStyle(document.querySelector('.row span')).fontFamily,"
                " getComputedStyle(document.querySelector('i.fa')).fontFamily]"))
            assert fonts[0].startswith('"DejaVu Sans"') and fonts[1] == "monospace", fonts   # the PC's font, icons kept
            assert ("Monitoring > Tank Status" in did) == in_memory   # the menu when a reload logs out
            assert s.alive()
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
    from tank_stock import fueltrans
    monkeypatch.setattr(fueltrans, "DATA_WAIT", 8)
    server = serve(False, never=(3,))
    s = FuelTransSession(f"http://127.0.0.1:{server.server_port}", "Dealer", "123456", settle=0)
    try:
        png, did = s.shot()
        assert did.endswith("1 card still had no figures after 8 s"), did
        if shutil.which("tesseract") and shutil.which("convert"):
            boxes, read = cards_mod.read_all(png)
            assert read[1]["volume"] == 8787.48 and read[4]["volume"] == 2513.75
            assert read[3]["volume"] == 1000000.0                    # the placeholder: the decant checks refuse it
    finally:
        s.close()
        server.shutdown()
