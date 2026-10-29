"""Live tank stock straight from FuelTrans' live data: no browser.

FuelTrans' Tank Status page gets each tank's figures as a ``tankStatusPkt``
over its live connection (socket.io, EIO 3), about every 5 s per tank, the
same connection the Pumps tab listens to (pumps.py). Live monitoring listens
to it the same way, through the IOCL PC's tunnel, plain HTTP long-polling:
connected in a second or two and every figure as soon as FuelTrans has it,
where a browser took about a minute to open, log in and show the cards, and
a screenshot each read. It only ever *listens*: nothing here sends an event
on that connection.

Pictures are for proof only, so they're taken when asked for: a capture,
and an automatic decantation's stock before and after. For those a
``FuelTransSession`` (fueltrans.py: FuelTrans in a headless browser) opens
on the first one and closes again PICTURES_IDLE after the last, unless
``keep_pictures()`` (an automatic decantation running, the screen being
read instead) says to keep it.

``FuelTransFeed`` has the session methods live monitoring uses (open, alive,
lost, screen, shot, close, ...), so the service runs it as any other
session, plus ``figures()``: each tank's latest exact figures. If FuelTrans
doesn't give its live data this way (``unavailable``) the screen is read
instead, as before.
"""
from __future__ import annotations

import json
import re
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .capture import CaptureError
from .fueltrans import LOST_AFTER, FuelTransSession, card_from_packet
from .pumps import FEED, PING_EVERY, POLL_WAIT, RETRY, packets

FIRST_WAIT = 12          # seconds open() waits for every tank's first figures (each comes every ~5 s)
STALE_S = 60             # a tank's figures without a newer packet this long aren't given any more
PICTURES_IDLE = 300      # seconds the picture browser stays open after its last picture
DETAILS_AGAIN = 300      # seconds before FuelTrans' tank list is asked for again, if it failed


def _fetch(url: str, data: bytes | None = None, timeout: float = POLL_WAIT) -> str:
    req = Request(url, data=data, method="POST" if data is not None else "GET")
    with urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def _why(exc: BaseException) -> str:
    reason = getattr(exc, "reason", exc)
    text = str(reason).lower()
    if "refused" in text:
        return "connection refused: the tunnel itself was down"
    if "reset" in text or "remote end closed" in text:
        return "connection reset: the tunnel dropped it"
    if "timed out" in text or isinstance(reason, TimeoutError):
        return "timed out: the tunnel was too slow"
    return str(reason)[:120] or type(exc).__name__


class FuelTransFeed:
    """FuelTrans' live data for live monitoring; a browser only for pictures."""

    position = 1                       # (AnyDesk's sessions say which of the PC's IDs connected)

    def __init__(self, url: str, user: str, password: str, *, keep_pictures=lambda: False,
                 fetch=_fetch, clock=time.monotonic):
        self.url, self.user, self.password = url.rstrip("/"), user, password
        self.keep_pictures = keep_pictures
        self.fetch, self.clock = fetch, clock
        self.unavailable = ""          # why FuelTrans' live data can't be listened to (the screen is read instead)
        self._stop = threading.Event()
        self._thread = None
        self._lock = threading.Lock()
        self._tanks: dict[int, tuple[float, dict]] = {}   # tank -> (when it came, its latest tankStatusPkt)
        self._down_since, self._down_why = None, ""        # FuelTrans not answering: since when, and how
        self._details: dict[int, dict] | None = None
        self._details_failed = float("-inf")
        self._pictures: FuelTransSession | None = None
        self._pictures_at = 0.0

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()

    # ---- the live data -----------------------------------------------------
    def _handshake(self) -> str:
        opened = self.fetch(self.url + FEED, timeout=20)
        sid = re.search(r'"sid"\s*:\s*"([^"]+)"', opened)
        if not sid:
            raise ValueError(f"its live connection didn't open ({opened[:80]!r})")
        self._take(opened)
        return sid.group(1)

    def _take(self, body: str) -> None:
        """A long poll's packets: each tank's figures kept (pumps' and the rest let go)."""
        for pkt in packets(body):
            if pkt == "1":                                   # the server closed the session
                raise ValueError("FuelTrans closed the live connection")
            if not pkt.startswith("42"):
                continue
            try:
                name, *args = json.loads(pkt[2:])
            except ValueError:
                continue
            items = args[0] if args and isinstance(args[0], list) else args[:1]
            for a in items:
                if not (isinstance(a, dict) and "tankId" in a and "lastUpdated" in a
                        and ("prodcutVolume" in a or "productVolume" in a)):
                    continue
                try:
                    no = int(a["tankId"])
                except (TypeError, ValueError):
                    continue
                with self._lock:
                    self._tanks[no] = (self.clock(), a)

    def _listen(self, sid: str) -> None:
        url = f"{self.url}{FEED}&sid={sid}"
        ping = self.clock() + PING_EVERY
        while not self._stop.is_set():
            if self.clock() >= ping:
                self.fetch(url, data=b"1:2", timeout=10)    # engine.io ping: not a socket.io event
                ping = self.clock() + PING_EVERY
            body = self.fetch(url)
            self._down_since, self._down_why = None, ""
            self._take(body)

    def _run(self, sid: str | None) -> None:
        """Listen until closed; open the connection again after a failure
        (the tunnel blipping, FuelTrans restarting)."""
        tries = 0
        while not self._stop.is_set():
            try:
                self._listen(sid or self._handshake())
                return
            except (OSError, URLError, HTTPError, ValueError) as exc:
                if self._down_since is None:
                    self._down_since = self.clock()
                self._down_why = _why(exc)
            sid = None
            self._stop.wait(RETRY[min(tries, len(RETRY) - 1)])
            tries += 1

    def _tank_details(self) -> dict[int, dict]:
        """FuelTrans' tank list (each tank's capacity and product), once."""
        if self._details is None and self.clock() - self._details_failed >= DETAILS_AGAIN:
            try:
                rows = json.loads(self.fetch(self.url + "/tankDetails", timeout=10))
                self._details = {int(t["tank_no"]): t for t in rows if isinstance(t, dict) and "tank_no" in t}
            except (OSError, ValueError, KeyError, TypeError):
                self._details_failed = self.clock()
        return self._details or {}

    def figures(self) -> dict[int, dict]:
        """{tank: its latest exact figures} (cards.read_card's shape), from
        packets under STALE_S old."""
        now = self.clock()
        with self._lock:
            latest = {no: pkt for no, (at, pkt) in self._tanks.items() if now - at < STALE_S}
        details = self._tank_details() if latest else {}
        out = {}
        for no, pkt in latest.items():
            card = card_from_packet(pkt, details.get(no) or {})
            if card:
                out[no] = card
        return out

    # ---- the session's methods ------------------------------------------------
    def open(self) -> int:
        try:
            sid = self._handshake()
        except HTTPError as exc:
            # FuelTrans answers, but not with its live data here: the screen, as before
            self.unavailable = f"HTTP {exc.code} for its live data"
        except ValueError as exc:
            self.unavailable = str(exc)
        except (URLError, OSError) as exc:
            why = _why(exc)
            if "refused" in why:
                raise CaptureError("The IOCL PC isn't connected to this server: its FuelTrans tunnel is down "
                                   "(PC off, offline, or its fueltrans-tunnel service stopped).") from None
            raise CaptureError(f"FuelTrans didn't answer: {why}") from None
        if self.unavailable:
            self.shot()                                      # (opens the browser: it reads the screen)
            return self.position
        self._tank_details()
        self._thread = threading.Thread(target=self._run, args=(sid,), daemon=True, name="tank-feed")
        self._thread.start()
        # every tank's first figures (each comes about every 5 s), so the first read has them all
        until, seen = self.clock() + FIRST_WAIT, -1
        while self.clock() < until and not self._stop.is_set():
            with self._lock:
                count = len(self._tanks)
            if count and count == seen and self._details and count >= len(self._details):
                break
            seen = count
            time.sleep(0.5)
        return self.position

    @property
    def lost(self) -> str:
        if self.unavailable and self._pictures:
            return self._pictures.lost
        why = f": {self._down_why}" if self._down_why else ""
        return (f"the IOCL PC's FuelTrans tunnel went down (no answer for {LOST_AFTER} s{why}; "
                "the station's internet, or the PC off)")

    def alive(self) -> bool:
        """FuelTrans' live data still comes, or has stopped for under
        LOST_AFTER seconds (the listener connects again by itself meanwhile).
        It also closes the picture browser once it's idle."""
        self._tidy()
        if self.unavailable:
            return bool(self._pictures and self._pictures.alive())
        if self._thread is None or not self._thread.is_alive():
            return False
        return self._down_since is None or self.clock() - self._down_since < LOST_AFTER

    # ---- pictures, when asked for ----------------------------------------------
    def _browser(self) -> FuelTransSession:
        with self._lock:
            if self._pictures is None:
                self._pictures = FuelTransSession(self.url, self.user, self.password)
            self._pictures_at = self.clock()
            return self._pictures

    def _tidy(self) -> None:
        """The picture browser closed PICTURES_IDLE after its last picture."""
        if (self._pictures is None or self.unavailable or self.clock() - self._pictures_at < PICTURES_IDLE
                or self.keep_pictures()):
            return
        with self._lock:
            idle = self._pictures if self.clock() - self._pictures_at >= PICTURES_IDLE else None
            self._pictures = None if idle else self._pictures
        if idle:
            idle.close()

    @property
    def last_figures(self) -> dict[int, dict]:
        """The exact figures of the last picture."""
        return self._pictures.last_figures if self._pictures else {}

    def why_no_figures(self, no: int) -> str:
        return self._pictures.why_no_figures(no) if self._pictures else "no picture taken"

    def shot(self) -> tuple[bytes, str]:
        """(a picture of Tank Status, what was done to reach it)."""
        return self._browser().shot()

    def screen(self) -> bytes:
        """A picture of Tank Status now (b"" while FuelTrans doesn't answer:
        no browser is opened through a tunnel that's down)."""
        if self._down_since is not None and not self.unavailable:
            return b""
        browser = self._browser()
        return browser.screen() if browser._page is not None else browser.shot()[0]

    def ended(self, png: bytes) -> str:
        return ""

    def windows(self) -> list:
        return []

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            pictures, self._pictures = self._pictures, None
        if pictures:
            pictures.close()
