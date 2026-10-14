"""Account manager: validation, secrecy, access control and the HTTP API.

Standard library only (no Playwright), so these run with the repo's root
requirements. The HTTP tests drive a real server on a random local port.
"""

import json
import os
import stat
import threading
import urllib.error
import urllib.request

import pytest

from xtrapower import manage

PASSWORD = "s3cret-A"
TOKEN = "123456789:AAEabcdefghijklmnopqrstuvwxyzWXYZ"


def _write_cfg(tmp_path, accounts=None, **extra):
    cfg = {
        "poll_seconds": 120,
        "telegram": {"token": TOKEN, "chat_id": "42"},
        "accounts": accounts if accounts is not None else [{
            "label": "Shyam", "customer_id": "1001", "cdp_port": 9222, "watch": True,
            "username": "1001", "password": PASSWORD,
            "nav_labels": ["Financials", "Balance Info"],
            "balance_url": "https://beta.iocxtrapower.com/Transactions/BalanceInfo",
        }],
    }
    cfg.update(extra)
    path = tmp_path / "config.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    return path


# ---- validation ------------------------------------------------------------

def test_clean_account_requires_name_digits_and_a_sane_port():
    base = {"label": "A", "customer_id": "1001", "cdp_port": 9222}
    with pytest.raises(manage.ValidationError, match="name"):
        manage.clean_account({**base, "label": "  "}, None, [])
    with pytest.raises(manage.ValidationError, match="digits"):
        manage.clean_account({**base, "customer_id": "10O1"}, None, [])
    with pytest.raises(manage.ValidationError, match="number"):
        manage.clean_account({**base, "cdp_port": "abc"}, None, [])
    with pytest.raises(manage.ValidationError, match="between"):
        manage.clean_account({**base, "cdp_port": 80}, None, [])
    with pytest.raises(manage.ValidationError, match="used by this page"):
        manage.clean_account({**base, "cdp_port": manage.DEFAULT_PORT}, None, [])


def test_clean_account_rejects_a_duplicate_id_or_port():
    others = [{"label": "Other", "customer_id": "2002", "cdp_port": 9223}]
    with pytest.raises(manage.ValidationError, match="already used"):
        manage.clean_account({"label": "A", "customer_id": "2002", "cdp_port": 9222}, None, others)
    with pytest.raises(manage.ValidationError, match="own Chrome port"):
        manage.clean_account({"label": "A", "customer_id": "1001", "cdp_port": 9223}, None, others)


def test_blank_password_keeps_the_saved_one_and_clear_removes_it():
    saved = {"label": "A", "customer_id": "1001", "cdp_port": 9222, "password": PASSWORD}
    kept = manage.clean_account({"label": "A2", "password": ""}, saved, [])
    assert kept["password"] == PASSWORD and kept["label"] == "A2"
    changed = manage.clean_account({"password": "new-one"}, saved, [])
    assert changed["password"] == "new-one"
    cleared = manage.clean_account({"clear_password": True, "password": "ignored"}, saved, [])
    assert cleared["password"] == ""


def test_editing_keeps_keys_the_page_does_not_show():
    saved = {"label": "A", "customer_id": "1001", "cdp_port": 9222,
             "nav_labels": ["Finance"], "balance_url": "https://x/y"}
    out = manage.clean_account({"watch": False}, saved, [])
    assert out["nav_labels"] == ["Finance"] and out["balance_url"] == "https://x/y"
    assert out["watch"] is False


def test_settings_validation():
    cfg = {"telegram": {"token": TOKEN, "chat_id": "42"}, "poll_seconds": 120}
    with pytest.raises(manage.ValidationError, match="BotFather"):
        manage.clean_settings({"telegram_token": "not-a-token"}, cfg)
    with pytest.raises(manage.ValidationError, match="Chat ID"):
        manage.clean_settings({"chat_id": "abc"}, cfg)
    with pytest.raises(manage.ValidationError, match="between"):
        manage.clean_settings({"poll_seconds": 10}, cfg)
    out = manage.clean_settings({"telegram_token": "", "chat_id": "-100123", "poll_seconds": "300"}, cfg)
    assert out["telegram"]["token"] == TOKEN            # blank token keeps the saved one
    assert out["telegram"]["chat_id"] == "-100123" and out["poll_seconds"] == 300


def test_public_views_never_contain_secrets():
    acct = {"label": "A", "customer_id": "1001", "cdp_port": 9222, "password": PASSWORD}
    view = manage.public_account(acct, {"accounts": {"1001": {"ccms": "₹5.00"}}})
    assert PASSWORD not in json.dumps(view)
    assert view["has_password"] is True and view["last_ccms"] == "₹5.00"
    settings = manage.public_settings({"telegram": {"token": TOKEN, "chat_id": "42"}})
    assert TOKEN not in json.dumps(settings)
    assert settings["telegram_token_hint"] == "…" + TOKEN[-4:]


def test_example_placeholders_count_as_not_set():
    s = manage.public_settings({"telegram": {"token": "PUT-YOUR-BOTFATHER-TOKEN-HERE",
                                             "chat_id": "PUT-YOUR-CHAT-ID-HERE"}})
    assert s["telegram_token_set"] is False and s["chat_id"] == ""


def test_next_free_port_skips_used_ones():
    assert manage.next_free_port([{"cdp_port": 9222}, {"cdp_port": 9223}]) == 9224
    assert manage.next_free_port([]) == 9222


# ---- who may connect ----------------------------------------------------------

def test_only_this_mac_is_allowed():
    assert manage.is_loopback("127.0.0.1")
    assert manage.is_loopback("::1")
    assert manage.is_loopback("::ffff:127.0.0.1")
    assert not manage.is_loopback("100.101.102.103")       # Tailscale phone: not any more
    assert not manage.is_loopback("192.168.1.20")          # office Wi-Fi
    assert not manage.is_loopback("not-an-ip")


def test_access_rules():
    port = 8780
    assert manage.access_error("127.0.0.1", "127.0.0.1:8780", port) is None
    assert manage.access_error("127.0.0.1", "localhost:8780", port) is None
    assert manage.access_error("::1", "[::1]:8780", port) is None
    # This Mac, but under another host name: DNS rebinding — refused.
    assert manage.access_error("127.0.0.1", "evil.example:8780", port)[0] == 403
    # Any other machine is refused, whatever Host it claims.
    assert manage.access_error("100.1.2.3", "127.0.0.1:8780", port)[0] == 403
    assert manage.access_error("192.168.1.20", "127.0.0.1:8780", port)[0] == 403


def test_server_binds_to_this_mac_only(tmp_path):
    app = manage.App(str(_write_cfg(tmp_path)), 0)
    srv = manage.make_server(app, 0)
    try:
        assert srv.server_address[0] == "127.0.0.1"
    finally:
        srv.server_close()


# ---- the HTTP API --------------------------------------------------------------

@pytest.fixture
def server(tmp_path):
    path = _write_cfg(tmp_path)
    app = manage.App(str(path), 0)
    srv = manage.make_server(app, 0)
    app.port = srv.server_port
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv, path
    srv.shutdown()
    srv.server_close()


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # never via a proxy


def _call(srv, method, path, body=None, csrf=True, host=None):
    req = urllib.request.Request(
        f"http://127.0.0.1:{srv.server_port}{path}",
        data=None if body is None else json.dumps(body).encode(), method=method)
    req.add_header("Content-Type", "application/json")
    if csrf:
        req.add_header("X-XP-CSRF", srv.app.csrf)
    if host:
        req.add_header("Host", host)
    try:
        with _OPENER.open(req, timeout=10) as r:
            raw = r.read()
            return r.status, raw, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def test_page_is_served_with_the_csrf_token_and_strict_headers(server):
    srv, _ = server
    status, raw, headers = _call(srv, "GET", "/")
    assert status == 200
    assert srv.app.csrf.encode() in raw and b"__CSRF__" not in raw
    assert "script-src 'self'" in headers["Content-Security-Policy"]
    assert headers["X-Frame-Options"] == "DENY"
    status, raw, _ = _call(srv, "GET", "/manage.js")
    assert status == 200 and b"X-XP-CSRF" in raw


def test_state_never_sends_passwords_or_the_token(server):
    srv, _ = server
    status, raw, _ = _call(srv, "GET", "/api/state")
    assert status == 200
    assert PASSWORD.encode() not in raw and TOKEN.encode() not in raw
    data = json.loads(raw)
    assert data["accounts"][0]["has_password"] is True
    assert data["next_port"] == 9223


def test_changes_without_the_page_token_are_refused(server):
    srv, path = server
    status, _, _ = _call(srv, "POST", "/api/accounts",
                         {"label": "B", "customer_id": "2002", "cdp_port": 9223}, csrf=False)
    assert status == 403
    assert "2002" not in path.read_text()


def test_wrong_host_header_is_refused(server):
    srv, _ = server
    status, _, _ = _call(srv, "GET", "/api/state", host=f"attacker.example:{srv.server_port}")
    assert status == 403


def test_old_pin_endpoints_are_gone(server):
    srv, _ = server
    for path in ("/api/login", "/api/pin", "/api/logout"):
        status, _, _ = _call(srv, "POST", path, {"pin": "482913"})
        assert status == 404


def test_add_edit_toggle_delete_roundtrip(server):
    srv, path = server
    status, raw, _ = _call(srv, "POST", "/api/accounts", {
        "label": "Ember", "customer_id": "2002", "cdp_port": 9223,
        "username": "2002", "password": "pw-B", "watch": True})
    assert status == 200 and len(json.loads(raw)["accounts"]) == 2
    saved = json.loads(path.read_text())
    assert saved["accounts"][1]["password"] == "pw-B"

    # Edit with a blank password: the saved one stays.
    status, _, _ = _call(srv, "PUT", "/api/accounts/2002",
                         {"label": "Ember Coal", "password": "", "cdp_port": 9223})
    assert status == 200
    ember = json.loads(path.read_text())["accounts"][1]
    assert ember["label"] == "Ember Coal" and ember["password"] == "pw-B"

    # Watching off, then delete.
    status, raw, _ = _call(srv, "POST", "/api/accounts/2002/watch", {"watch": False})
    assert status == 200 and json.loads(raw)["accounts"][1]["watch"] is False
    status, raw, _ = _call(srv, "DELETE", "/api/accounts/2002")
    assert status == 200 and [a["customer_id"] for a in json.loads(raw)["accounts"]] == ["1001"]

    # The first account's untouched keys survive all of that.
    first = json.loads(path.read_text())["accounts"][0]
    assert first["password"] == PASSWORD and first["nav_labels"] == ["Financials", "Balance Info"]


def test_validation_errors_come_back_readable(server):
    srv, _ = server
    status, raw, _ = _call(srv, "POST", "/api/accounts",
                           {"label": "Dup", "customer_id": "3003", "cdp_port": 9222})
    assert status == 400 and "own Chrome port" in json.loads(raw)["error"]
    status, raw, _ = _call(srv, "PUT", "/api/accounts/9999", {"label": "x"})
    assert status == 404


def test_settings_update_keeps_the_token_when_left_blank(server):
    srv, path = server
    status, raw, _ = _call(srv, "PUT", "/api/settings",
                           {"telegram_token": "", "chat_id": "77", "poll_seconds": 180})
    assert status == 200
    saved = json.loads(path.read_text())
    assert saved["telegram"] == {"token": TOKEN, "chat_id": "77"} and saved["poll_seconds"] == 180


def test_saved_config_is_private_and_backed_up(server):
    srv, path = server
    _call(srv, "POST", "/api/accounts/1001/watch", {"watch": False})
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    backup = str(path) + ".bak"
    assert os.path.exists(backup) and stat.S_IMODE(os.stat(backup).st_mode) == 0o600
    assert json.loads(open(backup, encoding="utf-8").read())["accounts"][0]["watch"] is True


def test_saving_drops_hand_written_comments_but_keeps_values(tmp_path):
    """Documented trade-off: a save rewrites config.json as plain JSON."""
    path = tmp_path / "config.json"
    path.write_text('{\n  // my note\n  "poll_seconds": 120,\n  "telegram": {},\n'
                    '  "accounts": [{"label": "A", "customer_id": "1", "cdp_port": 9222}]\n}\n',
                    encoding="utf-8")
    app = manage.App(str(path), 8780)
    app.set_watch("1", False)
    text = path.read_text()
    assert "// my note" not in text
    assert json.loads(text)["accounts"][0]["watch"] is False


def test_unknown_get_is_a_plain_404_not_a_token_error(server):
    """A browser's automatic /favicon.ico must not trip the page-token check."""
    srv, _ = server
    status, raw, _ = _call(srv, "GET", "/favicon.ico", csrf=False)
    assert status == 404 and json.loads(raw)["error"] == "Not found."


# ---- server mode (infra/xtrapower): Tailscale access, monitor controls --------

TS_HOST = "oracle-india.tail1234.ts.net"


def test_tailscale_name_is_accepted_only_for_the_allowed_login():
    port, hosts, users = 8780, {TS_HOST}, {"me@example.com"}
    ok = manage.access_error("127.0.0.1", TS_HOST, port, hosts, users, "Me@Example.com")
    assert ok is None
    assert manage.access_error("127.0.0.1", f"{TS_HOST}:443", port, hosts, users, "me@example.com") is None
    assert manage.access_error("127.0.0.1", TS_HOST, port, hosts, users, "other@example.com")[0] == 403
    assert manage.access_error("127.0.0.1", TS_HOST, port, hosts, users, None)[0] == 403
    # Without a login list, the Tailscale name alone is enough (still loopback only).
    assert manage.access_error("127.0.0.1", TS_HOST, port, hosts, (), None) is None
    # The name doesn't let other machines in, and other names stay refused.
    assert manage.access_error("100.64.0.9", TS_HOST, port, hosts, users, "me@example.com")[0] == 403
    assert manage.access_error("127.0.0.1", "evil.example", port, hosts, users, "me@example.com")[0] == 403


class FakeSystemd:
    def __init__(self, active="active", fail=None):
        self.active, self.fail, self.calls = active, fail, []

    def __call__(self, cmd, timeout=60):
        self.calls.append(cmd)
        if cmd[:2] == ["systemctl", "is-active"]:
            return (0 if self.active == "active" else 3), self.active + "\n"
        if cmd[:2] == ["systemctl", "is-enabled"]:
            return 0, "enabled\n"
        if self.fail and self.fail in cmd:
            return 1, "sudo: a password is required\n"
        if cmd[:3] == ["sudo", "-n", "/usr/bin/journalctl"]:
            return 0, "line one\nline two\n"
        if cmd[:3] == ["sudo", "-n", "/usr/bin/systemctl"]:
            self.active = "inactive" if "disable" in cmd else "active"
            return 0, ""
        return 1, "unexpected"


def _server_app(tmp_path, systemd):
    return manage.App(str(_write_cfg(tmp_path)), 8780, service="xtrapower",
                      allowed_hosts=[TS_HOST], allowed_users=["me@example.com"], run=systemd)


def test_server_mode_reports_and_controls_the_service(tmp_path):
    systemd = FakeSystemd()
    app = _server_app(tmp_path, systemd)
    snap = app.snapshot()
    assert snap["server"] is True and snap["monitor"]["running"] is True
    assert snap["monitor"]["start_at_boot"] is True

    app.control_monitor("stop")
    assert ["sudo", "-n", "/usr/bin/systemctl", "disable", "--now", "xtrapower"] in systemd.calls
    assert app.snapshot()["monitor"] == {"running": False, "pid": None, "state": "inactive",
                                         "start_at_boot": True}
    app.control_monitor("start")
    assert ["sudo", "-n", "/usr/bin/systemctl", "enable", "--now", "xtrapower"] in systemd.calls
    app.control_monitor("restart")
    assert ["sudo", "-n", "/usr/bin/systemctl", "restart", "xtrapower"] in systemd.calls
    with pytest.raises(LookupError):
        app.control_monitor("reboot")
    # Must match /etc/sudoers.d/xtrapower-manage exactly.
    assert app.recent_logs() == ["line one", "line two"]
    assert ["sudo", "-n", "/usr/bin/journalctl", "-u", "xtrapower", "-n", "80",
            "--no-pager", "-o", "short-iso"] in systemd.calls


def test_a_refused_control_is_shown_not_hidden(tmp_path):
    app = _server_app(tmp_path, FakeSystemd(fail="restart"))
    with pytest.raises(manage.ValidationError, match="password is required"):
        app.control_monitor("restart")


def test_mac_mode_has_no_service_controls_and_server_mode_no_open_window(tmp_path):
    mac = manage.App(str(_write_cfg(tmp_path)), 8780)
    assert mac.snapshot()["server"] is False
    with pytest.raises(manage.ValidationError):
        mac.control_monitor("stop")
    with pytest.raises(manage.ValidationError):
        mac.recent_logs()
    with pytest.raises(manage.ValidationError, match="opens by itself"):
        _server_app(tmp_path, FakeSystemd()).open_window("1001")


@pytest.fixture
def server_mode(tmp_path):
    systemd = FakeSystemd()
    app = _server_app(tmp_path, systemd)
    srv = manage.make_server(app, 0)
    app.port = srv.server_port
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv, systemd
    srv.shutdown()
    srv.server_close()


def test_monitor_buttons_need_the_page_token(server_mode):
    srv, systemd = server_mode
    status, _, _ = _call(srv, "POST", "/api/monitor/stop", {}, csrf=False)
    assert status == 403 and not any("disable" in c for c in systemd.calls)
    status, raw, _ = _call(srv, "POST", "/api/monitor/stop", {})
    assert status == 200 and json.loads(raw)["monitor"]["running"] is False
    status, raw, _ = _call(srv, "GET", "/api/logs")
    assert status == 200 and json.loads(raw)["lines"] == ["line one", "line two"]


def test_home_screen_files_are_served(server):
    srv, _ = server
    status, raw, headers = _call(srv, "GET", "/manifest.webmanifest", csrf=False)
    assert status == 200 and headers["Content-Type"] == "application/manifest+json"
    assert json.loads(raw)["display"] == "standalone"
    for icon in ("/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"):
        status, raw, headers = _call(srv, "GET", icon, csrf=False)
        assert status == 200 and raw[:8] == b"\x89PNG\r\n\x1a\n" and headers["Content-Type"] == "image/png"
    _, page, _ = _call(srv, "GET", "/")
    assert b'rel="manifest"' in page and b"apple-touch-icon" in page


# ---- the Tank stock tab: /ts/ is the tank stock page, passed through ------------

@pytest.fixture
def with_tank_stock(server_mode, tmp_path, monkeypatch):
    """The XtraPower server in server mode, and the real tank stock page server
    (tank_stock/service.py) behind its /ts/."""
    from tank_stock import service as ts
    station = ts.Station(home=tmp_path / "tank")
    tank = ts.make_server(station, 0, hosts=[TS_HOST], users=["me@example.com"])
    threading.Thread(target=tank.serve_forever, daemon=True).start()
    monkeypatch.setattr(manage, "TANK_STOCK", f"127.0.0.1:{tank.server_port}")
    yield server_mode[0], tank
    tank.shutdown()
    tank.server_close()


def _ts_call(srv, method, path, body=None, headers=None):
    req = urllib.request.Request(f"http://127.0.0.1:{srv.server_port}{path}",
                                 data=None if body is None else json.dumps(body).encode(), method=method)
    req.add_header("Host", TS_HOST)
    req.add_header("Tailscale-User-Login", "me@example.com")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with _OPENER.open(req, timeout=10) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def test_the_tank_stock_tab_is_the_tank_stock_page_passed_through(with_tank_stock):
    srv, tank = with_tank_stock
    status, raw, headers = _ts_call(srv, "GET", "/ts/")
    assert status == 200 and b"<title>Tank stock</title>" in raw
    assert tank.csrf.encode() in raw and b"__CSRF__" not in raw              # its own CSRF token
    assert headers["X-Frame-Options"] == "SAMEORIGIN" and "frame-ancestors 'self'" in headers["Content-Security-Policy"]
    assert b'src="app.js"' in raw                                            # relative: works under /ts/
    status, raw, _ = _ts_call(srv, "GET", "/ts/app.js")
    assert status == 200 and b"api/state" in raw and b'"/api/' not in raw
    status, raw, _ = _ts_call(srv, "GET", "/ts/api/state")
    assert status == 200 and "settings" in json.loads(raw)
    # a change needs the tank page's token, not the XtraPower one
    status, raw, _ = _ts_call(srv, "POST", "/ts/api/settings", {"interval_s": 30})
    assert status == 403
    status, raw, _ = _ts_call(srv, "POST", "/ts/api/settings", {"interval_s": 30}, {"X-TS-CSRF": tank.csrf})
    assert status == 200 and json.loads(raw)["settings"]["interval_s"] == 30
    # the shell frames it (same origin only)
    status, raw, headers = _ts_call(srv, "GET", "/")
    assert "frame-src 'self'" in headers["Content-Security-Policy"] and b'id="tsFrame"' in raw


def test_the_tank_stock_tab_is_only_for_the_allowed_tailscale_login(with_tank_stock):
    srv, _ = with_tank_stock
    status, raw, _ = _ts_call(srv, "GET", "/ts/api/state", headers={"Tailscale-User-Login": "someone@else.com"})
    assert status == 403                                                     # refused before it is passed on
    status, _, headers = _ts_call(srv, "GET", "/ts")
    assert status in (200, 308)


def test_the_tank_stock_tab_says_when_its_service_is_down(server_mode, monkeypatch):
    srv, _ = server_mode
    monkeypatch.setattr(manage, "TANK_STOCK", "127.0.0.1:9")                # nothing listens there
    status, raw, _ = _ts_call(srv, "GET", "/ts/api/state")
    assert status == 502 and "tank stock service isn't answering on this server" in json.loads(raw)["error"]


def test_the_tank_stock_tab_can_be_another_tailscale_machine(server_mode, monkeypatch):
    srv, _ = server_mode
    seen = {}

    class FakeHTTPS:
        def __init__(self, host, port, timeout):
            seen["at"] = (host, port)

        def request(self, method, path, body=None, headers=None):
            seen.update(method=method, path=path, headers=headers)

        def getresponse(self):
            class R:
                status = 200
                def read(self):
                    return b'{"ok": true}'
                def getheader(self, k):
                    return "application/json" if k == "Content-Type" else None
            return R()

        def close(self):
            pass

    monkeypatch.setattr(manage, "TANK_STOCK", "https://mac-tank.example.ts.net:8443")
    monkeypatch.setattr(manage.http.client, "HTTPSConnection", FakeHTTPS)
    status, raw, _ = _ts_call(srv, "GET", "/ts/api/state")
    assert status == 200 and json.loads(raw) == {"ok": True}
    assert seen["at"] == ("mac-tank.example.ts.net", 8443) and seen["path"] == "/api/state"
    assert seen["headers"]["Host"] == "mac-tank.example.ts.net:8443"
    assert "Tailscale-User-Login" not in seen["headers"]          # that machine's tailscale serve says who asks
