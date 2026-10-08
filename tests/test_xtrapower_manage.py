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
