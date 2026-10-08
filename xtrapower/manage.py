"""XtraPower account manager — edit the monitor's accounts from a browser.

A small local web app (standard library only, like the Tally apps) over
``config.json``: add / edit / delete accounts, switch watching on or off,
change a User ID or password, and edit the Telegram token, chat ID and check
interval. The monitor re-reads ``config.json`` every cycle, so a change takes
effect on its next check (default 2 minutes) without restarting anything.

Who can reach it
  * On this Mac at http://127.0.0.1:8780 — no PIN, same as the other apps.
  * With ``--remote``, also on this Mac's Tailscale address (100.x.y.z), so
    your phone can use it from anywhere over Tailscale's private network.
    Only devices signed in to *your* tailnet can reach that address; the
    server never listens on the office Wi-Fi or the open internet. Remote use
    needs the PIN, which can only be set from the Mac itself.

What it never does
  * Send a saved password or the Telegram token back to the browser. To
    change one, type the new value; leaving the box blank keeps the old one.

Run:  ./xtrapower/manage-mac.sh start     (background, Mac + phone)
      python -m xtrapower.manage           (foreground, Mac only)
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional
from urllib.parse import unquote, urlparse

from . import configfile
from . import launch as launch_mod
from . import state as state_mod
from .notify import Telegram

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(HERE, "config.json")
PAGE_PATH = os.path.join(HERE, "manage.html")
JS_PATH = os.path.join(HERE, "manage.js")
DEFAULT_PORT = 8780            # Tally apps use 8756 / 8760 / 8770 / 8771

SESSION_SECONDS = 12 * 3600    # a phone stays signed in for 12 hours
MAX_PIN_FAILURES = 5           # wrong PINs before a lockout...
LOCKOUT_SECONDS = 15 * 60      # ...of 15 minutes
MIN_PIN_LENGTH = 6
PBKDF2_ROUNDS = 200_000
POLL_MIN, POLL_MAX = 60, 3600  # check interval bounds (be polite to the portal)
MAX_BODY = 64_000

_TAILNET_V4 = ipaddress.ip_network("100.64.0.0/10")        # Tailscale's IPv4 range
_TAILNET_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")  # Tailscale's IPv6 range
_PLACEHOLDER = "PUT-YOUR"                                  # config.example.json values


class ValidationError(ValueError):
    """A user-facing problem with submitted data; the message is shown as-is."""


# ---- pure helpers (unit-tested) ------------------------------------------

def hash_pin(pin: str, salt: Optional[bytes] = None) -> dict:
    """Salted PBKDF2 hash of the PIN, as stored under ``config["ui"]``."""
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", str(pin).encode(), salt, PBKDF2_ROUNDS)
    return {"pin_salt": salt.hex(), "pin_hash": digest.hex()}


def verify_pin(pin: str, ui: dict) -> bool:
    try:
        salt = bytes.fromhex(ui["pin_salt"])
        want = bytes.fromhex(ui["pin_hash"])
    except (KeyError, ValueError, TypeError):
        return False
    got = hashlib.pbkdf2_hmac("sha256", str(pin).encode(), salt, PBKDF2_ROUNDS)
    return hmac.compare_digest(got, want)


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def account_key(acct: dict) -> str:
    """The key an account is addressed by (matches the monitor's ``cid``)."""
    return str(acct.get("customer_id") or acct.get("label") or "account")


def clean_account(data: dict, existing: Optional[dict], others: list) -> dict:
    """Validate a submitted account and merge it over the stored one.

    Keys the page doesn't edit (``nav_labels``, ``balance_url``, ...) are kept.
    A blank or missing password keeps the stored one; ``clear_password``
    removes it (the account then goes back to manual login).
    """
    out = dict(existing or {})
    label = str(data.get("label", out.get("label", ""))).strip()
    if not label:
        raise ValidationError("Give the account a name.")
    cid = str(data.get("customer_id", out.get("customer_id", ""))).strip()
    if not cid.isdigit():
        raise ValidationError("Customer ID must be digits only, e.g. 1005218882.")
    try:
        port = int(str(data.get("cdp_port", out.get("cdp_port", ""))).strip())
    except ValueError:
        raise ValidationError("Chrome port must be a number, e.g. 9222.") from None
    if not 1024 <= port <= 65535:
        raise ValidationError("Chrome port must be between 1024 and 65535.")
    if port == DEFAULT_PORT:
        raise ValidationError(f"Port {DEFAULT_PORT} is used by this page; pick another.")
    for other in others:
        if str(other.get("customer_id", "")) == cid:
            raise ValidationError(
                f'Customer ID {cid} is already used by "{other.get("label", cid)}".')
        if str(other.get("cdp_port", "")) == str(port):
            raise ValidationError(
                f'Port {port} is already used by "{other.get("label", "")}". '
                "Each account needs its own Chrome port.")
    out["label"] = label
    out["customer_id"] = cid
    out["cdp_port"] = port
    out["watch"] = _as_bool(data.get("watch", out.get("watch", True)))
    out["username"] = str(data.get("username", out.get("username", "")) or "").strip()
    if _as_bool(data.get("clear_password", False)):
        out["password"] = ""
    elif data.get("password"):
        out["password"] = str(data["password"])
    else:
        out.setdefault("password", "")
    return out


def clean_settings(data: dict, cfg: dict) -> dict:
    """Validate Telegram + interval changes. A blank token keeps the stored one."""
    tg = dict(cfg.get("telegram") or {})
    token = str(data.get("telegram_token") or "").strip()
    if token:
        if not re.fullmatch(r"\d{5,}:[A-Za-z0-9_-]{20,}", token):
            raise ValidationError(
                "That doesn't look like a BotFather token (it has the form 123456789:AAE...).")
        tg["token"] = token
    if "chat_id" in data:
        chat = str(data.get("chat_id") or "").strip()
        if chat and not re.fullmatch(r"-?\d+", chat):
            raise ValidationError("Chat ID is a number (group chats start with a minus sign).")
        tg["chat_id"] = chat
    poll = cfg.get("poll_seconds", 120)
    if "poll_seconds" in data:
        try:
            poll = int(str(data["poll_seconds"]).strip())
        except ValueError:
            raise ValidationError("Check interval must be a number of seconds.") from None
        if not POLL_MIN <= poll <= POLL_MAX:
            raise ValidationError(
                f"Check interval must be between {POLL_MIN} and {POLL_MAX} seconds.")
    return {"telegram": tg, "poll_seconds": poll}


def public_account(acct: dict, st: dict) -> dict:
    """What the page may see of an account — never the password."""
    s = (st.get("accounts") or {}).get(account_key(acct), {})
    return {
        "label": acct.get("label", ""),
        "customer_id": str(acct.get("customer_id", "")),
        "cdp_port": acct.get("cdp_port"),
        "watch": bool(acct.get("watch", True)),
        "username": acct.get("username", ""),
        "has_password": bool(acct.get("password")),
        "last_ccms": s.get("ccms"),
        "updated_at": s.get("updated_at"),
        "last_error": s.get("last_error"),
        "last_error_at": s.get("last_error_at"),
    }


def public_settings(cfg: dict) -> dict:
    """What the page may see of the settings — never the token itself."""
    tg = cfg.get("telegram") or {}
    token = str(tg.get("token") or "")
    token_set = bool(token) and _PLACEHOLDER not in token
    chat = str(tg.get("chat_id") or "")
    return {
        "telegram_token_set": token_set,
        "telegram_token_hint": ("…" + token[-4:]) if token_set else "",
        "chat_id": "" if _PLACEHOLDER in chat else chat,
        "poll_seconds": int(cfg.get("poll_seconds", 120)),
        "pin_set": bool((cfg.get("ui") or {}).get("pin_hash")),
    }


def next_free_port(accounts: list) -> int:
    used = {str(a.get("cdp_port")) for a in accounts}
    port = 9222
    while str(port) in used or port == DEFAULT_PORT:
        port += 1
    return port


def monitor_status(pid_path: str) -> dict:
    """Is the monitor (started by monitor-mac.sh) running right now?"""
    try:
        with open(pid_path, encoding="utf-8") as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return {"running": False, "pid": None}
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return {"running": False, "pid": None}
    except PermissionError:
        pass                    # exists, owned by someone else — still running
    return {"running": True, "pid": pid}


def client_kind(ip: str) -> str:
    """'local' (this Mac), 'tailnet' (one of your Tailscale devices) or 'other'."""
    try:
        addr = ipaddress.ip_address(ip.split("%")[0])
    except ValueError:
        return "other"
    if addr.version == 6 and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    if addr.is_loopback:
        return "local"
    if (addr.version == 4 and addr in _TAILNET_V4) or (addr.version == 6 and addr in _TAILNET_V6):
        return "tailnet"
    return "other"


def host_ok_for_local(host: str, port: int) -> bool:
    """A request from this Mac must name the Mac itself (blocks DNS rebinding)."""
    return (host or "").lower() in {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}


def access_error(kind: str, host: str, port: int, need_auth: bool,
                 session_ok: bool) -> Optional[tuple]:
    """``None`` if the request may proceed, else ``(status, message)``."""
    if kind == "other":
        return 403, "Not allowed from this network."
    if kind == "local" and not host_ok_for_local(host, port):
        return 403, "Open this page at http://127.0.0.1:%d/ on the Mac." % port
    if need_auth and kind == "tailnet" and not session_ok:
        return 401, "PIN required."
    return None


def tailscale_ipv4() -> Optional[str]:
    """This Mac's Tailscale IPv4 address, or None if Tailscale isn't running."""
    candidates = ("tailscale",
                  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
                  "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale")
    for exe in candidates:
        path = shutil.which(exe) or (exe if os.path.isfile(exe) else None)
        if not path:
            continue
        try:
            out = subprocess.run([path, "ip", "-4"], capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            continue
        for line in out.stdout.split():
            try:
                if ipaddress.ip_address(line) in _TAILNET_V4:
                    return line
            except ValueError:
                continue
    return None


# ---- the app: config IO, sessions, PIN -------------------------------------

class App:
    def __init__(self, config_path: str, port: int):
        self.config_path = config_path
        base = os.path.dirname(os.path.abspath(config_path))
        self.state_path = os.path.join(base, "state.json")
        self.pid_path = os.path.join(base, "monitor.pid")
        self.profiles_dir = os.path.join(base, "profiles")
        self.port = port
        self.csrf = secrets.token_urlsafe(32)   # per-run token embedded in the page
        self._sessions: dict[str, float] = {}
        self._fails = 0
        self._locked_until = 0.0
        self._lock = threading.Lock()

    # -- config file --
    def read(self) -> dict:
        cfg = configfile.load(self.config_path)
        cfg.setdefault("accounts", [])
        cfg.setdefault("telegram", {})
        cfg.setdefault("poll_seconds", 120)
        return cfg

    def write(self, cfg: dict) -> None:
        """Atomic write, previous version kept as config.json.bak, owner-only."""
        path = self.config_path
        folder = os.path.dirname(os.path.abspath(path))
        if os.path.exists(path):
            shutil.copy2(path, path + ".bak")
            os.chmod(path + ".bak", 0o600)
        fd, tmp = tempfile.mkstemp(dir=folder, prefix=".config-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2, ensure_ascii=False)
                f.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def snapshot(self, kind: str) -> dict:
        cfg = self.read()
        st = state_mod.load(self.state_path)
        return {
            "monitor": monitor_status(self.pid_path),
            "settings": public_settings(cfg),
            "accounts": [public_account(a, st) for a in cfg["accounts"]],
            "next_port": next_free_port(cfg["accounts"]),
            "is_local": kind == "local",
        }

    # -- accounts --
    @staticmethod
    def _index(cfg: dict, key: str) -> int:
        for i, acct in enumerate(cfg["accounts"]):
            if account_key(acct) == key:
                return i
        raise LookupError(key)

    def add_account(self, data: dict) -> None:
        with self._lock:
            cfg = self.read()
            cfg["accounts"].append(clean_account(data, None, cfg["accounts"]))
            self.write(cfg)

    def update_account(self, key: str, data: dict) -> None:
        with self._lock:
            cfg = self.read()
            i = self._index(cfg, key)
            others = [a for j, a in enumerate(cfg["accounts"]) if j != i]
            cfg["accounts"][i] = clean_account(data, cfg["accounts"][i], others)
            self.write(cfg)

    def set_watch(self, key: str, watch: bool) -> None:
        with self._lock:
            cfg = self.read()
            cfg["accounts"][self._index(cfg, key)]["watch"] = bool(watch)
            self.write(cfg)

    def delete_account(self, key: str) -> None:
        with self._lock:
            cfg = self.read()
            cfg["accounts"].pop(self._index(cfg, key))
            self.write(cfg)

    def open_window(self, key: str) -> None:
        cfg = self.read()
        acct = cfg["accounts"][self._index(cfg, key)]
        chrome = launch_mod.find_chrome()
        if not chrome:
            raise ValidationError("Google Chrome wasn't found on the Mac.")
        launch_mod.launch_account(chrome, acct, self.profiles_dir)

    # -- settings --
    def update_settings(self, data: dict) -> None:
        with self._lock:
            cfg = self.read()
            new = clean_settings(data, cfg)
            cfg["telegram"] = new["telegram"]
            cfg["poll_seconds"] = new["poll_seconds"]
            self.write(cfg)

    def test_telegram(self) -> None:
        tg = self.read().get("telegram") or {}
        bot = Telegram(tg.get("token"), tg.get("chat_id"))
        if not bot.configured or _PLACEHOLDER in str(tg.get("token")):
            raise ValidationError("Set the bot token and chat ID first.")
        if not bot.send("✅ XtraPower account manager: Telegram is working."):
            raise ValidationError("Telegram didn't accept the message. Check the token and chat ID.")

    # -- PIN + sessions --
    def set_pin(self, pin: str) -> None:
        pin = str(pin or "").strip()
        if len(pin) < MIN_PIN_LENGTH:
            raise ValidationError(f"Use at least {MIN_PIN_LENGTH} characters for the PIN.")
        with self._lock:
            cfg = self.read()
            cfg["ui"] = {**(cfg.get("ui") or {}), **hash_pin(pin)}
            self.write(cfg)
        self._sessions.clear()          # a new PIN signs every phone out

    def login(self, pin: str) -> tuple:
        """Returns ``(status, message, session_token_or_None)``."""
        with self._lock:
            now = time.time()
            if now < self._locked_until:
                mins = int((self._locked_until - now) // 60) + 1
                return 429, f"Too many wrong PINs. Try again in {mins} min.", None
            ui = self.read().get("ui") or {}
            if not ui.get("pin_hash"):
                return 409, ("No PIN is set yet. Open this page on the Mac and set one "
                             "under Settings first."), None
            if verify_pin(pin, ui):
                self._fails = 0
                token = secrets.token_urlsafe(32)
                self._sessions[token] = now + SESSION_SECONDS
                return 200, "", token
            self._fails += 1
            if self._fails >= MAX_PIN_FAILURES:
                self._fails = 0
                self._locked_until = now + LOCKOUT_SECONDS
                return 429, f"Wrong PIN. Locked for {LOCKOUT_SECONDS // 60} minutes.", None
            left = MAX_PIN_FAILURES - self._fails
            return 401, f"Wrong PIN ({left} {'try' if left == 1 else 'tries'} left).", None

    def session_valid(self, token: Optional[str]) -> bool:
        expiry = self._sessions.get(token or "")
        if not expiry:
            return False
        if expiry < time.time():
            self._sessions.pop(token, None)
            return False
        return True

    def logout(self, token: Optional[str]) -> None:
        self._sessions.pop(token or "", None)


# ---- HTTP ------------------------------------------------------------------

_SECURITY_HEADERS = (
    ("Cache-Control", "no-store"),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer"),
    ("Content-Security-Policy",
     "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
     "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
     "base-uri 'none'; form-action 'self'"),
)


class Handler(BaseHTTPRequestHandler):
    server_version = "XtraPowerManager"

    @property
    def app(self) -> App:
        return self.server.app          # type: ignore[attr-defined]

    def log_message(self, fmt, *args):  # one line per request, to the log file
        sys.stderr.write("%s %s\n" % (self.client_address[0], fmt % args))

    # -- plumbing --
    def _send(self, status: int, body: bytes, ctype: str, extra=()) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in _SECURITY_HEADERS:
            self.send_header(k, v)
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, data: dict, extra=()) -> None:
        self._send(status, json.dumps(data).encode(), "application/json; charset=utf-8", extra)

    def _session_token(self) -> Optional[str]:
        jar = cookies.SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie", ""))
        except cookies.CookieError:
            return None
        return jar["xp_session"].value if "xp_session" in jar else None

    def _gate(self, need_auth: bool = True) -> Optional[str]:
        kind = client_kind(self.client_address[0])
        err = access_error(kind, self.headers.get("Host", ""), self.app.port, need_auth,
                           self.app.session_valid(self._session_token()))
        if err:
            self._json(err[0], {"error": err[1]})
            return None
        return kind

    def _csrf_ok(self) -> bool:
        sent = self.headers.get("X-XP-CSRF", "")
        if sent and hmac.compare_digest(sent, self.app.csrf):
            return True
        self._json(403, {"error": "This page is out of date. Reload it and try again."})
        return False

    def _body(self) -> dict:
        size = int(self.headers.get("Content-Length") or 0)
        if size > MAX_BODY:
            raise ValidationError("Request too large.")
        raw = self.rfile.read(size) if size else b"{}"
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise ValidationError("Bad request.") from None
        if not isinstance(data, dict):
            raise ValidationError("Bad request.")
        return data

    # -- routes --
    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")

    def _route(self, method: str) -> None:
        path = urlparse(self.path).path
        try:
            if method == "GET" and path in ("/", "/index.html"):
                if self._gate(need_auth=False):
                    with open(PAGE_PATH, encoding="utf-8") as f:
                        html = f.read().replace("__CSRF__", self.app.csrf)
                    self._send(200, html.encode(), "text/html; charset=utf-8")
                return
            if method == "GET" and path == "/manage.js":
                if self._gate(need_auth=False):
                    with open(JS_PATH, "rb") as f:
                        self._send(200, f.read(), "application/javascript; charset=utf-8")
                return
            if method == "POST" and path == "/api/login":
                if self._gate(need_auth=False) and self._csrf_ok():
                    status, msg, token = self.app.login(self._body().get("pin", ""))
                    if token:
                        cookie = (f"xp_session={token}; HttpOnly; SameSite=Strict; Path=/; "
                                  f"Max-Age={SESSION_SECONDS}")
                        self._json(200, {"ok": True}, extra=(("Set-Cookie", cookie),))
                    else:
                        self._json(status, {"error": msg})
                return

            kind = self._gate()
            if not kind:
                return
            if method == "GET":
                if path == "/api/state":
                    self._json(200, self.app.snapshot(kind))
                else:                       # e.g. a browser's automatic /favicon.ico
                    self._json(404, {"error": "Not found."})
                return
            if not self._csrf_ok():
                return
            self._mutate(method, path, kind)
        except ValidationError as exc:
            self._json(400, {"error": str(exc)})
        except LookupError:
            self._json(404, {"error": "That account no longer exists. Reload the page."})
        except configfile.ConfigError as exc:
            self._json(500, {"error": str(exc)})

    def _mutate(self, method: str, path: str, kind: str) -> None:
        app = self.app
        if method == "POST" and path == "/api/logout":
            app.logout(self._session_token())
            self._json(200, {"ok": True}, extra=((
                "Set-Cookie", "xp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"),))
            return
        if method == "POST" and path == "/api/accounts":
            app.add_account(self._body())
            self._json(200, app.snapshot(kind))
            return
        m = re.fullmatch(r"/api/accounts/([^/]+)(/watch|/open)?", path)
        if m:
            key, action = unquote(m.group(1)), m.group(2)
            if method == "PUT" and not action:
                app.update_account(key, self._body())
            elif method == "DELETE" and not action:
                app.delete_account(key)
            elif method == "POST" and action == "/watch":
                app.set_watch(key, _as_bool(self._body().get("watch")))
            elif method == "POST" and action == "/open":
                app.open_window(key)
            else:
                self._json(405, {"error": "Not allowed."})
                return
            self._json(200, app.snapshot(kind))
            return
        if method == "PUT" and path == "/api/settings":
            app.update_settings(self._body())
            self._json(200, app.snapshot(kind))
            return
        if method == "POST" and path == "/api/settings/test":
            app.test_telegram()
            self._json(200, {"ok": True})
            return
        if method == "POST" and path == "/api/pin":
            if kind != "local":
                self._json(403, {"error": "The PIN can only be set on the Mac itself."})
                return
            app.set_pin(self._body().get("pin", ""))
            self._json(200, app.snapshot(kind))
            return
        self._json(404, {"error": "Not found."})


def make_server(app: App, host: str, port: int) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.app = app                       # type: ignore[attr-defined]
    return srv


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="XtraPower account manager (web page)")
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--remote", action="store_true",
                    help="also listen on this Mac's Tailscale address (phone access, PIN required)")
    ap.add_argument("--no-browser", action="store_true", help="don't open the page on start")
    args = ap.parse_args(argv)

    app = App(args.config, args.port)
    try:
        cfg = app.read()
    except configfile.ConfigError as exc:
        sys.exit(f"\n{exc}\n")

    hosts = ["127.0.0.1"]
    ts_ip = tailscale_ipv4() if args.remote else None
    if args.remote and not ts_ip:
        print("Tailscale isn't running on this Mac, so the page is Mac-only for now. "
              "Install Tailscale, sign in, then restart this.", flush=True)
    if ts_ip:
        hosts.append(ts_ip)

    servers = []
    for host in hosts:
        try:
            servers.append(make_server(app, host, args.port))
        except OSError as exc:
            sys.exit(f"Can't listen on {host}:{args.port} ({exc}). Is the account manager "
                     "already running? Check with: ./xtrapower/manage-mac.sh status")
    for srv in servers[1:]:
        threading.Thread(target=srv.serve_forever, daemon=True).start()

    local_url = f"http://127.0.0.1:{args.port}/"
    print(f"XtraPower account manager — on this Mac: {local_url}", flush=True)
    if ts_ip:
        print(f"XtraPower account manager — on your phone (Tailscale): "
              f"http://{ts_ip}:{args.port}/  (PIN required)", flush=True)
        if not (cfg.get("ui") or {}).get("pin_hash"):
            print("No PIN set yet: open the Mac link above and set one under Settings.", flush=True)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(local_url)).start()
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for srv in servers:
            srv.server_close()


if __name__ == "__main__":
    main()
