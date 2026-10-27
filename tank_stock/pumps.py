"""Pump and nozzle status from FuelTrans' live connection (the Pumps tab).

FuelTrans pushes each pump's status about once a second over its live
connection (socket.io, protocol EIO 3), the same one that brings the tank
figures to its pages: ``pumpStatusPkt`` = {PumpId, status, nozzleId,
trxnVolume, trxnAmount, lockval, npndstatus, ...}. This listens to it
through the IOCL PC's tunnel, plain HTTP long-polling, no browser. It only
ever *listens*: FuelTrans' Pump Status page can also send pump controls on
that connection (sendPumpControl), and nothing here ever sends an event.

Off unless you start it, and then completely idle again once it stops: no
thread waking, no request to FuelTrans. It stops when you press Stop, when
no nozzle is ticked, or UNSEEN_STOP after the Pumps page was last open (it
is for watching, not for running unattended). A restart leaves it off.

While it runs, for the nozzles you tick:
- live status, litres and rupees of the sale in progress, how long it has
  been fuelling and its flow now;
- each nozzle's usual flow, learnt from its finished sales (litres over the
  time it fuelled), so a slow and a fast nozzle each get their own;
- a preset tapped on the phone (the attendant sets it on the dispenser's
  keypad, which FuelTrans never sees): progress and the time left;
- interlocks: ``lockval`` is a bit field (bit i = one interlock, named as
  FuelTrans' Pump Status page names them) plus the NPND flag; Telegram is
  told when one comes on or clears on a watched nozzle.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import threading
import time
import traceback
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# FuelTrans' own names for pumpStatusPkt.status (its Pump Status page).
STATUS = ("UNKNOWN", "INOPERATIVE", "IDLE", "CALLING", "AUTHORISED", "FUELING",
          "SUSPENDED", "SALE END", "OFFLINE", "PUMP LOCK", "PUMP STOP")
FUELING, SUSPENDED, SALE_END = 5, 6, 7
# lockval bit -> interlock, as FuelTrans' Pump Status page names them: it
# writes lockval in binary, reverses it, and calls getInterlock(digit, bit)
# for each digit (bit 0 is the lowest). Bits it has no name for (0, 19) show
# as "interlock bit N".
INTERLOCKS: dict[int, str] = {
    1: "TEST INTERLOCK", 2: "PRESET INTERLOCK", 3: "NPND INTERLOCK", 4: "ATG INTERLOCK",
    5: "WATER HIGH INTERLOCK", 6: "PRODUCT LOW INTERLOCK", 7: "TTRECEIPT INTERLOCK",
    8: "DELIVERY INPROGRESS INTERLOCK", 9: "PUMP LOCK INTERLOCK", 10: "PUMP BLOCK INTERLOCK",
    11: "NOZZLE BLOCK INTERLOCK", 12: "PUMP UM INTERLOCK", 13: "NOZZLE UM INTERLOCK",
    14: "TANK BLOCK INTERLOCK", 15: "TANK UM INTERLOCK", 16: "NOPRICE INTERLOCK",
    17: "DENSITY INTERLOCK", 18: "INTERLOCK (bit 18)", 20: "TANK LEAKAGE INTERLOCK",
}
NPND = "NPND INTERLOCK"   # (also its own flag, npndstatus)
PRODUCTS = {"HS": "HSD", "HSD": "HSD", "MS": "MS", "XG": "XG", "XP": "XP95", "XP95": "XP95"}

FEED = "/socket.io/?EIO=3&transport=polling"
POLL_WAIT = 35          # seconds a long poll may take (FuelTrans answers within ~25 s)
PING_EVERY = 20         # seconds: engine.io keep-alive ("2"), so the session isn't dropped
RETRY = (2, 5, 10, 30, 60)   # seconds before opening the connection again after a failure
LAYOUT_EVERY = 3600     # seconds: the pumps, nozzles and prices are read again this often
LAYOUT_RETRY = 60       # seconds: the Pumps page open but the pump list couldn't be read: asked again
STALE_AFTER = 15        # seconds without a packet: the page says the data is old
FLOW_WINDOW = 10        # seconds of a sale the flow "now" is taken over
MIN_SALE_L = 1.0        # a sale smaller than this (or under 10 s) doesn't teach the speed
MIN_SALE_S = 10
GAP_S = 6               # seconds between two fuelling packets beyond which it wasn't flowing
SPEEDS_KEPT = 30        # sales per nozzle its usual flow is the median of
SALES_KEPT = 5          # recent sales shown per watched nozzle
UNSEEN_STOP = 900       # seconds after the Pumps page was last open that monitoring stops by itself
PRESET_KINDS = ("amount", "litres")


def packets(data: str):
    """Engine.io v3 polling payload: "<length>:<packet>" one after another."""
    i = 0
    while i < len(data):
        j = data.find(":", i)
        if j < 0:
            return
        try:
            n = int(data[i:j])
        except ValueError:
            return
        yield data[j + 1:j + 1 + n]
        i = j + 1 + n


def interlocks(lockval, npnd) -> list[str]:
    """The interlocks a pumpStatusPkt says are on, by name."""
    names = []
    try:
        bits = int(lockval or 0)
    except (TypeError, ValueError):
        bits = 0
    i = 0
    while bits >> i:
        if (bits >> i) & 1:
            names.append(INTERLOCKS.get(i, f"interlock bit {i}"))
        i += 1
    if str(npnd) == "1" and NPND not in names:
        names.append(NPND)
    return names


def _flowing(points) -> tuple[float, float]:
    """(seconds, litres) a sale's points flowed for: a gap between two points
    longer than GAP_S (the pump suspended, the trigger let go) isn't flow."""
    secs = moved = 0.0
    for (t1, v1), (t2, v2) in zip(points, points[1:]):
        if 0 < t2 - t1 <= GAP_S:
            secs += t2 - t1
            moved += max(0.0, v2 - v1)
    return secs, moved


def _median(values):
    v = sorted(values)
    return v[len(v) // 2] if v else None


class Pumps:
    """The pumps' live state, what's watched, and what was learnt."""

    def __init__(self, home: Path, url_of, notify=lambda text: True, fetch=None, clock=time.time):
        self.home = home
        self.url_of = url_of              # () -> FuelTrans' address through the tunnel, or "" if none
        self.notify = notify
        self.fetch = fetch or self._fetch
        self.clock = clock
        self.lock = threading.Lock()
        self.layout: dict[int, dict] = {}
        self.layout_at = 0.0
        self.layout_error = ""            # why the pump list couldn't be read, if it couldn't
        self._layout_tried = float("-inf")
        self._layout_busy = threading.Lock()
        self.live: dict[int, dict] = {}
        self.feed = {"connected": False, "since": None, "error": "", "last": None}
        self.on = False                   # monitoring started (never at start-up)
        self.seen_at = 0.0                # the Pumps page last open
        self.stopped = None               # {at, why}: the last time it stopped by itself or was stopped
        self.wake = threading.Event()     # the listener sleeps on this while off
        saved = self._read()
        self.watch = [int(p) for p in saved.get("watch", [])]
        self.presets = {int(k): v for k, v in (saved.get("presets") or {}).items()}
        self.speeds = {int(k): v for k, v in (saved.get("speeds") or {}).items()}
        self.sales = {int(k): v for k, v in (saved.get("sales") or {}).items()}
        self.alerts = saved.get("alerts", True)
        self.told: dict[int, list[str]] = {}

    # ---- saved state -------------------------------------------------------
    def _read(self) -> dict:
        try:
            return json.loads((self.home / "pumps.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save(self) -> None:
        data = {"watch": self.watch, "presets": self.presets, "speeds": self.speeds,
                "sales": self.sales, "alerts": self.alerts}
        try:
            tmp = self.home / "pumps.json.tmp"
            tmp.write_text(json.dumps(data), encoding="utf-8")
            os.replace(tmp, self.home / "pumps.json")
        except OSError:
            traceback.print_exc()

    # ---- what the page changes --------------------------------------------
    def set_watch(self, pumps) -> dict:
        try:
            wanted = sorted({int(p) for p in pumps or []})
        except (TypeError, ValueError):
            raise ValueError("Pumps are numbers.") from None
        if self.layout and any(p not in self.layout for p in wanted):
            raise ValueError("There's no such pump in FuelTrans.")
        with self.lock:
            self.watch = wanted
            self.presets = {p: v for p, v in self.presets.items() if p in wanted}
            self._save()
        if not wanted and self.on:
            self.stop("no nozzle ticked")
        return self.view()

    def start(self) -> dict:
        if not self.url_of():
            raise ValueError("The pumps come from FuelTrans through the IOCL PC's tunnel, "
                             "which this server doesn't use (infra/fueltrans/tank-stock-setup.sh).")
        if not self.watch:
            raise ValueError("Tick the nozzles to watch first.")
        self.on, self.seen_at, self.stopped = True, self.clock(), None
        self.wake.set()
        return self.view()

    def stop(self, why: str = "stopped by you") -> dict:
        if self.on:
            self.on, self.stopped = False, {"at": self.clock(), "why": why}
        self.wake.set()
        return self.view()

    def seen(self) -> None:
        """The Pumps page is open in front of someone."""
        self.seen_at = self.clock()

    def need_layout(self) -> None:
        """The Pumps page is open: read the pump list (one small request) if
        there's none yet or it's LAYOUT_EVERY old, so the nozzles can be
        ticked before monitoring is started. While monitoring, the listener
        keeps it; a failure is asked again after LAYOUT_RETRY."""
        base = self.url_of()
        now = self.clock()
        if (not base or self.on or (self.layout and now - self.layout_at < LAYOUT_EVERY)
                or now - self._layout_tried < LAYOUT_RETRY):
            return
        if not self._layout_busy.acquire(blocking=False):
            return                                     # (another request is reading it)
        try:
            self._layout_tried = now
            self.load_layout(base.rstrip("/"))
            self.layout_error = "" if self.layout else "FuelTrans listed no pumps"
        except (OSError, URLError, HTTPError, ValueError) as exc:
            self.layout_error = _why(exc)
        finally:
            self._layout_busy.release()

    def _unseen(self) -> bool:
        """Running with nobody looking for UNSEEN_STOP: stop."""
        if self.on and self.clock() - self.seen_at >= UNSEEN_STOP:
            self.stop(f"the Pumps page wasn't open for {UNSEEN_STOP // 60} min")
            return True
        return False

    def set_preset(self, pump, kind, value) -> dict:
        try:
            pump = int(pump)
        except (TypeError, ValueError):
            raise ValueError("Which pump?") from None
        with self.lock:
            if value in (None, "", 0):
                self.presets.pop(pump, None)
            else:
                if kind not in PRESET_KINDS:
                    raise ValueError("A preset is in rupees (amount) or litres.")
                try:
                    v = float(value)
                except (TypeError, ValueError):
                    raise ValueError("The preset is a number.") from None
                if not 0 < v <= (200000 if kind == "amount" else 20000):
                    raise ValueError("That preset is out of range.")
                self.presets[pump] = {"kind": kind, "value": v, "at": self.clock()}
            self._save()
        return self.view()

    def set_alerts(self, on) -> dict:
        with self.lock:
            self.alerts = bool(on)
            self._save()
        return self.view()

    # ---- FuelTrans ----------------------------------------------------------
    @staticmethod
    def _fetch(url: str, data: bytes | None = None, timeout: float = POLL_WAIT) -> str:
        req = Request(url, data=data, method="POST" if data is not None else "GET")
        with urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")

    def load_layout(self, base: str) -> None:
        """Pumps, nozzles, products, prices and tanks (getDuPumpNozzleDetails)."""
        rows = json.loads(self.fetch(base + "/getDuPumpNozzleDetails", timeout=20))
        layout = {}
        for r in rows if isinstance(rows, list) else []:
            try:
                pump = int(r["pump_no"])
            except (KeyError, TypeError, ValueError):
                continue
            code = str(r.get("grade_code") or "").upper()
            layout[pump] = {"pump": pump, "du": r.get("du_no"), "nozzle": r.get("nozzle_no"),
                            "make": r.get("make") or r.get("dispenser_type") or "",
                            "product": PRODUCTS.get(code, code or "?"), "price": r.get("grade_price"),
                            "tank": r.get("tank_no1")}
        if layout:
            with self.lock:
                self.layout, self.layout_at = layout, self.clock()

    def on_packet(self, name: str, args: list) -> None:
        a = args[0] if args and isinstance(args[0], dict) else None
        if name != "pumpStatusPkt" or not a:
            return
        self.feed["last"] = self.clock()
        try:
            self.update(int(a.get("PumpId")), a)
        except (TypeError, ValueError):
            pass

    def update(self, pump: int, a: dict) -> None:
        """One pumpStatusPkt: the pump's state, its sale, and what it teaches."""
        now = self.clock()
        try:
            status = int(a.get("status"))
        except (TypeError, ValueError):
            status = 0
        vol, amt = float(a.get("trxnVolume") or 0), float(a.get("trxnAmount") or 0)
        told = None
        with self.lock:
            p = self.live.setdefault(pump, {"sale": None})
            p.update(status=status, volume=round(vol, 3), amount=round(amt, 2), at=now,
                     locks=interlocks(a.get("lockval"), a.get("npndstatus")))
            sale = p.get("sale")
            if status == FUELING:
                if not sale or sale.get("ended"):
                    sale = p["sale"] = {"started": now, "points": []}
                pts = sale["points"]
                if not pts or vol != pts[-1][1] or now - pts[-1][0] >= 5:
                    pts.append((now, vol))
                    if len(pts) > 120:                       # (a long sale: its flow so far, as two points' worth)
                        secs, moved = _flowing(pts[:-60])
                        sale["flowed"] = [sale.get("flowed", [0, 0])[0] + secs, sale.get("flowed", [0, 0])[1] + moved]
                        del pts[:-61]
                sale["fueled_at"] = now
            elif sale and not sale.get("ended") and status != SUSPENDED:
                self._finish(pump, p, sale, now)             # (suspended: the trigger let go, the same sale)
            if pump in self.watch and p["locks"] != self.told.get(pump, []):
                told = (list(self.told.get(pump, [])), list(p["locks"]))
                self.told[pump] = list(p["locks"])
        if told and self.alerts:
            self._tell_locks(pump, *told)

    def _finish(self, pump: int, p: dict, sale: dict, now: float) -> None:
        """A sale ended (under the lock): learn its flow, keep it, drop the preset."""
        sale["ended"] = now
        litres = p["volume"]
        secs, moved = _flowing(sale["points"])
        secs, moved = secs + sale.get("flowed", [0, 0])[0], moved + sale.get("flowed", [0, 0])[1]
        lpm = round(moved / secs * 60, 1) if secs > 0 and moved > 0 else None
        if lpm and litres >= MIN_SALE_L and secs >= MIN_SALE_S:
            self.speeds[pump] = (self.speeds.get(pump, []) + [lpm])[-SPEEDS_KEPT:]
        preset = self.presets.pop(pump, None)
        self.sales[pump] = ([{"ended": now, "litres": litres, "amount": p["amount"],
                              "secs": round(now - sale["started"]), "lpm": lpm,
                              "preset": preset}] + self.sales.get(pump, []))[:SALES_KEPT]
        self._save()

    def _tell_locks(self, pump: int, before: list[str], now: list[str]) -> None:
        name = self.name(pump)
        if now:
            self.notify(f"🔒 {name}: {', '.join(now)}.")
        elif before:
            self.notify(f"🔓 {name}: interlock cleared ({', '.join(before)}).")

    def name(self, pump: int) -> str:
        n = self.layout.get(pump)
        return f"Pump {pump} ({n['product']}, DU {n['du']})" if n else f"Pump {pump}"

    # ---- the loop ------------------------------------------------------------
    def wanted(self) -> bool:
        return self.on and bool(self.watch) and bool(self.url_of()) and not self._unseen()

    def run(self, stop: threading.Event) -> None:
        """Listen while monitoring is on; open the connection again after a
        failure (the tunnel down, FuelTrans restarting). Off, it sleeps until
        started: no timer, no request."""
        tries = 0
        while not stop.is_set():
            if not self.wanted():
                self.feed.update(connected=False, error="")
                self.wake.wait()
                self.wake.clear()
                tries = 0
                continue
            try:
                self._listen(stop)
                tries = 0
            except (OSError, URLError, HTTPError, ValueError) as exc:
                self.feed.update(connected=False, error=_why(exc))
                self.wake.wait(RETRY[min(tries, len(RETRY) - 1)])      # (Stop wakes it at once)
                self.wake.clear()
                tries += 1
            except Exception as exc:  # noqa: BLE001 - keep listening whatever one packet did
                traceback.print_exc()
                self.feed.update(connected=False, error=f"{type(exc).__name__}: {exc}")
                self.wake.wait(RETRY[-1])
                self.wake.clear()

    def _listen(self, stop: threading.Event) -> None:
        base = self.url_of().rstrip("/")
        if self.clock() - self.layout_at >= LAYOUT_EVERY or not self.layout:
            self.load_layout(base)
        opened = self.fetch(base + FEED, timeout=20)
        sid = re.search(r'"sid"\s*:\s*"([^"]+)"', opened)
        if not sid:
            raise ValueError(f"FuelTrans' live connection didn't open ({opened[:80]!r})")
        sid = sid.group(1)
        url = f"{base}{FEED}&sid={sid}"
        self.feed.update(connected=True, since=self.clock(), error="")
        ping = time.monotonic() + PING_EVERY
        while not stop.is_set() and self.wanted() and base == self.url_of().rstrip("/"):
            if time.monotonic() >= ping:
                self.fetch(url, data=b"1:2", timeout=10)        # engine.io ping: not a socket.io event
                ping = time.monotonic() + PING_EVERY
            for pkt in packets(self.fetch(url)):
                if pkt == "1":                                   # the server closed the session
                    raise ValueError("FuelTrans closed the live connection")
                if pkt.startswith("42"):
                    try:
                        name, *args = json.loads(pkt[2:])
                    except ValueError:
                        continue
                    self.on_packet(name, args)
            if self.clock() - self.layout_at >= LAYOUT_EVERY:
                self.load_layout(base)
        self.feed.update(connected=False)

    # ---- the page -----------------------------------------------------------
    def view(self) -> dict:
        now = self.clock()
        with self.lock:
            pumps = [{**n, "watched": n["pump"] in self.watch} for _, n in sorted(self.layout.items())]
            watched = [self._card(p, now) for p in self.watch]
            last = self.feed.get("last")
            return {"available": bool(self.url_of()), "on": self.on, "stopped": self.stopped,
                    "layout_error": "" if self.layout else self.layout_error,
                    "stops_in_s": max(0, round(UNSEEN_STOP - (now - self.seen_at))) if self.on else None,
                    "alerts": self.alerts, "pumps": pumps, "watching": watched,
                    "feed": {**self.feed, "stale": bool(self.watch) and (not last or now - last > STALE_AFTER),
                             "age_s": None if not last else round(now - last)},
                    "statuses": list(STATUS)}

    def _card(self, pump: int, now: float) -> dict:
        n = self.layout.get(pump, {"pump": pump})
        p = self.live.get(pump) or {}
        status = p.get("status")
        card = {**n, "status": STATUS[status] if isinstance(status, int) and 0 <= status < len(STATUS) else "UNKNOWN",
                "code": status, "litres": p.get("volume"), "amount": p.get("amount"), "locks": p.get("locks", []),
                "usual_lpm": _median(self.speeds.get(pump, [])), "learnt_from": len(self.speeds.get(pump, [])),
                "sales": self.sales.get(pump, []), "preset": self.presets.get(pump), "fueling_s": None,
                "lpm": None, "left_s": None, "progress": None, "seen_s": None if not p.get("at") else round(now - p["at"])}
        sale = p.get("sale")
        if status == FUELING and sale and not sale.get("ended"):
            card["fueling_s"] = round(now - sale["started"])
            recent = [(t, v) for t, v in sale["points"] if t >= now - FLOW_WINDOW]
            if len(recent) > 1 and recent[-1][0] - recent[0][0] >= 3:
                card["lpm"] = round((recent[-1][1] - recent[0][1]) / (recent[-1][0] - recent[0][0]) * 60, 1)
        preset = card["preset"]
        if preset:
            litres = card["litres"] or 0
            price = (card["amount"] / litres) if litres > 0.5 and card["amount"] else n.get("price")
            target = preset["value"] if preset["kind"] == "litres" else (preset["value"] / price if price else None)
            if target:
                card["target_litres"] = round(target, 2)
                card["progress"] = round(min(1.0, litres / target), 3) if status == FUELING else None
                rate = card["lpm"] or card["usual_lpm"]
                if rate and rate > 0 and status in (FUELING, 4, 3, 2):
                    card["left_s"] = max(0, round((target - (litres if status == FUELING else 0)) / rate * 60))
        return card


def _why(exc: BaseException) -> str:
    reason = getattr(exc, "reason", exc)
    text = str(reason)
    if "refused" in text.lower():
        return "the IOCL PC's tunnel is down (connection refused)"
    if "timed out" in text.lower():
        return "FuelTrans didn't answer in time"
    return text[:160] or type(exc).__name__
