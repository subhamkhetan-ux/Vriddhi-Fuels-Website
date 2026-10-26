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
import os
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from .capture import CaptureError

URL = "http://127.0.0.1:13000"        # the tunnel's end (infra/fueltrans/server-setup.sh)
USER = "Dealer"
# The PC's screen, so FuelTrans lays the cards out as there, drawn 1.4 times
# as large: what AnyDesk showed on the 1920 x 1080 virtual display, which the
# card reader is tuned to (FuelTrans' small 10 px labels read reliably).
VIEWPORT = {"width": 1366, "height": 768}
SCALE = 1.4
TANK_PAGE = "/tank-dashboard"
CONFIG = "/assets/data/config.json"   # where FuelTrans' page reads its backend address
PROBLEM_PNG = "fueltrans-problem.png"  # what the browser showed when a read failed (in TANK_STOCK_HOME)
LOGIN_WAIT = 20                       # seconds for the user list, and for the login to go through
CARDS_WAIT = 40                       # seconds for the tank cards to show their figures
SETTLE = 3                            # seconds more, for every card's figures to fill in
FRESH_EVERY = 1800                    # seconds: the page is reloaded this often while live
ACTION_WAIT = 120                     # seconds any one browser step may take


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
    lost = "the IOCL PC's FuelTrans tunnel went down (PC off or offline)"

    def __init__(self, url: str = URL, user: str = USER, password: str = "", *, settle: int = SETTLE):
        self.url, self.user, self.password = url.rstrip("/"), user, password
        self.settle = settle
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="fueltrans")
        self._pw = self._browser = self._page = None
        self._fresh_at = 0.0

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()

    def _do(self, fn, *args):
        return self._pool.submit(fn, *args).result(timeout=ACTION_WAIT + CARDS_WAIT)

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

    def _go(self, path: str) -> None:
        try:
            self._page.goto(self.url + path, wait_until="domcontentloaded", timeout=30_000)
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
        page.wait_for_timeout(int(self.settle * 1000))
        return ", ".join(did)

    def _png(self) -> bytes:
        self._start()
        return self._page.screenshot(type="png")

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

    def alive(self) -> bool:
        """FuelTrans still answers through the tunnel."""
        if self._page is None:
            return False
        try:
            with urlopen(self.url + "/assets/data/config.json", timeout=5) as r:
                return r.status == 200
        except HTTPError as exc:
            return exc.code < 500
        except (URLError, OSError):
            return False

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
        print(f"  Tank {no} ({card.get('product')}): volume {card.get('volume')} L, "
              f"ullage {card.get('ullage')} L, height {card.get('height')} mm")
    print("Read through FuelTrans: it works." if read else "No tank cards were read: send me this output.")
    return 0 if read else 1


if __name__ == "__main__":
    raise SystemExit(main())
