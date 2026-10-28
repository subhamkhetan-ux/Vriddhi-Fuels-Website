"""FuelTrans' Tank Status page in a browser on this server, instead of the
IOCL PC's screen through AnyDesk.

The PC keeps an SSH tunnel open to this server (infra/fueltrans/), so
FuelTrans answers here at http://127.0.0.1:13000 exactly as it does at
localhost:3000 on the PC. A headless Chromium logs in to it (user Dealer by
default) and opens Tank Status; its screenshots are what AnyDesk's were, so
the cards are found, read and pictured the same way (cards.py), only sharper.
Nothing runs on, or changes on, the PC, and there is no session limit.

``FuelTransSession`` has ``capture.Session``'s methods, so the service uses
either. Playwright's objects belong to the thread that made them, and the
service calls a session from several threads (the live loop, the phone page,
a GitHub job), so each session runs its browser in a thread of its own and
the methods hand their work to it.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import mimetypes
import os
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import urlopen

from .capture import CaptureError
from .cards import PRODUCTS, TIME
from .pumps import packets as engine_packets

URL = "http://127.0.0.1:13000"        # the tunnel's end (infra/fueltrans/server-setup.sh)
USER = "Dealer"
# The PC's screen (1920 x 1080, drawn 1:1), so FuelTrans lays the cards out
# as there: what AnyDesk showed on its 1920 x 1080 virtual display, which the
# card reader is tuned to. (Narrower, FuelTrans' 14 px figures wrap.)
VIEWPORT = {"width": 1920, "height": 1080}
SCALE = 1
# The PC draws FuelTrans in DejaVu Sans (its CSS fonts aren't on the PC), and
# the card reader is tuned to that; this server would pick an Arial-like font
# instead. Icon fonts (Font Awesome's <i class="fa ...">) keep their own.
PC_FONT = """body, body *:not(i):not(.fa):not([class*="fa-"]):not([class*="icon"]) {
  font-family: "DejaVu Sans", sans-serif !important; }"""
PC_FONT_SCRIPT = ("document.addEventListener('DOMContentLoaded', () => {"
                  " const s = document.createElement('style');"
                  f" s.textContent = {json.dumps(PC_FONT)}; document.head.appendChild(s); }});")
TANK_PAGE = "/tank-dashboard"
CONFIG = "/assets/data/config.json"   # where FuelTrans' page reads its backend address
PROBLEM_PNG = "fueltrans-problem.png"  # what the browser showed when a read failed (in TANK_STOCK_HOME)
LOGIN_WAIT = 20                       # seconds for the user list, and for the login to go through
CARDS_WAIT = 40                       # seconds for the tank cards to show their figures
SETTLE = 3                            # seconds more, for every card's figures to fill in
DATA_WAIT = 45                        # seconds for every card's first live figures (see _data)
NO_DATA = re.compile(r"00/00/0000")   # a card's "Last Updated" before its first figures came
FRESH_EVERY = 1800                    # seconds: the page is reloaded this often while live
STALE_RELOAD = 150                    # seconds without any card's "Last Updated" moving: reloaded
UPDATED = re.compile(r"Last\s*Updated", re.I)
ACTION_WAIT = 120                     # seconds any one browser step may take
LOAD_WAIT = 120                       # seconds FuelTrans' page may take to load (its files come over the PC's upload)
# FuelTrans' program files (names with their content's fingerprint: a new
# version has new names), fonts and pictures: kept here once fetched, so
# opening FuelTrans moves a few KB over the station's upload, not ~4.6 MB.
FILES = re.compile(r"\.[0-9a-f]{16,}\.(?:js|css)$|\.(?:woff2?|ttf|eot|otf|png|jpe?g|gif|svg|ico)$", re.I)
FILES_DIR = "fueltrans-files"          # (in TANK_STOCK_HOME)
KEPT_PACKETS = 12                     # a tank's last live-data packets kept (to match the screen's)
SHOT_TRIES = 3                        # screenshots taken at most for one whose cards held still
DETAILS_AGAIN = 300                   # seconds before FuelTrans' tank list is asked for again, if it failed
LOST_AFTER = 30                       # seconds of FuelTrans not answering before the session is lost
PROBE_WAIT = 10                       # seconds one "does FuelTrans answer?" may take


def _down(exc: Exception) -> CaptureError:
    text = str(exc)
    if re.search(r"ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ECONNREFUSED", text):
        return CaptureError("The IOCL PC isn't connected to this server: its FuelTrans tunnel is down "
                            "(PC off, offline, or its fueltrans-tunnel service stopped).")
    return CaptureError(f"FuelTrans didn't open: {text.splitlines()[0][:200] if text else type(exc).__name__}")


class FuelTransSession:
    """FuelTrans in a headless browser, logged in, on Tank Status.

    ``open()`` logs in; ``shot()`` takes a screenshot of Tank Status (logging
    in again, or opening the page, if need be); ``screen()`` takes one of
    whatever the page shows; ``alive()`` says whether FuelTrans still answers
    through the tunnel; ``close()`` closes the browser."""

    position = 1                       # (AnyDesk's sessions say which of the PC's IDs connected)
    @property
    def lost(self) -> str:
        """Why the session was lost, for the page and Telegram."""
        why = f": {self._down_why}" if self._down_why else ""
        return (f"the IOCL PC's FuelTrans tunnel went down (no answer for {LOST_AFTER} s{why}; "
                "the station's internet, or the PC off)")

    def __init__(self, url: str = URL, user: str = USER, password: str = "", *, settle: int = SETTLE):
        self.url, self.user, self.password = url.rstrip("/"), user, password
        self.settle = settle
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="fueltrans")
        self._pw = self._browser = self._page = None
        self._fresh_at = 0.0
        self._clocks, self._clocks_at = "", 0.0   # the cards' "Last Updated" times, and since when
        self._down_since, self._down_why = None, ""   # FuelTrans not answering: since when, and how
        self._tanks: dict[int, list[dict]] = {}           # tank -> its last tankStatusPkts, newest last
        self._polls: list = []                             # live-data replies over HTTP, not yet looked at
        self._events: dict[str, int] = {}                  # the live data's events seen, by name (for why_no_figures)
        self._shown_last: list[str] = []                   # the cards' "Last Updated" lines at the last screenshot
        self._details: dict[int, dict] | None = None      # tank -> FuelTrans' tankDetails row
        self._details_failed = float("-inf")               # (when asking for it last failed)
        self.last_figures: dict[int, dict] = {}           # the exact figures at the last screenshot

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()

    def _do(self, fn, *args):
        return self._pool.submit(fn, *args).result(timeout=2 * LOAD_WAIT + ACTION_WAIT + CARDS_WAIT + DATA_WAIT)

    # ---- in the browser's thread -----------------------------------------
    def _start(self) -> None:
        if self._page is not None:
            return
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        exe = os.environ.get("TANK_STOCK_CHROMIUM") or None
        self._browser = self._pw.chromium.launch(headless=True, executable_path=exe,
                                                 args=["--disable-dev-shm-usage"])
        self._page = self._browser.new_page(viewport=VIEWPORT, device_scale_factor=SCALE)
        self._page.set_default_timeout(ACTION_WAIT * 1000)
        self._page.route("**" + CONFIG, self._config)
        self._page.route(lambda url: bool(FILES.search(urlparse(url).path)), self._file)
        self._page.add_init_script(PC_FONT_SCRIPT)
        self._page.on("websocket", self._on_socket)
        self._page.on("response", self._on_response)

    # ---- the exact figures: FuelTrans' own live data, as its page receives it.
    # Its page gets each tank's figures as a "tankStatusPkt" over socket.io
    # (a websocket, or HTTP polling before that's up) and shows them on the
    # tank's card; any other event carrying a tank's figures (its tankId,
    # lastUpdated and volume) is kept the same way. A screenshot's figures are the packets whose "Last Updated"
    # is the very one its card shows: exactly what the picture says, with no
    # reading of the picture. A tank without one (FuelTrans changed its live
    # data, say) is read off the screen as before.
    def _on_socket(self, ws) -> None:
        if "socket.io" in ws.url:
            ws.on("framereceived", self._on_frame)

    def _on_response(self, response) -> None:
        if "/socket.io/" in response.url and "transport=polling" in response.url:
            self._polls.append(response)               # (its body is read outside the event)

    def _on_frame(self, payload) -> None:
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8", "replace")
        if not isinstance(payload, str) or not payload.startswith("42"):
            return
        try:
            name, *args = json.loads(payload[2:])
        except (ValueError, TypeError):
            return
        if isinstance(name, str) and (name in self._events or len(self._events) < 50):
            self._events[name] = self._events.get(name, 0) + 1
        items = args[0] if args and isinstance(args[0], list) else args[:1]
        for pkt in items:
            if not (isinstance(pkt, dict) and "tankId" in pkt and "lastUpdated" in pkt
                    and ("prodcutVolume" in pkt or "productVolume" in pkt)):
                continue
            try:
                kept = self._tanks.setdefault(int(pkt["tankId"]), [])
            except (TypeError, ValueError):
                continue
            kept.append(pkt)
            del kept[:-KEPT_PACKETS]

    def _read_polls(self) -> None:
        polls, self._polls = self._polls, []
        for response in polls:
            try:
                body = response.text()
            except Exception:  # noqa: BLE001 - gone: the websocket brings the next ones
                continue
            for packet in engine_packets(body):
                self._on_frame(packet)

    def _shown(self) -> list[str]:
        """The cards' "Last Updated" lines, as the page shows them now."""
        try:
            return self._page.get_by_text(UPDATED).all_inner_texts()
        except Exception:  # noqa: BLE001 - no exact figures for this screen
            return []

    def why_no_figures(self, no: int) -> str:
        """Why a tank had no exact figures at the last screenshot: what the
        cards showed, the tank's packets' times, and the live events seen."""
        times = [str(p.get("lastUpdated")) for p in self._tanks.get(no, [])][-5:]
        shown = [m.group(0) for m in (TIME.search(t) for t in self._shown_last) if m]
        events = ", ".join(f"{k}×{v}" for k, v in sorted(self._events.items(), key=lambda kv: -kv[1])[:8])
        return (f"cards show {shown or 'nothing'}; Tank {no}'s live packets {times or 'none'}; "
                f"live events {events or 'none'}")

    def _tank_details(self) -> dict[int, dict]:
        """FuelTrans' tank list (each tank's capacity and product), once."""
        if self._details is None and time.monotonic() - self._details_failed >= DETAILS_AGAIN:
            try:
                with urlopen(self.url + "/tankDetails", timeout=PROBE_WAIT) as r:
                    rows = json.loads(r.read())
                self._details = {int(t["tank_no"]): t for t in rows if isinstance(t, dict) and "tank_no" in t}
            except (OSError, ValueError, KeyError, TypeError):
                self._details_failed = time.monotonic()
        return self._details or {}

    def _figures(self, shown: list[str]) -> dict[int, dict]:
        """{tank: exact figures} for the cards showing ``shown`` times."""
        self._read_polls()
        times = {_when(m.groups()) for m in (TIME.search(t) for t in shown) if m}
        out, details = {}, None
        for no, kept in list(self._tanks.items()):
            for pkt in reversed(kept):
                m = TIME.search(str(pkt.get("lastUpdated") or ""))
                if m and _when(m.groups()) in times:
                    if details is None:
                        details = self._tank_details()
                    card = card_from_packet(pkt, details.get(no) or {})
                    if card:
                        out[no] = card
                    break
        return out

    def _config(self, route) -> None:
        """FuelTrans' page asks its backend at config.json's baseUrl,
        http://localhost:3000: right on the PC, nothing here. This browser
        gets its own address instead (the same FuelTrans, through the tunnel)."""
        try:
            resp = route.fetch()
            cfg = resp.json()
            if not isinstance(cfg, dict):
                raise ValueError("not an object")
            cfg["baseUrl"] = self.url
            route.fulfill(response=resp, body=json.dumps(cfg), content_type="application/json")
        except Exception:  # noqa: BLE001 - FuelTrans' own file, then
            route.continue_()

    def _file(self, route) -> None:
        """One of FuelTrans' program files, fonts or pictures: from this
        server's copy, else through the tunnel (and kept)."""
        name = re.sub(r"[^A-Za-z0-9._-]", "_", urlparse(route.request.url).path.lstrip("/"))[-180:]
        home = Path(os.environ.get("TANK_STOCK_HOME", "/opt/agents/tank-stock")) / FILES_DIR
        kind = mimetypes.guess_type(name)[0] or "application/octet-stream"
        try:
            return route.fulfill(status=200, body=(home / name).read_bytes(), content_type=kind)
        except OSError:
            pass
        try:
            resp = route.fetch(timeout=LOAD_WAIT * 1000)
        except Exception:  # noqa: BLE001 - the browser tries it itself, then
            return route.continue_()
        body = resp.body()
        if resp.status == 200 and body:
            try:
                home.mkdir(parents=True, exist_ok=True)
                tmp = home / f".{name}.{os.getpid()}.tmp"
                tmp.write_bytes(body)
                os.replace(tmp, home / name)
            except OSError:
                pass                                  # (not kept: fetched again next time)
        route.fulfill(response=resp, body=body)

    def _go(self, path: str) -> None:
        try:
            self._page.goto(self.url + path, wait_until="domcontentloaded", timeout=LOAD_WAIT * 1000)
        except Exception as exc:  # noqa: BLE001 - said in plain words
            raise _down(exc) from None
        self._fresh_at = time.monotonic()

    def _login(self) -> None:
        page = self._page
        if not self.password:
            raise CaptureError("The FuelTrans password isn't saved here yet: run "
                               "infra/fueltrans/tank-stock-setup.sh on the server.")
        want = self.user.strip().lower()
        select = page.locator("select").first
        if select.count():
            # the user list comes from FuelTrans (getSiteUsers) after the page loads
            deadline = time.monotonic() + LOGIN_WAIT
            value = None
            while value is None and time.monotonic() < deadline:
                for opt in select.locator("option").all():
                    if (opt.inner_text() or "").strip().lower() == want:
                        value = opt.get_attribute("value")
                        break
                else:
                    time.sleep(0.5)
            if value is None:
                raise CaptureError(f"FuelTrans' login page has no user “{self.user}” "
                                   "(its user list didn't load: is FuelTrans running on the PC?).")
            select.select_option(value=value)
        else:
            page.locator("input:not([type=password]):not([type=hidden])").first.fill(self.user)
        page.locator("input[type=password]").first.fill(self.password)
        button = page.get_by_role("button", name=re.compile(r"log\s*in", re.I))
        (button.first if button.count() else page.get_by_text(re.compile(r"^\s*log\s*in\s*$", re.I)).first).click()
        deadline = time.monotonic() + LOGIN_WAIT
        while time.monotonic() < deadline:
            page.wait_for_timeout(500)
            if "/login" not in page.url and page.locator("input[type=password]").count() == 0:
                return
        raise CaptureError(f"FuelTrans didn't accept the login (user {self.user}): "
                           "check the password saved by infra/fueltrans/tank-stock-setup.sh.")

    def _cards_shown(self, wait: float) -> bool:
        try:
            self._page.get_by_text(re.compile(r"product\s*volume", re.I)).first.wait_for(
                state="visible", timeout=int(wait * 1000))
            return True
        except Exception:  # noqa: BLE001 - not there
            return False

    def _menu_to_tanks(self) -> None:
        """What a person does: Monitoring in the menu bar, then Tank Status."""
        page = self._page
        try:
            page.get_by_text(re.compile(r"^\s*monitoring\s*$", re.I)).first.click(timeout=10_000)
            page.get_by_text(re.compile(r"^\s*tank\s*status\s*$", re.I)).first.click(timeout=10_000)
        except Exception:  # noqa: BLE001 - said below if the cards don't come
            pass

    def _tank_status(self) -> str:
        """Bring Tank Status up with its figures; says what it took. A
        failure keeps what the page showed (PROBLEM_PNG) and says where it was."""
        self._start()
        try:
            return self._to_tanks()
        except CaptureError as exc:
            where = ""
            try:
                where = self._page.url.replace(self.url, "") or "/"
                png = self._page.screenshot(type="png")
                home = Path(os.environ.get("TANK_STOCK_HOME", "/opt/agents/tank-stock"))
                (home / PROBLEM_PNG).write_bytes(png)
            except Exception:  # noqa: BLE001 - the error says what it can
                pass
            raise CaptureError(f"{exc} (page: {where})" if where else str(exc)) from None

    def _settled(self, wait: float) -> str:
        """What FuelTrans shows once it has started (an Angular app: the
        login redirect and the cards come a moment after the page loads):
        "login", "cards", or "" if neither within ``wait`` seconds."""
        page, deadline = self._page, time.monotonic() + wait
        while True:
            if page.locator("input[type=password]").count():
                return "login"
            if self._cards_shown(0.5):
                return "cards"
            if time.monotonic() >= deadline:
                return ""
            page.wait_for_timeout(500)

    def _to_tanks(self) -> str:
        page, did = self._page, []
        if (TANK_PAGE in page.url and time.monotonic() - self._fresh_at < FRESH_EVERY
                and self._settled(2) == "cards"):
            return "already on Tank Status"
        self._go(TANK_PAGE)
        did.append("opened FuelTrans")
        state = self._settled(LOGIN_WAIT)
        if state == "login":
            self._login()
            did.append(f"logged in as {self.user}")
            if TANK_PAGE not in page.url:
                self._go(TANK_PAGE)
            state = self._settled(CARDS_WAIT)
            if state == "login":               # (the login is kept per page load only)
                self._login()
                self._menu_to_tanks()
                did.append("Monitoring > Tank Status")
                state = self._settled(CARDS_WAIT)
        if state != "cards":
            if not did[-1].startswith("Monitoring"):
                self._menu_to_tanks()
                did.append("Monitoring > Tank Status")
            if self._settled(CARDS_WAIT / 2) != "cards":
                raise CaptureError("FuelTrans opened, but its Tank Status page showed no tank cards.")
        waiting = self._data(DATA_WAIT)
        if waiting:
            did.append(f"{waiting} card{'s' if waiting > 1 else ''} still had no figures after {DATA_WAIT} s")
        page.wait_for_timeout(int(self.settle * 1000))
        return ", ".join(did)

    def _data(self, wait: float) -> int:
        """Wait for every card's first live figures. A freshly opened Tank
        Status page shows each card as a placeholder (OFFLINE, Last Updated
        00/00/0000 00:00:00, 1,000,000.00 ltr, 714.90 mm) until FuelTrans'
        live connection brings that tank's figures, each at its own pace.
        Returns how many cards are still waiting (an ATG probe that is down)."""
        page, deadline = self._page, time.monotonic() + wait
        while True:
            waiting = page.get_by_text(NO_DATA).count()
            if not waiting or time.monotonic() >= deadline:
                return waiting
            page.wait_for_timeout(1000)

    def _keep_fresh(self) -> None:
        """While Tank Status stays open (live monitoring), FuelTrans' live
        connection brings the figures. If it stalls (no card's "Last Updated"
        moves for STALE_RELOAD), or the page is FRESH_EVERY old, open it again."""
        page = self._page
        if page is None or TANK_PAGE not in page.url:
            return
        now = time.monotonic()
        try:
            clocks = " | ".join(page.get_by_text(UPDATED).all_inner_texts())
        except Exception:  # noqa: BLE001 - looked at again next time
            return
        if clocks != self._clocks:
            self._clocks, self._clocks_at = clocks, now
        if now - self._clocks_at >= STALE_RELOAD or now - self._fresh_at >= FRESH_EVERY:
            self._fresh_at = float("-inf")        # (so _to_tanks opens the page again)
            self._tank_status()
            self._clocks, self._clocks_at = "", time.monotonic()

    def _png(self) -> bytes:
        """A screenshot, and (last_figures) the exact figures it shows: taken
        again if a card's "Last Updated" moved while it was being taken."""
        self._start()
        self._keep_fresh()
        for _ in range(SHOT_TRIES):
            before = self._shown()
            png = self._page.screenshot(type="png")
            shown = self._shown()
            if shown == before:
                break
        self._shown_last = shown
        self.last_figures = self._figures(shown) if shown == before else {}
        return png

    def _stop(self) -> None:
        for thing in (self._browser, self._pw):
            try:
                if thing is self._pw and thing:
                    thing.stop()
                elif thing:
                    thing.close()
            except Exception:  # noqa: BLE001 - it is over either way
                pass
        self._pw = self._browser = self._page = None

    # ---- the session's methods (any thread) --------------------------------
    def open(self) -> int:
        try:
            self._do(self._tank_status)
        except BaseException:
            self.close()
            raise
        return self.position

    def _answers(self) -> str:
        """"" if FuelTrans answers through the tunnel, else how it failed."""
        try:
            with urlopen(self.url + CONFIG, timeout=PROBE_WAIT) as r:
                return "" if r.status == 200 else f"HTTP {r.status}"
        except HTTPError as exc:
            return "" if exc.code < 500 else f"HTTP {exc.code}"
        except (URLError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            text = str(reason).lower()
            return ("connection refused: the tunnel itself was down" if "refused" in text else
                    "timed out: the tunnel was too slow" if "timed out" in text or isinstance(reason, TimeoutError)
                    else str(reason)[:120])

    def alive(self) -> bool:
        """FuelTrans still answers through the tunnel, or hasn't for under
        LOST_AFTER seconds: the station's internet blips now and then, and
        the page (FuelTrans' own live connection) rides that out by itself."""
        if self._page is None:
            return False
        failed = self._answers()
        if not failed:
            self._down_since, self._down_why = None, ""
            return True
        now = time.monotonic()
        if self._down_since is None:
            self._down_since = now
        self._down_why = failed
        return now - self._down_since < LOST_AFTER

    def screen(self) -> bytes:
        return self._do(self._png)

    def ended(self, png: bytes) -> str:
        return ""

    def shot(self) -> tuple[bytes, str]:
        """(PNG of Tank Status, what was done to reach it)."""
        def run():
            did = self._tank_status()
            return self._png(), did
        return self._do(run)

    def windows(self) -> list:
        return []

    def close(self) -> None:
        try:
            self._pool.submit(self._stop).result(timeout=60)
        except Exception:  # noqa: BLE001 - closing anyway
            pass
        self._pool.shutdown(wait=False)


def _when(groups) -> tuple:
    """A "Last Updated" time as numbers (seconds 0 if not shown)."""
    return tuple(int(g or 0) for g in groups)


def card_from_packet(pkt: dict, details: dict) -> dict | None:
    """A tankStatusPkt as the card reader's figures (cards.read_card's shape),
    exact: None for a card still waiting for its first figures, or a packet
    whose fields aren't the ones known (FuelTrans changed: the screen is read
    instead). ``details``: the tank's tankDetails row (capacity, product;
    without it the decant app's own capacity is used)."""
    when = str(pkt.get("lastUpdated") or "")
    t = TIME.search(when)
    if not t or when.startswith("00/00/0000"):
        return None
    try:
        volume = float(pkt["prodcutVolume"] if "prodcutVolume" in pkt else pkt["productVolume"])
        ullage, height = float(pkt["ullage"]), float(pkt["productLevel"])
        no = int(pkt["tankId"])
    except (KeyError, TypeError, ValueError):
        return None
    num = lambda k: round(float(pkt.get(k) or 0), 2)   # noqa: E731
    product = ""
    for pat, key in PRODUCTS:
        if re.search(pat, str(details.get("product_name") or ""), re.I):
            product = key
    try:
        capacity = float(details.get("capacity") or 0) or None
    except (TypeError, ValueError):
        capacity = None
    card = {"no": no, "time": t.groups(), "capacity": capacity, "volume": round(volume, 2),
            "height": round(height, 2), "water": num("waterVolume"), "ullage": round(ullage, 2),
            "density": num("density"), "densityTc": num("tcDensity"), "temp": num("temperature"),
            "disagree": [], "exact": True}
    if product:
        card["product"] = product
    return card


def main() -> int:
    """python -m tank_stock.fueltrans: read the tanks once with the saved
    login, as the service will (tank-stock-setup.sh's check)."""
    from . import cards
    home = Path(os.environ.get("TANK_STOCK_HOME", "/opt/agents/tank-stock"))
    try:
        login = json.loads((home / "login.json").read_text(encoding="utf-8"))
        session = FuelTransSession(login.get("url") or URL, login.get("user") or USER,
                                   login.get("password") or "")
        try:
            png, did = session.shot()
            exact = session.last_figures
        finally:
            session.close()
    except (OSError, ValueError, CaptureError) as exc:
        print(f"The read failed: {exc}")
        if (home / PROBLEM_PNG).exists():
            print(f"What the browser showed: {home / PROBLEM_PNG}")
        return 1
    boxes, read = cards.read_all(png)
    print(f"  FuelTrans: {did}")
    for no, card in sorted(read.items()):
        ex = exact.get(no)
        if ex:
            card = {**card, **ex}
        print(f"  Tank {no} ({card.get('product')}): volume {card.get('volume')} L, "
              f"ullage {card.get('ullage')} L, height {card.get('height')} mm "
              f"({'exact, from FuelTrans live data' if ex else 'read off the screen'})")
    print("Read through FuelTrans: it works." if read else "No tank cards were read: send me this output.")
    return 0 if read else 1


if __name__ == "__main__":
    raise SystemExit(main())
