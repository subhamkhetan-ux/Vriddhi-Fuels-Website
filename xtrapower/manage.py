"""XtraPower account manager — edit the monitor's accounts in a browser on the Mac.

A small local web app (standard library only, like the Tally apps) over
``config.json``: add / edit / delete accounts, switch watching on or off,
change a User ID, password or Chrome port, and edit the Telegram token, chat
ID and check interval. The monitor re-reads ``config.json`` every cycle, so a
change takes effect on its next check (default 2 minutes) without a restart.

It runs on this Mac only, at http://127.0.0.1:8780 — the same as the other
local apps (bank_tally, iocl_tally, fleet_tally, consign). Nothing else can
reach it. To check on the monitor from your phone, use the Telegram commands
instead (/status, /logs — see telegram_bot.py).

It never sends a saved password or the Telegram token back to the browser: to
change one, type the new value; leaving the box blank keeps the old one.

Run:  ./xtrapower/manage-mac.sh          (opens the page; Ctrl-C to stop)
"""

from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import sys
import tempfile
import threading
import webbrowser
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

POLL_MIN, POLL_MAX = 60, 3600  # check interval bounds (be polite to the portal)
MAX_BODY = 64_000
_PLACEHOLDER = "PUT-YOUR"      # config.example.json values


class ValidationError(ValueError):
    """A user-facing problem with submitted data; the message is shown as-is."""


# ---- pure helpers (unit-tested) ------------------------------------------

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


def is_loopback(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip.split("%")[0])
    except ValueError:
        return False
    if addr.version == 6 and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_loopback


def host_ok(host: str, port: int) -> bool:
    """The request must name this Mac itself (blocks DNS rebinding)."""
    return (host or "").lower() in {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}


def access_error(client_ip: str, host: str, port: int) -> Optional[tuple]:
    """``None`` if the request may proceed, else ``(status, message)``."""
    if not is_loopback(client_ip):
        return 403, "This page only works on the Mac itself."
    if not host_ok(host, port):
        return 403, f"Open this page at http://127.0.0.1:{port}/ on the Mac."
    return None


# ---- the app: config IO -----------------------------------------------------

class App:
    def __init__(self, config_path: str, port: int):
        self.config_path = config_path
        base = os.path.dirname(os.path.abspath(config_path))
        self.state_path = os.path.join(base, "state.json")
        self.pid_path = os.path.join(base, "monitor.pid")
        self.profiles_dir = os.path.join(base, "profiles")
        self.port = port
        self.csrf = secrets.token_urlsafe(32)   # per-run token embedded in the page
        self._lock = threading.Lock()

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

    def snapshot(self) -> dict:
        cfg = self.read()
        st = state_mod.load(self.state_path)
        return {
            "monitor": monitor_status(self.pid_path),
            "settings": public_settings(cfg),
            "accounts": [public_account(a, st) for a in cfg["accounts"]],
            "next_port": next_free_port(cfg["accounts"]),
        }

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

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.client_address[0], fmt % args))

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in _SECURITY_HEADERS:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, data: dict) -> None:
        self._send(status, json.dumps(data).encode(), "application/json; charset=utf-8")

    def _allowed(self) -> bool:
        err = access_error(self.client_address[0], self.headers.get("Host", ""), self.app.port)
        if err:
            self._json(err[0], {"error": err[1]})
            return False
        return True

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
            if not self._allowed():
                return
            if method == "GET":
                if path in ("/", "/index.html"):
                    with open(PAGE_PATH, encoding="utf-8") as f:
                        html = f.read().replace("__CSRF__", self.app.csrf)
                    self._send(200, html.encode(), "text/html; charset=utf-8")
                elif path == "/manage.js":
                    with open(JS_PATH, "rb") as f:
                        self._send(200, f.read(), "application/javascript; charset=utf-8")
                elif path == "/api/state":
                    self._json(200, self.app.snapshot())
                else:                       # e.g. a browser's automatic /favicon.ico
                    self._json(404, {"error": "Not found."})
                return
            if not self._csrf_ok():
                return
            self._mutate(method, path)
        except ValidationError as exc:
            self._json(400, {"error": str(exc)})
        except LookupError:
            self._json(404, {"error": "That account no longer exists. Reload the page."})
        except configfile.ConfigError as exc:
            self._json(500, {"error": str(exc)})

    def _mutate(self, method: str, path: str) -> None:
        app = self.app
        if method == "POST" and path == "/api/accounts":
            app.add_account(self._body())
            self._json(200, app.snapshot())
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
            self._json(200, app.snapshot())
            return
        if method == "PUT" and path == "/api/settings":
            app.update_settings(self._body())
            self._json(200, app.snapshot())
            return
        if method == "POST" and path == "/api/settings/test":
            app.test_telegram()
            self._json(200, {"ok": True})
            return
        self._json(404, {"error": "Not found."})


def make_server(app: App, port: int) -> ThreadingHTTPServer:
    """Bind to 127.0.0.1 only — like the other local apps, never the network."""
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.app = app                       # type: ignore[attr-defined]
    return srv


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="XtraPower account manager (web page, this Mac only)")
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-browser", action="store_true", help="don't open the page on start")
    args = ap.parse_args(argv)

    app = App(args.config, args.port)
    try:
        app.read()
    except configfile.ConfigError as exc:
        sys.exit(f"\n{exc}\n")
    try:
        httpd = make_server(app, args.port)
    except OSError as exc:
        sys.exit(f"Can't listen on 127.0.0.1:{args.port} ({exc}). "
                 "Is the account manager already open in another Terminal window?")

    url = f"http://127.0.0.1:{args.port}/"
    print(f"XtraPower account manager: {url}  (this Mac only; Ctrl-C to stop)", flush=True)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
