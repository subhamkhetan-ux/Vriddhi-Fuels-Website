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
  ``interval_min`` minutes read the screen again (no reconnecting) and, with
  ``auto_upload``, update the decant app. It runs until AnyDesk ends the
  session (e.g. a free licence's time limit) or you press Stop; the
  XtraPower Telegram bot is told when AnyDesk ends it, with what the screen
  showed.
- GitHub's "Tank stock" job: its queued requests run here, in the session
  (``python -m tank_stock.run --in-session``), or from the live session's
  screen while one is open.

Settings live in /opt/agents/tank-stock/settings.json and the AnyDesk login
in login.json (owner-only; saved by the workflow's save-login mode).
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
from .capture import CaptureError, Session, parse_ids

HOME = Path(os.environ.get("TANK_STOCK_HOME", "/opt/agents/tank-stock"))
QUEUE = Path(os.environ.get("TANK_STOCK_QUEUE", "/opt/agents/tank-stock-queue"))
PYTHON = os.environ.get("TANK_STOCK_PYTHON", "/opt/agents/venv/bin/python")
STATIC = Path(__file__).resolve().parent / "static"
PORT = 8790
IST = timezone(timedelta(hours=5, minutes=30))
TANKS = (1, 2, 3, 4)
DEFAULTS = {"interval_min": 15, "tanks": list(TANKS), "auto_upload": True}   # live monitoring
INTERVAL = (1, 240)              # minutes between live reads (no reconnecting)
CHECK_EVERY = 15                 # seconds: is the live session still open?
MAX_FAILED_READS = 3             # live reads that may fail in a row
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
    out = {**DEFAULTS, **{k: v for k, v in old.items() if k in DEFAULTS}}
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
        self.live_last = _read_json(home / "live.json", {})
        self.alerted = ""
        self._dropped = ""               # the day earlier days' proof pictures were last cleared
        self.last = _read_json(home / "last.json", {})

    # ---- settings and login --------------------------------------------
    @property
    def settings(self) -> dict:
        return clean_settings({}, _read_json(self.home / "settings.json", {}))

    def save_settings(self, new: dict) -> dict:
        s = clean_settings(new, self.settings)
        _write_json(self.home / "settings.json", s)
        if self.live:                    # a running live session picks them up
            self.live.update(tanks=s["tanks"], interval_min=s["interval_min"], auto_upload=s["auto_upload"])
            self.live["wake"].set()
        return s

    def login(self) -> tuple[list[str], str]:
        data = _read_json(self.home / "login.json", {})
        if not data.get("password") or not data.get("ids"):
            raise CaptureError("The AnyDesk login isn't on the server yet: run the 'Tank stock' "
                               "workflow once in save-login mode.")
        return parse_ids(",".join(data["ids"])), data["password"]

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
        live = self.live if self.live and self.live.get("state") == "live" else None
        self._hold("decantation" if decantation else "capture", wait=90 if live else 0)
        try:
            try:
                if live:
                    png, page = live["session"].shot()
                    used = live["session"].position
                else:
                    ids, password = self.login()
                    with self.session_cls(ids, password) as session:
                        png, page = session.shot()
                        used = session.position
            except CaptureError as exc:
                self.last = {**self.last, "error": str(exc), "error_at": now_iso(), "why": why}
                _write_json(self.home / "last.json", self.last)
                raise
            last = self._record(png, page, used, tanks, upload, why)
        finally:
            self._release()
        if decantation and self.live:
            self.stop_live("sent for decantation")
        return last

    def _record(self, png, page, used, tanks, upload, why) -> dict:
        started = now_iso()
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
        (self.home / "cards.json").write_text(json.dumps({str(k): v for k, v in read.items()}))
        if upload:
            self._upload(tanks, read, cfg)
        _write_json(self.home / "last.json", self.last)
        return self.last

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
                self.decant.drop_old_proofs()
                self._dropped = self.decant.ist_day()
            jpeg = cards_mod.to_jpeg(self.picture(sorted(saved)))
            if not jpeg:
                raise ValueError("the picture of the cards could not be made")
            self.decant.save_proof(jpeg, {r["tank_id"]: r["mark"] for r in saved.values()})
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
            try:
                cfg = self.decant.settings()
            except self.decant.DecantError as exc:
                return {n: {"ok": False, "message": str(exc)} for n in tanks}
            results = self._upload(tanks, read, cfg)
            _write_json(self.home / "last.json", self.last)
        finally:
            self._release()
        return results

    def picture(self, tanks, stack: bool = False) -> bytes:
        try:
            png = (self.home / "screen.png").read_bytes()
        except OSError:
            return b""
        boxes = {int(k): tuple(v["box"]) for k, v in (self.last.get("tanks") or {}).items()}
        return cards_mod.picture(png, boxes, clean_tanks(tanks), stack=stack)

    # ---- live monitoring ------------------------------------------------
    def start_live(self, new_settings: dict | None = None) -> dict:
        """Connect and keep the session open, reading every interval_min."""
        if self.live:
            raise RuntimeError("Live monitoring is already running.")
        if self.busy.locked():
            raise RuntimeError("The agent is busy with the PC right now; try again in a minute.")
        s = self.save_settings(new_settings or {})
        self.live = {"state": "connecting", "since": now_iso(), "tanks": s["tanks"],
                     "interval_min": s["interval_min"], "auto_upload": s["auto_upload"],
                     "reads": 0, "failed": 0, "stop": threading.Event(), "wake": threading.Event()}
        threading.Thread(target=self._live_run, args=(self.live,), daemon=True, name="live").start()
        return self.live_view()

    def stop_live(self, why: str = "stopped by you") -> None:
        live = self.live
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
                session = self.session_cls(ids, password)
                session.open()
            finally:
                self._release()
            live.update(state="live", session=session, connected=now_iso())
            while not live["stop"].is_set():
                self._live_read(live)
                if live["failed"] >= MAX_FAILED_READS:
                    reason = f"{MAX_FAILED_READS} reads in a row failed"
                    break
                due = time.time() + live["interval_min"] * 60
                live["next_read"] = datetime.fromtimestamp(due, IST).isoformat(timespec="seconds")
                while time.time() < due and not live["stop"].is_set():
                    live["wake"].clear()
                    live["wake"].wait(timeout=min(CHECK_EVERY, max(0.1, due - time.time())))
                    if not session.alive():
                        reason = "AnyDesk ended the session"
                        final = session.screen()          # what AnyDesk shows now
                        break
                    if live["wake"].is_set() and not live["stop"].is_set():
                        due = min(due, time.time() + live["interval_min"] * 60)
                if reason:
                    break
            reason = reason or live.get("stop_reason") or "stopped"
        except (CaptureError, RuntimeError) as exc:
            reason = str(exc)
        except Exception as exc:  # noqa: BLE001 - always close the session
            reason = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()
        finally:
            if session:
                session.close()
            self._live_end(live, reason, final)

    def _live_read(self, live) -> None:
        try:
            self._hold("live read", wait=120)
        except RuntimeError:
            live["failed"] += 1
            return
        try:
            png, page = live["session"].shot()
            last = self._record(png, page, live["session"].position, live["tanks"],
                                live["auto_upload"], "live")
            live.update(reads=live["reads"] + 1, failed=0, last_read=last["at"])
            bad = {n: u["message"] for n, u in last.get("uploads", {}).items() if not u.get("ok")}
            missing = [n for n in live["tanks"] if str(n) not in last["tanks"]]
            problem = "; ".join([f"Tank {n}: {m}" for n, m in sorted(bad.items())]
                                + ([f"not on the screen: Tank {', '.join(map(str, missing))} ({page})"]
                                   if missing and not bad else []))
            if problem and problem != self.alerted:
                self.notify(f"⚠️ Tank stock (live): {problem}")
            self.alerted = problem
        except Exception as exc:  # noqa: BLE001 - count it, keep the session
            live["failed"] += 1
            live["last_error"] = f"{type(exc).__name__}: {exc}"
        finally:
            self._release()

    def _live_end(self, live, reason: str, final: bytes) -> None:
        ended = now_iso()
        minutes = int((datetime.fromisoformat(ended) - datetime.fromisoformat(live["since"])).total_seconds() // 60)
        took = f"{minutes // 60} h {minutes % 60} min" if minutes >= 60 else f"{minutes} min"
        self.live_last = {"since": live["since"], "ended": ended, "lasted": took, "reason": reason,
                          "reads": live["reads"]}
        _write_json(self.home / "live.json", self.live_last)
        self.live = None
        self.alerted = ""
        if live.get("stop_reason"):
            return                          # you stopped it: no message needed
        reads = f"{live['reads']} read{'' if live['reads'] == 1 else 's'}"
        text = f"Tank stock live monitoring ended after {took} ({reads}): {reason}."
        if final:
            self.notify_photo(final, text + "\nThis is what the server's AnyDesk showed.")
        else:
            self.notify(text)

    def live_view(self) -> dict | None:
        live = self.live
        if not live:
            return None
        return {k: v for k, v in live.items() if k not in ("session", "stop", "wake")}

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
                if self.live and self.live.get("state") == "live":
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
                Path(f"{job}.rc.tmp").write_text(f"{rc}\n")
                os.replace(f"{job}.rc.tmp", f"{job}.rc")

    def _job_from_live(self, job: str) -> tuple[int, str]:
        """The GitHub job asked while the live session is open: answer from it."""
        Path(f"{job}.env").unlink(missing_ok=True)
        try:
            self._hold("GitHub job", wait=120)
        except RuntimeError as exc:
            return 1, f"{exc}\n"
        try:
            png, page = self.live["session"].shot()
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
            "limits": {"interval_min": INTERVAL},
            "login_saved": bool(login.get("password") and login.get("ids")),
            "busy": {"since": self.busy_since, "what": self.busy_what} if self.busy_since else None,
            "live": self.live_view(),
            "live_last": self.live_last,
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
                st = self.station
                if st.busy.locked() or (st.live and st.live.get("state") != "live"):
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
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        except RuntimeError as exc:
            return self._json(409, {"error": str(exc)})
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
    station = Station()
    stop = threading.Event()
    threading.Thread(target=station.queue_loop, args=(stop,), daemon=True, name="queue").start()
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
