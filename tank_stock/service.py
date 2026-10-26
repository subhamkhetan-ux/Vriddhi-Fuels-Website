"""Tank stock page and live monitor (runs on the India server).

python -m tank_stock.service      (tank-stock-session.service runs it)

It runs inside the runner user's console login session, because that is the
only place AnyDesk agrees to start (see infra/anydesk/tank-stock-session.service).
Nothing connects on its own: everything starts from the phone page at
http://127.0.0.1:8790, published to your own Tailscale devices (setup.sh).

- Capture: connect, read the chosen tanks' cards (a zoomed picture and the
  figures), disconnect. Upload sends them to the decant app (decant.py).
- Send for decantation: capture, upload, and end the live session if one is
  open.
- Live monitoring: connect once and keep that AnyDesk session open; every
  ``interval_s`` seconds (5 at least) read the watched tanks' product
  volume again (no reconnecting, no pictures), show it on the page and, with
  ``auto_upload``, send the volume alone to the decant app. It runs until
  AnyDesk ends the session (e.g. a free licence's time limit) or you press
  Stop; then the last screen becomes a capture with its pictures. The
  XtraPower Telegram bot is told when AnyDesk ends it, with what the screen
  showed.
- Automatic decantation (auto.py): pick a truck's invoice and which chamber
  goes into which tank, press Start; it reads the stock before, follows the
  stock as the chambers go in, takes the stock after once it has settled and
  finishes the decantation in the decant app, asking on the page when the
  stock says something the plan didn't.
- GitHub's "Tank stock" job: its queued requests run here, in the session
  (``python -m tank_stock.run --in-session``), or from the live session's
  screen while one is open.

Settings live in /opt/agents/tank-stock/settings.json and the AnyDesk login
in login.json (owner-only; saved by infra/mac/vm-setup.sh, which asks for it).

With ``"source": "fueltrans"`` in login.json (infra/fueltrans/tank-stock-setup.sh)
the "session" is FuelTrans itself in a headless browser here, through the IOCL
PC's tunnel (fueltrans.py), instead of AnyDesk: the same screenshots, read the
same way, with no AnyDesk and no console login session.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
import traceback
from urllib.parse import parse_qs, urlparse

from . import cards as cards_mod
from . import decant, fueltrans, telegram
from .auto import AutoDecant, AutoError
from .capture import CaptureError, Session, parse_ids
from .phone import PhoneStock

HOME = Path(os.environ.get("TANK_STOCK_HOME", "/opt/agents/tank-stock"))
QUEUE = Path(os.environ.get("TANK_STOCK_QUEUE", "/opt/agents/tank-stock-queue"))
PYTHON = os.environ.get("TANK_STOCK_PYTHON", "/opt/agents/venv/bin/python")
STATIC = Path(__file__).resolve().parent / "static"
PORT = 8790
IST = timezone(timedelta(hours=5, minutes=30))
TANKS = (1, 2, 3, 4)
DEFAULTS = {"interval_s": 10, "tanks": list(TANKS), "auto_upload": True,    # live monitoring
            "reconnect": False}  # connect again when AnyDesk ends the session
INTERVAL = (5, 3600)             # seconds between live reads (no reconnecting)
CHECK_EVERY = 5                  # seconds: is the live session still open?
MAX_FAILED_READS = 5             # live reads that may fail in a row
SETTINGS_EVERY = 600             # seconds: re-read the decant app's settings while live
RECONNECT_AFTER = 15             # seconds before connecting again ("reconnect" on)
NO_CARDS_ALERT_EVERY = 600       # seconds: "no tank cards on the PC's screen" to Telegram at most this often
RECONNECT_RUN = 12               # ... at most this many in a row of short sessions
LONG_SESSION = 600               # a session this long resets that count
LIVE_UPLOAD_TIMEOUT = 8          # seconds: a live upload gives up (the live read waits for it)
LIVE_UPLOAD_BACKOFF = 30         # seconds: after the decant app couldn't be reached, before trying again
PROBE_STALE_S = 180              # a card whose "Last Updated" time hasn't moved this long: frozen figures
UNWATCHED_STOP = 900             # seconds: live monitoring nobody has open (and that sends nothing) ends
REQUEST_EVERY = 30               # seconds: has a phone asked for a decantation to be finished here, or for its stock?
SESSIONS_KEPT = 200              # AnyDesk sessions remembered (sessions.jsonl)
MAX_BODY = 16_000
AUTO_ACTIONS = ("answer", "done", "drop", "after", "release", "cancel", "clear", "reconnect", "add")
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "/icon-192.png": ("icon-192.png", "image/png"),
    "/icon-512.png": ("icon-512.png", "image/png"),
    "/apple-touch-icon.png": ("apple-touch-icon.png", "image/png"),
    "/icon-maskable-512.png": ("icon-maskable-512.png", "image/png"),
}
SECURITY_HEADERS = (
    ("Cache-Control", "no-store"),
    ("X-Content-Type-Options", "nosniff"),
    # framed only by the same origin: the XtraPower app's Tank stock tab (/ts/)
    ("X-Frame-Options", "SAMEORIGIN"),
    ("Referrer-Policy", "no-referrer"),
    ("Content-Security-Policy",
     "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
     "font-src https://fonts.gstatic.com; img-src 'self' blob:; "
     "connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"),
)


def _span(seconds) -> str:
    """3725 -> "1 h 2 min"; 125 -> "2 min 5 s"."""
    seconds = int(seconds or 0)
    h, m, sec = seconds // 3600, seconds % 3600 // 60, seconds % 60
    return f"{h} h {m} min" if h else f"{m} min {sec} s" if m else f"{sec} s"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def now_iso() -> str:
    return datetime.now(IST).isoformat(timespec="seconds")


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _read_json_safe(path: Path, default):
    """A file that must not be lost (a running decantation): if it can't be
    read back whole (a power cut mid-write), the copy kept before it, and the
    bad one put aside, never silently taken as empty. -> (data, what happened)"""
    if not path.exists():
        return default, ""
    try:
        return json.loads(path.read_text(encoding="utf-8")), ""
    except (OSError, ValueError):
        aside = path.with_name(f"{path.name}.corrupt-{int(time.time())}")
        try:
            os.replace(path, aside)
        except OSError:
            pass
        bak = path.with_name(path.name + ".bak")
        try:
            return json.loads(bak.read_text(encoding="utf-8")), f"{path.name} was damaged: the copy from before it was used"
        except (OSError, ValueError):
            return default, f"{path.name} was damaged and had no good copy (put aside as {aside.name})"


def _write_json(path: Path, data, private: bool = False, keep_copy: bool = False) -> None:
    """Written whole or not at all: a temporary file, on disk, then renamed
    over it (a full disk leaves the old one as it was). keep_copy: the old one
    is kept as .bak first (see _read_json_safe)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")   # one per thread
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600 if private else 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1)
            f.flush()
            os.fsync(f.fileno())
        if keep_copy and path.exists():
            try:
                os.replace(path, path.with_name(path.name + ".bak"))
            except OSError:
                pass
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def clean_tanks(value) -> list[int]:
    try:
        tanks = sorted({int(t) for t in value})
    except (TypeError, ValueError):
        raise ValueError("Tanks must be numbers 1 to 4.") from None
    if not tanks or any(t not in TANKS for t in tanks):
        raise ValueError("Pick at least one tank, 1 to 4.")
    return tanks


def clean_settings(new: dict, old: dict) -> dict:
    out = {**DEFAULTS, **{k: v for k, v in old.items() if k in DEFAULTS}}
    if "auto_upload" in new:
        out["auto_upload"] = bool(new["auto_upload"])
    if "reconnect" in new:
        out["reconnect"] = bool(new["reconnect"])
    if "interval_s" in new:
        try:
            seconds = int(new["interval_s"])
        except (TypeError, ValueError):
            raise ValueError("The interval must be a whole number of seconds.") from None
        if not INTERVAL[0] <= seconds <= INTERVAL[1]:
            raise ValueError(f"The interval must be {INTERVAL[0]} to {INTERVAL[1]} seconds.")
        out["interval_s"] = seconds
    if "tanks" in new:
        out["tanks"] = clean_tanks(new["tanks"])
    return out


class Station:
    """Settings, the last capture, the live session; one AnyDesk use at a time."""

    def __init__(self, home: Path = HOME, session_cls=Session, decant_mod=decant,
                 notify=telegram.send_text, notify_photo=telegram.send_photo):
        self.home = home
        self.session_cls = session_cls
        self.decant = decant_mod
        self.notify, self.notify_photo = notify, notify_photo
        self.busy = threading.Lock()     # one capture / live read at a time
        self.busy_since = None
        self.busy_what = ""
        self.live = None                 # {state, session, since, tanks, ...} while live
        self._live_lock = threading.Lock()   # one live session starts at a time
        self.live_last = _read_json(home / "live.json", {})
        self.alerted = {}                # what Telegram was last told, per tank ("down": the app unreachable)
        self._dropped = ""               # the day earlier days' proof pictures were last cleared
        self._short_runs = 0             # reconnects in a row after short sessions
        self._no_cards_told = 0.0        # when Telegram last got "no tank cards" with the screen
        self.seen_at = time.time()       # when the page was last open in front of someone
        self.last = _read_json(home / "last.json", {})
        self.auto = AutoDecant(self)
        self.phone = PhoneStock(self)    # a phone's "Check stock now" / "Monitor the stock" (decant home page)

    # ---- settings and login --------------------------------------------
    @property
    def settings(self) -> dict:
        return clean_settings({}, _read_json(self.home / "settings.json", {}))

    def save_settings(self, new: dict) -> dict:
        s = clean_settings(new, self.settings)
        _write_json(self.home / "settings.json", s)
        if self.live:                    # a running live session picks them up
            self.live.update(tanks=s["tanks"], interval_s=s["interval_s"], auto_upload=s["auto_upload"])
            self.live["wake"].set()
        return s

    def from_fueltrans(self) -> bool:
        """The tank cards come from FuelTrans through the tunnel, not AnyDesk."""
        return _read_json(self.home / "login.json", {}).get("source") == "fueltrans"

    def login(self) -> tuple[list[str], str]:
        data = _read_json(self.home / "login.json", {})
        if data.get("source") == "fueltrans":
            if not data.get("password"):
                raise CaptureError("The FuelTrans login isn't saved here yet: run "
                                   "infra/fueltrans/tank-stock-setup.sh on the server.")
            return [data.get("url") or "", data.get("user") or ""], data["password"]
        if not data.get("password") or not data.get("ids"):
            raise CaptureError("The AnyDesk login isn't saved here yet: run infra/mac/vm-setup.sh "
                               "again with ASK_AGAIN=1 (it asks for the AnyDesk numbers and password).")
        return parse_ids(",".join(data["ids"])), data["password"]

    def _session(self, ids, password):
        """A session to read the PC's tank cards: AnyDesk, or FuelTrans
        itself through the tunnel (login.json's "source")."""
        if self.session_cls is Session and self.from_fueltrans():
            url, user = ids
            return fueltrans.FuelTransSession(url or fueltrans.URL, user or fueltrans.USER, password)
        return self.session_cls(ids, password)

    def _hold(self, what: str, wait: float = 0) -> None:
        """Take the PC for ``what``, waiting up to ``wait`` seconds."""
        got = self.busy.acquire(timeout=wait) if wait else self.busy.acquire(blocking=False)
        if not got:
            raise RuntimeError("The agent is busy with the PC right now; try again in a minute.")
        self.busy_since, self.busy_what = now_iso(), what

    def _release(self) -> None:
        self.busy_since, self.busy_what = None, ""
        self.busy.release()

    # ---- capture --------------------------------------------------------
    def capture(self, tanks, upload: bool = False, decantation: bool = False, why: str = "phone") -> dict:
        """Read the tanks: from the open live session, else connect for this
        one capture. ``decantation``: upload, then end the live session."""
        tanks = clean_tanks(tanks)
        upload = upload or decantation
        try:
            self._hold("decantation" if decantation else "capture", wait=90 if self.live else 0)
        except RuntimeError as exc:
            self._failed(exc, why)
            raise
        try:
            try:
                # (looked at once the PC is ours: live monitoring may have
                # ended, or finished connecting, while this waited for it)
                live = self._live_now()
                if live:
                    png, page = live["session"].shot()
                    used = live["session"].position
                else:
                    ids, password = self.login()
                    with self._session(ids, password) as session:
                        png, page = session.shot()
                        used = session.position
                last = self._record(png, page, used, tanks, upload, why)
            except Exception as exc:
                self._failed(exc, why)
                raise
        finally:
            self._release()
        if decantation and self.live and not self.auto.active():
            self.stop_live("sent for decantation")   # (an automatic decantation needs it on)
        return last

    def _live_now(self):
        """The open live session, if it is live and still connected."""
        live = self.live
        if not live or live.get("state") != "live" or not live.get("session"):
            return None
        try:
            return live if live["session"].alive() else None
        except Exception:  # noqa: BLE001 - not usable
            return None

    def _failed(self, exc: Exception, why: str) -> None:
        """A capture that failed: the page says why (whatever went wrong)."""
        if not isinstance(exc, (CaptureError, RuntimeError, ValueError)):
            traceback.print_exc()
        msg = str(exc) if isinstance(exc, (CaptureError, RuntimeError, ValueError)) else \
            f"The capture failed ({type(exc).__name__})."
        self.last = {**self.last, "error": msg, "error_at": now_iso(), "why": why}
        try:
            _write_json(self.home / "last.json", self.last)
        except OSError:
            traceback.print_exc()

    def _record(self, png, page, used, tanks, upload, why) -> dict:
        started = now_iso()
        seen = _utc_now()                 # a card whose time isn't read is stamped with this
        tmp = self.home / "screen.png.tmp"
        tmp.write_bytes(png)
        os.replace(tmp, self.home / "screen.png")
        boxes, read = cards_mod.read_all(png)
        self._screen = (png, dict(boxes))         # the picture and its card boxes, together
        cfg, cfg_error = self._settings()
        found = {}
        for no, card in read.items():
            card.setdefault("seenAt", seen)
            tank = self.decant.tank_for(no, cfg)
            built = self.decant.make_reading(card, tank, cfg) if tank else None
            found[str(no)] = {
                "box": boxes[no], "product": card.get("product"), "tank_id": tank and tank["id"],
                "reading": built and built["reading"], "confidence": built and built["confidence"],
                "problems": built["problems"] if built else ["the decant app has no such tank"],
            }
        self.last = {"at": started, "why": why, "page": page, "id_no": used, "tanks": found,
                     "asked": tanks, "settings_note": cfg_error, "uploads": {}}
        missing = [n for n in tanks if str(n) not in found]
        if missing:
            self._no_cards(png, page, missing if found else None)
        (self.home / "cards.json").write_text(json.dumps({str(k): v for k, v in read.items()}))
        if upload and cfg.get("default"):
            # Which card is which tank comes from the app's settings: without
            # them nothing is saved under a guessed tank.
            self.last["uploads"] = {str(n): {"ok": False, "at": now_iso(), "message": "not saved: the decant app's "
                                             "settings couldn't be read (which tank is which)"} for n in tanks}
        elif upload:
            self._upload(tanks, read, cfg)
        _write_json(self.home / "last.json", self.last)
        return self.last

    def _settings(self, quick: bool = False) -> tuple[dict, str]:
        """The decant app's settings: the last ones read if it can't be reached
        now, else its defaults (marked "default": not for saving readings)."""
        try:
            cfg = self.decant.settings(timeout=LIVE_UPLOAD_TIMEOUT) if quick else self.decant.settings()
            self._cfg = cfg
            return cfg, ""
        except self.decant.DecantError as exc:
            if getattr(self, "_cfg", None):
                return self._cfg, f"{exc} Using the app's settings as last read."
            return {"tanks": self.decant.DEFAULT_TANKS, "dateOrder": "MDY", "chart": self.decant.dip_chart(),
                    "default": True}, f"{exc} Using the app's default tanks (nothing is saved to it)."

    def _upload(self, tanks, read, cfg) -> dict:
        try:
            results = self.decant.upload(read, tanks, cfg)
        except self.decant.DecantError as exc:
            results = {n: {"ok": False, "message": str(exc)} for n in tanks}
        stamp = now_iso()
        uploads = self.last.setdefault("uploads", {})
        for no, r in results.items():
            uploads[str(no)] = {**{k: v for k, v in r.items() if k != "mark"}, "at": stamp}
        self._save_proof(results)
        return results

    def _save_proof(self, results) -> None:
        """The zoomed cards of the tanks just saved, for the app's result
        pictures on any phone today (decant.save_proof)."""
        saved = {no: r for no, r in results.items() if r.get("ok") and r.get("mark")}
        if not saved:
            return
        try:
            if self._dropped != self.decant.ist_day():
                try:                        # (tidying up never costs today's pictures)
                    self.decant.drop_old_proofs()
                    self._dropped = self.decant.ist_day()
                except self.decant.DecantError:
                    pass
            # one picture per tank (its own card), so a result shows each
            # tank's stock before and after on its own
            for no in sorted(saved):
                jpeg = cards_mod.to_jpeg(self.picture([no]))
                if not jpeg:
                    raise ValueError(f"the picture of Tank {no}'s card could not be made")
                self.decant.save_proof(jpeg, {saved[no]["tank_id"]: saved[no]["mark"]})
            self.last["proof"] = {"ok": True, "tanks": sorted(saved), "at": now_iso()}
        except (self.decant.DecantError, ValueError) as exc:
            self.last["proof"] = {"ok": False, "message": str(exc), "at": now_iso()}

    def upload_last(self, tanks) -> dict:
        """The Upload buttons: save the last capture's readings."""
        tanks = clean_tanks(tanks)
        read = {int(k): v for k, v in _read_json(self.home / "cards.json", {}).items()}
        if not read:
            raise ValueError("Capture the tanks first.")
        try:
            self._hold("upload", wait=5)
        except RuntimeError:
            raise ValueError("The agent is reading the PC; upload when it has finished.") from None
        try:
            cfg, err = self._settings()
            if cfg.get("default"):
                return {n: {"ok": False, "message": err} for n in tanks}
            results = self._upload(tanks, read, cfg)
            _write_json(self.home / "last.json", self.last)
        finally:
            self._release()
        return results

    def _no_cards(self, png: bytes, page: str, missing=None) -> None:
        """No tank card on the PC's screen (or not the ones asked for): show
        the XtraPower bot what it showed (privately; the page shows it too)."""
        if time.time() - self._no_cards_told < NO_CARDS_ALERT_EVERY:
            return
        self._no_cards_told = time.time()
        if missing:
            text = (f"Tank stock: Tank {', '.join(map(str, missing))} not found on the IOCL PC's screen ({page}). "
                    "This is what it showed.")
        else:
            text = (f"Tank stock: no tank cards on the IOCL PC's screen ({page}). "
                    "This is what it showed. Put FuelTrans on Monitoring → Tank Status on the PC.")
        try:
            self.notify_photo(png, text)
        except Exception:  # noqa: BLE001 - the page shows it either way
            traceback.print_exc()

    def picture(self, tanks, stack: bool = False, grid: bool = False, full: bool = False) -> bytes:
        shot = getattr(self, "_screen", None)
        if shot:
            png, boxes = shot[0], {int(k): tuple(v) for k, v in shot[1].items()}
        else:                              # (since the service started: the files)
            try:
                png = (self.home / "screen.png").read_bytes()
            except OSError:
                return b""
            boxes = {int(k): tuple(v["box"]) for k, v in (self.last.get("tanks") or {}).items()}
        if full:
            return png                     # the whole screen: what the PC showed
        return cards_mod.picture(png, boxes, clean_tanks(tanks), stack=stack, grid=grid)

    def full_read(self, png: bytes | None, tanks, why: str) -> dict:
        """A full read of a live session's screen, saved like a capture (the
        page's pictures, the decant app's stock and proof picture).
        -> {tank no: {"reading": the reading saved (or read) | None, "problem"}}"""
        tanks = clean_tanks(tanks)
        if not png:
            return {n: {"reading": None, "problem": "no screen yet"} for n in tanks}
        self._hold(why, wait=60)
        try:
            live = self.live or {}
            last = self._record(png, live.get("page") or "the live session",
                                live["session"].position if live.get("session") else None, tanks, True, why)
            # each tank's own zoomed card, from this very screen (before another capture replaces it)
            pics = {}
            for no in tanks:
                if str(no) in (last.get("tanks") or {}):
                    try:
                        pics[no] = cards_mod.to_jpeg(self.picture([no])) or b""
                    except Exception:  # noqa: BLE001 - the reading counts without its picture
                        pics[no] = b""
        finally:
            self._release()
        proof = last.get("proof") or {}
        out = {}
        for no in tanks:
            f = (last.get("tanks") or {}).get(str(no)) or {}
            u = (last.get("uploads") or {}).get(str(no)) or {}
            reading = u.get("reading") if u.get("ok") else None
            if reading is None and f.get("reading") and f.get("confidence") not in (None, "low"):
                reading = f["reading"]                 # read fine; the app just has a newer one
            out[no] = {"reading": reading, "jpeg": pics.get(no, b""),
                       "cloud": bool(proof.get("ok") and no in (proof.get("tanks") or [])),
                       "problem": "" if reading else "; ".join(f.get("problems") or []) or u.get("message") or "not read"}
        return out

    # ---- live monitoring ------------------------------------------------
    # One AnyDesk session stays open. The first read finds the cards; after
    # that a read is a screenshot, a fingerprint of each watched card, and a
    # quick read of the cards whose volume rows changed. The page shows each
    # tank's product volume as it comes, and (with auto_upload) the decant
    # app gets the volume alone. When it ends, the
    # last screen becomes an ordinary capture: pictures to save or upload.
    def start_live(self, new_settings: dict | None = None, auto: bool = False) -> dict:
        """Connect and keep the session open, reading every interval_s.
        auto: for the automatic decantation (the saved settings stay)."""
        with self._live_lock:
            return self._start_live(new_settings, auto)

    def _start_live(self, new_settings, auto) -> dict:
        if self.live:
            raise RuntimeError("Live monitoring is already running.")
        if self.busy.locked() and not auto:
            raise RuntimeError("The agent is busy with the PC right now; try again in a minute.")
        s = self.settings if auto else self.save_settings(new_settings or {})
        self.live = {"state": "connecting", "since": now_iso(), "tanks": s["tanks"], "by_auto": auto,
                     "interval_s": s["interval_s"], "auto_upload": s["auto_upload"],
                     "reads": 0, "failed": 0, "figures": {}, "uploads": {},
                     "stop": threading.Event(), "wake": threading.Event()}
        (self.home / "live-log.csv").unlink(missing_ok=True)       # (the change log of earlier versions)
        threading.Thread(target=self._live_run, args=(self.live,), daemon=True, name="live").start()
        return self.live_view()

    def stop_live(self, why: str = "stopped by you", force: bool = False) -> None:
        live = self.live
        if live and self.auto.active() and not force:
            raise RuntimeError("An automatic decantation is running on it: hand it over to the decant app "
                               "or cancel it first.")
        if live:
            live["stop_reason"] = why
            live["stop"].set()
            live["wake"].set()

    def _live_run(self, live) -> None:
        session, reason, final = None, "", b""
        try:
            self._hold("connecting for live monitoring", wait=90)
            try:
                ids, password = self.login()
                session = self._session(ids, password)
                session.open()
            finally:
                self._release()
            live.update(state="live", session=session, connected=now_iso())
            while not live["stop"].is_set():
                started = time.monotonic()           # (not the wall clock: it can jump when the VM wakes)
                self._live_read(live)
                took = time.monotonic() - started
                live["read_s"] = round(took, 1)
                try:
                    self.auto.on_read(live)            # an automatic decantation follows the stock
                except Exception:  # noqa: BLE001 - the live session carries on
                    traceback.print_exc()
                if self._unwatched(live):
                    live["stop_reason"] = (f"nobody had the page open for {UNWATCHED_STOP // 60} min, "
                                           "so the AnyDesk session was closed to free the server's memory")
                    break
                if live["failed"] >= MAX_FAILED_READS:
                    reason = f"{MAX_FAILED_READS} reads in a row failed ({live.get('last_error', '')})"
                    break
                # never busier than half the time, however slow the reads get
                due = started + max(self._every(live), 2 * took)
                live["next_read"] = datetime.fromtimestamp(time.time() + due - time.monotonic(), IST) \
                    .isoformat(timespec="seconds")
                while time.monotonic() < due and not live["stop"].is_set():
                    live["wake"].clear()
                    live["wake"].wait(timeout=min(CHECK_EVERY, max(0.1, due - time.monotonic())))
                    if not session.alive():
                        reason = getattr(session, "lost", "") or "AnyDesk ended the session"
                        final = session.screen()          # what AnyDesk shows now
                        break
                    if live["wake"].is_set() and not live["stop"].is_set():
                        due = min(due, started + max(self._every(live), 2 * took))
                if reason:
                    break
            if not reason and live.get("anydesk_said"):
                reason = f"AnyDesk ended the session (it shows \u201c{live['anydesk_said']}\u201d)"
                final = live["anydesk_png"]
            reason = reason or live.get("stop_reason") or "stopped"
        except (CaptureError, RuntimeError) as exc:
            reason = str(exc)
        except Exception as exc:  # noqa: BLE001 - always close the session
            reason = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()
        finally:
            live["state"] = "ending"               # a capture no longer uses it
            if session:
                try:
                    self._hold("closing the live session", wait=60)   # (not in the middle of a capture's shot)
                    held = True
                except RuntimeError:
                    held = False
                try:
                    session.close()
                except Exception:  # noqa: BLE001 - it is over either way
                    traceback.print_exc()
                finally:
                    if held:
                        self._release()
            self._live_end(live, reason, final)

    def _every(self, live) -> int:
        """Seconds between live reads: shorter while a decantation needs them."""
        return self.phone.interval(self.auto.interval(live["interval_s"]))

    def _unwatched(self, live) -> bool:
        """Live monitoring that nobody watches and that does nothing on its
        own (no sending to the decant app, no automatic decantation, no phone
        monitoring) only holds AnyDesk, its screen and memory: it ends."""
        if live.get("by_auto") or live.get("auto_upload") or self.auto.active() or self.phone.active():
            return False
        since = max(self.seen_at, datetime.fromisoformat(live["since"]).timestamp())
        return time.time() - since > UNWATCHED_STOP

    def _live_cfg(self, live) -> dict:
        if not live.get("cfg") or time.time() - live.get("cfg_at", 0) > SETTINGS_EVERY:
            cfg, _ = self._settings(quick=True)    # (a live read holds the PC: it doesn't wait long)
            if not cfg.get("default") or not live.get("cfg"):
                live["cfg"] = cfg
            # (defaults: asked again in a minute, not in ten)
            live["cfg_at"] = time.time() - (SETTINGS_EVERY - 60 if live["cfg"].get("default") else 0)
        return live["cfg"]

    def _live_find(self, live) -> bytes:
        """Open Tank Status if need be and find the cards: a full read."""
        png, page = live["session"].shot()
        boxes, read = cards_mod.read_all(png)
        live.update(boxes=boxes, page=page, fp={},
                    products={no: c.get("product") for no, c in read.items()})
        return png

    def _live_read(self, live) -> None:
        try:
            self._hold("live read", wait=30)
        except RuntimeError:
            return                                     # a capture from the page: next time
        try:
            if not live.get("boxes"):
                png = self._live_find(live)
            else:
                png = live["session"].screen()
            px = cards_mod.Pixels(png)
            if not px.ok:
                raise CaptureError("The screenshot of the live session failed.")
            cfg = self._live_cfg(live)
            changed, good = {}, 0
            watched = sorted(set(live["tanks"]) | self.auto.watched() | self.phone.watched())
            for no in watched:
                box = live["boxes"].get(no)
                if not box:
                    continue
                try:
                    clock = cards_mod.clock_print(px, box)
                except Exception:  # noqa: BLE001 - unknown: nothing is said about it
                    clock = ""
                if clock:
                    tick = live.setdefault("ticks", {}).get(no)
                    if not tick or tick["fp"] != clock:
                        live["ticks"][no] = {"fp": clock, "since": now_iso(), "t": time.time()}
                fp = cards_mod.fingerprint(px, box)
                if fp == live["fp"].get(no):
                    good += 1                         # same figures as last time
                    continue
                card = cards_mod.read_figures(png, box)
                card.update(no=no, product=live["products"].get(no), seenAt=_utc_now())
                tank = self.decant.tank_for(no, cfg)
                built = self.decant.make_reading(card, tank, cfg) if tank else None
                if not built or card.get("volume") is None:
                    continue
                live["figures"][str(no)] = {"reading": {"volume": built["reading"]["volume"]},
                                            "confidence": built["confidence"],
                                            "problems": built["problems"], "at": now_iso()}
                if built["confidence"] != "low":
                    live["fp"][no] = fp               # read again next time otherwise
                    changed[no] = card
                    good += 1
            if not good and watched:
                # AnyDesk dropped the session but kept its window ("Client Offline")?
                said = live["session"].ended(png) if hasattr(live["session"], "ended") else ""
                if said:
                    live["anydesk_said"], live["anydesk_png"] = said, png
                    live["stop"].set()
                    live["wake"].set()
                    return
                # no watched card readable: the PC shows something else; find the cards again
                live["boxes"] = None
                raise CaptureError("The tank cards were not on the screen.")
            # the changed figures, and those the decant app couldn't take before
            wanted = lambda no: (live["auto_upload"] or no in self.auto.to_upload()   # noqa: E731
                                 or no in self.phone.watched())
            pending = live.setdefault("pending", {})
            send = {**{no: c for no, c in pending.items() if wanted(no)},
                    **{no: c for no, c in changed.items() if wanted(no)}}
            if send and cfg.get("default"):
                pending.update(send)                  # sent once the app's settings are read
            elif send:
                self._live_upload(live, send, cfg)
            live.pop("last_error", None)
            live.update(failed=0, last_read=now_iso(), last_png=png)
            live["reads"] += 1                        # counted once all of it is done
        except Exception as exc:  # noqa: BLE001 - count it, keep the session
            live["failed"] += 1
            live["last_error"] = str(exc) if isinstance(exc, CaptureError) else f"{type(exc).__name__}: {exc}"
        finally:
            self._release()

    def _live_upload(self, live, changed, cfg) -> None:
        """The figures alone to the decant app (no pictures while live). One the
        app couldn't take (it couldn't be reached) is kept and sent again - a
        steady tank's card isn't read again, so it would never go otherwise -
        after a short pause, so a dead connection doesn't hold every read."""
        pending = live.setdefault("pending", {})
        if time.time() < live.get("upload_after", 0):
            pending.update(changed)                    # (tried again after the pause)
            return
        try:
            results = self.decant.upload(changed, sorted(changed), cfg, only_volume=True,
                                         timeout=LIVE_UPLOAD_TIMEOUT)
        except self.decant.DecantError as exc:
            results = {n: {"ok": False, "message": str(exc)} for n in changed}
        stamp = now_iso()
        unreachable = False
        for no, r in results.items():
            msg = r.get("message") or ""
            # (not reached, the server's trouble, too many requests or too slow: sent again; a real "no": not)
            retry = not r.get("ok") and ("could not be reached" in msg or "refused (5" in msg
                                         or "refused (408" in msg or "refused (429" in msg)
            if retry:
                pending[no] = changed[no]
                unreachable = True
                r = {**r, "message": f"{msg} (sent again when it answers)"}
            else:
                pending.pop(no, None)
            live["uploads"][str(no)] = {**{k: v for k, v in r.items() if k != "mark"}, "at": stamp}
        live["upload_after"] = time.time() + LIVE_UPLOAD_BACKOFF if unreachable else 0
        # Telegram: the app being unreachable once (not per tank, nor per
        # read), and a tank's own problem once until it changes or clears.
        told = self.alerted
        if unreachable:
            if not told.get("down"):
                told["down"] = next(r["message"] for r in results.values() if not r.get("ok"))
                self.notify(f"⚠️ Tank stock (live): {told['down'].replace(' (sent again when it answers)', '')} "
                            "The volumes are sent again when it answers.")
        elif told.get("down") and not pending:
            told.pop("down")
            self.notify("✅ Tank stock (live): the decant app answers again; the latest volumes are in it.")
        new = []
        for no, r in sorted(results.items()):
            msg = r.get("message") or ""
            if r.get("ok") or no in pending:
                told.pop(no, None)
            elif told.get(no) != msg:
                told[no] = msg
                new.append(f"Tank {no}: {msg}")
        if new:
            self.notify("⚠️ Tank stock (live): " + "; ".join(new))

    def _live_end(self, live, reason: str, final: bytes) -> None:
        ended = now_iso()
        minutes = int((datetime.fromisoformat(ended) - datetime.fromisoformat(live["since"])).total_seconds() // 60)
        took = f"{minutes // 60} h {minutes % 60} min" if minutes >= 60 else f"{minutes} min"
        self.live_last = {"since": live["since"], "ended": ended, "lasted": took, "reason": reason,
                          "reads": live["reads"]}
        session = self._log_session(live, ended, reason)
        # The last screen read becomes a capture: its pictures to save or upload.
        if live.get("last_png") and live.get("stop_reason") != "sent for decantation":
            try:
                self._hold("the live session's last pictures", wait=60)
                try:
                    self._record(live["last_png"], "the last screen of the live session",
                                 live["session"].position if live.get("session") else None,
                                 live["tanks"], False, "live")
                finally:
                    self._release()
            except Exception:  # noqa: BLE001 - the session is over either way
                traceback.print_exc()
        try:
            _write_json(self.home / "live.json", self.live_last)
        except OSError:                     # (a full disk: the session still ends)
            traceback.print_exc()
        finally:
            if self.live is live:           # (never a newer session started meanwhile)
                self.live = None
        try:
            self.auto.on_live_end(reason, by_you=bool(live.get("stop_reason")))
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        if live.get("stop_reason"):
            return                          # you stopped it: no message needed
        again = self._reconnect_later(session)
        reads = f"{live['reads']} read{'' if live['reads'] == 1 else 's'}"
        lasted = (f" The AnyDesk session lasted {_span(session['lasted_s'])}."
                  if session.get("lasted_s") is not None else "")
        text = (f"Tank stock live monitoring ended after {took} ({reads}): {reason}.{lasted}"
                + (f" Connecting again in {RECONNECT_AFTER} s." if again else ""))
        if final:
            self.notify_photo(final, text + "\nThis is what the server's AnyDesk showed.")
        else:
            self.notify(text)

    # ---- AnyDesk sessions: how long they last ---------------------------------
    def _log_session(self, live, ended: str, reason: str) -> dict:
        """One line in sessions.jsonl per live session: when it connected, how
        long the AnyDesk session itself lasted and who ended it."""
        connected = live.get("connected")
        lasted = None
        if connected:
            lasted = int((datetime.fromisoformat(ended) - datetime.fromisoformat(connected)).total_seconds())
        by = ("you" if live.get("stop_reason") == "stopped by you" else
              "agent" if live.get("stop_reason") else
              "anydesk" if reason.startswith("AnyDesk ended the session") else "problem")
        row = {"since": live["since"], "connected": connected, "ended": ended, "lasted_s": lasted,
               "by": by, "reason": reason, "reads": live.get("reads", 0),
               "id": live["session"].position if live.get("session") else None}
        path = self.home / "sessions.jsonl"
        try:
            lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
            lines = (lines + [json.dumps(row)])[-SESSIONS_KEPT:]
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        except OSError:
            traceback.print_exc()
        return row

    def sessions(self) -> dict:
        """For the page: the recent sessions, and how long AnyDesk lets one
        run (from the ones it ended itself)."""
        rows = []
        try:
            for line in (self.home / "sessions.jsonl").read_text(encoding="utf-8").splitlines():
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue
        except OSError:
            pass
        ended = sorted(r["lasted_s"] for r in rows if r.get("by") == "anydesk" and r.get("lasted_s") is not None)
        stats = None
        if ended:
            stats = {"count": len(ended), "shortest_s": ended[0], "longest_s": ended[-1],
                     "typical_s": ended[len(ended) // 2]}
        return {"recent": rows[-8:][::-1], "anydesk": stats}

    def _reconnect_later(self, session: dict) -> bool:
        """With "reconnect" on: AnyDesk ended a session that had connected, so
        connect again shortly (not while an automatic decantation, which has
        its own reconnecting, runs). Short sessions over and over stop it."""
        if not self.settings.get("reconnect") or session.get("by") != "anydesk" or self.auto.active():
            return False
        self._short_runs = 0 if (session.get("lasted_s") or 0) >= LONG_SESSION else self._short_runs + 1
        if self._short_runs > RECONNECT_RUN:
            self.notify(f"Tank stock: AnyDesk ended {RECONNECT_RUN} sessions in a row within "
                        f"{LONG_SESSION // 60} min each, so I stopped connecting again. Start live monitoring "
                        "from the page when you want it.")
            self._short_runs = 0
            return False

        def again():
            if self.live:
                return
            try:
                self.start_live(auto=True)       # (the saved settings, unchanged)
                self.live["by_auto"] = False     # it's still your live monitoring
            except RuntimeError:
                traceback.print_exc()
        threading.Timer(RECONNECT_AFTER, again).start()
        return True

    def live_view(self) -> dict | None:
        live = self.live
        if not live:
            return None
        hidden = ("session", "stop", "wake", "last_png", "cfg", "fp", "boxes", "ticks", "anydesk_png")
        out = {k: v for k, v in live.items() if k not in hidden}
        # each card's "Last Updated" clock: frozen means the figures are too
        out["probes"] = {str(no): {"since": t["since"], "age_s": round(time.time() - t["t"]),
                                   "frozen": time.time() - t["t"] >= PROBE_STALE_S}
                         for no, t in (live.get("ticks") or {}).items()}
        # what it really does while an automatic decantation runs on it
        out["watched"] = sorted(set(live["tanks"]) | self.auto.watched() | self.phone.watched())
        out["every_s"] = self._every(live)
        out["sending"] = sorted(out["watched"] if live["auto_upload"] else self.auto.to_upload() | self.phone.watched())
        return out

    # ---- GitHub job requests -------------------------------------------
    def queue_loop(self, stop: threading.Event) -> None:
        QUEUE.mkdir(mode=0o700, parents=True, exist_ok=True)
        while not stop.wait(2):
            try:
                self._queue_once()
            except Exception:  # noqa: BLE001 - the queue keeps running whatever one job did
                traceback.print_exc()

    def request_loop(self, stop: threading.Event) -> None:
        """A phone's "Let the tank stock server finish it", "Check stock now" or
        "Monitor the stock" (decant app): looked for every REQUEST_EVERY seconds."""
        while not stop.wait(REQUEST_EVERY):
            for look in (self.auto.check_requests, self.phone.check):
                try:
                    look()
                except Exception:  # noqa: BLE001 - looked for again next time
                    traceback.print_exc()

    def _queue_once(self) -> None:
        for req in sorted(QUEUE.glob("*.req")):
            job = str(req)[:-4]
            try:
                workdir = req.read_text(encoding="utf-8").strip()
                req.unlink()
            except OSError:
                continue
            try:
                if self._live_now() or self.from_fueltrans():
                    rc, out = self._job_from_live(job)
                    Path(f"{job}.log").write_text(out)
                else:
                    with open(f"{job}.log", "wb") as log:
                        try:
                            rc = subprocess.run([PYTHON, "-m", "tank_stock.run", "--in-session", job],
                                                cwd=workdir, stdout=log, stderr=subprocess.STDOUT,
                                                timeout=600).returncode
                        except (OSError, subprocess.TimeoutExpired) as exc:
                            log.write(f"The capture could not run: {type(exc).__name__}\n".encode())
                            rc = 1
            except Exception:  # noqa: BLE001 - the job is still answered
                traceback.print_exc()
                rc = 1
            Path(f"{job}.rc.tmp").write_text(f"{rc}\n")
            os.replace(f"{job}.rc.tmp", f"{job}.rc")

    def _job_from_live(self, job: str) -> tuple[int, str]:
        """The GitHub job asked while the live session is open (or the cards
        come from FuelTrans, which needs no AnyDesk session): answer from it."""
        Path(f"{job}.env").unlink(missing_ok=True)
        try:
            self._hold("GitHub job", wait=120)
        except RuntimeError as exc:
            return 1, f"{exc}\n"
        try:
            live = self._live_now()
            if live:
                png, page = live["session"].shot()
            elif self.from_fueltrans():
                ids, password = self.login()
                with self._session(ids, password) as session:
                    png, page = session.shot()
            else:
                return 1, "The live session ended just now; ask again.\n"
        except Exception as exc:  # noqa: BLE001
            return 1, f"The live session's screen could not be read ({type(exc).__name__}).\n"
        finally:
            self._release()
        sent = self.notify_photo(png, f"Tank stock screen from the live session, {now_iso()}: {page}.")
        return (0 if sent else 1), (f"Captured from the open live session ({page}); "
                                    f"{'sent to Telegram' if sent else 'Telegram delivery failed'}.\n")

    # ---- the page's view ------------------------------------------------
    def view(self) -> dict:
        login = _read_json(self.home / "login.json", {})
        return {
            "settings": self.settings,
            "limits": {"interval_s": INTERVAL},
            "login_saved": bool(login.get("password") and (login.get("ids") or login.get("source") == "fueltrans")),
            "source": login.get("source") or "anydesk",
            "busy": {"since": self.busy_since, "what": self.busy_what} if self.busy_since else None,
            "live": self.live_view(),
            "live_last": self.live_last,
            "last": self.last,
            "auto": self.auto.view(),
            "sessions": self.sessions(),
        }


# ---- HTTP --------------------------------------------------------------

def access_error(client_ip, host, port, hosts, users, login):
    """As the XtraPower page: from this machine only, by its own name or the
    server's Tailscale name with an allowed Tailscale login."""
    from xtrapower.manage import access_error as check
    err = check(client_ip, host, port, hosts, users, login)
    if err and "Mac" in err[1]:
        err = (err[0], "Open this page from your phone through Tailscale (see infra/anydesk/phone-setup.sh).")
    return err


class Handler(BaseHTTPRequestHandler):
    server_version = "TankStock"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.client_address[0], fmt % args))

    @property
    def station(self) -> Station:
        return self.server.station           # type: ignore[attr-defined]

    def _send(self, status, body: bytes, ctype: str):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in SECURITY_HEADERS:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, data):
        self._send(status, json.dumps(data).encode(), "application/json; charset=utf-8")

    def _allowed(self) -> bool:
        srv = self.server
        err = access_error(self.client_address[0], self.headers.get("Host", ""), srv.port,  # type: ignore[attr-defined]
                           srv.hosts, srv.users, self.headers.get("Tailscale-User-Login"))  # type: ignore[attr-defined]
        if err:
            self._json(err[0], {"error": err[1]})
        return not err

    def do_GET(self):
        try:
            self._get()
        except Exception:  # noqa: BLE001 - always an answer the page can show
            traceback.print_exc()
            try:
                self._json(500, {"error": "That didn't work on the server."})
            except OSError:
                pass

    def _get(self):
        if not self._allowed():
            return
        url = urlparse(self.path)
        if url.path in STATIC_FILES:
            name, ctype = STATIC_FILES[url.path]
            body = (STATIC / name).read_bytes()
            if name == "index.html":
                body = body.replace(b"__CSRF__", self.server.csrf.encode())  # type: ignore[attr-defined]
            return self._send(200, body, ctype)
        if url.path == "/api/state":
            if parse_qs(url.query).get("seen") == ["1"]:          # the page is in front of someone
                self.station.seen_at = time.time()
            return self._json(200, self.station.view())
        if url.path == "/api/auto/options":
            try:
                return self._json(200, self.station.auto.options())
            except AutoError as exc:
                return self._json(502, {"error": str(exc)})
        if url.path == "/api/auto/proof":
            query = parse_qs(url.query)
            jpeg = self.station.auto.proof_picture(query.get("tank", [""])[0], query.get("which", [""])[0])
            if not jpeg:
                return self._json(404, {"error": "No picture for that."})
            return self._send(200, jpeg, "image/jpeg")
        if url.path == "/api/picture":
            try:
                query = parse_qs(url.query)
                tanks = [t for t in query.get("tanks", [""])[0].split(",") if t]
                full = query.get("full", ["0"])[0] == "1"
                png = self.station.picture(tanks, stack=query.get("stack", ["0"])[0] == "1",
                                           grid=query.get("grid", ["0"])[0] == "1", full=full)
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
            if not png:
                return self._json(404, {"error": "No capture yet."})
            return self._send(200, png, "image/png")
        self._json(404, {"error": "Not found."})

    def do_POST(self):
        if not self._allowed():
            return
        if not hmac.compare_digest(self.headers.get("X-TS-CSRF", ""), self.server.csrf):  # type: ignore[attr-defined]
            return self._json(403, {"error": "This page is out of date. Reload it and try again."})
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = -1
        if size < 0:
            return self._json(400, {"error": "Bad request."})
        if size > MAX_BODY:
            return self._json(413, {"error": "Request too large."})
        try:
            body = json.loads(self.rfile.read(size) or b"{}")
            path = urlparse(self.path).path
            if path == "/api/capture":
                tanks = clean_tanks(body.get("tanks") or [])
                st = self.station
                # (a live session's reads hold the PC for seconds: the capture waits its turn)
                if (st.busy.locked() and not st._live_now()) or (st.live and st.live.get("state") != "live"):
                    return self._json(409, {"error": "The agent is busy with the PC; wait for it to finish."})
                threading.Thread(target=self._capture, daemon=True,
                                 args=(tanks, bool(body.get("upload")), bool(body.get("decantation")))).start()
                return self._json(202, {"started": True})
            if path == "/api/live/start":
                return self._json(202, {"live": self.station.start_live(body)})
            if path == "/api/live/stop":
                self.station.stop_live()
                return self._json(200, {"stopping": True})
            if path == "/api/upload":
                return self._json(200, {"results": self.station.upload_last(body.get("tanks") or [])})
            if path == "/api/settings":
                return self._json(200, {"settings": self.station.save_settings(body)})
            if path == "/api/auto/check":
                return self._json(200, self.station.auto.check(str(body.get("invoice_no") or ""), body.get("plan") or {}))
            if path == "/api/auto/takeover":
                return self._json(202, {"auto": self.station.auto.take_over(str(body.get("session_id") or ""))})
            if path == "/api/auto/start":
                return self._json(202, {"auto": self.station.auto.start(str(body.get("invoice_no") or ""),
                                                                        body.get("plan") or {})})
            if path.startswith("/api/auto/") and path[10:] in AUTO_ACTIONS:
                return self._json(200, {"auto": self.station.auto.act(path[10:], body)})
        except (ValueError, CaptureError) as exc:      # (AutoError is a ValueError)
            return self._json(400, {"error": str(exc)})
        except RuntimeError as exc:
            return self._json(409, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001 - always an answer the page can show
            traceback.print_exc()
            msg = "the server's disk is full" if isinstance(exc, OSError) and exc.errno == 28 else type(exc).__name__
            return self._json(500, {"error": f"That didn't work on the server ({msg})."})
        self._json(404, {"error": "Not found."})

    def _capture(self, tanks, upload, decantation):
        try:
            self.station.capture(tanks, upload=upload, decantation=decantation)
        except (CaptureError, RuntimeError):
            pass                              # recorded in last.json for the page
        except Exception:  # noqa: BLE001
            traceback.print_exc()


def make_server(station: Station, port: int = PORT, hosts=(), users=()) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.station, srv.port, srv.csrf = station, port, secrets.token_urlsafe(32)  # type: ignore[attr-defined]
    srv.hosts = {h.strip().lower() for h in hosts if h.strip()}      # type: ignore[attr-defined]
    srv.users = {u.strip().lower() for u in users if u.strip()}      # type: ignore[attr-defined]
    return srv


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Tank stock page and live monitor")
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args(argv)
    HOME.mkdir(parents=True, exist_ok=True)
    try:
        os.nice(10)        # the OCR yields to the XtraPower monitor on this small server
    except OSError:
        pass
    station = Station()
    station.auto.resume()      # an automatic decantation that was running carries on
    stop = threading.Event()
    threading.Thread(target=station.queue_loop, args=(stop,), daemon=True, name="queue").start()
    threading.Thread(target=station.request_loop, args=(stop,), daemon=True, name="requests").start()
    hosts = os.environ.get("TANK_STOCK_HOSTS", "").split(",")
    users = os.environ.get("TANK_STOCK_USERS", "").split(",")
    httpd = make_server(station, args.port, hosts, users)
    print(f"Tank stock page on http://127.0.0.1:{args.port}/ "
          f"({', '.join(sorted(httpd.hosts)) or 'this server only'}); "  # type: ignore[attr-defined]
          "nothing connects until asked from the page.", flush=True)
    try:
        httpd.serve_forever()
    finally:
        stop.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
