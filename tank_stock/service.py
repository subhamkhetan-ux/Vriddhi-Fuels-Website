"""Tank stock monitor and phone page (runs on the India server).

python -m tank_stock.service      (tank-stock-session.service runs it)

It runs inside the runner user's console login session, because that is the
only place AnyDesk agrees to start (see infra/anydesk/tank-stock-session.service).
It does three things:

- the monitor: every ``interval_min`` minutes (default 15) it connects to the
  IOCL PC, reads the Tank Status cards and, with ``auto_upload`` on, saves the
  watched tanks' stock to the decant app (only cards that pass the app's
  checks; see decant.py). Failures go to the XtraPower Telegram bot once,
  and so does the recovery;
- the phone page at http://127.0.0.1:8790, published to your own Tailscale
  devices (infra/anydesk/phone-setup.sh): pick tanks, capture now, see the
  zoomed cards and their figures, upload to decant, change the monitor;
- GitHub's "Tank stock" job: requests it leaves in the queue are run here
  (``python -m tank_stock.run --in-session``), in the session.

Settings live in /opt/agents/tank-stock/settings.json and the AnyDesk login
in login.json (owner-only; saved by the workflow's save-login mode). One
capture runs at a time (capture.py holds a lock).
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
from . import decant, telegram
from .capture import CaptureError, capture, parse_ids

HOME = Path(os.environ.get("TANK_STOCK_HOME", "/opt/agents/tank-stock"))
QUEUE = Path(os.environ.get("TANK_STOCK_QUEUE", "/opt/agents/tank-stock-queue"))
PYTHON = os.environ.get("TANK_STOCK_PYTHON", "/opt/agents/venv/bin/python")
STATIC = Path(__file__).resolve().parent / "static"
PORT = 8790
IST = timezone(timedelta(hours=5, minutes=30))
TANKS = (1, 2, 3, 4)
DEFAULTS = {"monitor": True, "interval_min": 15, "tanks": list(TANKS), "auto_upload": True}
INTERVAL = (5, 1440)             # minutes; a capture takes about a minute
MAX_BODY = 16_000
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "/icon-192.png": ("icon-192.png", "image/png"),
    "/icon-512.png": ("icon-512.png", "image/png"),
    "/apple-touch-icon.png": ("apple-touch-icon.png", "image/png"),
}
SECURITY_HEADERS = (
    ("Cache-Control", "no-store"),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer"),
    ("Content-Security-Policy",
     "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; "
     "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"),
)


def now_iso() -> str:
    return datetime.now(IST).isoformat(timespec="seconds")


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write_json(path: Path, data, private: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600 if private else 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def clean_tanks(value) -> list[int]:
    try:
        tanks = sorted({int(t) for t in value})
    except (TypeError, ValueError):
        raise ValueError("Tanks must be numbers 1 to 4.") from None
    if not tanks or any(t not in TANKS for t in tanks):
        raise ValueError("Pick at least one tank, 1 to 4.")
    return tanks


def clean_settings(new: dict, old: dict) -> dict:
    out = {**DEFAULTS, **old}
    if "monitor" in new:
        out["monitor"] = bool(new["monitor"])
    if "auto_upload" in new:
        out["auto_upload"] = bool(new["auto_upload"])
    if "interval_min" in new:
        try:
            minutes = int(new["interval_min"])
        except (TypeError, ValueError):
            raise ValueError("The interval must be a whole number of minutes.") from None
        if not INTERVAL[0] <= minutes <= INTERVAL[1]:
            raise ValueError(f"The interval must be {INTERVAL[0]} to {INTERVAL[1]} minutes.")
        out["interval_min"] = minutes
    if "tanks" in new:
        out["tanks"] = clean_tanks(new["tanks"])
    return out


class Station:
    """Settings, the last capture, and running captures one at a time."""

    def __init__(self, home: Path = HOME, capture_fn=capture, decant_mod=decant, notify=telegram.send_text):
        self.home = home
        self.capture_fn = capture_fn
        self.decant = decant_mod
        self.notify = notify
        self.busy = threading.Lock()
        self.busy_since = None
        self.busy_what = ""
        self.wake = threading.Event()
        self.alerted = ""               # the failure Telegram was last told about
        self.last = _read_json(home / "last.json", {})
        self.monitor_state = _read_json(home / "monitor.json", {})

    # ---- settings and login --------------------------------------------
    @property
    def settings(self) -> dict:
        return {**DEFAULTS, **_read_json(self.home / "settings.json", {})}

    def save_settings(self, new: dict) -> dict:
        s = clean_settings(new, self.settings)
        _write_json(self.home / "settings.json", s)
        self.wake.set()                 # the monitor re-plans its next run
        return s

    def login(self) -> tuple[list[str], str]:
        data = _read_json(self.home / "login.json", {})
        if not data.get("password") or not data.get("ids"):
            raise CaptureError("The AnyDesk login isn't on the server yet: run the 'Tank stock' "
                               "workflow once in save-login mode.")
        return parse_ids(",".join(data["ids"])), data["password"]

    # ---- one capture ----------------------------------------------------
    def run(self, tanks, upload: bool, why: str) -> dict:
        """Connect, read the cards, maybe upload. Returns the new ``last``."""
        if not self.busy.acquire(blocking=False):
            raise RuntimeError("A capture is already running; wait for it to finish.")
        self.busy_since, self.busy_what = now_iso(), why
        try:
            return self._run(clean_tanks(tanks), upload, why)
        finally:
            self.busy_since, self.busy_what = None, ""
            self.busy.release()

    def _run(self, tanks, upload, why):
        started = now_iso()
        try:
            ids, password = self.login()
            png, _windows, used, page = self.capture_fn(ids, password)
        except CaptureError as exc:
            self.last = {**self.last, "error": str(exc), "error_at": started, "why": why}
            _write_json(self.home / "last.json", self.last)
            raise
        (self.home / "screen.png").write_bytes(png)
        boxes, read = cards_mod.read_all(png)
        try:
            cfg, cfg_error = self.decant.settings(), ""
        except self.decant.DecantError as exc:
            cfg = {"tanks": self.decant.DEFAULT_TANKS, "dateOrder": "MDY", "chart": self.decant.dip_chart()}
            cfg_error = f"{exc} Using the app's default tanks."
        found = {}
        for no, card in read.items():
            tank = self.decant.tank_for(no, cfg)
            built = self.decant.make_reading(card, tank, cfg) if tank else None
            found[str(no)] = {
                "box": boxes[no], "product": card.get("product"), "tank_id": tank and tank["id"],
                "reading": built and built["reading"], "confidence": built and built["confidence"],
                "problems": built["problems"] if built else ["the decant app has no such tank"],
            }
        self.last = {"at": started, "why": why, "page": page, "id_no": used, "tanks": found,
                     "asked": tanks, "settings_note": cfg_error, "uploads": {}}
        if upload:
            self._upload(tanks, read, cfg)
        _write_json(self.home / "last.json", self.last)
        (self.home / "cards.json").write_text(json.dumps({str(k): v for k, v in read.items()}))
        return self.last

    def _upload(self, tanks, read, cfg) -> dict:
        try:
            results = self.decant.upload(read, tanks, cfg)
        except self.decant.DecantError as exc:
            results = {n: {"ok": False, "message": str(exc)} for n in tanks}
        stamp = now_iso()
        uploads = self.last.setdefault("uploads", {})
        for no, r in results.items():
            uploads[str(no)] = {**r, "at": stamp}
        return results

    def upload_last(self, tanks) -> dict:
        """The Upload buttons: save the last capture's readings."""
        tanks = clean_tanks(tanks)
        read = {int(k): v for k, v in _read_json(self.home / "cards.json", {}).items()}
        if not read:
            raise ValueError("Capture the tanks first.")
        if not self.busy.acquire(timeout=5):
            raise ValueError("A capture is running; upload when it has finished.")
        try:
            try:
                cfg = self.decant.settings()
            except self.decant.DecantError as exc:
                return {n: {"ok": False, "message": str(exc)} for n in tanks}
            results = self._upload(tanks, read, cfg)
            _write_json(self.home / "last.json", self.last)
        finally:
            self.busy.release()
        return results

    def picture(self, tanks, stack: bool = False) -> bytes:
        try:
            png = (self.home / "screen.png").read_bytes()
        except OSError:
            return b""
        boxes = {int(k): tuple(v["box"]) for k, v in (self.last.get("tanks") or {}).items()}
        return cards_mod.picture(png, boxes, clean_tanks(tanks), stack=stack)

    # ---- the monitor ----------------------------------------------------
    def next_due(self) -> float:
        last = self.monitor_state.get("last_run_ts", 0)
        return last + self.settings["interval_min"] * 60

    def monitor_once(self) -> None:
        s = self.settings
        if self.busy.locked():                  # a capture from the page: try again in a minute
            self.monitor_state["last_run_ts"] = time.time() - s["interval_min"] * 60 + 60
            return
        self.monitor_state["last_run_ts"] = time.time()
        self.monitor_state["last_run"] = now_iso()
        try:
            last = self.run(s["tanks"], s["auto_upload"], "monitor")
            bad = {n: u["message"] for n, u in last.get("uploads", {}).items() if not u.get("ok")}
            problem = "; ".join(f"Tank {n}: {m}" for n, m in sorted(bad.items()))
            self.monitor_state["last_error"] = problem
        except (CaptureError, RuntimeError) as exc:
            problem = str(exc)
            self.monitor_state["last_error"] = problem
        except Exception as exc:  # noqa: BLE001 - keep the monitor alive
            problem = f"{type(exc).__name__}: {exc}"
            self.monitor_state["last_error"] = problem
            traceback.print_exc()
        _write_json(self.home / "monitor.json", self.monitor_state)
        # Tell Telegram when something goes wrong, and when it's fine again.
        if problem and problem != self.alerted:
            self.notify(f"⚠️ Tank stock monitor: {problem}")
        elif not problem and self.alerted:
            self.notify("✅ Tank stock monitor is uploading again.")
        self.alerted = problem

    def monitor_loop(self, stop: threading.Event) -> None:
        while not stop.is_set():
            wait = self.next_due() - time.time()
            if self.settings["monitor"] and wait <= 0:
                self.monitor_once()
                continue
            self.wake.clear()
            self.wake.wait(timeout=min(max(wait, 5), 60) if self.settings["monitor"] else 60)

    # ---- GitHub job requests -------------------------------------------
    def queue_loop(self, stop: threading.Event) -> None:
        QUEUE.mkdir(mode=0o700, parents=True, exist_ok=True)
        while not stop.wait(2):
            for req in sorted(QUEUE.glob("*.req")):
                job = str(req)[:-4]
                try:
                    workdir = req.read_text(encoding="utf-8").strip()
                    req.unlink()
                except OSError:
                    continue
                with open(f"{job}.log", "wb") as log:
                    try:
                        rc = subprocess.run([PYTHON, "-m", "tank_stock.run", "--in-session", job],
                                            cwd=workdir, stdout=log, stderr=subprocess.STDOUT,
                                            timeout=600).returncode
                    except (OSError, subprocess.TimeoutExpired) as exc:
                        log.write(f"The capture could not run: {type(exc).__name__}\n".encode())
                        rc = 1
                Path(f"{job}.rc.tmp").write_text(f"{rc}\n")
                os.replace(f"{job}.rc.tmp", f"{job}.rc")

    # ---- the page's view ------------------------------------------------
    def view(self) -> dict:
        s = self.settings
        login = _read_json(self.home / "login.json", {})
        due = self.next_due()
        return {
            "settings": s,
            "limits": {"interval_min": INTERVAL},
            "login_saved": bool(login.get("password") and login.get("ids")),
            "busy": {"since": self.busy_since, "what": self.busy_what} if self.busy_since else None,
            "monitor": {**{k: v for k, v in self.monitor_state.items() if k != "last_run_ts"},
                        "next_run": datetime.fromtimestamp(max(due, time.time()), IST).isoformat(timespec="seconds")
                        if s["monitor"] else None},
            "last": self.last,
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
            return self._json(200, self.station.view())
        if url.path == "/api/picture":
            try:
                query = parse_qs(url.query)
                tanks = [t for t in query.get("tanks", [""])[0].split(",") if t]
                png = self.station.picture(tanks, stack=query.get("stack", ["0"])[0] == "1")
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
        size = int(self.headers.get("Content-Length") or 0)
        if size > MAX_BODY:
            return self._json(413, {"error": "Request too large."})
        try:
            body = json.loads(self.rfile.read(size) or b"{}")
            path = urlparse(self.path).path
            if path == "/api/capture":
                tanks = clean_tanks(body.get("tanks") or [])
                if self.station.busy.locked():
                    return self._json(409, {"error": "A capture is already running; wait for it to finish."})
                threading.Thread(target=self._capture, args=(tanks, bool(body.get("upload"))),
                                 daemon=True).start()
                return self._json(202, {"started": True})
            if path == "/api/upload":
                return self._json(200, {"results": self.station.upload_last(body.get("tanks") or [])})
            if path == "/api/settings":
                return self._json(200, {"settings": self.station.save_settings(body)})
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        self._json(404, {"error": "Not found."})

    def _capture(self, tanks, upload):
        try:
            self.station.run(tanks, upload, "phone")
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
    ap = argparse.ArgumentParser(description="Tank stock monitor and phone page")
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args(argv)
    HOME.mkdir(parents=True, exist_ok=True)
    station = Station()
    stop = threading.Event()
    threading.Thread(target=station.queue_loop, args=(stop,), daemon=True, name="queue").start()
    threading.Thread(target=station.monitor_loop, args=(stop,), daemon=True, name="monitor").start()
    hosts = os.environ.get("TANK_STOCK_HOSTS", "").split(",")
    users = os.environ.get("TANK_STOCK_USERS", "").split(",")
    httpd = make_server(station, args.port, hosts, users)
    print(f"Tank stock page on http://127.0.0.1:{args.port}/ "
          f"({', '.join(sorted(httpd.hosts)) or 'this server only'}); monitor "  # type: ignore[attr-defined]
          f"{'on' if station.settings['monitor'] else 'off'}.", flush=True)
    try:
        httpd.serve_forever()
    finally:
        stop.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
