"""The Jarvis bridge (jarvis/bridge/): picking accounts, the XtraPower actions
on a temporary config, owner scripts, and one check-in against a fake
Supabase. Nothing real is started — subprocess calls are recorded."""

import json
import os
import subprocess

import pytest

from jarvis.bridge import actions, bridge
from jarvis.bridge.supa import read_js_config
from xtrapower import manage

ACCOUNTS = [
    {"label": "Shyam Metalics", "customer_id": "1005218882", "cdp_port": 9222, "watch": False},
    {"label": "Ember Coal", "customer_id": "1005079471", "cdp_port": 9223, "watch": True, "password": "x"},
    {"label": "SSL XP", "customer_id": "1005133705", "cdp_port": 9224, "watch": False},
]


class Recorder:
    def __init__(self, out="✓ Monitoring is ON (PID 1)."):
        self.calls = []
        self.out = out

    def __call__(self, cmd, **kw):
        self.calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout=self.out, stderr="")


@pytest.fixture
def root(tmp_path):
    (tmp_path / "xtrapower").mkdir()
    (tmp_path / "xtrapower" / "config.json").write_text(json.dumps({
        "poll_seconds": 120, "telegram": {"token": "t", "chat_id": "1"}, "accounts": ACCOUNTS}), encoding="utf-8")
    return tmp_path


def ctx_for(root, open_ports=(), **kw):
    return actions.Ctx(root=str(root), run=kw.pop("run", Recorder()), port_open=lambda p: p in open_ports, **kw)


def watched(root):
    cfg = json.loads((root / "xtrapower" / "config.json").read_text())
    return {a["label"]: a["watch"] for a in cfg["accounts"]}


# ---- picking the account ----------------------------------------------------------

def test_pick_account_by_label_id_or_words():
    assert actions.pick_account(ACCOUNTS, "ember")["label"] == "Ember Coal"
    assert actions.pick_account(ACCOUNTS, "Shyam metalics account")["label"] == "Shyam Metalics"
    assert actions.pick_account(ACCOUNTS, "1005133705")["label"] == "SSL XP"
    assert actions.pick_account(ACCOUNTS, "ssl")["label"] == "SSL XP"
    assert actions.pick_account(ACCOUNTS, "metalics")["label"] == "Shyam Metalics"
    with pytest.raises(actions.ActionError, match="No XtraPower account"):
        actions.pick_account(ACCOUNTS, "tata")
    with pytest.raises(actions.ActionError, match="several"):
        actions.pick_account(ACCOUNTS, "1005")


# ---- XtraPower ----------------------------------------------------------------------

def test_watch_turns_the_account_on_opens_chrome_and_starts_the_monitor(root, monkeypatch):
    opened = []
    monkeypatch.setattr(manage.launch_mod, "find_chrome", lambda: "/Applications/Chrome")
    monkeypatch.setattr(manage.launch_mod, "launch_account", lambda chrome, acct, prof: opened.append(acct["label"]))
    run = Recorder()
    res = actions.run_action(ctx_for(root, run=run), "xtrapower.watch", {"account": "shyam", "watch": True})
    assert watched(root)["Shyam Metalics"] is True
    assert opened == ["Shyam Metalics"]
    assert run.calls == [["bash", os.path.join(str(root), "xtrapower", "monitor-mac.sh"), "start"]]
    assert "Now watching Shyam Metalics" in res["text"] and "log in" in res["text"]


def test_watch_with_chrome_open_and_monitor_running_just_switches_it_on(root, monkeypatch):
    (root / "xtrapower" / "monitor.pid").write_text(str(os.getpid()))
    run = Recorder()
    res = actions.run_action(ctx_for(root, open_ports={9224}, run=run), "xtrapower.watch", {"account": "SSL XP"})
    assert watched(root)["SSL XP"] is True and run.calls == []
    assert "next check" in res["text"]


def test_stopping_the_last_watched_account_turns_the_monitor_off(root):
    (root / "xtrapower" / "monitor.pid").write_text(str(os.getpid()))
    run = Recorder("✓ Monitoring is OFF.")
    res = actions.run_action(ctx_for(root, run=run), "xtrapower.watch", {"account": "ember", "watch": False})
    assert watched(root)["Ember Coal"] is False
    assert run.calls and run.calls[0][-1] == "stop"
    assert "turned the monitor off" in res["text"]


def test_status_reads_config_state_and_chrome_windows(root):
    (root / "xtrapower" / "state.json").write_text(json.dumps(
        {"accounts": {"1005079471": {"ccms": "₹2,50,000.00", "updated_at": "2026-10-12T10:00:00+05:30"}}}))
    res = actions.run_action(ctx_for(root, open_ports={9223}), "xtrapower.status", {})
    assert res["running"] is False
    ember = next(a for a in res["accounts"] if a["label"] == "Ember Coal")
    assert ember["chrome_open"] is True and ember["last_ccms"] == "₹2,50,000.00"
    assert "Monitoring is OFF" in res["text"] and "Ember Coal: watching, CCMS ₹2,50,000.00" in res["text"]
    assert "password" not in json.dumps(res)


def test_monitor_failure_is_reported(root):
    def fail(cmd, **kw):
        return subprocess.CompletedProcess(cmd, 1, stdout="✗ No .venv found — run ./xtrapower/setup-mac.sh first.", stderr="")
    with pytest.raises(actions.ActionError, match="No .venv"):
        actions.run_action(ctx_for(root, run=fail), "xtrapower.start", {})


def test_not_set_up_yet(tmp_path):
    with pytest.raises(actions.ActionError, match="isn't set up"):
        actions.run_action(ctx_for(tmp_path), "xtrapower.status", {})


def test_logs_tail(root):
    (root / "xtrapower" / "monitor.log").write_text("\n".join(f"line {i}" for i in range(100)))
    res = actions.run_action(ctx_for(root), "xtrapower.logs", {"lines": 3})
    assert res["lines"] == ["line 97", "line 98", "line 99"]


# ---- owner's scripts -----------------------------------------------------------------

def test_only_listed_scripts_run(root):
    run = Recorder("agent is running")
    spawned = []
    scripts = {
        "agent_status": {"label": "Payment agent status", "run": ["bash", "local_agent/agentctl.sh", "status"]},
        "bank": {"label": "Bank to Tally app", "run": ["bash", "bank_tally/run_app.sh"], "background": True},
    }
    ctx = ctx_for(root, run=run, scripts=scripts, popen=lambda cmd, **kw: spawned.append(cmd))
    assert actions.run_action(ctx, "script.run", {"name": "agent_status"})["output"] == "agent is running"
    assert run.calls == [["bash", "local_agent/agentctl.sh", "status"]]
    assert actions.run_action(ctx, "script.run", {"name": "bank to tally app"})["text"] == "Started Bank to Tally app on the Mac."
    assert spawned == [["bash", "bank_tally/run_app.sh"]]
    with pytest.raises(actions.ActionError, match="No script named"):
        actions.run_action(ctx, "script.run", {"name": "rm -rf /"})
    with pytest.raises(actions.ActionError, match="doesn't know"):
        actions.run_action(ctx, "shell", {"cmd": "ls"})


# ---- one check-in ---------------------------------------------------------------------

class FakeSupa:
    def __init__(self, queue):
        self.queue = list(queue)
        self.finished = []

    def rpc(self, fn, args=None):
        if fn == "jarvis_bridge_poll":
            return self.queue.pop(0) if self.queue else None
        if fn == "jarvis_bridge_finish":
            self.finished.append(args)
            return None
        raise AssertionError(fn)


def test_step_runs_a_command_and_posts_the_result(root):
    supa = FakeSupa([{"id": 7, "action": "bridge.ping", "args": {}}, {"id": 8, "action": "format.disk", "args": {}}])
    b = bridge.Bridge({"name": "mac", "poll_seconds": 3, "scripts": {}}, supa=supa, ctx=ctx_for(root))
    assert b.step() is True
    assert supa.finished[0]["p_id"] == 7 and supa.finished[0]["p_ok"] is True
    assert "xtrapower.watch" in supa.finished[0]["p_result"]["actions"]
    assert b.step() is True
    assert supa.finished[1]["p_ok"] is False and "doesn't know" in supa.finished[1]["p_error"]
    assert b.step() is False


def test_reads_the_jarvis_projects_public_config():
    cfg = read_js_config(os.path.join(actions.ROOT, "jarvis", "config.js"))
    assert cfg["SUPABASE_URL"].startswith("https://") and cfg["SUPABASE_ANON_KEY"].startswith("sb_publishable_")
